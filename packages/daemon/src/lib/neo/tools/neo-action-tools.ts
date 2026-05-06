/**
 * Neo Action Tools - MCP tools for write operations
 *
 * Implements space, workflow, configuration, and messaging
 * write operations with security-tier enforcement. Each tool checks whether
 * the current security mode requires confirmation before execution and either
 * runs immediately or returns a `confirmationRequired` payload.
 *
 * Pattern: two-layer design (testable handlers + MCP server wrapper)
 *   createNeoActionToolHandlers(config) → plain handler functions
 *   createNeoActionMcpServer(config)    → MCP server wrapping those handlers
 *
 * Supported tools:
 *
 *   Space operations (delegated to GlobalSpaces handler layer)
 *   - create_space
 *   - update_space
 *   - delete_space
 *
 *   Workflow operations
 *   - start_workflow_run  (delegated to GlobalSpaces handler layer)
 *   - cancel_workflow_run
 *   - approve_gate
 *   - reject_gate
 *
 *   Configuration management
 *   - add_mcp_server
 *   - update_mcp_server
 *   - delete_mcp_server
 *   - toggle_mcp_server
 *   - add_skill
 *   - update_skill
 *   - delete_skill
 *   - toggle_skill
 *   - update_app_settings
 *
 *   Undo
 *   - undo_last_action
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { NeoActivityLogger } from '../activity-logger';
import type {
	AppMcpServer,
	AppMcpServerSourceType,
	AppSkill,
	AppSkillConfig,
	GlobalSettings,
	SkillSourceType,
	SpaceAutonomyLevel,
} from '@neokai/shared';
import {
	ActionClassification,
	shouldAutoExecute,
	type NeoSecurityMode,
	type NeoActionResult,
	type PendingActionStore,
} from '../security-tier';

// ---------------------------------------------------------------------------
// Space / Workflow interfaces (delegated to global-spaces handler layer)
// ---------------------------------------------------------------------------

/** Minimal ToolResult shape shared with global-spaces handlers. */
interface SharedToolResult {
	[key: string]: unknown;
	content: Array<{ type: 'text'; text: string }>;
}

/**
 * Handlers from the GlobalSpaces layer that Neo delegates space/workflow
 * operations to.  Neo wraps each call with a security-tier check before
 * delegating.
 *
 * Pass `createGlobalSpacesToolHandlers(config, state)` as this value when
 * wiring up the real daemon.  Use a mock object in unit tests.
 */
export interface NeoActionSpaceHandlers {
	create_space(args: {
		name: string;
		workspace_path: string;
		description?: string;
		instructions?: string;
		autonomy_level?: SpaceAutonomyLevel;
	}): Promise<SharedToolResult>;

	update_space(args: {
		space_id: string;
		name?: string;
		description?: string;
		instructions?: string;
		background_context?: string;
		default_model?: string;
		autonomy_level?: SpaceAutonomyLevel;
	}): Promise<SharedToolResult>;

	delete_space(args: { space_id: string }): Promise<SharedToolResult>;

	start_workflow_run(args: {
		space_id?: string;
		workflow_id: string;
		title: string;
		description?: string;
		goal_id?: string;
	}): Promise<SharedToolResult>;
}

/** Minimal workflow-run record needed by cancel/gate handlers. */
export interface NeoWorkflowRun {
	id: string;
	spaceId: string;
	status: string;
	failureReason?: string | null;
}

/** Repository for reading and transitioning workflow run state. */
export interface NeoActionWorkflowRunRepository {
	getRun(id: string): NeoWorkflowRun | null;
	transitionStatus(id: string, to: string): NeoWorkflowRun;
	updateRun(id: string, params: { failureReason?: string | null }): NeoWorkflowRun | null;
}

/** Minimal space task record for cancellation. */
export interface NeoSpaceTask {
	id: string;
	status: string;
}

/** Manager for space tasks within a single workflow run. */
export interface NeoActionSpaceTaskManager {
	listTasksByWorkflowRun(runId: string): Promise<NeoSpaceTask[]>;
	cancelTask(taskId: string): Promise<unknown>;
}

/** Factory that creates a SpaceTaskManager scoped to a space. */
export interface NeoActionSpaceTaskManagerFactory {
	getTaskManager(spaceId: string): NeoActionSpaceTaskManager;
}

/** Gate data record returned by the repository. */
export interface NeoGateDataRecord {
	data: Record<string, unknown>;
}

/** Repository for reading and writing gate approval data. */
export interface NeoActionGateDataRepository {
	get(runId: string, gateId: string): NeoGateDataRecord | null;
	merge(runId: string, gateId: string, partial: Record<string, unknown>): NeoGateDataRecord;
}

/** Optional callback to notify the runtime that gate data changed. */
export type NeoGateChangedNotifier = (runId: string, gateId: string) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Configuration management interfaces
// ---------------------------------------------------------------------------

export interface NeoMcpManager {
	/** Create a new app-level MCP server entry */
	createMcpServer(params: {
		name: string;
		sourceType: AppMcpServerSourceType;
		description?: string;
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		url?: string;
		headers?: Record<string, string>;
		enabled?: boolean;
	}): AppMcpServer;
	/** Update an existing MCP server entry */
	updateMcpServer(
		id: string,
		updates: {
			name?: string;
			description?: string;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			url?: string;
			headers?: Record<string, string>;
			enabled?: boolean;
		}
	): AppMcpServer | null;
	/** Delete an MCP server entry, returns true if deleted */
	deleteMcpServer(id: string): boolean;
	/** Get an MCP server entry by id */
	getMcpServer(id: string): AppMcpServer | null;
	/** Get an MCP server entry by name (for lookups) */
	getMcpServerByName(name: string): AppMcpServer | null;
}

export interface NeoSkillsManager {
	/** Add a new skill */
	addSkill(params: {
		name: string;
		displayName: string;
		description: string;
		sourceType: SkillSourceType;
		config: AppSkillConfig;
		enabled?: boolean;
		validationStatus?: 'pending' | 'valid' | 'invalid' | 'unknown';
	}): AppSkill;
	/** Update an existing skill (user-editable fields only) */
	updateSkill(
		id: string,
		params: { displayName?: string; description?: string; config?: AppSkillConfig }
	): AppSkill;
	/** Toggle skill enabled state */
	setSkillEnabled(id: string, enabled: boolean): AppSkill;
	/** Remove a skill by ID, returns false if built-in or not found */
	removeSkill(id: string): boolean;
	/** Get a skill by ID */
	getSkill(id: string): AppSkill | null;
}

