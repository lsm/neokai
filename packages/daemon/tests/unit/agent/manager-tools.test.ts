/**
 * Manager Tools MCP Server Tests
 *
 * Tests the MCP server tools for ManagerAgent to signal task completion
 * and fetch context from worker sessions.
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import {
	createManagerToolsMcpServer,
	type ManagerCompleteTaskParams,
	type ManagerFetchContextParams,
	type ManagerFetchContextResult,
} from '../../../src/lib/agent/manager-tools';

/**
 * Tool result type matching CallToolResult from MCP SDK
 */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
}

/**
 * Helper to get tool handler from the MCP server instance
 */
function getToolHandler(
	server: ReturnType<typeof createManagerToolsMcpServer>,
	toolName: string
): (args: Record<string, unknown>) => Promise<ToolResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const registeredTools = (server.instance as any)._registeredTools;
	const tool = registeredTools[toolName];
	if (!tool) {
		throw new Error(`Tool "${toolName}" not found`);
	}
	return tool.handler;
}

describe('createManagerToolsMcpServer', () => {
	const mockSessionId = 'session-1234567890abcdef';
	let mockOnCompleteTask: ReturnType<
		typeof mock<(_params: ManagerCompleteTaskParams) => Promise<void>>
	>;
	let mockOnFetchContext: ReturnType<
		typeof mock<(_params: ManagerFetchContextParams) => Promise<ManagerFetchContextResult>>
	>;

	beforeEach(() => {
		mockOnCompleteTask = mock(async (_params: ManagerCompleteTaskParams) => {});
		mockOnFetchContext = mock(async (_params: ManagerFetchContextParams) => ({
			messages: [{ role: 'user', content: 'test message' }],
			message: 'Context fetched successfully',
		}));
	});

	describe('server creation', () => {
		it('should create MCP server with correct name (includes session ID)', () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			// Server name should include first 8 characters of session ID
			expect(server.name).toBe('manager-tools-session-');
			expect(server.name).toContain('session-');
			expect(server.type).toBe('sdk');
			expect(server.instance).toBeDefined();
		});

		it('should return server with 2 tools', () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			// The instance has _registeredTools with both tools
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const registeredTools = (server.instance as any)._registeredTools;
			expect(registeredTools['manager_complete_task']).toBeDefined();
			expect(registeredTools['manager_fetch_context']).toBeDefined();
		});
	});

	describe('manager_complete_task tool', () => {
		it('should execute successfully with required parameters (task_id, summary)', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			const handler = getToolHandler(server, 'manager_complete_task');
			const result = await handler({
				task_id: 'task-001',
				summary: 'Task completed successfully',
			});

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe('text');
			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult.success).toBe(true);
			expect(parsedResult.message).toBe('Task marked as complete');

			expect(mockOnCompleteTask).toHaveBeenCalledTimes(1);
			expect(mockOnCompleteTask).toHaveBeenCalledWith({
				taskId: 'task-001',
				summary: 'Task completed successfully',
				filesChanged: undefined,
				nextSteps: undefined,
			});
		});

		it('should execute successfully with optional files_changed parameter', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			const handler = getToolHandler(server, 'manager_complete_task');
			const result = await handler({
				task_id: 'task-002',
				summary: 'Updated configuration files',
				files_changed: ['config.json', 'settings.yaml'],
				next_steps: ['Review changes', 'Deploy to staging'],
			});

			expect(result.content).toHaveLength(1);
			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult.success).toBe(true);

			expect(mockOnCompleteTask).toHaveBeenCalledTimes(1);
			expect(mockOnCompleteTask).toHaveBeenCalledWith({
				taskId: 'task-002',
				summary: 'Updated configuration files',
				filesChanged: ['config.json', 'settings.yaml'],
				nextSteps: ['Review changes', 'Deploy to staging'],
			});
		});

		it('should return success response', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			const handler = getToolHandler(server, 'manager_complete_task');
			const result = await handler({
				task_id: 'task-003',
				summary: 'Success',
			});

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe('text');

			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult).toEqual({
				success: true,
				message: 'Task marked as complete',
			});
		});

		it('should call onCompleteTask callback with correct parameters', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			const handler = getToolHandler(server, 'manager_complete_task');
			await handler({
				task_id: 'task-004',
				summary: 'Implementation complete',
				files_changed: ['src/index.ts'],
				next_steps: ['Run tests'],
			});

			expect(mockOnCompleteTask).toHaveBeenCalledWith({
				taskId: 'task-004',
				summary: 'Implementation complete',
				filesChanged: ['src/index.ts'],
				nextSteps: ['Run tests'],
			});
		});

		it('should handle callback errors gracefully', async () => {
			const errorMock = mock(async () => {
				throw new Error('Callback failed');
			});

			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: errorMock,
			});

			const handler = getToolHandler(server, 'manager_complete_task');

			// The handler should propagate the error
			await expect(
				handler({
					task_id: 'task-005',
					summary: 'This will fail',
				})
			).rejects.toThrow('Callback failed');
		});
	});

	describe('manager_fetch_context tool', () => {
		it('should execute successfully with message_limit parameter', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
				onFetchContext: mockOnFetchContext,
			});

			const handler = getToolHandler(server, 'manager_fetch_context');
			const result = await handler({
				message_limit: 10,
			});

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe('text');

			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult.messages).toHaveLength(1);
			expect(parsedResult.message).toBe('Context fetched successfully');

			expect(mockOnFetchContext).toHaveBeenCalledTimes(1);
			expect(mockOnFetchContext).toHaveBeenCalledWith({ messageLimit: 10 });
		});

		it('should return context when onFetchContext handler is provided', async () => {
			const fetchResult: ManagerFetchContextResult = {
				messages: [
					{ role: 'user', content: 'First message' },
					{ role: 'assistant', content: 'Response' },
				],
				message: 'Successfully fetched 2 messages',
			};

			const localMockOnFetchContext = mock(async () => fetchResult);

			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
				onFetchContext: localMockOnFetchContext,
			});

			const handler = getToolHandler(server, 'manager_fetch_context');
			const result = await handler({ message_limit: 5 });

			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult).toEqual(fetchResult);
			expect(parsedResult.messages).toHaveLength(2);
			expect(parsedResult.message).toBe('Successfully fetched 2 messages');
		});

		it('should return "no context available" when handler not provided', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
				// onFetchContext not provided
			});

			const handler = getToolHandler(server, 'manager_fetch_context');
			const result = await handler({ message_limit: 10 });

			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult).toEqual({
				messages: [],
				message: 'Context fetched (no handler configured)',
			});
		});

		it('should handle callback errors gracefully', async () => {
			const errorMock = mock(async () => {
				throw new Error('Fetch failed');
			});

			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
				onFetchContext: errorMock,
			});

			const handler = getToolHandler(server, 'manager_fetch_context');

			await expect(handler({ message_limit: 10 })).rejects.toThrow('Fetch failed');
		});
	});

	describe('edge cases', () => {
		it('should handle empty files_changed array', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			const handler = getToolHandler(server, 'manager_complete_task');
			await handler({
				task_id: 'task-empty',
				summary: 'No files changed',
				files_changed: [],
			});

			expect(mockOnCompleteTask).toHaveBeenCalledWith(
				expect.objectContaining({
					filesChanged: [],
				})
			);
		});

		it('should handle long session ID by truncating in name', () => {
			const longSessionId = 'session-abcdefghijklmnopqrstuvwxyz1234567890';

			const server = createManagerToolsMcpServer({
				sessionId: longSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			// Name should use first 8 chars of session ID
			// 'session-abcdefghijklmnopqrstuvwxyz...'.slice(0, 8) = 'session-'
			expect(server.name).toBe('manager-tools-session-');
		});

		it('should handle short session ID', () => {
			const shortSessionId = 'abc123';

			const server = createManagerToolsMcpServer({
				sessionId: shortSessionId,
				onCompleteTask: mockOnCompleteTask,
			});

			// slice(0, 8) of 'abc123' is 'abc123'
			expect(server.name).toBe('manager-tools-abc123');
		});

		it('should handle empty messages in fetch context result', async () => {
			const localMock = mock(async () => ({
				messages: [],
				message: 'No context available',
			}));

			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
				onFetchContext: localMock,
			});

			const handler = getToolHandler(server, 'manager_fetch_context');
			const result = await handler({ message_limit: 5 });

			const parsedResult = JSON.parse(result.content[0].text as string);
			expect(parsedResult.messages).toEqual([]);
			expect(parsedResult.message).toBe('No context available');
		});

		it('should handle undefined message_limit (zod default applied by SDK)', async () => {
			const server = createManagerToolsMcpServer({
				sessionId: mockSessionId,
				onCompleteTask: mockOnCompleteTask,
				onFetchContext: mockOnFetchContext,
			});

			const handler = getToolHandler(server, 'manager_fetch_context');

			// Call with empty object - zod default(10) would be applied by the SDK
			// when parsing, but when calling handler directly we get undefined
			const result = await handler({});

			// The handler should still work and return valid JSON
			expect(result.content).toHaveLength(1);

			// Note: When calling the handler directly, zod parsing isn't applied
			// so message_limit is undefined. In real SDK usage, the schema default
			// would be applied before the handler is called.
			expect(mockOnFetchContext).toHaveBeenCalledWith({ messageLimit: undefined });
		});
	});
});
