/**
 * Extended SDK Config RPC Handlers Tests (Offline)
 *
 * Additional tests to cover edge cases and restart functionality:
 * - config.mcp.get/update
 * - config.mcp.addServer/removeServer
 * - config.env.get/update
 * - Error handling and restartQuery option
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../test-utils';

describe('SDK Config RPC Handlers - Extended', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	// Helper to send RPC call
	async function sendRpcCall(
		ws: WebSocket,
		method: string,
		data: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: `call-${Date.now()}`,
				type: 'CALL',
				method,
				data,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		return responsePromise;
	}

	describe('config.mcp.get', () => {
		test('should return MCP config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.get', { sessionId });

			expect(response.type).toBe('RESULT');
			// Response includes MCP config and runtime status
			// mcpServers may be undefined if not configured
			expect(response.data).toBeDefined();
			const data = response.data as { runtimeStatus?: unknown[] };
			expect(data.runtimeStatus).toBeArray();
			ws.close();
		});
	});

	describe('config.mcp.update', () => {
		test('should update MCP servers', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.update', {
				sessionId,
				mcpServers: {
					'test-server': {
						command: 'test-command',
						args: [],
					},
				},
				strictMcpConfig: false,
			});

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid MCP server config', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.update', {
				sessionId,
				mcpServers: {
					'': {
						// Empty name should fail
						command: 'test-command',
						args: [],
					},
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.mcp.addServer', () => {
		test('should add MCP server', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-add',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.addServer', {
				sessionId,
				name: 'new-server',
				config: {
					command: 'npx',
					args: ['-y', '@modelcontextprotocol/server-test'],
				},
			});

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject adding invalid server', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-add-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.addServer', {
				sessionId,
				name: '', // Empty name should fail
				config: {
					command: 'test-command',
					args: [],
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.mcp.removeServer', () => {
		test('should remove MCP server', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-mcp-remove',
			});

			// First add a server
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			await sendRpcCall(ws, 'config.mcp.addServer', {
				sessionId,
				name: 'temp-server',
				config: { command: 'test', args: [] },
			});

			// Then remove it
			const response = await sendRpcCall(ws, 'config.mcp.removeServer', {
				sessionId,
				name: 'temp-server',
			});

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});
	});

	describe('config.env.get', () => {
		test('should return environment config for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-env-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.get', { sessionId });

			expect(response.type).toBe('RESULT');
			expect(response.data).toBeDefined();
			ws.close();
		});
	});

	describe('config.env.update', () => {
		test('should update environment settings', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-env-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.update', {
				sessionId,
				settings: {
					additionalDirectories: ['/extra/dir'],
					env: { MY_VAR: 'test-value' },
				},
			});

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('success');
			expect((response.data as Record<string, unknown>).success).toBe(true);
			ws.close();
		});

		test('should reject invalid env settings', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-env-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.update', {
				sessionId,
				settings: {
					// additionalDirectories should be array of strings
					additionalDirectories: 'not-an-array',
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { success: boolean; error?: string };
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			ws.close();
		});
	});

	describe('config.model.update with maxThinkingTokens', () => {
		test('should update maxThinkingTokens', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-thinking-tokens',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.update', {
				sessionId,
				settings: {
					maxThinkingTokens: 4096,
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { applied?: string[] };
			expect(data.applied).toContain('maxThinkingTokens');
			ws.close();
		});
	});

	describe('config.model.update with fallback settings', () => {
		test('should update fallbackModel, maxTurns, maxBudgetUsd', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-model-fallback',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.model.update', {
				sessionId,
				settings: {
					fallbackModel: 'claude-haiku-4-20250514',
					maxTurns: 100,
					maxBudgetUsd: 10.0,
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { pending?: string[] };
			expect(data.pending).toContain('fallbackModel');
			expect(data.pending).toContain('maxTurns');
			expect(data.pending).toContain('maxBudgetUsd');
			ws.close();
		});
	});

	describe('config.updateBulk with restartQuery', () => {
		test('should update config with restartQuery=false', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-bulk-no-restart',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.updateBulk', {
				sessionId,
				config: {
					systemPrompt: 'New system prompt',
				},
				restartQuery: false,
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { pending?: string[] };
			expect(data.pending).toContain('systemPrompt');
			ws.close();
		});

		test('should handle tools in bulk config (maps to sdkToolsPreset)', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/config-bulk-tools',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.updateBulk', {
				sessionId,
				config: {
					tools: 'sdk',
				},
				restartQuery: false,
			});

			expect(response.type).toBe('RESULT');
			ws.close();
		});
	});

	describe('Error handling for non-existent sessions', () => {
		test('config.env.get should error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.env.get', {
				sessionId: 'non-existent',
			});

			expect(response.type).toBe('ERROR');
			ws.close();
		});

		test('config.mcp.get should error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'config.mcp.get', {
				sessionId: 'non-existent',
			});

			expect(response.type).toBe('ERROR');
			ws.close();
		});
	});
});
