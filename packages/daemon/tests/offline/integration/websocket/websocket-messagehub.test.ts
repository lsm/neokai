/**
 * WebSocket + MessageHub Integration Tests
 *
 * Tests the full stack: WebSocket transport → MessageHub → RPC handlers.
 * Verifies bidirectional RPC and pub/sub over WebSocket connections.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../../test-utils';
import {
	createTestApp,
	createWebSocket,
	waitForWebSocketState,
	waitForWebSocketMessage,
} from '../../../test-utils';

describe('WebSocket + MessageHub Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('WebSocket Connection', () => {
		test('should establish WebSocket connection', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');

			await waitForWebSocketState(ws, WebSocket.OPEN);

			expect(ws.readyState).toBe(WebSocket.OPEN);

			ws.close();
			await waitForWebSocketState(ws, WebSocket.CLOSED);
		});

		test('should handle multiple concurrent connections', async () => {
			const ws1 = createWebSocket(ctx.baseUrl, 'global');
			const ws2 = createWebSocket(ctx.baseUrl, 'global');
			const ws3 = createWebSocket(ctx.baseUrl, 'global');

			await Promise.all([
				waitForWebSocketState(ws1, WebSocket.OPEN),
				waitForWebSocketState(ws2, WebSocket.OPEN),
				waitForWebSocketState(ws3, WebSocket.OPEN),
			]);

			expect(ws1.readyState).toBe(WebSocket.OPEN);
			expect(ws2.readyState).toBe(WebSocket.OPEN);
			expect(ws3.readyState).toBe(WebSocket.OPEN);

			ws1.close();
			ws2.close();
			ws3.close();
		});
	});

	describe('RPC over WebSocket', () => {
		test('should execute RPC call over WebSocket', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Send RPC call using proper protocol format
			const messageId = 'test-call-1';
			ws.send(
				JSON.stringify({
					id: messageId,
					type: 'CALL',
					method: 'session.list',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for response
			const response = await waitForWebSocketMessage(ws);

			expect(response.type).toBe('RESULT');
			expect(response.requestId).toBe(messageId);
			expect(response.data).toBeDefined();
			expect(response.data.sessions).toBeArray();

			ws.close();
		});

		test('should handle RPC errors over WebSocket', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Send RPC call for non-existent session
			const messageId = 'test-call-2';
			ws.send(
				JSON.stringify({
					id: messageId,
					type: 'CALL',
					method: 'session.get',
					data: { sessionId: 'non-existent' },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for error response
			const response = await waitForWebSocketMessage(ws);

			expect(response.type).toBe('ERROR');
			expect(response.requestId).toBe(messageId);
			expect(response.error).toBeDefined();
			expect(response.error).toContain('Session not found');

			ws.close();
		});

		test('should create session via WebSocket RPC', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Create session
			const messageId = 'create-session';
			ws.send(
				JSON.stringify({
					id: messageId,
					type: 'CALL',
					method: 'session.create',
					data: { workspacePath: '/test/ws' },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for result
			const response = await waitForWebSocketMessage(ws);

			expect(response.type).toBe('RESULT');
			expect(response.data.sessionId).toBeString();

			// Verify in database
			const session = ctx.db.getSession(response.data.sessionId);
			expect(session).toBeDefined();
			expect(session?.workspacePath).toBe('/test/ws');

			ws.close();
		});
	});

	describe('Multiple Clients', () => {
		test('should handle client disconnection gracefully', async () => {
			const ws1 = createWebSocket(ctx.baseUrl, 'global');
			const ws2 = createWebSocket(ctx.baseUrl, 'global');

			await Promise.all([
				waitForWebSocketState(ws1, WebSocket.OPEN),
				waitForWebSocketState(ws2, WebSocket.OPEN),
			]);

			// Close ws1
			ws1.close();
			await waitForWebSocketState(ws1, WebSocket.CLOSED);

			// ws2 should still work
			ws2.send(
				JSON.stringify({
					type: 'CALL',
					method: 'session.list',
					data: {},
					id: 'list-1',
					sessionId: 'global',

					timestamp: new Date().toISOString(),

					version: '1.0.0',
				})
			);

			const response = await waitForWebSocketMessage(ws2);
			expect(response.type).toBe('RESULT');

			ws2.close();
		});
	});

	describe('Error Handling', () => {
		test('should handle invalid JSON', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Send invalid JSON
			ws.send('invalid json {{{');

			// Should get error response or connection should close
			// WebSocket error handling varies, just ensure it doesn't crash the server
			await Bun.sleep(100);

			// Server should still be functional
			const ws2 = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws2, WebSocket.OPEN);
			expect(ws2.readyState).toBe(WebSocket.OPEN);

			ws.close();
			ws2.close();
		});

		test('should handle missing method', async () => {
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			ws.send(
				JSON.stringify({
					type: 'CALL',
					method: 'nonexistent.method',
					data: {},
					id: 'missing-1',
					sessionId: 'global',

					timestamp: new Date().toISOString(),

					version: '1.0.0',
				})
			);

			const response = await waitForWebSocketMessage(ws);
			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('No handler');

			ws.close();
		});
	});
});
