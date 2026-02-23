/**
 * Worker Tools - MCP tools for Worker agents
 *
 * These tools are exposed to Worker agents, allowing them to:
 * - Signal task completion to Room Agent
 * - Request human review when needed
 *
 * Replaces manager-tools with direct completion signaling.
 *
 * SECURITY NOTE: The task_id is bound at worker creation time (config.taskId)
 * and cannot be overridden by the worker. This prevents a worker from marking
 * arbitrary tasks as complete.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Parameters for the worker_complete_task tool (internal use)
 * Task ID is bound at creation time, not accepted as a parameter
 */
export interface WorkerCompleteTaskParams {
	taskId: string;
	summary: string;
	filesChanged?: string[];
	nextSteps?: string[];
}

/**
 * Parameters for worker_report_progress tool (internal use)
 */
export interface WorkerReportProgressParams {
	taskId: string;
	progress: number;
	currentStep?: string;
	details?: string;
}

/**
 * Configuration for creating the Worker Tools MCP server
 */
export interface WorkerToolsConfig {
	/** ID of the worker session using these tools */
	sessionId: string;
	/** Task ID this worker is executing (bound at creation time) */
	taskId: string;
	/** Callback when task is completed */
	onCompleteTask: (params: WorkerCompleteTaskParams) => Promise<void>;
	/** Callback to report task progress */
	onReportProgress: (params: WorkerReportProgressParams) => Promise<void>;
	/** Callback to request human review */
	onRequestReview: (reason: string) => Promise<void>;
}

/**
 * Create an MCP server with worker tools
 *
 * This server provides tools that allow the WorkerAgent to:
 * - Signal task completion to Room Agent
 * - Request human review when needed
 */
export function createWorkerToolsMcpServer(config: WorkerToolsConfig) {
	return createSdkMcpServer({
		name: `worker-tools-${config.sessionId.slice(0, 8)}`,
		tools: [
			tool(
				'worker_complete_task',
				'Complete your task and report results to the Room Agent. Call this when you have successfully completed your assigned work.',
				{
					// NOTE: task_id is NOT accepted as a parameter for security
					// The task ID is bound at worker creation time and cannot be changed
					summary: z.string().describe('Summary of what you accomplished'),
					files_changed: z
						.array(z.string())
						.optional()
						.describe('List of files that were modified'),
					next_steps: z.array(z.string()).optional().describe('Suggested follow-up actions'),
				},
				async (args) => {
					// Always use config.taskId (bound at creation time) for security
					await config.onCompleteTask({
						taskId: config.taskId,
						summary: args.summary,
						filesChanged: args.files_changed,
						nextSteps: args.next_steps,
					});

					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									success: true,
									message: 'Task completed successfully',
								}),
							},
						],
					};
				}
			),
			tool(
				'worker_report_progress',
				'Report incremental progress for your assigned task. Use this as you complete meaningful milestones.',
				{
					progress: z.number().min(0).max(100).describe('Task progress percentage (0-100)'),
					current_step: z
						.string()
						.optional()
						.describe('Short description of the current step or milestone'),
					details: z.string().optional().describe('Optional details about recent progress'),
				},
				async (args) => {
					await config.onReportProgress({
						taskId: config.taskId,
						progress: args.progress,
						currentStep: args.current_step,
						details: args.details,
					});

					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									success: true,
									message: 'Progress reported successfully',
								}),
							},
						],
					};
				}
			),
			tool(
				'worker_request_review',
				'Request human review before proceeding. Use this when you are unsure about something or need approval before making changes.',
				{
					reason: z
						.string()
						.describe('Why you need review - be specific about what you want reviewed'),
				},
				async (args) => {
					await config.onRequestReview(args.reason);

					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									success: true,
									message: 'Review requested. Waiting for human input.',
								}),
							},
						],
					};
				}
			),
		],
	});
}

export type WorkerToolsMcpServer = ReturnType<typeof createWorkerToolsMcpServer>;
