/**
 * Room Agent Tools - MCP tools for RoomAgent orchestration
 *
 * These tools are exposed to the RoomAgent when it runs as an active agent,
 * allowing it to:
 * - Complete goals
 * - Create and manage tasks
 * - Spawn worker sessions
 * - Request reviews
 * - Escalate issues
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Parameters for room_complete_goal tool
 */
export interface RoomCompleteGoalParams {
	goalId: string;
	result: string;
}

/**
 * Parameters for room_create_task tool
 */
export interface RoomCreateTaskParams {
	title: string;
	description: string;
	priority?: 'low' | 'normal' | 'high' | 'urgent';
	goalId?: string;
}

/**
 * Parameters for room_spawn_worker tool
 */
export interface RoomSpawnWorkerParams {
	taskId: string;
	mode?: 'single' | 'parallel' | 'serial';
}

/**
 * Parameters for room_update_goal_progress tool
 */
export interface RoomUpdateGoalProgressParams {
	goalId: string;
	progress: number;
	metrics?: Record<string, number>;
}

/**
 * Parameters for room_schedule_job tool
 */
export interface RoomScheduleJobParams {
	name: string;
	description?: string;
	scheduleType: 'interval' | 'daily' | 'weekly';
	/** For interval: minutes between runs */
	intervalMinutes?: number;
	/** For daily/weekly: hour (0-23) */
	hour?: number;
	/** For daily/weekly: minute (0-59) */
	minute?: number;
	/** For weekly: day of week (0=Sunday, 6=Saturday) */
	dayOfWeek?: number;
	/** Task template for spawned tasks */
	taskTemplate: {
		title: string;
		description: string;
		priority?: 'low' | 'normal' | 'high' | 'urgent';
	};
	/** Maximum number of runs (optional) */
	maxRuns?: number;
}

/**
 * Parameters for room_update_prompts tool
 */
export interface RoomUpdatePromptsParams {
	templateId: string;
	customContent: string;
	reason: string;
}

/**
 * Goal summary returned by room_list_goals
 */
export interface RoomGoalSummary {
	id: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	progress: number;
}

/**
 * Job summary returned by room_list_jobs
 */
export interface RoomJobSummary {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	schedule: string;
}

/**
 * Task summary returned by room_list_tasks
 */
export interface RoomTaskSummary {
	id: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	progress: number;
}

/**
 * Configuration for creating the Room Agent Tools MCP server
 */
export interface RoomAgentToolsConfig {
	/** ID of the room */
	roomId: string;
	/** ID of the session using these tools */
	sessionId: string;
	/** Callback when goal is completed */
	onCompleteGoal: (params: RoomCompleteGoalParams) => Promise<void>;
	/** Callback to create a new task */
	onCreateTask: (params: RoomCreateTaskParams) => Promise<{ taskId: string }>;
	/** Callback to spawn a worker for a task */
	onSpawnWorker: (
		params: RoomSpawnWorkerParams
	) => Promise<{ pairId: string; workerSessionId: string }>;
	/** Callback to request human review */
	onRequestReview: (taskId: string, reason: string) => Promise<void>;
	/** Callback to escalate an issue */
	onEscalate: (taskId: string, reason: string) => Promise<void>;
	/** Callback to update goal progress */
	onUpdateGoalProgress: (params: RoomUpdateGoalProgressParams) => Promise<void>;
	/** Callback to schedule a recurring job */
	onScheduleJob?: (params: RoomScheduleJobParams) => Promise<{ jobId: string }>;
	/** Callback to cancel a recurring job */
	onCancelJob?: (jobId: string) => Promise<void>;
	/** Callback to update room prompts */
	onUpdatePrompts?: (params: RoomUpdatePromptsParams) => Promise<void>;
	/** Callback to list goals */
	onListGoals: (status?: string) => Promise<RoomGoalSummary[]>;
	/** Callback to list recurring jobs */
	onListJobs: () => Promise<RoomJobSummary[]>;
	/** Callback to list tasks */
	onListTasks: (status?: string) => Promise<RoomTaskSummary[]>;
}

