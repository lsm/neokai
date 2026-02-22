/**
 * Worker Tools - MCP tools for Worker agents
 *
 * These tools are exposed to Worker agents, allowing them to:
 * - Signal task completion to Room Agent
 * - Request human review when needed
 *
 * Replaces manager-tools with direct completion signaling.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Parameters for the worker_complete_task tool
 */
export interface WorkerCompleteTaskParams {
	taskId: string;
	summary: string;
	filesChanged?: string[];
	nextSteps?: string[];
}

/**
 * Configuration for creating the Worker Tools MCP server
 */
export interface WorkerToolsConfig {
	/** ID of the worker session using these tools */
	sessionId: string;
	/** Task ID this worker is executing */
	taskId: string;
	/** Callback when task is completed */
	onCompleteTask: (params: WorkerCompleteTaskParams) => Promise<void>;
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
					task_id: z.string().describe('ID of the task you completed'),
					summary: z.string().describe('Summary of what you accomplished'),
					files_changed: z
						.array(z.string())
						.optional()
						.describe('List of files that were modified'),
					next_steps: z.array(z.string()).optional().describe('Suggested follow-up actions'),
				},
				async (args) => {
					await config.onCompleteTask({
						taskId: args.task_id,
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
