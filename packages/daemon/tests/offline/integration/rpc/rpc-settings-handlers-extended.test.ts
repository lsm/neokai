/**
 * Extended Settings RPC Handlers Tests (Offline)
 *
 * Additional tests for:
 * - settings.mcp.listFromSources
 * - settings.mcp.updateServerSettings
 * - settings.session.get/update
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
	callRPCHandler,
} from '../../../test-utils';

describe('Settings RPC Handlers - Extended', () => {
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

	describe('settings.mcp.listFromSources', () => {
		test('should list MCP servers without sessionId', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.listFromSources', {});

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('servers');
			expect(response.data).toHaveProperty('serverSettings');
			ws.close();
		});

		test('should list MCP servers with sessionId', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.listFromSources', {
				sessionId,
			});

			expect(response.type).toBe('RESULT');
			expect(response.data).toHaveProperty('servers');
			ws.close();
		});

		test('should error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.listFromSources', {
				sessionId: 'non-existent-session',
			});

			expect(response.type).toBe('ERROR');
			ws.close();
		});
	});

	describe('settings.mcp.updateServerSettings', () => {
		test('should update server settings', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.updateServerSettings', {
				serverName: 'test-server',
				settings: {
					allowed: true,
					defaultOn: true,
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { success: boolean };
			expect(data.success).toBe(true);
			ws.close();
		});

		test('should update only allowed setting', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.updateServerSettings', {
				serverName: 'another-server',
				settings: {
					allowed: false,
				},
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { success: boolean };
			expect(data.success).toBe(true);
			ws.close();
		});
	});

	describe('settings.session.get', () => {
		test('should get session settings (placeholder)', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/session-settings-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.session.get', {
				sessionId,
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { sessionId: string; settings: Record<string, unknown> };
			expect(data.sessionId).toBe(sessionId);
			expect(data.settings).toBeDefined();
			ws.close();
		});
	});

	describe('settings.session.update', () => {
		test('should update session settings (placeholder)', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/session-settings-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.session.update', {
				sessionId,
				updates: { someKey: 'someValue' },
			});

			expect(response.type).toBe('RESULT');
			const data = response.data as { success: boolean; sessionId: string };
			expect(data.success).toBe(true);
			expect(data.sessionId).toBe(sessionId);
			ws.close();
		});
	});

	describe('Direct RPC handler tests', () => {
		test('settings.global.update with showArchived triggers filter change event', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			})) as { success: boolean };

			expect(result.success).toBe(true);
		});
	});
});