/**
 * Create an MCP server with room agent tools
 *
 * This server provides tools that allow the RoomAgent to:
 * - Complete goals
 * - Create new tasks
 * - Spawn worker sessions to execute tasks
 * - Request human reviews
 * - Escalate issues
 * - Update goal progress
 * - Schedule recurring jobs (for patterns like optimal timing, retries)
 * - Update room prompts (self-optimization)
 */
export function createRoomAgentMcpServer(config: RoomAgentToolsConfig) {
	// Use 'as const' pattern with spread to avoid type narrowing issues
	const baseTools = [
		tool(
			'room_complete_goal',
			'Mark a goal as completed and record the result',
			{
				goal_id: z.string().describe('ID of the goal to complete'),
				result: z.string().describe('Summary of what was achieved'),
			},
			async (args) => {
				await config.onCompleteGoal({
					goalId: args.goal_id,
					result: args.result,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({ success: true, message: 'Goal marked as complete' }),
						},
					],
				};
			}
		),

		tool(
			'room_create_task',
			'Create a new task for this room',
			{
				title: z.string().describe('Task title'),
				description: z.string().describe('Detailed task description'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Task priority'),
				goal_id: z.string().optional().describe('Link this task to a goal'),
			},
			async (args) => {
				const result = await config.onCreateTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					goalId: args.goal_id,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								taskId: result.taskId,
								message: 'Task created successfully',
							}),
						},
					],
				};
			}
		),

		tool(
			'room_spawn_worker',
			'Spawn a worker session to execute a task',
			{
				task_id: z.string().describe('ID of the task to work on'),
				mode: z
					.enum(['single', 'parallel', 'serial'])
					.optional()
					.default('single')
					.describe('Execution mode for the worker'),
			},
			async (args) => {
				const result = await config.onSpawnWorker({
					taskId: args.task_id,
					mode: args.mode,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								pairId: result.pairId,
								workerSessionId: result.workerSessionId,
								message: 'Worker spawned successfully',
							}),
						},
					],
				};
			}
		),

		tool(
			'room_wait_for_review',
			'Request a human review before proceeding',
			{
				task_id: z.string().describe('ID of the task needing review'),
				reason: z.string().describe('Why review is needed'),
			},
			async (args) => {
				await config.onRequestReview(args.task_id, args.reason);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								message: 'Review requested. Agent will wait for human input.',
							}),
						},
					],
				};
			}
		),

		tool(
			'room_escalate',
			'Escalate an issue to human attention',
			{
				task_id: z.string().describe('ID of the task with issues'),
				reason: z.string().describe('Why escalation is needed'),
			},
			async (args) => {
				await config.onEscalate(args.task_id, args.reason);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								message: 'Issue escalated. A human will be notified.',
							}),
						},
					],
				};
			}
		),

		tool(
			'room_update_goal_progress',
			'Update the progress of a goal',
			{
				goal_id: z.string().describe('ID of the goal to update'),
				progress: z.number().min(0).max(100).describe('Progress percentage (0-100)'),
				metrics: z.record(z.string(), z.number()).optional().describe('Optional metrics to track'),
			},
			async (args) => {
				await config.onUpdateGoalProgress({
					goalId: args.goal_id,
					progress: args.progress,
					metrics: args.metrics as Record<string, number> | undefined,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								message: 'Goal progress updated',
							}),
						},
					],
				};
			}
		),

		tool(
			'room_list_goals',
			'List current goals for this room',
			{
				status: z
					.enum(['pending', 'in_progress', 'completed', 'cancelled'])
					.optional()
					.describe('Filter goals by status (omit for all goals)'),
			},
			async (args) => {
				const goals = await config.onListGoals(args.status);
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({ goals }),
						},
					],
				};
			}
		),

		tool('room_list_jobs', 'List recurring jobs configured for this room', {}, async () => {
			const jobs = await config.onListJobs();
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({ jobs }),
					},
				],
			};
		}),

		tool(
			'room_list_tasks',
			'List tasks for this room',
			{
				status: z
					.enum(['pending', 'in_progress', 'completed', 'failed'])
					.optional()
					.describe('Filter tasks by status (omit for all tasks)'),
			},
			async (args) => {
				const tasks = await config.onListTasks(args.status);
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({ tasks }),
						},
					],
				};
			}
		),
	];

	// Build optional tools arrays
	const scheduleJobTool = config.onScheduleJob
		? [
				tool(
					'room_schedule_job',
					'Schedule a recurring job for this room. Use this when you discover patterns like optimal posting times or need to retry after rate limits.',
					{
						name: z.string().describe('Name for this job'),
						description: z.string().optional().describe('Description of what this job does'),
						schedule_type: z.enum(['interval', 'daily', 'weekly']).describe('Type of schedule'),
						interval_minutes: z
							.number()
							.min(1)
							.optional()
							.describe('For interval type: minutes between runs'),
						hour: z.number().min(0).max(23).optional().describe('For daily/weekly: hour (0-23)'),
						minute: z
							.number()
							.min(0)
							.max(59)
							.optional()
							.describe('For daily/weekly: minute (0-59)'),
						day_of_week: z
							.number()
							.min(0)
							.max(6)
							.optional()
							.describe('For weekly: day of week (0=Sunday, 6=Saturday)'),
						task_title: z.string().describe('Title for tasks created by this job'),
						task_description: z.string().describe('Description for tasks created by this job'),
						task_priority: z
							.enum(['low', 'normal', 'high', 'urgent'])
							.optional()
							.default('normal')
							.describe('Priority for created tasks'),
						max_runs: z.number().optional().describe('Maximum number of times to run'),
					},
					async (args) => {
						const result = await config.onScheduleJob!({
							name: args.name,
							description: args.description,
							scheduleType: args.schedule_type,
							intervalMinutes: args.interval_minutes,
							hour: args.hour,
							minute: args.minute,
							dayOfWeek: args.day_of_week,
							taskTemplate: {
								title: args.task_title,
								description: args.task_description,
								priority: args.task_priority,
							},
							maxRuns: args.max_runs,
						});

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										success: true,
										jobId: result.jobId,
										message: 'Recurring job scheduled successfully',
									}),
								},
							],
						};
					}
				),
			]
		: [];

	const cancelJobTool = config.onCancelJob
		? [
				tool(
					'room_cancel_job',
					'Cancel a scheduled recurring job',
					{
						job_id: z.string().describe('ID of the job to cancel'),
					},
					async (args) => {
						await config.onCancelJob!(args.job_id);

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										success: true,
										message: 'Recurring job cancelled',
									}),
								},
							],
						};
					}
				),
			]
		: [];

	const updatePromptsTool = config.onUpdatePrompts
		? [
				tool(
					'room_update_prompts',
					'Update room system prompts when you discover patterns that would improve agent performance',
					{
						template_id: z.string().describe('ID of the prompt template to update'),
						custom_content: z.string().describe('The customized prompt content'),
						reason: z.string().describe('Why this change improves the prompt'),
					},
					async (args) => {
						await config.onUpdatePrompts!({
							templateId: args.template_id,
							customContent: args.custom_content,
							reason: args.reason,
						});

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										success: true,
										message: 'Room prompts updated successfully',
									}),
								},
							],
						};
					}
				),
			]
		: [];

	// Combine all tools
	const tools = [...baseTools, ...scheduleJobTool, ...cancelJobTool, ...updatePromptsTool];

	return createSdkMcpServer({
		name: `room-agent-${config.roomId.slice(0, 8)}`,
		tools,
	});
}

export type RoomAgentMcpServer = ReturnType<typeof createRoomAgentMcpServer>;
