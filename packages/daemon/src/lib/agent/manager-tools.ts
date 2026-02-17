/**
 * Manager Tools - MCP tools for ManagerAgent to signal task completion
 *
 * These tools are exposed to the ManagerAgent running in a ManagerSession,
 * allowing it to communicate with the RoomAgent orchestration layer.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Parameters for the manager_complete_task tool
 */
export interface ManagerCompleteTaskParams {
	taskId: string;
	summary: string;
	filesChanged?: string[];
	nextSteps?: string[];
}

/**
 * Parameters for the manager_fetch_context tool
 */
export interface ManagerFetchContextParams {
	messageLimit?: number;
}

/**
 * Result from fetching context
 */
export interface ManagerFetchContextResult {
	messages: Array<{ role: string; content: string }>;
	message: string;
}

/**
 * Configuration for creating the Manager Tools MCP server
 */
export interface ManagerToolsConfig {
	/** ID of the session using these tools */
	sessionId: string;
	/** Callback when task is completed */
	onCompleteTask: (params: ManagerCompleteTaskParams) => Promise<void>;
	/** Callback to fetch additional context from worker session */
	onFetchContext?: (params: ManagerFetchContextParams) => Promise<ManagerFetchContextResult>;
}

/**
 * Create an MCP server with manager tools for ManagerAgent
 *
 * This server provides tools that allow the ManagerAgent to:
 * - Signal task completion to RoomAgent
 * - Fetch additional context from the worker session if needed
 */
export function createManagerToolsMcpServer(config: ManagerToolsConfig) {
	return createSdkMcpServer({
		name: `manager-tools-${config.sessionId.slice(0, 8)}`,
		tools: [
			tool(
				'manager_complete_task',
				'Complete the current task and signal to RoomAgent that work is done',
				{
					task_id: z.string().describe('ID of the task being completed'),
					summary: z.string().describe('Summary of what was accomplished'),
					files_changed: z
						.array(z.string())
						.optional()
						.describe('List of files that were modified'),
					next_steps: z.array(z.string()).optional().describe('Suggested next steps if any'),
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
								text: JSON.stringify({ success: true, message: 'Task marked as complete' }),
							},
						],
					};
				}
			),
			tool(
				'manager_fetch_context',
				'Fetch additional context from the worker session',
				{
					message_limit: z
						.number()
						.optional()
						.default(10)
						.describe('Number of recent messages to fetch'),
				},
				async (args) => {
					if (config.onFetchContext) {
						const result = await config.onFetchContext({
							messageLimit: args.message_limit,
						});
						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify(result),
								},
							],
						};
					}

					// Default stub response when no fetch handler is configured
					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									messages: [],
									message: 'Context fetched (no handler configured)',
								}),
							},
						],
					};
				}
			),
		],
	});
}