export interface NeoSettingsManager {
	getGlobalSettings(): GlobalSettings;
	updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings;
}

// ---------------------------------------------------------------------------
// Messaging & session control interfaces
// ---------------------------------------------------------------------------

export interface NeoSessionManager {
	/**
	 * Inject a message into a session. `sessionId` is the target session.
	 */
	injectMessage(sessionId: string, message: string): Promise<void>;
	/**
	 * Find the active worker session ID for a task. Returns null if not found.
	 */
	getActiveSessionForTask(taskId: string): string | null;
	/**
	 * Route a session through the UI-only delete primitive, removing
	 * its worktree + SDK `.jsonl` files AND its DB row (cascades to
	 * `sdk_messages`).
	 */
	deleteSessionResources(sessionId: string, trigger: string): Promise<void>;
}

export interface NeoActionToolsConfig {
	pendingStore: PendingActionStore;
	/** Workspace root — used by query tools (e.g. get_status) */
	workspaceRoot?: string;
	/** Returns the current security mode (looked up at call time) */
	getSecurityMode(): NeoSecurityMode;

	// ── Space / Workflow dependencies ──────────────────────────────────────
	/** Pre-constructed GlobalSpaces handlers — Neo delegates CRUD and run ops to these. */
	spaceHandlers?: NeoActionSpaceHandlers;
	/** Repository for reading and transitioning workflow-run state. */
	workflowRunRepo?: NeoActionWorkflowRunRepository;
	/** Factory for per-space task managers (used by cancel_workflow_run). */
	spaceTaskManagerFactory?: NeoActionSpaceTaskManagerFactory;
	/** Repository for gate approval data. */
	gateDataRepo?: NeoActionGateDataRepository;
	/**
	 * Optional callback invoked after gate data is written.
	 * When provided, triggers channel re-evaluation so downstream nodes
	 * activate if the gate is now open (mirrors fireGateChanged in the RPC layer).
	 */
	onGateChanged?: NeoGateChangedNotifier;
	/**
	 * Optional callback invoked after a workflow run's status changes.
	 * Mirrors the `space.workflowRun.updated` event emitted by the RPC layer
	 * so that the frontend LiveQuery subscriptions receive the update.
	 * Called by cancel_workflow_run, approve_gate, and reject_gate.
	 */
	onWorkflowRunUpdated?: (
		spaceId: string,
		runId: string,
		run: NeoWorkflowRun
	) => void | Promise<void>;
	/**
	 * Optional callback invoked after gate data is written.
	 * Mirrors the `space.gateData.updated` event emitted by the RPC layer.
	 * Called by approve_gate and reject_gate.
	 */
	onGateDataUpdated?: (
		spaceId: string,
		runId: string,
		gateId: string,
		data: Record<string, unknown>
	) => void | Promise<void>;
	/** MCP server CRUD operations (optional — config tools disabled if absent) */
	mcpManager?: NeoMcpManager;
	/** Skills CRUD operations (optional — skill tools disabled if absent) */
	skillsManager?: NeoSkillsManager;
	/** App settings manager (optional — update_app_settings disabled if absent) */
	settingsManager?: NeoSettingsManager;
	/** Session manager for message injection (optional — messaging tools disabled if absent) */
	sessionManager?: NeoSessionManager;
	/** Activity logger for recording every tool invocation (optional — logging disabled if absent) */
	activityLogger?: NeoActivityLogger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Well-known sensitive environment variable names that must not be stored
 * in the MCP registry.  Secret values should live in the host process
 * environment (process.env) and are inherited by MCP child processes
 * automatically — they must never be persisted to SQLite.
 */
const SENSITIVE_ENV_VARS = new Set([
	'ANTHROPIC_API_KEY',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'ANTHROPIC_AUTH_TOKEN',
	'GLM_API_KEY',
	'ZHIPU_API_KEY',
	'OPENAI_API_KEY',
	'COPILOT_GITHUB_TOKEN',
	'GITHUB_TOKEN',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
]);

interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: Record<string, unknown> | unknown[]): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): ToolResult {
	return jsonResult({ success: false, error: message });
}

function successResult(data: Record<string, unknown> = {}): ToolResult {
	return jsonResult({ success: true, ...data });
}

/**
 * Wrap a write operation with security-tier enforcement.
 *
 * If the current mode allows auto-execution for the given tool, the executor
 * runs immediately.  Otherwise the input is stored in the pending store and a
 * `confirmationRequired` payload is returned for the user to confirm.
 */
