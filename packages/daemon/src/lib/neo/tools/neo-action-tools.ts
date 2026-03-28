/**
 * Neo Action Tools - MCP tools for write operations
 *
 * Implements room, goal, and task write operations with security-tier enforcement.
 * Each tool checks whether the current security mode requires confirmation before
 * execution and either runs immediately or returns a `confirmationRequired` payload.
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

export interface NeoActionToolsConfig {
	roomManager: NeoActionRoomManager;
	managerFactory: NeoActionManagerFactory;
	runtimeService?: NeoActionRuntimeService;
	pendingStore: PendingActionStore;
	/** Workspace root — auto-applied as allowedPaths when not provided */
	workspaceRoot?: string;
	/** Returns the current security mode (looked up at call time) */
	getSecurityMode(): NeoSecurityMode;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
	const { roomManager, managerFactory, runtimeService, workspaceRoot } = config;

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
			return withSecurityCheck('delete_room', args as Record<string, unknown>, config, async () => {
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
					if (task.status !== 'review') {
						return errorResult(`Task is not in review status (current: ${task.status})`);
					}

					const resumed = await runtime.resumeWorkerFromHuman(
						args.task_id,
						'Human has approved the PR. Merge it now by running `gh pr merge` (do NOT use --delete-branch). After the merge completes, your work is done.',
						{ approved: true }
					);

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
	];

	return createSdkMcpServer({ name: 'neo-action', tools });
}
