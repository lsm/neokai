/**
 * Room Agent Tools - MCP tools for Room chat session
 *
 * These tools allow the Room Agent to manage goals and tasks on behalf of
 * the human user. The Room Agent session already exists (room:chat:${roomId}),
 * these tools are attached to it.
 *
 * Tools: create_goal, list_goals, update_goal, create_task, list_tasks,
 *        update_task, cancel_task, get_room_status, approve_task, reject_task,
 *        send_message_to_task, get_task_detail
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TaskStatus } from '@neokai/shared';
import type { GoalManager } from '../managers/goal-manager';
import type { TaskManager } from '../managers/task-manager';
import type { SessionGroupRepository } from '../state/session-group-repository';
import type { DaemonHub } from '../../daemon-hub';
import type { RoomRuntime } from '../runtime/room-runtime';
import { routeHumanMessageToGroup } from '../runtime/human-message-routing';

export interface RoomAgentToolsConfig {
	roomId: string;
	goalManager: GoalManager;
	taskManager: TaskManager;
	groupRepo: SessionGroupRepository;
	daemonHub?: DaemonHub;
	runtimeService?: {
		getRuntime(roomId: string): RoomRuntime | null;
	};
}

interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: Record<string, unknown>): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Create tool handler functions that can be tested directly.
 * Returns a map of tool name -> handler function.
 */
