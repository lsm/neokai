/**
 * Neo Action Tools - MCP tools for write operations
 *
 * Implements room, goal, task, space, workflow, configuration, and messaging
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
 *   Room operations
 *   - create_room
 *   - delete_room
 *   - update_room_settings
 *
 *   Goal operations
 *   - create_goal
 *   - update_goal
 *   - set_goal_status
 *
 *   Task operations
 *   - create_task
 *   - update_task
 *   - set_task_status
 *   - approve_task
 *   - reject_task
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
 *   Messaging & session control
 *   - send_message_to_room
 *   - send_message_to_task
 *   - stop_session
 *   - pause_schedule
 *   - resume_schedule
 *
 *   Undo
 *   - undo_last_action
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { NeoActivityLogger } from '../activity-logger';
import type {
	Room,
	RoomGoal,
	NeoTask,
	GoalStatus,
	TaskStatus,
	GoalPriority,
	TaskPriority,
	MissionType,
	AutonomyLevel,
	WorkspacePath,
	SpaceAutonomyLevel,
	AppMcpServer,
	AppMcpServerSourceType,
	AppSkill,
	AppSkillConfig,
	SkillSourceType,
	GlobalSettings,
} from '@neokai/shared';
import {
	ActionClassification,
	shouldAutoExecute,
	type NeoSecurityMode,
	type NeoActionResult,
	type PendingActionStore,
} from '../security-tier';

// ---------------------------------------------------------------------------
// Minimal dependency interfaces
// ---------------------------------------------------------------------------

export interface NeoActionRoomManager {
	createRoom(params: {
		name: string;
		background?: string;
		allowedPaths?: WorkspacePath[];
		defaultPath?: string;
		defaultModel?: string;
		allowedModels?: string[];
	}): Room;
	deleteRoom(id: string): boolean;
	getRoom(id: string): Room | null;
	/** Count of worker sessions currently assigned to a room */
	getActiveSessionCount?(roomId: string): number;
	updateRoom(
		id: string,
		params: {
			name?: string;
			background?: string | null;
			instructions?: string | null;
			defaultModel?: string | null;
			allowedModels?: string[];
			allowedPaths?: WorkspacePath[];
			defaultPath?: string | null;
		}
	): Room | null;
}

export interface NeoActionGoalManager {
	createGoal(params: {
		title: string;
		description?: string;
		priority?: GoalPriority;
		missionType?: MissionType;
		autonomyLevel?: AutonomyLevel;
	}): Promise<RoomGoal>;
	getGoal(id: string): Promise<RoomGoal | null>;
	patchGoal(
		id: string,
		patch: {
			title?: string;
			description?: string;
			priority?: GoalPriority;
			missionType?: MissionType;
			autonomyLevel?: AutonomyLevel;
		}
	): Promise<RoomGoal>;
	updateGoalStatus(
		id: string,
		status: GoalStatus,
		updates?: { schedulePaused?: boolean }
	): Promise<RoomGoal>;
	/** Hard-delete a goal by ID. Used by undo of create_goal. */
	deleteGoal?(id: string): Promise<boolean>;
}

export interface NeoActionTaskManager {
	createTask(params: {
		title: string;
		description: string;
		priority?: TaskPriority;
		dependsOn?: string[];
		status?: TaskStatus;
	}): Promise<NeoTask>;
	getTask(id: string): Promise<NeoTask | null>;
	updateTaskFields(
		id: string,
		updates: {
			title?: string;
			description?: string;
			priority?: TaskPriority;
			dependsOn?: string[];
		}
	): Promise<NeoTask>;
	setTaskStatus(
		id: string,
		status: TaskStatus,
		opts?: { result?: string; error?: string }
	): Promise<NeoTask>;
	/** Hard-delete a task by ID. Used by undo of create_task. */
	deleteTask?(id: string): Promise<boolean>;
}

/** Optional runtime — if not provided, approve/reject fallback gracefully */
export interface NeoActionRuntime {
	resumeWorkerFromHuman(
		taskId: string,
		message: string,
		opts: { approved: boolean }
	): Promise<boolean>;
	interruptTaskSession(taskId: string): Promise<{ success: boolean }>;
}

export interface NeoActionRuntimeService {
	getRuntime(roomId: string): NeoActionRuntime | null;
}

/** Factory that returns managers scoped to a given room ID */
export interface NeoActionManagerFactory {
	getGoalManager(roomId: string): NeoActionGoalManager;
	getTaskManager(roomId: string): NeoActionTaskManager;
}

// ---------------------------------------------------------------------------
// Space / Workflow interfaces (delegated to global-spaces handler layer)
// ---------------------------------------------------------------------------