async function withSecurityCheck(
	toolName: string,
	input: Record<string, unknown>,
	config: Pick<NeoActionToolsConfig, 'pendingStore' | 'getSecurityMode'>,
	executor: () => Promise<ToolResult>
): Promise<ToolResult> {
	const mode = config.getSecurityMode();
	const riskLevel = ActionClassification[toolName] ?? 'medium';

	if (shouldAutoExecute(mode, riskLevel)) {
		return executor();
	}

	// Confirmation required — store the pending action and return a structured payload
	const pendingActionId = config.pendingStore.store({ toolName, input });
	const result: NeoActionResult = {
		success: false,
		confirmationRequired: true,
		pendingActionId,
		actionDescription: `Execute ${toolName}`,
		riskLevel,
	};
	return jsonResult(result as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Handler functions (testable without MCP plumbing)
// ---------------------------------------------------------------------------

export function createNeoActionToolHandlers(config: NeoActionToolsConfig) {
	const {
		workspaceRoot: _workspaceRoot,
		spaceHandlers,
		workflowRunRepo,
		spaceTaskManagerFactory,
		gateDataRepo,
		onGateChanged,
		onWorkflowRunUpdated,
		onGateDataUpdated,
		mcpManager,
		skillsManager,
		settingsManager,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		sessionManager,
	} = config;

	return {
		// ── Space ─────────────────────────────────────────────────────────────

		async create_space(args: {
			name: string;
			workspace_path: string;
			description?: string;
			instructions?: string;
			autonomy_level?: SpaceAutonomyLevel;
		}): Promise<ToolResult> {
			return withSecurityCheck('create_space', args as Record<string, unknown>, config, () => {
				if (!spaceHandlers) {
					return Promise.resolve(errorResult('Space operations are not available'));
				}
				return spaceHandlers.create_space(args);
			});
		},

		async update_space(args: {
			space_id: string;
			name?: string;
			description?: string;
			instructions?: string;
			background_context?: string;
			default_model?: string;
			autonomy_level?: SpaceAutonomyLevel;
		}): Promise<ToolResult> {
			// Input validation — stays outside the security check (no backend needed to validate)
			const hasUpdates =
				args.name !== undefined ||
				args.description !== undefined ||
				args.instructions !== undefined ||
				args.background_context !== undefined ||
				args.default_model !== undefined ||
				args.autonomy_level !== undefined;
			if (!hasUpdates) {
				return errorResult('No update fields provided');
			}
			return withSecurityCheck('update_space', args as Record<string, unknown>, config, () => {
				if (!spaceHandlers) {
					return Promise.resolve(errorResult('Space operations are not available'));
				}
				return spaceHandlers.update_space(args);
			});
		},

		async delete_space(args: { space_id: string }): Promise<ToolResult> {
			return withSecurityCheck('delete_space', args as Record<string, unknown>, config, () => {
				if (!spaceHandlers) {
					return Promise.resolve(errorResult('Space operations are not available'));
				}
				return spaceHandlers.delete_space(args);
			});
		},

		// ── Workflow ──────────────────────────────────────────────────────────

		async start_workflow_run(args: {
			space_id?: string;
			workflow_id: string;
			title: string;
			description?: string;
			goal_id?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck(
				'start_workflow_run',
				args as Record<string, unknown>,
				config,
				() => {
					if (!spaceHandlers) {
						return Promise.resolve(errorResult('Workflow operations are not available'));
					}
					return spaceHandlers.start_workflow_run(args);
				}
			);
		},

		async cancel_workflow_run(args: { run_id: string }): Promise<ToolResult> {
			return withSecurityCheck(
				'cancel_workflow_run',
				args as Record<string, unknown>,
				config,
				async () => {
					if (!workflowRunRepo || !spaceTaskManagerFactory) {
						return errorResult('Workflow run operations are not available');
					}

					const run = workflowRunRepo.getRun(args.run_id);
					if (!run) {
						return errorResult(`Workflow run not found: ${args.run_id}`);
					}
					if (run.status === 'cancelled') {
						return successResult({ runId: args.run_id, alreadyCancelled: true });
					}
					if (run.status === 'done') {
						return errorResult('Cannot cancel a completed workflow run');
					}

					// Cancel all open/in_progress tasks for this run (best-effort)
					const taskManager = spaceTaskManagerFactory.getTaskManager(run.spaceId);
					const tasks = await taskManager.listTasksByWorkflowRun(run.id);
					for (const task of tasks) {
						if (task.status === 'open' || task.status === 'in_progress') {
							await taskManager.cancelTask(task.id).catch(() => {
								/* best-effort — individual task failures do not abort run cancellation */
							});
						}
					}

					const updated = workflowRunRepo.transitionStatus(args.run_id, 'cancelled');
					await onWorkflowRunUpdated?.(run.spaceId, run.id, updated);
					return successResult({ runId: args.run_id });
				}
			);
		},

		// ── Gate ──────────────────────────────────────────────────────────────

		async approve_gate(args: {
			run_id: string;
			gate_id: string;
			reason?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck(
				'approve_gate',
				args as Record<string, unknown>,
				config,
				async () => {
					if (!workflowRunRepo || !gateDataRepo) {
						return errorResult('Gate operations are not available');
					}

					const run = workflowRunRepo.getRun(args.run_id);
					if (!run) {
						return errorResult(`Workflow run not found: ${args.run_id}`);
					}
					if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
						return errorResult(`Cannot approve gate on a ${run.status} workflow run`);
					}

					// Idempotent: already approved
					const existing = gateDataRepo.get(args.run_id, args.gate_id);
					if (existing?.data?.approved === true) {
						return successResult({
							runId: args.run_id,
							gateId: args.gate_id,
							gateData: existing.data,
						});
					}

					const gateData = gateDataRepo.merge(args.run_id, args.gate_id, {
						approved: true,
						approvedAt: Date.now(),
						approvalSource: 'agent',
					});

					// If previously rejected, transition back to in_progress and clear failure reason
					let currentRun = run;
					if (run.status === 'blocked' && run.failureReason === 'humanRejected') {
						currentRun = workflowRunRepo.transitionStatus(args.run_id, 'in_progress');
						currentRun =
							workflowRunRepo.updateRun(args.run_id, { failureReason: null }) ?? currentRun;
						await onWorkflowRunUpdated?.(run.spaceId, run.id, currentRun);
					}

					await onGateDataUpdated?.(run.spaceId, run.id, args.gate_id, gateData.data);
					await onGateChanged?.(args.run_id, args.gate_id);

					return successResult({
						runId: args.run_id,
						gateId: args.gate_id,
						gateData: gateData.data,
					});
				}
			);
		},

		// ── MCP server configuration ──────────────────────────────────────────

		async add_mcp_server(args: {
			name: string;
			source_type: string;
			description?: string;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			url?: string;
			headers?: Record<string, string>;
			enabled?: boolean;
		}): Promise<ToolResult> {
			if (!mcpManager) {
				return errorResult('MCP manager not available');
			}
			// Reject well-known sensitive env vars to prevent credential injection.
			// Raw secret values must never be stored in the MCP registry — they
			// should be pre-set in the host process environment and referenced by key.
			if (args.env) {
				const rejected = Object.keys(args.env).filter((k) => SENSITIVE_ENV_VARS.has(k));
				if (rejected.length > 0) {
					return errorResult(
						`Refusing to store sensitive env var(s): ${rejected.join(', ')}. ` +
							'Set these in the host environment instead; the MCP process inherits them automatically.'
					);
				}
			}
			return withSecurityCheck(
				'add_mcp_server',
				args as Record<string, unknown>,
				config,
				async () => {
					try {
						const server = mcpManager.createMcpServer({
							name: args.name,
							sourceType: args.source_type as AppMcpServerSourceType,
							description: args.description,
							command: args.command,
							args: args.args,
							env: args.env,
							url: args.url,
							headers: args.headers,
							enabled: args.enabled,
						});
						return successResult({ server });
					} catch (err) {
						return errorResult(err instanceof Error ? err.message : String(err));
					}
				}
			);
		},

		async update_mcp_server(args: {
			server_id: string;
			name?: string;
			description?: string;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			url?: string;
			headers?: Record<string, string>;
		}): Promise<ToolResult> {
			// Note: `source_type` is intentionally omitted from update params — it is
			// immutable after creation (similar to skill.name).  To change transport
			// type, delete and re-create the entry.
			if (!mcpManager) {
				return errorResult('MCP manager not available');
			}

			const hasUpdates =
				args.name !== undefined ||
				args.description !== undefined ||
				args.command !== undefined ||
				args.args !== undefined ||
				args.env !== undefined ||
				args.url !== undefined ||
				args.headers !== undefined;
			if (!hasUpdates) {
				return errorResult('No update fields provided');
			}

			if (args.env) {
				const rejected = Object.keys(args.env).filter((k) => SENSITIVE_ENV_VARS.has(k));
				if (rejected.length > 0) {
					return errorResult(
						`Refusing to store sensitive env var(s): ${rejected.join(', ')}. Use a secrets manager or set them in the process environment instead.`
					);
				}
			}

			return withSecurityCheck(
				'update_mcp_server',
				args as Record<string, unknown>,
				config,
				async () => {
					try {
						const server = mcpManager.updateMcpServer(args.server_id, {
							name: args.name,
							description: args.description,
							command: args.command,
							args: args.args,
							env: args.env,
							url: args.url,
							headers: args.headers,
						});
						if (!server) {
							return errorResult(`MCP server not found: ${args.server_id}`);
						}
						return successResult({ server });
					} catch (err) {
						return errorResult(err instanceof Error ? err.message : String(err));
					}
				}
			);
		},

		async delete_mcp_server(args: { server_id: string }): Promise<ToolResult> {
			if (!mcpManager) {
				return errorResult('MCP manager not available');
			}
			return withSecurityCheck(
				'delete_mcp_server',
				args as Record<string, unknown>,
				config,
				async () => {
					const server = mcpManager.getMcpServer(args.server_id);
					if (!server) {
						return errorResult(`MCP server not found: ${args.server_id}`);
					}
					const deleted = mcpManager.deleteMcpServer(args.server_id);
					if (!deleted) {
						return errorResult(`Failed to delete MCP server: ${args.server_id}`);
					}
					return successResult({ serverId: args.server_id });
				}
			);
		},

		async toggle_mcp_server(args: { server_id: string; enabled: boolean }): Promise<ToolResult> {
			if (!mcpManager) {
				return errorResult('MCP manager not available');
			}
			return withSecurityCheck(
				'toggle_mcp_server',
				args as Record<string, unknown>,
				config,
				async () => {
					const server = mcpManager.updateMcpServer(args.server_id, {
						enabled: args.enabled,
					});
					if (!server) {
						return errorResult(`MCP server not found: ${args.server_id}`);
					}
					return successResult({ server });
				}
			);
		},

		// ── Skill configuration ───────────────────────────────────────────────

		async add_skill(args: {
			name: string;
			display_name: string;
			description: string;
			source_type: string;
			config: Record<string, unknown>;
			enabled?: boolean;
		}): Promise<ToolResult> {
			if (!skillsManager) {
				return errorResult('Skills manager not available');
			}
			return withSecurityCheck('add_skill', args as Record<string, unknown>, config, async () => {
				try {
					const skill = skillsManager.addSkill({
						name: args.name,
						displayName: args.display_name,
						description: args.description,
						sourceType: args.source_type as SkillSourceType,
						config: args.config as unknown as AppSkillConfig,
						enabled: args.enabled,
					});
					return successResult({ skill });
				} catch (err) {
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			});
		},

		async update_skill(args: {
			skill_id: string;
			display_name?: string;
			description?: string;
			config?: Record<string, unknown>;
		}): Promise<ToolResult> {
			if (!skillsManager) {
				return errorResult('Skills manager not available');
			}

			const hasUpdates =
				args.display_name !== undefined ||
				args.description !== undefined ||
				args.config !== undefined;
			if (!hasUpdates) {
				return errorResult('No update fields provided');
			}

			return withSecurityCheck(
				'update_skill',
				args as Record<string, unknown>,
				config,
				async () => {
					try {
						const existing = skillsManager.getSkill(args.skill_id);
						if (!existing) {
							return errorResult(`Skill not found: ${args.skill_id}`);
						}
						const skill = skillsManager.updateSkill(args.skill_id, {
							displayName: args.display_name,
							description: args.description,
							config: args.config as unknown as AppSkillConfig | undefined,
						});
						return successResult({ skill });
					} catch (err) {
						return errorResult(err instanceof Error ? err.message : String(err));
					}
				}
			);
		},

		async delete_skill(args: { skill_id: string }): Promise<ToolResult> {
			if (!skillsManager) {
				return errorResult('Skills manager not available');
			}
			return withSecurityCheck(
				'delete_skill',
				args as Record<string, unknown>,
				config,
				async () => {
					const existing = skillsManager.getSkill(args.skill_id);
					if (!existing) {
						return errorResult(`Skill not found: ${args.skill_id}`);
					}
					if (existing.builtIn) {
						return errorResult(
							`Cannot delete built-in skill "${existing.name}". Use toggle_skill to disable it instead.`
						);
					}
					const deleted = skillsManager.removeSkill(args.skill_id);
					if (!deleted) {
						return errorResult(`Failed to delete skill: ${args.skill_id}`);
					}
					return successResult({ skillId: args.skill_id });
				}
			);
		},

		async toggle_skill(args: { skill_id: string; enabled: boolean }): Promise<ToolResult> {
			if (!skillsManager) {
				return errorResult('Skills manager not available');
			}
			return withSecurityCheck(
				'toggle_skill',
				args as Record<string, unknown>,
				config,
				async () => {
					try {
						const skill = skillsManager.setSkillEnabled(args.skill_id, args.enabled);
						return successResult({ skill });
					} catch (err) {
						return errorResult(err instanceof Error ? err.message : String(err));
					}
				}
			);
		},

		// ── App settings ──────────────────────────────────────────────────────

		async update_app_settings(args: {
			model?: string;
			thinking_level?: string;
			auto_scroll?: boolean;
			max_concurrent_workers?: number;
		}): Promise<ToolResult> {
			if (!settingsManager) {
				return errorResult('Settings manager not available');
			}

			const hasUpdates =
				args.model !== undefined ||
				args.thinking_level !== undefined ||
				args.auto_scroll !== undefined ||
				args.max_concurrent_workers !== undefined;
			if (!hasUpdates) {
				return errorResult('No update fields provided');
			}

			return withSecurityCheck(
				'update_app_settings',
				args as Record<string, unknown>,
				config,
				async () => {
					const updates: Partial<GlobalSettings> = {};
					if (args.model !== undefined) updates.model = args.model;
					if (args.thinking_level !== undefined)
						updates.thinkingLevel = args.thinking_level as GlobalSettings['thinkingLevel'];
					if (args.auto_scroll !== undefined) updates.autoScroll = args.auto_scroll;
					if (args.max_concurrent_workers !== undefined)
						updates.maxConcurrentWorkers = args.max_concurrent_workers;
					const settings = settingsManager.updateGlobalSettings(updates);
					return successResult({ settings });
				}
			);
		},

		// ── Gate ──────────────────────────────────────────────────────────────

		async reject_gate(args: {
			run_id: string;
			gate_id: string;
			reason?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck('reject_gate', args as Record<string, unknown>, config, async () => {
				if (!workflowRunRepo || !gateDataRepo) {
					return errorResult('Gate operations are not available');
				}

				const run = workflowRunRepo.getRun(args.run_id);
				if (!run) {
					return errorResult(`Workflow run not found: ${args.run_id}`);
				}
				if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
					return errorResult(`Cannot reject gate on a ${run.status} workflow run`);
				}

				// Idempotent: already rejected
				const existing = gateDataRepo.get(args.run_id, args.gate_id);
				if (existing?.data?.approved === false) {
					return successResult({
						runId: args.run_id,
						gateId: args.gate_id,
						gateData: existing.data,
					});
				}

				const gateData = gateDataRepo.merge(args.run_id, args.gate_id, {
					approved: false,
					rejectedAt: Date.now(),
					reason: args.reason ?? null,
					approvalSource: 'agent',
				});

				if (run.status !== 'blocked') {
					workflowRunRepo.transitionStatus(args.run_id, 'blocked');
				}
				const updatedRun =
					workflowRunRepo.updateRun(args.run_id, { failureReason: 'humanRejected' }) ?? run;

				await onWorkflowRunUpdated?.(run.spaceId, run.id, updatedRun);
				await onGateDataUpdated?.(run.spaceId, run.id, args.gate_id, gateData.data);

				return successResult({
					runId: args.run_id,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			});
		},

		// ── Undo ─────────────────────────────────────────────────────────────

		async undo_last_action(): Promise<ToolResult> {
			const activityLogger = config.activityLogger;
			if (!activityLogger) {
				return errorResult(
					'Activity logging is not available — undo requires activity logging to be enabled'
				);
			}

			return withSecurityCheck('undo_last_action', {}, config, async () => {
				const entry = activityLogger.getLatestUndoable();
				if (!entry) {
					return errorResult('Nothing to undo — no undoable actions in the activity log');
				}

				let undoData: Record<string, unknown>;
				try {
					undoData = JSON.parse(entry.undoData ?? '{}') as Record<string, unknown>;
				} catch {
					return errorResult(`Undo data is corrupt for action: ${entry.toolName}`);
				}

				// Execute the reverse operation
				let message: string;
				try {
					message = await executeUndo(entry.toolName, undoData);
				} catch (err) {
					return errorResult(
						`Undo failed for ${entry.toolName}: ${err instanceof Error ? err.message : String(err)}`
					);
				}

				// Mark original entry as no longer undoable (prevents double-undo)
				activityLogger.markUndone(entry.id);

				return successResult({
					undoneActionId: entry.id,
					undoneToolName: entry.toolName,
					message,
				});
			});
		},
	};

	// ---------------------------------------------------------------------------
	// Internal undo dispatch
	// ---------------------------------------------------------------------------

	async function executeUndo(toolName: string, undoData: Record<string, unknown>): Promise<string> {
		switch (toolName) {
			case 'toggle_skill': {
				const skillId = undoData.skillId as string | undefined;
				const previousEnabled = undoData.previousEnabled as boolean | undefined;
				if (!skillId || previousEnabled === undefined)
					throw new Error('Missing skillId or previousEnabled in undo data');
				if (!skillsManager) throw new Error('Skills manager not available for undo');
				const skill = skillsManager.getSkill(skillId);
				if (!skill) throw new Error(`Skill ${skillId} no longer exists`);
				skillsManager.setSkillEnabled(skillId, previousEnabled);
				return `Restored skill ${skillId} enabled state to: ${previousEnabled}`;
			}

			case 'toggle_mcp_server': {
				const serverId = undoData.serverId as string | undefined;
				const previousServerEnabled = undoData.previousEnabled as boolean | undefined;
				if (!serverId || previousServerEnabled === undefined)
					throw new Error('Missing serverId or previousEnabled in undo data');
				if (!mcpManager) throw new Error('MCP manager not available for undo');
				const server = mcpManager.getMcpServer(serverId);
				if (!server) throw new Error(`MCP server ${serverId} no longer exists`);
				const restoredServer = mcpManager.updateMcpServer(serverId, {
					enabled: previousServerEnabled,
				});
				if (!restoredServer)
					throw new Error(`Failed to restore MCP server ${serverId} — it may have been deleted`);
				return `Restored MCP server ${serverId} enabled state to: ${previousServerEnabled}`;
			}

			case 'update_app_settings': {
				const previousSettings = undoData.previousSettings as Record<string, unknown> | undefined;
				if (!previousSettings) throw new Error('Missing previousSettings in undo data');
				if (!settingsManager) throw new Error('Settings manager not available for undo');
				const settingsUpdates: Partial<GlobalSettings> = {};
				if ('model' in previousSettings) settingsUpdates.model = previousSettings.model as string;
				if ('thinkingLevel' in previousSettings)
					settingsUpdates.thinkingLevel =
						previousSettings.thinkingLevel as GlobalSettings['thinkingLevel'];
				if ('autoScroll' in previousSettings)
					settingsUpdates.autoScroll = previousSettings.autoScroll as boolean;
				if ('maxConcurrentWorkers' in previousSettings)
					settingsUpdates.maxConcurrentWorkers = previousSettings.maxConcurrentWorkers as number;
				settingsManager.updateGlobalSettings(settingsUpdates);
				return 'Restored previous app settings';
			}

			default:
				throw new Error(`No undo handler for tool: ${toolName}`);
		}
	}
}

// ---------------------------------------------------------------------------
// MCP server wrapper
// ---------------------------------------------------------------------------

/**
 * Options for the per-tool activity logging wrapper inside createNeoActionMcpServer.
 *
 * Non-undoable tools: only toolName + args needed (targetType/Id optional).
 * Undoable tools additionally supply preCapture (for update ops) or postCapture
 * (for create ops) to record undo data alongside the log entry.
 */
interface LoggingOpts {
	/** Entity category for the activity feed (e.g. 'room', 'goal', 'skill'). */
	targetType?: string;
	/**
	 * Extract the target entity ID from the tool args and/or result data.
	 * args: raw tool arguments; data: parsed JSON result object.
	 */
	getTargetId?: (args: Record<string, unknown>, data: Record<string, unknown>) => string | null;
	/**
	 * Whether a successful execution of this tool can be reversed via
	 * `undo_last_action`.  Set to true only for tools in the undoable list.
	 */
	undoable?: boolean;
	/**
	 * Async function run BEFORE the handler executes.
	 * Used to capture the entity's current state so the undo step knows what to
	 * restore (e.g. previous enabled flag, previous status, previous settings).
	 * Return null if the entity cannot be found (undo becomes unavailable).
	 */
	preCapture?: () => Promise<Record<string, unknown> | null>;
	/**
	 * Synchronous function run AFTER the handler executes (only when successful).
	 * Used for create operations to extract the new entity ID from the result.
	 * Return null when undo data is unavailable (e.g. entity not in result).
	 */
	postCapture?: (data: Record<string, unknown>) => Record<string, unknown> | null;
}

export function createNeoActionMcpServer(config: NeoActionToolsConfig) {
	const handlers = createNeoActionToolHandlers(config);
	const activityLogger = config.activityLogger;

	// ── Activity logging helpers ──────────────────────────────────────────────

	/** Parse the JSON payload out of a ToolResult without throwing. */
	function parseResultData(result: ToolResult): Record<string, unknown> {
		try {
			return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	/**
	 * Wrap a tool callback with pre/post activity logging.
	 *
	 * The logger is only invoked when:
	 * 1. `activityLogger` is set on the config (no-op otherwise).
	 * 2. The result is NOT a `confirmationRequired` response (deferred actions
	 *    are not yet executed — nothing to log until they are confirmed).
	 *
	 * Undo data is captured in two phases:
	 * - Pre-capture: runs before execution, reads current entity state.
	 * - Post-capture: runs after execution, extracts the created entity ID.
	 * Exactly one of these should be set for undoable tools.
	 */
	async function logged(
		toolName: string,
		args: Record<string, unknown>,
		fn: () => Promise<ToolResult>,
		opts: LoggingOpts = {}
	): Promise<ToolResult> {
		if (!activityLogger) return fn();

		// preCapture is best-effort: a capture failure must never prevent the
		// tool from executing.
		let preUndoData: Record<string, unknown> | null = null;
		if (opts.undoable && opts.preCapture) {
			try {
				preUndoData = await opts.preCapture();
			} catch {
				// Swallow — proceed without undo data.
			}
		}

		let result: ToolResult;
		try {
			result = await fn();
		} catch (err) {
			// Tool handler threw — log the failure and re-throw so the MCP layer
			// can return an error response to the caller.
			activityLogger.logAction({
				toolName,
				input: args,
				output: null,
				status: 'error',
				error: err instanceof Error ? err.message : String(err),
				targetType: opts.targetType ?? null,
				targetId: null,
				undoable: false,
				undoData: undefined,
			});
			throw err;
		}

		const data = parseResultData(result);

		// Confirmation-required responses are pending — nothing has executed yet.
		if (data.confirmationRequired === true) return result;

		const isError = data.success === false;
		const targetId = opts.getTargetId ? opts.getTargetId(args, data) : null;
		const postUndoData =
			opts.undoable && !isError && opts.postCapture ? opts.postCapture(data) : null;
		const undoData = postUndoData ?? preUndoData;

		activityLogger.logAction({
			toolName,
			input: args,
			output: result.content[0]?.text ?? null,
			status: isError ? 'error' : 'success',
			error: isError ? ((data.error as string) ?? null) : null,
			targetType: opts.targetType ?? null,
			targetId,
			// Only mark as undoable when the action succeeded AND undo data was captured.
			undoable: (opts.undoable ?? false) && !isError && undoData !== null,
			undoData: undoData ?? undefined,
		});

		return result;
	}

	const tools = [
		// ── Space ─────────────────────────────────────────────────────────────
		tool(
			'create_space',
			'Create a new space with a name and workspace path. Low risk — auto-executes in balanced mode.',
			{
				name: z.string().describe('Name for the new space'),
				workspace_path: z.string().describe('Absolute path to the workspace directory'),
				description: z.string().optional().describe('Description of the space'),
				instructions: z
					.string()
					.optional()
					.describe('Instructions for agents working in this space'),
				autonomy_level: z
					.number()
					.int()
					.min(1)
					.max(5)
					.optional()
					.describe(
						'Autonomy level (1-5): 1 = fully supervised (all actions need approval), 2 = mostly supervised (routine actions auto-approved), 3 = balanced (default, judgment calls need approval), 4 = mostly autonomous (only high-risk actions need approval), 5 = fully autonomous (all actions auto-approved)'
					),
			},
			(args) =>
				logged(
					'create_space',
					args as Record<string, unknown>,
					() =>
						handlers.create_space({
							...args,
							autonomy_level: args.autonomy_level as SpaceAutonomyLevel | undefined,
						}),
					{ targetType: 'space' }
				)
		),

		tool(
			'update_space',
			'Update space metadata such as name, description, instructions, or autonomy level. Low risk — auto-executes in balanced mode.',
			{
				space_id: z.string().describe('ID of the space to update'),
				name: z.string().optional().describe('New name'),
				description: z.string().optional().describe('New description'),
				instructions: z.string().optional().describe('New instructions for agents'),
				background_context: z.string().optional().describe('New background context'),
				default_model: z.string().optional().describe('New default model ID'),
				autonomy_level: z
					.number()
					.int()
					.min(1)
					.max(5)
					.optional()
					.describe(
						'New autonomy level (1-5): 1 = fully supervised, 2 = mostly supervised, 3 = balanced, 4 = mostly autonomous, 5 = fully autonomous'
					),
			},
			(args) =>
				logged(
					'update_space',
					args as Record<string, unknown>,
					() =>
						handlers.update_space({
							...args,
							autonomy_level: args.autonomy_level as SpaceAutonomyLevel | undefined,
						}),
					{
						targetType: 'space',
						getTargetId: (a) => (a.space_id as string) ?? null,
					}
				)
		),

		tool(
			'delete_space',
			'Permanently delete a space and all its data. Medium risk — requires confirmation in balanced mode.',
			{
				space_id: z.string().describe('ID of the space to delete'),
			},
			// Non-undoable: data is permanently deleted, cannot reconstruct.
			(args) =>
				logged('delete_space', args as Record<string, unknown>, () => handlers.delete_space(args), {
					targetType: 'space',
					getTargetId: (a) => (a.space_id as string) ?? null,
				})
		),

		// ── Workflow ──────────────────────────────────────────────────────────
		tool(
			'start_workflow_run',
			'Begin a workflow run in a space. Low risk — auto-executes in balanced mode.',
			{
				space_id: z
					.string()
					.optional()
					.describe('Target space ID (defaults to the active space context)'),
				workflow_id: z.string().describe('ID of the workflow to run'),
				title: z.string().describe('Short title for this workflow run'),
				description: z.string().optional().describe('Description of the work'),
				goal_id: z.string().optional().describe('Goal/mission ID to associate with this run'),
			},
			// Non-undoable: creates cascading side effects (tasks, agent sessions).
			(args) =>
				logged(
					'start_workflow_run',
					args as Record<string, unknown>,
					() => handlers.start_workflow_run(args),
					{ targetType: 'workflow_run' }
				)
		),

		tool(
			'cancel_workflow_run',
			'Cancel an active workflow run and all its pending tasks. Medium risk — requires confirmation in balanced mode.',
			{
				run_id: z.string().describe('ID of the workflow run to cancel'),
			},
			// Non-undoable: cascading side effects cannot be cleanly reversed.
			(args) =>
				logged(
					'cancel_workflow_run',
					args as Record<string, unknown>,
					() => handlers.cancel_workflow_run(args),
					{
						targetType: 'workflow_run',
						getTargetId: (a) => (a.run_id as string) ?? null,
					}
				)
		),

		// ── Gate ──────────────────────────────────────────────────────────────
		tool(
			'approve_gate',
			'Approve a human-approval gate in a workflow run, allowing the workflow to proceed. Medium risk — requires confirmation in balanced mode.',
			{
				run_id: z.string().describe('ID of the workflow run'),
				gate_id: z.string().describe('ID of the gate to approve'),
				reason: z.string().optional().describe('Optional reason for the approval'),
			},
			// Non-undoable: gate decision may have triggered downstream workflow steps.
			(args) =>
				logged('approve_gate', args as Record<string, unknown>, () => handlers.approve_gate(args), {
					targetType: 'gate',
					getTargetId: (a) => (a.gate_id as string) ?? null,
				})
		),

		tool(
			'reject_gate',
			'Reject a human-approval gate in a workflow run, halting it for revision. Medium risk — requires confirmation in balanced mode.',
			{
				run_id: z.string().describe('ID of the workflow run'),
				gate_id: z.string().describe('ID of the gate to reject'),
				reason: z.string().optional().describe('Reason for the rejection'),
			},
			// Non-undoable: gate decision may have triggered downstream workflow steps.
			(args) =>
				logged('reject_gate', args as Record<string, unknown>, () => handlers.reject_gate(args), {
					targetType: 'gate',
					getTargetId: (a) => (a.gate_id as string) ?? null,
				})
		),

		// ── MCP server configuration ──────────────────────────────────────────
		tool(
			'add_mcp_server',
			'Register a new MCP server in the application registry. Medium risk — requires confirmation in balanced mode.',
			{
				name: z.string().describe('Unique name for the MCP server'),
				source_type: z
					.enum(['stdio', 'sse', 'http'])
					.describe('Transport type: stdio, sse, or http'),
				description: z.string().optional().describe('Description of what the server provides'),
				command: z.string().optional().describe('Executable command (stdio servers)'),
				args: z.array(z.string()).optional().describe('Command arguments (stdio servers)'),
				env: z
					.record(z.string(), z.string())
					.optional()
					.describe('Environment variable overrides (stdio servers)'),
				url: z.string().optional().describe('Server URL (sse or http servers)'),
				headers: z
					.record(z.string(), z.string())
					.optional()
					.describe('Additional HTTP headers (sse or http servers)'),
				enabled: z.boolean().optional().describe('Whether to enable immediately (default: false)'),
			},
			(args) =>
				logged(
					'add_mcp_server',
					args as Record<string, unknown>,
					() => handlers.add_mcp_server(args),
					{ targetType: 'mcp_server' }
				)
		),

		tool(
			'update_mcp_server',
			'Update an existing MCP server entry. Medium risk — requires confirmation in balanced mode.',
			{
				server_id: z.string().describe('ID of the MCP server to update'),
				name: z.string().optional().describe('New name for the server'),
				description: z.string().optional().describe('New description'),
				command: z.string().optional().describe('New command (stdio servers)'),
				args: z.array(z.string()).optional().describe('New command arguments (stdio servers)'),
				env: z
					.record(z.string(), z.string())
					.optional()
					.describe('New environment variables (stdio servers)'),
				url: z.string().optional().describe('New URL (sse or http servers)'),
				headers: z
					.record(z.string(), z.string())
					.optional()
					.describe('New headers (sse or http servers)'),
			},
			(args) =>
				logged(
					'update_mcp_server',
					args as Record<string, unknown>,
					() => handlers.update_mcp_server(args),
					{
						targetType: 'mcp_server',
						getTargetId: (a) => (a.server_id as string) ?? null,
					}
				)
		),

		tool(
			'delete_mcp_server',
			'Remove an MCP server from the registry. Medium risk — requires confirmation in balanced mode.',
			{
				server_id: z.string().describe('ID of the MCP server to delete'),
			},
			// Non-undoable: data is permanently deleted, cannot reconstruct.
			(args) =>
				logged(
					'delete_mcp_server',
					args as Record<string, unknown>,
					() => handlers.delete_mcp_server(args),
					{
						targetType: 'mcp_server',
						getTargetId: (a) => (a.server_id as string) ?? null,
					}
				)
		),

		tool(
			'toggle_mcp_server',
			'Enable or disable an MCP server globally. Low risk — auto-executes in balanced mode.',
			{
				server_id: z.string().describe('ID of the MCP server to toggle'),
				enabled: z.boolean().describe('Whether to enable or disable the server'),
			},
			(args) =>
				logged(
					'toggle_mcp_server',
					args as Record<string, unknown>,
					() => handlers.toggle_mcp_server(args),
					{
						targetType: 'mcp_server',
						getTargetId: (a) => (a.server_id as string) ?? null,
						undoable: true,
						// Capture the server's current enabled state BEFORE the toggle.
						preCapture: async () => {
							if (!config.mcpManager) return null;
							const server = config.mcpManager.getMcpServer(args.server_id);
							return server ? { serverId: server.id, previousEnabled: server.enabled } : null;
						},
					}
				)
		),

		// ── Skill configuration ───────────────────────────────────────────────
		tool(
			'add_skill',
			'Register a new skill in the application registry. Medium risk — requires confirmation in balanced mode.',
			{
				name: z
					.string()
					.describe(
						'Unique internal name (slug-style, e.g. "my-skill"). Immutable after creation.'
					),
				display_name: z.string().describe('Human-readable display name shown in the UI'),
				description: z.string().describe('Short description of what the skill does'),
				source_type: z
					.enum(['builtin', 'plugin', 'mcp_server'])
					.describe('Where the skill comes from'),
				config: z
					.record(z.string(), z.unknown())
					.describe(
						'Source-type-specific configuration (e.g. {"type":"plugin","pluginPath":"/path/to/plugin"})'
					),
				enabled: z.boolean().optional().describe('Whether to enable immediately (default: false)'),
			},
			(args) =>
				logged('add_skill', args as Record<string, unknown>, () => handlers.add_skill(args), {
					targetType: 'skill',
				})
		),

		tool(
			'update_skill',
			'Update an existing skill entry. Medium risk — requires confirmation in balanced mode.',
			{
				skill_id: z.string().describe('ID of the skill to update'),
				display_name: z.string().optional().describe('New human-readable display name'),
				description: z.string().optional().describe('New description'),
				config: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('New source-type-specific configuration'),
			},
			(args) =>
				logged('update_skill', args as Record<string, unknown>, () => handlers.update_skill(args), {
					targetType: 'skill',
					getTargetId: (a) => (a.skill_id as string) ?? null,
				})
		),

		tool(
			'delete_skill',
			'Remove a skill from the registry. Built-in skills cannot be deleted — use toggle_skill instead. Medium risk — requires confirmation in balanced mode.',
			{
				skill_id: z.string().describe('ID of the skill to delete'),
			},
			// Non-undoable: data is permanently deleted, cannot reconstruct.
			(args) =>
				logged('delete_skill', args as Record<string, unknown>, () => handlers.delete_skill(args), {
					targetType: 'skill',
					getTargetId: (a) => (a.skill_id as string) ?? null,
				})
		),

		tool(
			'toggle_skill',
			'Enable or disable a skill globally. Low risk — auto-executes in balanced mode.',
			{
				skill_id: z.string().describe('ID of the skill to toggle'),
				enabled: z.boolean().describe('Whether to enable or disable the skill'),
			},
			(args) =>
				logged('toggle_skill', args as Record<string, unknown>, () => handlers.toggle_skill(args), {
					targetType: 'skill',
					getTargetId: (a) => (a.skill_id as string) ?? null,
					undoable: true,
					// Capture the skill's current enabled state BEFORE the toggle.
					preCapture: async () => {
						if (!config.skillsManager) return null;
						const skill = config.skillsManager.getSkill(args.skill_id);
						return skill ? { skillId: skill.id, previousEnabled: skill.enabled } : null;
					},
				})
		),

		// ── App settings ──────────────────────────────────────────────────────
		tool(
			'update_app_settings',
			'Update global application settings such as model, thinking level, or max workers. Low risk — auto-executes in balanced mode.',
			{
				model: z
					.string()
					.optional()
					.describe('Default model ID for new sessions (e.g. "sonnet", "opus")'),
				thinking_level: z
					.enum(['none', 'low', 'medium', 'high'])
					.optional()
					.describe('Default thinking level for new sessions'),
				auto_scroll: z.boolean().optional().describe('Whether to auto-scroll chat to new messages'),
				max_concurrent_workers: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe('Maximum number of concurrent worker sessions per space agent'),
			},
			(args) =>
				logged(
					'update_app_settings',
					args as Record<string, unknown>,
					() => handlers.update_app_settings(args),
					{
						targetType: 'settings',
						undoable: true,
						// Capture only the settings fields being changed BEFORE the update.
						preCapture: async () => {
							if (!config.settingsManager) return null;
							const current = config.settingsManager.getGlobalSettings();
							const previous: Record<string, unknown> = {};
							if (args.model !== undefined) previous.model = current.model ?? null;
							if (args.thinking_level !== undefined)
								previous.thinkingLevel = current.thinkingLevel ?? null;
							if (args.auto_scroll !== undefined) previous.autoScroll = current.autoScroll ?? null;
							if (args.max_concurrent_workers !== undefined)
								previous.maxConcurrentWorkers = current.maxConcurrentWorkers ?? null;
							return Object.keys(previous).length > 0 ? { previousSettings: previous } : null;
						},
					}
				)
		),

		// ── Undo ─────────────────────────────────────────────────────────────
		tool(
			'undo_last_action',
			'Reverse the most recent undoable Neo action (e.g. undo a toggle, status change, settings update, or created entity). High risk — requires confirmation in balanced mode.',
			{},
			(_args) =>
				logged('undo_last_action', {}, () => handlers.undo_last_action(), {
					// targetType is null because it depends on the action being undone;
					// the relevant context is in the output JSON (undoneToolName).
					undoable: false,
				})
		),
	];

	return createSdkMcpServer({ name: 'neo-action', tools });
}