export function createRoomAgentToolHandlers(config: RoomAgentToolsConfig) {
	const { goalManager, taskManager, groupRepo, roomId, daemonHub, runtimeService } = config;

	return {
		async create_goal(args: {
			title: string;
			description?: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const goal = await goalManager.createGoal({
				title: args.title,
				description: args.description,
				priority: args.priority,
			});
			// Notify runtime so it schedules a tick immediately (instead of waiting for the timer)
			if (daemonHub) {
				void daemonHub.emit('goal.created', {
					sessionId: `room:${roomId}`,
					roomId,
					goalId: goal.id,
					goal,
				});
			}
			return jsonResult({ success: true, goalId: goal.id, goal });
		},

		async list_goals(): Promise<ToolResult> {
			const goals = await goalManager.listGoals();
			return jsonResult({ success: true, goals });
		},

		async update_goal(args: {
			goal_id: string;
			status?: 'active' | 'needs_human' | 'completed' | 'archived';
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			let updated = goal;
			if (args.status) {
				updated = await goalManager.updateGoalStatus(args.goal_id, args.status);
			}
			if (args.priority) {
				updated = await goalManager.updateGoalPriority(args.goal_id, args.priority);
			}
			return jsonResult({ success: true, goal: updated });
		},

		async create_task(args: {
			title: string;
			description: string;
			goal_id?: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const task = await taskManager.createTask({
				title: args.title,
				description: args.description,
				priority: args.priority,
			});
			if (args.goal_id) {
				await goalManager.linkTaskToGoal(args.goal_id, task.id);
			}
			// Notify runtime so it schedules a tick immediately
			if (daemonHub) {
				void daemonHub.emit('room.task.update', {
					sessionId: `room:${roomId}`,
					roomId,
					task,
				});
			}
			return jsonResult({ success: true, taskId: task.id, task });
		},

		async list_tasks(args: { goal_id?: string; status?: TaskStatus }): Promise<ToolResult> {
			let tasks = await taskManager.listTasks(args.status ? { status: args.status } : undefined);
			if (args.goal_id) {
				const goal = await goalManager.getGoal(args.goal_id);
				if (goal) {
					const linkedIds = new Set(goal.linkedTaskIds);
					tasks = tasks.filter((t) => linkedIds.has(t.id));
				}
			}
			return jsonResult({ success: true, tasks });
		},

		async update_task(args: {
			task_id: string;
			title?: string;
			description?: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			const updates: {
				title?: string;
				description?: string;
				priority?: 'low' | 'normal' | 'high' | 'urgent';
			} = {};
			if (args.title !== undefined) updates.title = args.title;
			if (args.description !== undefined) updates.description = args.description;
			if (args.priority !== undefined) updates.priority = args.priority;
			// Apply updates if any fields were provided; otherwise return existing task unchanged
			const updated =
				Object.keys(updates).length > 0
					? await taskManager.updateTaskFields(args.task_id, updates)
					: task;
			// Notify UI of the update
			if (daemonHub) {
				void daemonHub.emit('room.task.update', {
					sessionId: `room:${roomId}`,
					roomId,
					task: updated,
				});
			}
			return jsonResult({ success: true, task: updated });
		},

		async cancel_task(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}

			let cancelledTaskIds: string[] = [];
			let usedRuntimeCancellation = false;
			if (runtimeService) {
				const runtime = runtimeService.getRuntime(roomId);
				if (runtime) {
					const result = await runtime.cancelTask(args.task_id);
					if (!result.success) {
						return jsonResult({
							success: false,
							error: `Failed to cancel task: ${args.task_id}`,
						});
					}
					cancelledTaskIds = result.cancelledTaskIds;
					usedRuntimeCancellation = true;
				}
			}

			// Fallback when runtime service is unavailable: status-only cancellation.
			if (!usedRuntimeCancellation) {
				const cancelledTasks = await taskManager.cancelTaskCascade(args.task_id);
				cancelledTaskIds = cancelledTasks.map((cancelledTask) => cancelledTask.id);

				// Notify UI of status change for every affected task in fallback mode.
				if (daemonHub) {
					for (const cancelledTaskId of cancelledTaskIds) {
						const cancelledTask = await taskManager.getTask(cancelledTaskId);
						if (!cancelledTask) continue;
						void daemonHub.emit('room.task.update', {
							sessionId: `room:${roomId}`,
							roomId,
							task: cancelledTask,
						});
					}
				}
			}
			return jsonResult({ success: true, message: `Task ${args.task_id} cancelled` });
		},

		async approve_task(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (!runtimeService) {
				return jsonResult({ success: false, error: 'Runtime service not available' });
			}
			const runtime = runtimeService.getRuntime(roomId);
			if (!runtime) {
				return jsonResult({ success: false, error: 'Room runtime not found' });
			}
			const approved = await runtime.resumeWorkerFromHuman(
				args.task_id,
				'Task approved. Please proceed.',
				{ approved: true }
			);
			if (!approved) {
				return jsonResult({
					success: false,
					error: 'Failed to approve task — task may not be awaiting review',
				});
			}
			return jsonResult({ success: true, message: `Task ${args.task_id} approved` });
		},

		async reject_task(args: { task_id: string; feedback: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (!runtimeService) {
				return jsonResult({ success: false, error: 'Runtime service not available' });
			}
			const runtime = runtimeService.getRuntime(roomId);
			if (!runtime) {
				return jsonResult({ success: false, error: 'Room runtime not found' });
			}
			const resumed = await runtime.resumeWorkerFromHuman(args.task_id, args.feedback, {
				approved: false,
			});
			if (!resumed) {
				return jsonResult({
					success: false,
					error: 'Failed to reject task — task may not be awaiting review',
				});
			}
			return jsonResult({ success: true, message: `Task ${args.task_id} rejected with feedback` });
		},

		async send_message_to_task(args: { task_id: string; message: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (!runtimeService) {
				return jsonResult({ success: false, error: 'Runtime service not available' });
			}
			const runtime = runtimeService.getRuntime(roomId);
			if (!runtime) {
				return jsonResult({ success: false, error: 'Room runtime not found' });
			}
			const { success, error } = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				args.task_id,
				args.message
			);
			return jsonResult(error !== undefined ? { success, error } : { success });
		},

		async get_task_detail(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			const group = groupRepo.getGroupByTaskId(args.task_id);
			return jsonResult({
				success: true,
				task,
				group: group
					? {
							id: group.id,
							state: group.state,
							workerSessionId: group.workerSessionId,
							leaderSessionId: group.leaderSessionId,
							feedbackIteration: group.feedbackIteration,
							awaitingHumanReview: group.state === 'awaiting_human',
						}
					: null,
			});
		},

		async get_room_status(): Promise<ToolResult> {
			const goals = await goalManager.listGoals();
			const tasks = await taskManager.listTasks();
			const activeGroups = groupRepo.getActiveGroups(roomId);

			// Collect task IDs that need human review:
			// either the task is in 'review' status OR the group is in 'awaiting_human' state
			const needsReviewIds = new Set<string>();
			tasks.filter((t) => t.status === 'review').forEach((t) => needsReviewIds.add(t.id));
			activeGroups
				.filter((g) => g.state === 'awaiting_human')
				.forEach((g) => needsReviewIds.add(g.taskId));

			const tasksNeedingReview = [...needsReviewIds].map((taskId) => {
				const task = tasks.find((t) => t.id === taskId);
				return { taskId, title: task?.title ?? '' };
			});

			return jsonResult({
				success: true,
				status: {
					goals: {
						total: goals.length,
						active: goals.filter((g) => g.status === 'active').length,
						completed: goals.filter((g) => g.status === 'completed').length,
						needsHuman: goals.filter((g) => g.status === 'needs_human').length,
					},
					tasks: {
						total: tasks.length,
						pending: tasks.filter((t) => t.status === 'pending').length,
						inProgress: tasks.filter((t) => t.status === 'in_progress').length,
						review: tasks.filter((t) => t.status === 'review').length,
						completed: tasks.filter((t) => t.status === 'completed').length,
						failed: tasks.filter((t) => t.status === 'failed').length,
						cancelled: tasks.filter((t) => t.status === 'cancelled').length,
					},
					activeGroups: activeGroups.length,
					groups: activeGroups.map((g) => ({
						id: g.id,
						taskId: g.taskId,
						state: g.state,
						iteration: g.feedbackIteration,
					})),
					tasksNeedingReview,
				},
			});
		},
	};
}

export function createRoomAgentMcpServer(config: RoomAgentToolsConfig) {
	const handlers = createRoomAgentToolHandlers(config);

	const tools = [
		tool(
			'create_goal',
			'Create a new goal for the room',
			{
				title: z.string().describe('Short title for the goal'),
				description: z.string().optional().describe('Detailed description'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Goal priority'),
			},
			(args) => handlers.create_goal(args)
		),
		tool('list_goals', 'List all goals in this room', {}, () => handlers.list_goals()),
		tool(
			'update_goal',
			'Update an existing goal',
			{
				goal_id: z.string().describe('ID of the goal to update'),
				status: z
					.enum(['active', 'needs_human', 'completed', 'archived'])
					.optional()
					.describe('New status'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
			},
			(args) => handlers.update_goal(args)
		),
		tool(
			'create_task',
			'Create a new task and optionally link it to a goal',
			{
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed task description and acceptance criteria'),
				goal_id: z.string().optional().describe('Goal ID to link this task to'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Task priority'),
			},
			(args) => handlers.create_task(args)
		),
		tool(
			'list_tasks',
			'List tasks in this room, optionally filtered by goal',
			{
				goal_id: z.string().optional().describe('Filter to tasks linked to this goal'),
				status: z
					.enum(['draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled'])
					.optional()
					.describe('Filter by status'),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'update_task',
			'Update an existing task (title, description, and/or priority). Only provided fields are changed; omitted fields keep their current values.',
			{
				task_id: z.string().describe('ID of the task to update'),
				title: z.string().trim().min(1).optional().describe('New title for the task'),
				description: z.string().trim().min(1).optional().describe('New description for the task'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
			},
			(args) => handlers.update_task(args)
		),
		tool(
			'cancel_task',
			'Cancel a task (marks as cancelled — distinct from failed — and cleans up agent sessions)',
			{ task_id: z.string().describe('ID of the task to cancel') },
			(args) => handlers.cancel_task(args)
		),
		tool(
			'approve_task',
			'Approve a task that is awaiting human review, allowing the worker to proceed',
			{ task_id: z.string().describe('ID of the task to approve') },
			(args) => handlers.approve_task(args)
		),
		tool(
			'reject_task',
			'Reject a task that is awaiting human review, sending feedback to the worker',
			{
				task_id: z.string().describe('ID of the task to reject'),
				feedback: z.string().describe('Feedback explaining what needs to be fixed or improved'),
			},
			(args) => handlers.reject_task(args)
		),
		tool(
			'send_message_to_task',
			'Send a message to the active agent session for a task (routes to worker or leader based on current state)',
			{
				task_id: z.string().describe('ID of the task to send the message to'),
				message: z.string().describe('The message content to send'),
			},
			(args) => handlers.send_message_to_task(args)
		),
		tool(
			'get_task_detail',
			'Get full details for a task including current group state, session IDs, and whether it is awaiting human review',
			{ task_id: z.string().describe('ID of the task to get details for') },
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'get_room_status',
			'Get an overview of the room state including goals, tasks, active groups, and tasks needing review',
			{},
			() => handlers.get_room_status()
		),
	];

	return createSdkMcpServer({ name: 'room-agent', tools });
}

export type RoomAgentMcpServer = ReturnType<typeof createRoomAgentMcpServer>;
