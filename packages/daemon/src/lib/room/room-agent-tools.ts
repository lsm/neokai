/**
 * Room Agent Tools - MCP tools for Room chat session
 *
 * These tools allow the Room Agent to manage goals and tasks on behalf of
 * the human user. The Room Agent session already exists (room:chat:${roomId}),
 * these tools are attached to it.
 *
 * Tools: create_goal, list_goals, update_goal, create_task, list_tasks,
 *        update_task, cancel_task, get_room_status
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TaskStatus } from '@neokai/shared';
import type { GoalManager } from './goal-manager';
import type { TaskManager } from './task-manager';
import type { TaskPairRepository } from './task-pair-repository';

export interface RoomAgentToolsConfig {
	roomId: string;
	goalManager: GoalManager;
	taskManager: TaskManager;
	taskPairRepo: TaskPairRepository;
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
	const { goalManager, taskManager, taskPairRepo, roomId } = config;

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
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (args.priority) {
				await taskManager.updateTaskPriority(args.task_id, args.priority);
			}
			return jsonResult({ success: true, task: await taskManager.getTask(args.task_id) });
		},

		async cancel_task(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			await taskManager.failTask(args.task_id, 'Cancelled by user');
			return jsonResult({ success: true, message: `Task ${args.task_id} cancelled` });
		},

		async get_room_status(): Promise<ToolResult> {
			const goals = await goalManager.listGoals();
			const tasks = await taskManager.listTasks();
			const activePairs = taskPairRepo.getActivePairs(roomId);

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
						escalated: tasks.filter((t) => t.status === 'escalated').length,
						completed: tasks.filter((t) => t.status === 'completed').length,
						failed: tasks.filter((t) => t.status === 'failed').length,
					},
					activePairs: activePairs.length,
					pairs: activePairs.map((p) => ({
						id: p.id,
						taskId: p.taskId,
						state: p.pairState,
						iteration: p.feedbackIteration,
					})),
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
					.enum(['draft', 'pending', 'in_progress', 'escalated', 'completed', 'failed'])
					.optional()
					.describe('Filter by status'),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'update_task',
			'Update an existing task',
			{
				task_id: z.string().describe('ID of the task to update'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
			},
			(args) => handlers.update_task(args)
		),
		tool(
			'cancel_task',
			'Cancel a task (marks as failed and cleans up agent sessions)',
			{ task_id: z.string().describe('ID of the task to cancel') },
			(args) => handlers.cancel_task(args)
		),
		tool(
			'get_room_status',
			'Get an overview of the room state including goals, tasks, and active pairs',
			{},
			() => handlers.get_room_status()
		),
	];

	return createSdkMcpServer({ name: 'room-agent', tools });
}

export type RoomAgentMcpServer = ReturnType<typeof createRoomAgentMcpServer>;
