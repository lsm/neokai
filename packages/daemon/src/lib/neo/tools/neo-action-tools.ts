/**
 * Neo Action Tools - MCP tools for write operations
 *
 * Implements room, goal, task, space, and workflow write operations with
 * security-tier enforcement.  Each tool checks whether the current security
 * mode requires confirmation before execution and either runs immediately or
 * returns a `confirmationRequired` payload.
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
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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
	updateGoalStatus(id: string, status: GoalStatus): Promise<RoomGoal>;
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
}

/** Optional runtime — if not provided, approve/reject fallback gracefully */
export interface NeoActionRuntime {
	resumeWorkerFromHuman(
		taskId: string,
		message: string,
		opts: { approved: boolean }
	): Promise<boolean>;
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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
	};
}

// ---------------------------------------------------------------------------
// MCP server wrapper
// ---------------------------------------------------------------------------

export function createNeoActionMcpServer(config: NeoActionToolsConfig) {
	const handlers = createNeoActionToolHandlers(config);

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
			(args) => handlers.create_room(args)
		),

		tool(
			'delete_room',
			'Delete a room permanently. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room to delete'),
			},
			(args) => handlers.delete_room(args)
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
			(args) => handlers.update_room_settings(args)
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
			(args) => handlers.create_goal(args)
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
			(args) => handlers.update_goal(args)
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
			(args) => handlers.set_goal_status(args)
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
			(args) => handlers.create_task(args)
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
			(args) => handlers.update_task(args)
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
			(args) => handlers.set_task_status(args)
		),

		tool(
			'approve_task',
			'Approve a task PR that is currently in review status. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task to approve'),
			},
			(args) => handlers.approve_task(args)
		),

		tool(
			'reject_task',
			'Reject a task PR that is currently in review status, providing feedback for revision. Medium risk — requires confirmation in balanced mode.',
			{
				room_id: z.string().describe('ID of the room containing the task'),
				task_id: z.string().describe('ID of the task to reject'),
				feedback: z.string().describe('Feedback explaining why the task was rejected'),
			},
			(args) => handlers.reject_task(args)
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
			(args) => handlers.create_space(args)
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
			(args) => handlers.update_space(args)
		),

		tool(
			'delete_space',
			'Permanently delete a space and all its data. Medium risk — requires confirmation in balanced mode.',
			{
				space_id: z.string().describe('ID of the space to delete'),
			},
			(args) => handlers.delete_space(args)
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
			(args) => handlers.start_workflow_run(args)
		),

		tool(
			'cancel_workflow_run',
			'Cancel an active workflow run and all its pending tasks. Medium risk — requires confirmation in balanced mode.',
			{
				run_id: z.string().describe('ID of the workflow run to cancel'),
			},
			(args) => handlers.cancel_workflow_run(args)
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
			(args) => handlers.approve_gate(args)
		),

		tool(
			'reject_gate',
			'Reject a human-approval gate in a workflow run, halting it for revision. Medium risk — requires confirmation in balanced mode.',
			{
				run_id: z.string().describe('ID of the workflow run'),
				gate_id: z.string().describe('ID of the gate to reject'),
				reason: z.string().optional().describe('Reason for the rejection'),
			},
			(args) => handlers.reject_gate(args)
		),
	];

	return createSdkMcpServer({ name: 'neo-action', tools });
}