/** Minimal ToolResult shape shared with global-spaces handlers. */
interface SharedToolResult {
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
	 * Used by send_message_to_room and send_message_to_task.
	 */
	injectMessage(sessionId: string, message: string): Promise<void>;
	/**
	 * Find the active session ID for a room. Returns the first active session
	 * or null if there are none.
	 */
	getActiveSessionForRoom(roomId: string): string | null;
	/**
	 * Find the active worker session ID for a task. Returns null if not found.
	 */
	getActiveSessionForTask(taskId: string): string | null;
}

export interface NeoActionToolsConfig {
	roomManager: NeoActionRoomManager;
	managerFactory: NeoActionManagerFactory;
	runtimeService?: NeoActionRuntimeService;
	pendingStore: PendingActionStore;
	/** Workspace root — auto-applied as allowedPaths when not provided */
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
	'BRAVE_API_KEY',
	'COPILOT_GITHUB_TOKEN',
	'GITHUB_TOKEN',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
]);

/**
 * Approval message sent to the worker agent when a task is approved.
 * The worker is expected to merge the PR as its final step.
 */
const APPROVE_TASK_MESSAGE =
	'Human has approved the PR. Merge it now by running `gh pr merge` (do NOT use --delete-branch). After the merge completes, your work is done.';

interface ToolResult {
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
		roomManager,
		managerFactory,
		runtimeService,
		workspaceRoot,
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
		sessionManager,
	} = config;

	return {
		// ── Room ──────────────────────────────────────────────────────────────

		async create_room(args: {
			name: string;
			description?: string;
			workspace_path?: string;
			default_model?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck('create_room', args as Record<string, unknown>, config, async () => {
				const allowedPaths: WorkspacePath[] = args.workspace_path
					? [{ path: args.workspace_path }]
					: workspaceRoot
						? [{ path: workspaceRoot }]
						: [];
				const defaultPath = args.workspace_path ?? workspaceRoot;

				const room = roomManager.createRoom({
					name: args.name,
					background: args.description,
					allowedPaths,
					defaultPath,
					defaultModel: args.default_model,
				});

				return successResult({ room });
			});
		},

		async delete_room(args: { room_id: string }): Promise<ToolResult> {
			// If the room has active sessions, escalate to high risk.
			// ActionClassification maps `delete_room` (medium) and
			// `delete_room_with_active_tasks` (high) separately — pick the right key.
			const activeSessions = roomManager.getActiveSessionCount?.(args.room_id) ?? 0;
			const toolName = activeSessions > 0 ? 'delete_room_with_active_tasks' : 'delete_room';

			return withSecurityCheck(toolName, args as Record<string, unknown>, config, async () => {
				const room = roomManager.getRoom(args.room_id);
				if (!room) {
					return errorResult(`Room not found: ${args.room_id}`);
				}
				const deleted = roomManager.deleteRoom(args.room_id);
				if (!deleted) {
					return errorResult(`Failed to delete room: ${args.room_id}`);
				}
				return successResult({ roomId: args.room_id });
			});
		},

		async update_room_settings(args: {
			room_id: string;
			name?: string;
			description?: string;
			instructions?: string;
			default_model?: string;
			allowed_models?: string[];
		}): Promise<ToolResult> {
			// Guard: require at least one field beyond room_id
			const hasUpdates =
				args.name !== undefined ||
				args.description !== undefined ||
				args.instructions !== undefined ||
				args.default_model !== undefined ||
				args.allowed_models !== undefined;
			if (!hasUpdates) {
				return errorResult('No update fields provided');
			}

			return withSecurityCheck(
				'update_room_settings',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					const updated = roomManager.updateRoom(args.room_id, {
						name: args.name,
						background: args.description,
						instructions: args.instructions,
						defaultModel: args.default_model,
						allowedModels: args.allowed_models,
					});

					if (!updated) {
						return errorResult(`Failed to update room: ${args.room_id}`);
					}

					return successResult({ room: updated });
				}
			);
		},

		// ── Goal ─────────────────────────────────────────────────────────────

		async create_goal(args: {
			room_id: string;
			title: string;
			description?: string;
			priority?: string;
			mission_type?: string;
			autonomy_level?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck('create_goal', args as Record<string, unknown>, config, async () => {
				const room = roomManager.getRoom(args.room_id);
				if (!room) {
					return errorResult(`Room not found: ${args.room_id}`);
				}

				const goalManager = managerFactory.getGoalManager(args.room_id);
				const goal = await goalManager.createGoal({
					title: args.title,
					description: args.description,
					priority: args.priority as GoalPriority | undefined,
					missionType: args.mission_type as MissionType | undefined,
					autonomyLevel: args.autonomy_level as AutonomyLevel | undefined,
				});

				return successResult({ goal });
			});
		},

		async update_goal(args: {
			room_id: string;
			goal_id: string;
			title?: string;
			description?: string;
			priority?: string;
			mission_type?: string;
			autonomy_level?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck('update_goal', args as Record<string, unknown>, config, async () => {
				const room = roomManager.getRoom(args.room_id);
				if (!room) {
					return errorResult(`Room not found: ${args.room_id}`);
				}

				const goalManager = managerFactory.getGoalManager(args.room_id);
				const existing = await goalManager.getGoal(args.goal_id);
				if (!existing) {
					return errorResult(`Goal not found: ${args.goal_id}`);
				}

				const patch: Record<string, unknown> = {};
				if (args.title !== undefined) patch.title = args.title;
				if (args.description !== undefined) patch.description = args.description;
				if (args.priority !== undefined) patch.priority = args.priority as GoalPriority;
				if (args.mission_type !== undefined) patch.missionType = args.mission_type as MissionType;
				if (args.autonomy_level !== undefined)
					patch.autonomyLevel = args.autonomy_level as AutonomyLevel;

				if (Object.keys(patch).length === 0) {
					return errorResult('No update fields provided');
				}

				const goal = await goalManager.patchGoal(args.goal_id, patch);
				return successResult({ goal });
			});
		},

		async set_goal_status(args: {
			room_id: string;
			goal_id: string;
			status: string;
		}): Promise<ToolResult> {
			return withSecurityCheck(
				'set_goal_status',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					const goalManager = managerFactory.getGoalManager(args.room_id);
					const existing = await goalManager.getGoal(args.goal_id);
					if (!existing) {
						return errorResult(`Goal not found: ${args.goal_id}`);
					}

					const goal = await goalManager.updateGoalStatus(args.goal_id, args.status as GoalStatus);
					return successResult({ goal });
				}
			);
		},

		// ── Task ─────────────────────────────────────────────────────────────

		async create_task(args: {
			room_id: string;
			title: string;
			description: string;
			priority?: string;
			depends_on?: string[];
		}): Promise<ToolResult> {
			return withSecurityCheck('create_task', args as Record<string, unknown>, config, async () => {
				const room = roomManager.getRoom(args.room_id);
				if (!room) {
					return errorResult(`Room not found: ${args.room_id}`);
				}

				const taskManager = managerFactory.getTaskManager(args.room_id);
				const task = await taskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority as TaskPriority | undefined,
					dependsOn: args.depends_on,
				});

				return successResult({ task });
			});
		},

		async update_task(args: {
			room_id: string;
			task_id: string;
			title?: string;
			description?: string;
			priority?: string;
			depends_on?: string[];
		}): Promise<ToolResult> {
			return withSecurityCheck('update_task', args as Record<string, unknown>, config, async () => {
				const room = roomManager.getRoom(args.room_id);
				if (!room) {
					return errorResult(`Room not found: ${args.room_id}`);
				}

				const taskManager = managerFactory.getTaskManager(args.room_id);
				const existing = await taskManager.getTask(args.task_id);
				if (!existing) {
					return errorResult(`Task not found: ${args.task_id}`);
				}

				const updates: {
					title?: string;
					description?: string;
					priority?: TaskPriority;
					dependsOn?: string[];
				} = {};
				if (args.title !== undefined) updates.title = args.title;
				if (args.description !== undefined) updates.description = args.description;
				if (args.priority !== undefined) updates.priority = args.priority as TaskPriority;
				if (args.depends_on !== undefined) updates.dependsOn = args.depends_on;

				if (Object.keys(updates).length === 0) {
					return errorResult('No update fields provided');
				}

				const task = await taskManager.updateTaskFields(args.task_id, updates);
				return successResult({ task });
			});
		},

		async set_task_status(args: {
			room_id: string;
			task_id: string;
			status: string;
			result?: string;
			error?: string;
		}): Promise<ToolResult> {
			return withSecurityCheck(
				'set_task_status',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					const taskManager = managerFactory.getTaskManager(args.room_id);
					const existing = await taskManager.getTask(args.task_id);
					if (!existing) {
						return errorResult(`Task not found: ${args.task_id}`);
					}

					const task = await taskManager.setTaskStatus(args.task_id, args.status as TaskStatus, {
						result: args.result,
						error: args.error,
					});
					return successResult({ task });
				}
			);
		},

		async approve_task(args: { room_id: string; task_id: string }): Promise<ToolResult> {
			return withSecurityCheck(
				'approve_task',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					if (!runtimeService) {
						return errorResult('Runtime service not available');
					}

					const runtime = runtimeService.getRuntime(args.room_id);
					if (!runtime) {
						return errorResult(`No runtime found for room: ${args.room_id}`);
					}

					const taskManager = managerFactory.getTaskManager(args.room_id);
					const task = await taskManager.getTask(args.task_id);
					if (!task) {
						return errorResult(`Task not found: ${args.task_id}`);
					}
					// Explicit pre-check: gives a clear error before we hit resumeWorkerFromHuman,
					// which would return false with a less specific "no group found" message.
					if (task.status !== 'review') {
						return errorResult(`Task is not in review status (current: ${task.status})`);
					}

					const resumed = await runtime.resumeWorkerFromHuman(args.task_id, APPROVE_TASK_MESSAGE, {
						approved: true,
					});

					if (!resumed) {
						return errorResult(
							`Failed to approve task ${args.task_id} — no submitted-for-review group found`
						);
					}

					return successResult({ taskId: args.task_id });
				}
			);
		},

		async reject_task(args: {
			room_id: string;
			task_id: string;
			feedback: string;
		}): Promise<ToolResult> {
			// Validate feedback before the security check to avoid storing a pending action
			// with empty feedback that would produce a useless rejection message.
			if (!args.feedback?.trim()) {
				return errorResult('Feedback is required for task rejection');
			}

			return withSecurityCheck('reject_task', args as Record<string, unknown>, config, async () => {
				const room = roomManager.getRoom(args.room_id);
				if (!room) {
					return errorResult(`Room not found: ${args.room_id}`);
				}

				if (!runtimeService) {
					return errorResult('Runtime service not available');
				}

				const runtime = runtimeService.getRuntime(args.room_id);
				if (!runtime) {
					return errorResult(`No runtime found for room: ${args.room_id}`);
				}

				const taskManager = managerFactory.getTaskManager(args.room_id);
				const task = await taskManager.getTask(args.task_id);
				if (!task) {
					return errorResult(`Task not found: ${args.task_id}`);
				}
				// Explicit pre-check: gives a clear error before we hit resumeWorkerFromHuman,
				// which would return false with a less specific "no group found" message.
				if (task.status !== 'review') {
					return errorResult(`Task is not in review status (current: ${task.status})`);
				}

				const message = `[Human Rejection]\n\n${args.feedback.trim()}`;
				const resumed = await runtime.resumeWorkerFromHuman(args.task_id, message, {
					approved: false,
				});

				if (!resumed) {
					return errorResult(
						`Failed to reject task ${args.task_id} — no submitted-for-review group found`
					);
				}

				return successResult({ taskId: args.task_id });
			});
		},

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
					if (run.status === 'completed') {
						return errorResult('Cannot cancel a completed workflow run');
					}

					// Cancel all pending/in_progress tasks for this run (best-effort)
					const taskManager = spaceTaskManagerFactory.getTaskManager(run.spaceId);
					const tasks = await taskManager.listTasksByWorkflowRun(run.id);
					for (const task of tasks) {
						if (task.status === 'pending' || task.status === 'in_progress') {
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
					if (
						run.status === 'completed' ||
						run.status === 'cancelled' ||
						run.status === 'pending'
					) {
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
					});

					// If previously rejected, transition back to in_progress and clear failure reason
					let currentRun = run;
					if (run.status === 'needs_attention' && run.failureReason === 'humanRejected') {
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

		// ── Messaging & session control ───────────────────────────────────────

		async send_message_to_room(args: { room_id: string; message: string }): Promise<ToolResult> {
			// Validate before the security check so we don't waste a pending action slot.
			if (!args.message?.trim()) {
				return errorResult('Message must not be empty');
			}
			if (!sessionManager) {
				return errorResult('Session manager not available');
			}
			return withSecurityCheck(
				'send_message_to_room',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}
					const sessionId = sessionManager.getActiveSessionForRoom(args.room_id);
					if (!sessionId) {
						return errorResult(`No active session found for room: ${args.room_id}`);
					}
					await sessionManager.injectMessage(sessionId, args.message);
					return successResult({ sessionId });
				}
			);
		},

		async send_message_to_task(args: {
			room_id: string;
			task_id: string;
			message: string;
		}): Promise<ToolResult> {
			// Validate before the security check so we don't waste a pending action slot.
			if (!args.message?.trim()) {
				return errorResult('Message must not be empty');
			}
			if (!sessionManager) {
				return errorResult('Session manager not available');
			}
			return withSecurityCheck(
				'send_message_to_task',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}
					const taskManager = managerFactory.getTaskManager(args.room_id);
					const task = await taskManager.getTask(args.task_id);
					if (!task) {
						return errorResult(`Task not found: ${args.task_id}`);
					}
					const sessionId = sessionManager.getActiveSessionForTask(args.task_id);
					if (!sessionId) {
						return errorResult(`No active session found for task: ${args.task_id}`);
					}
					await sessionManager.injectMessage(sessionId, args.message);
					return successResult({ sessionId });
				}
			);
		},

		async stop_session(args: { room_id: string; task_id: string }): Promise<ToolResult> {
			return withSecurityCheck(
				'stop_session',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					if (!runtimeService) {
						return errorResult('Runtime service not available');
					}
					const runtime = runtimeService.getRuntime(args.room_id);
					if (!runtime) {
						return errorResult(`No runtime found for room: ${args.room_id}`);
					}

					const taskManager = managerFactory.getTaskManager(args.room_id);
					const task = await taskManager.getTask(args.task_id);
					if (!task) {
						return errorResult(`Task not found: ${args.task_id}`);
					}

					if (task.status !== 'in_progress' && task.status !== 'review') {
						return errorResult(
							`Task cannot be interrupted (current status: ${task.status}). Only in_progress or review tasks can be interrupted.`
						);
					}

					const result = await runtime.interruptTaskSession(args.task_id);
					if (!result.success) {
						return errorResult(`Failed to interrupt session for task ${args.task_id}`);
					}

					return successResult({
						taskId: args.task_id,
						message: `Generation interrupted for task ${args.task_id}. Task remains active and awaiting input.`,
					});
				}
			);
		},

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
				if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'pending') {
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
				});

				if (run.status !== 'needs_attention') {
					workflowRunRepo.transitionStatus(args.run_id, 'needs_attention');
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

		async pause_schedule(args: { room_id: string; goal_id: string }): Promise<ToolResult> {
			return withSecurityCheck(
				'pause_schedule',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					const goalManager = managerFactory.getGoalManager(args.room_id);
					const goal = await goalManager.getGoal(args.goal_id);
					if (!goal) {
						return errorResult(`Goal not found: ${args.goal_id}`);
					}
					if (goal.missionType !== 'recurring') {
						return errorResult(`Goal ${args.goal_id} is not a recurring mission`);
					}

					if (goal.schedulePaused) {
						return successResult({ goal, alreadyPaused: true });
					}

					const updated = await goalManager.updateGoalStatus(args.goal_id, goal.status, {
						schedulePaused: true,
					});
					return successResult({ goal: updated });
				}
			);
		},

		async resume_schedule(args: { room_id: string; goal_id: string }): Promise<ToolResult> {
			return withSecurityCheck(
				'resume_schedule',
				args as Record<string, unknown>,
				config,
				async () => {
					const room = roomManager.getRoom(args.room_id);
					if (!room) {
						return errorResult(`Room not found: ${args.room_id}`);
					}

					const goalManager = managerFactory.getGoalManager(args.room_id);
					const goal = await goalManager.getGoal(args.goal_id);
					if (!goal) {
						return errorResult(`Goal not found: ${args.goal_id}`);
					}
					if (goal.missionType !== 'recurring') {
						return errorResult(`Goal ${args.goal_id} is not a recurring mission`);
					}
					if (!goal.schedule) {
						return errorResult(`Goal ${args.goal_id} has no schedule set. Set a schedule first.`);
					}

					if (!goal.schedulePaused) {
						return successResult({ goal, alreadyResumed: true });
					}

					const updated = await goalManager.updateGoalStatus(args.goal_id, goal.status, {
						schedulePaused: false,
					});
					return successResult({ goal: updated });
				}
			);
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
			case 'create_room': {
				const roomId = undoData.roomId as string | undefined;
				if (!roomId) throw new Error('Missing roomId in undo data');
				const room = roomManager.getRoom(roomId);
				if (!room) throw new Error(`Room ${roomId} no longer exists — already deleted`);
				roomManager.deleteRoom(roomId);
				return `Deleted room: ${roomId}`;
			}

			case 'update_room_settings': {
				const roomId = undoData.roomId as string | undefined;
				if (!roomId) throw new Error('Missing roomId in undo data');
				const room = roomManager.getRoom(roomId);
				if (!room) throw new Error(`Room ${roomId} no longer exists`);
				const updateParams: Parameters<typeof roomManager.updateRoom>[1] = {};
				if ('previousName' in undoData) updateParams.name = undoData.previousName as string;
				if ('previousBackground' in undoData)
					updateParams.background = undoData.previousBackground as string | null;
				if ('previousInstructions' in undoData)
					updateParams.instructions = undoData.previousInstructions as string | null;
				if ('previousDefaultModel' in undoData)
					updateParams.defaultModel = undoData.previousDefaultModel as string | null;
				if ('previousAllowedModels' in undoData)
					updateParams.allowedModels = undoData.previousAllowedModels as string[];
				const updated = roomManager.updateRoom(roomId, updateParams);
				if (!updated) throw new Error(`Failed to restore room ${roomId} settings`);
				return `Restored previous settings for room: ${roomId}`;
			}

			case 'create_goal': {
				const goalId = undoData.goalId as string | undefined;
				const goalRoomId = undoData.roomId as string | undefined;
				if (!goalId || !goalRoomId) throw new Error('Missing goalId or roomId in undo data');
				const goalManager = managerFactory.getGoalManager(goalRoomId);
				const goal = await goalManager.getGoal(goalId);
				if (!goal) throw new Error(`Goal ${goalId} no longer exists — already deleted`);
				if (goalManager.deleteGoal) {
					await goalManager.deleteGoal(goalId);
				} else {
					await goalManager.updateGoalStatus(goalId, 'archived');
				}
				return `Deleted goal: ${goalId}`;
			}

			case 'set_goal_status': {
				const goalId = undoData.goalId as string | undefined;
				const goalRoomId = undoData.roomId as string | undefined;
				const previousGoalStatus = undoData.previousStatus as GoalStatus | undefined;
				if (!goalId || !goalRoomId || !previousGoalStatus)
					throw new Error('Missing goalId, roomId, or previousStatus in undo data');
				const goalManager = managerFactory.getGoalManager(goalRoomId);
				const goal = await goalManager.getGoal(goalId);
				if (!goal) throw new Error(`Goal ${goalId} no longer exists`);
				await goalManager.updateGoalStatus(goalId, previousGoalStatus);
				return `Restored goal ${goalId} status to: ${previousGoalStatus}`;
			}

			case 'create_task': {
				const taskId = undoData.taskId as string | undefined;
				const taskRoomId = undoData.roomId as string | undefined;
				if (!taskId || !taskRoomId) throw new Error('Missing taskId or roomId in undo data');
				const taskManager = managerFactory.getTaskManager(taskRoomId);
				const task = await taskManager.getTask(taskId);
				if (!task) throw new Error(`Task ${taskId} no longer exists — already deleted`);
				if (taskManager.deleteTask) {
					await taskManager.deleteTask(taskId);
				} else {
					await taskManager.setTaskStatus(taskId, 'cancelled');
				}
				return `Deleted task: ${taskId}`;
			}

			case 'set_task_status': {
				const taskId = undoData.taskId as string | undefined;
				const taskRoomId = undoData.roomId as string | undefined;
				const previousTaskStatus = undoData.previousStatus as TaskStatus | undefined;
				if (!taskId || !taskRoomId || !previousTaskStatus)
					throw new Error('Missing taskId, roomId, or previousStatus in undo data');
				const taskManager = managerFactory.getTaskManager(taskRoomId);
				const task = await taskManager.getTask(taskId);
				if (!task) throw new Error(`Task ${taskId} no longer exists`);
				await taskManager.setTaskStatus(taskId, previousTaskStatus);
				return `Restored task ${taskId} status to: ${previousTaskStatus}`;
			}

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
				mcpManager.updateMcpServer(serverId, { enabled: previousServerEnabled });
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
		// ── Room ─────────────────────────────────────────────────────────────
		tool(
			'create_room',
			'Create a new room with an optional description and workspace path. Low risk — auto-executes in balanced mode.',
			{
				name: z.string().describe('Room name'),
				description: z.string().optional().describe('Background context for the room'),
				workspace_path: z
					.string()
					.optional()
					.describe('Absolute path to the workspace directory for this room'),
				default_model: z.string().optional().describe('Default model ID for new sessions'),
			},
			(args) =>
				logged('create_room', args as Record<string, unknown>, () => handlers.create_room(args), {
					targetType: 'room',
					getTargetId: (_, d) => ((d.room as Record<string, unknown>)?.id as string) ?? null,
					undoable: true,
					// Undo = delete the created room; capture its ID from the result.
					postCapture: (d) => {
						const id = (d.room as Record<string, unknown>)?.id as string | undefined;
						return id ? { roomId: id } : null;
					},
				})
		),

		tool(
			'delete_room',
			'Delete a room permanently. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room to delete'),
			},
			// Non-undoable: data is permanently deleted, cannot reconstruct.
			(args) =>
				logged('delete_room', args as Record<string, unknown>, () => handlers.delete_room(args), {
					targetType: 'room',
					getTargetId: (a) => (a.room_id as string) ?? null,
				})
		),

		tool(
			'update_room_settings',
			'Update room settings such as name, description, instructions, or default model. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room to update'),
				name: z.string().optional().describe('New room name'),
				description: z.string().optional().describe('New background context'),
				instructions: z.string().optional().describe('Custom instructions for the room agent'),
				default_model: z.string().optional().describe('Default model ID for new sessions'),
				allowed_models: z
					.array(z.string())
					.optional()
					.describe('Allowed model IDs (empty = all allowed)'),
			},
			(args) =>
				logged(
					'update_room_settings',
					args as Record<string, unknown>,
					() => handlers.update_room_settings(args),
					{
						targetType: 'room',
						getTargetId: (a) => (a.room_id as string) ?? null,
						undoable: true,
						// Capture the room's current settings BEFORE the update so we can restore them.
						preCapture: async () => {
							const room = config.roomManager.getRoom(args.room_id);
							if (!room) return null;
							return {
								roomId: room.id,
								previousName: room.name,
								previousBackground: room.background ?? null,
								previousInstructions: room.instructions ?? null,
								previousDefaultModel: room.defaultModel ?? null,
								previousAllowedModels: room.allowedModels ?? [],
							};
						},
					}
				)
		),

		// ── Goal ─────────────────────────────────────────────────────────────
		tool(
			'create_goal',
			'Create a new goal (mission) in the specified room. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room to create the goal in'),
				title: z.string().describe('Goal title'),
				description: z.string().optional().describe('Detailed goal description'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Goal priority (default: normal)'),
				mission_type: z
					.enum(['one_shot', 'measurable', 'recurring'])
					.optional()
					.describe('Mission type (default: one_shot)'),
				autonomy_level: z
					.enum(['supervised', 'semi_autonomous'])
					.optional()
					.describe('Autonomy level (default: supervised)'),
			},
			(args) =>
				logged('create_goal', args as Record<string, unknown>, () => handlers.create_goal(args), {
					targetType: 'goal',
					getTargetId: (_, d) => ((d.goal as Record<string, unknown>)?.id as string) ?? null,
					undoable: true,
					// Undo = delete the created goal; capture its ID + roomId from the result.
					postCapture: (d) => {
						const id = (d.goal as Record<string, unknown>)?.id as string | undefined;
						return id ? { goalId: id, roomId: args.room_id } : null;
					},
				})
		),

		tool(
			'update_goal',
			'Update goal fields such as title, description, priority, mission type, or autonomy level. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the goal'),
				goal_id: z.string().describe('ID of the goal to update'),
				title: z.string().optional().describe('New goal title'),
				description: z.string().optional().describe('New goal description'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
				mission_type: z
					.enum(['one_shot', 'measurable', 'recurring'])
					.optional()
					.describe('New mission type'),
				autonomy_level: z
					.enum(['supervised', 'semi_autonomous'])
					.optional()
					.describe('New autonomy level'),
			},
			(args) =>
				logged('update_goal', args as Record<string, unknown>, () => handlers.update_goal(args), {
					targetType: 'goal',
					getTargetId: (a) => (a.goal_id as string) ?? null,
				})
		),

		tool(
			'set_goal_status',
			'Transition a goal to a new status (active, completed, needs_human, archived). Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the goal'),
				goal_id: z.string().describe('ID of the goal'),
				status: z
					.enum(['active', 'completed', 'needs_human', 'archived'])
					.describe('New goal status'),
			},
			(args) =>
				logged(
					'set_goal_status',
					args as Record<string, unknown>,
					() => handlers.set_goal_status(args),
					{
						targetType: 'goal',
						getTargetId: (a) => (a.goal_id as string) ?? null,
						undoable: true,
						// Capture the goal's current status BEFORE transition.
						preCapture: async () => {
							const goalManager = config.managerFactory.getGoalManager(args.room_id);
							const goal = await goalManager.getGoal(args.goal_id);
							return goal
								? { goalId: goal.id, roomId: args.room_id, previousStatus: goal.status }
								: null;
						},
					}
				)
		),

		// ── Task ─────────────────────────────────────────────────────────────
		tool(
			'create_task',
			'Create a new task in the specified room. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room to create the task in'),
				title: z.string().describe('Task title'),
				description: z.string().describe('Detailed task description'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Task priority (default: normal)'),
				depends_on: z.array(z.string()).optional().describe('IDs of tasks this task depends on'),
			},
			(args) =>
				logged('create_task', args as Record<string, unknown>, () => handlers.create_task(args), {
					targetType: 'task',
					getTargetId: (_, d) => ((d.task as Record<string, unknown>)?.id as string) ?? null,
					undoable: true,
					// Undo = delete the created task; capture its ID + roomId from the result.
					postCapture: (d) => {
						const id = (d.task as Record<string, unknown>)?.id as string | undefined;
						return id ? { taskId: id, roomId: args.room_id } : null;
					},
				})
		),

		tool(
			'update_task',
			'Update task fields such as title, description, priority, or dependencies. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task to update'),
				title: z.string().optional().describe('New task title'),
				description: z.string().optional().describe('New task description'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
				depends_on: z.array(z.string()).optional().describe('New dependency task IDs'),
			},
			(args) =>
				logged('update_task', args as Record<string, unknown>, () => handlers.update_task(args), {
					targetType: 'task',
					getTargetId: (a) => (a.task_id as string) ?? null,
				})
		),

		tool(
			'set_task_status',
			'Transition a task to a new status. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task'),
				// `rate_limited` and `usage_limited` are intentionally excluded: those
				// statuses are set by the runtime in response to API errors and cannot
				// be meaningfully set by a human or agent action.
				status: z
					.enum([
						'draft',
						'pending',
						'in_progress',
						'review',
						'completed',
						'needs_attention',
						'cancelled',
						'archived',
					])
					.describe('New task status'),
				result: z.string().optional().describe('Result summary (for completed/review statuses)'),
				error: z.string().optional().describe('Error message (for needs_attention status)'),
			},
			(args) =>
				logged(
					'set_task_status',
					args as Record<string, unknown>,
					() => handlers.set_task_status(args),
					{
						targetType: 'task',
						getTargetId: (a) => (a.task_id as string) ?? null,
						undoable: true,
						// Capture the task's current status BEFORE transition.
						preCapture: async () => {
							const taskManager = config.managerFactory.getTaskManager(args.room_id);
							const task = await taskManager.getTask(args.task_id);
							return task
								? { taskId: task.id, roomId: args.room_id, previousStatus: task.status }
								: null;
						},
					}
				)
		),

		tool(
			'approve_task',
			'Approve a task PR that is currently in review status. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task to approve'),
			},
			// Non-undoable: task review decision may have triggered agent actions.
			(args) =>
				logged('approve_task', args as Record<string, unknown>, () => handlers.approve_task(args), {
					targetType: 'task',
					getTargetId: (a) => (a.task_id as string) ?? null,
				})
		),

		tool(
			'reject_task',
			'Reject a task PR that is currently in review status, providing feedback for revision. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task to reject'),
				feedback: z.string().describe('Feedback explaining why the task was rejected'),
			},
			// Non-undoable: task review decision may have triggered agent actions.
			(args) =>
				logged('reject_task', args as Record<string, unknown>, () => handlers.reject_task(args), {
					targetType: 'task',
					getTargetId: (a) => (a.task_id as string) ?? null,
				})
		),

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
					.enum(['supervised', 'semi_autonomous'])
					.optional()
					.describe(
						'Autonomy level: "supervised" (default) waits for human approval on judgment calls; "semi_autonomous" handles simple cases independently'
					),
			},
			(args) =>
				logged('create_space', args as Record<string, unknown>, () => handlers.create_space(args), {
					targetType: 'space',
				})
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
					.enum(['supervised', 'semi_autonomous'])
					.optional()
					.describe('New autonomy level'),
			},
			(args) =>
				logged('update_space', args as Record<string, unknown>, () => handlers.update_space(args), {
					targetType: 'space',
					getTargetId: (a) => (a.space_id as string) ?? null,
				})
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
					.describe('Maximum number of concurrent worker sessions per room agent'),
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

		// ── Messaging & session control ───────────────────────────────────────
		tool(
			'send_message_to_room',
			'Inject a message into the active session of a room. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room to send the message to'),
				message: z.string().describe('Message content to inject into the session'),
			},
			// Non-undoable: messages injected into agent sessions may have been acted upon.
			(args) =>
				logged(
					'send_message_to_room',
					args as Record<string, unknown>,
					() => handlers.send_message_to_room(args),
					{
						targetType: 'room',
						getTargetId: (a) => (a.room_id as string) ?? null,
					}
				)
		),

		tool(
			'send_message_to_task',
			'Inject a message into the active worker session for a specific task. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task whose session to send the message to'),
				message: z.string().describe('Message content to inject into the task session'),
			},
			// Non-undoable: messages injected into agent sessions may have been acted upon.
			(args) =>
				logged(
					'send_message_to_task',
					args as Record<string, unknown>,
					() => handlers.send_message_to_task(args),
					{
						targetType: 'task',
						getTargetId: (a) => (a.task_id as string) ?? null,
					}
				)
		),

		tool(
			'stop_session',
			'Interrupt the running agent session for a task. Only works for in_progress or review tasks. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task whose session to stop'),
			},
			// Non-undoable: session interruption may have cascading side effects.
			(args) =>
				logged('stop_session', args as Record<string, unknown>, () => handlers.stop_session(args), {
					targetType: 'task',
					getTargetId: (a) => (a.task_id as string) ?? null,
				})
		),

		tool(
			'pause_schedule',
			'Pause the schedule for a recurring mission. While paused, the mission will not trigger automatically. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the goal'),
				goal_id: z.string().describe('ID of the recurring goal to pause'),
			},
			(args) =>
				logged(
					'pause_schedule',
					args as Record<string, unknown>,
					() => handlers.pause_schedule(args),
					{
						targetType: 'goal',
						getTargetId: (a) => (a.goal_id as string) ?? null,
					}
				)
		),

		tool(
			'resume_schedule',
			'Resume a paused recurring mission schedule. Low risk — auto-executes in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the goal'),
				goal_id: z.string().describe('ID of the recurring goal to resume'),
			},
			(args) =>
				logged(
					'resume_schedule',
					args as Record<string, unknown>,
					() => handlers.resume_schedule(args),
					{
						targetType: 'goal',
						getTargetId: (a) => (a.goal_id as string) ?? null,
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
