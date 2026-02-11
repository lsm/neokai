/**
 * Model RPC Handlers Tests (Offline)
 *
 * Tests for model-related RPC handlers:
 * - session.model.get
 * - session.model.switch
 * - models.clearCache
 *
 * For tests that require real API access (models.list),
 * see tests/online/session-handlers.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Model RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.model.get', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'model-get-1',
					type: 'REQ',
					method: 'session.model.get',
					data: {
						sessionId: 'non-existent',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();

			ws.close();
		});

		test('should return current model for existing session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/model-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'model-get-2',
					type: 'REQ',
					method: 'session.model.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			expect(response.data.currentModel).toBeString();
			expect(response.data.modelInfo).toBeDefined();

			ws.close();
		});
	});

	describe('session.model.switch', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'model-switch-1',
					type: 'REQ',
					method: 'session.model.switch',
					data: {
						sessionId: 'non-existent',
						model: 'claude-opus-4-20250514',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();

			ws.close();
		});

		test('should accept model switch request for invalid model', async () => {
			// EventBus-centric: RPC accepts request, validation happens async via EventBus
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/model-switch',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'model-switch-2',
					type: 'REQ',
					method: 'session.model.switch',
					data: {
						sessionId,
						model: 'invalid-model-name',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			// Synchronous: RPC returns {success: false, error} for invalid model
			expect(response.data.success).toBe(false);
			expect(response.data.error).toBeDefined();

			ws.close();
		});

		test('should accept model switch request for same model', async () => {
			// Synchronous: RPC returns {success: true, model} for same model (already using)
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/model-switch',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Get current model
			const getPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'model-get-3',
					type: 'REQ',
					method: 'session.model.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const getResponse = await getPromise;
			const currentModel = getResponse.data.currentModel;

			// Try to switch to same model
			const switchPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'model-switch-3',
					type: 'REQ',
					method: 'session.model.switch',
					data: {
						sessionId,
						model: currentModel,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await switchPromise;

			expect(response.type).toBe('RSP');
			// Synchronous: RPC returns {success: true, model} for same model
			expect(response.data.success).toBe(true);
			expect(response.data.model).toBe(currentModel);

			ws.close();
		});
	});

	describe('models.clearCache', () => {
		test('should clear model cache successfully', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'models-clear-1',
					type: 'REQ',
					method: 'models.clearCache',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RSP');
			expect(response.data.success).toBe(true);

			ws.close();
		});
	});
});
