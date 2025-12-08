/**
 * Session Handlers Tests
 *
 * Tests for session-related RPC handlers:
 * - message.send
 * - client.interrupt
 * - session.model.get
 * - session.model.switch
 * - models.list
 * - models.clearCache
 * - agent.getState
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from './test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
	hasApiKey,
} from './test-utils';

describe('Session RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('message.send', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'msg-1',
					type: 'CALL',
					method: 'message.send',
					data: {
						sessionId: 'non-existent',
						content: 'Hello',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			// Could be either SESSION_NOT_FOUND from setup-websocket.ts or "Session not found" from handler
			expect(
				response.errorCode === 'SESSION_NOT_FOUND' || response.error?.includes('Session not found')
			).toBe(true);

			ws.close();
		});

		// Note: This test requires API key (not just OAuth) because message.send uses Claude SDK
		test.skipIf(!hasApiKey())('should accept message for existing session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/message-send',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'msg-2',
					type: 'CALL',
					method: 'message.send',
					data: {
						sessionId,
						content: 'Hello, Claude!',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.messageId).toBeString();

			ws.close();
		});
	});

	describe('client.interrupt', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'int-1',
					type: 'CALL',
					method: 'client.interrupt',
					data: {
						sessionId: 'non-existent',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');

			ws.close();
		});

		test('should successfully interrupt an existing session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/interrupt',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'int-2',
					type: 'CALL',
					method: 'client.interrupt',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.success).toBe(true);

			ws.close();
		});
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
					type: 'CALL',
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

			expect(response.type).toBe('ERROR');

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
					type: 'CALL',
					method: 'session.model.get',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
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
					type: 'CALL',
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

			expect(response.type).toBe('ERROR');

			ws.close();
		});

		test('should return error for invalid model', async () => {
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
					type: 'CALL',
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

			expect(response.type).toBe('RESULT');
			expect(response.data.success).toBe(false);
			expect(response.data.error).toContain('Invalid model');

			ws.close();
		});

		test('should indicate already using model if same model', async () => {
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
					type: 'CALL',
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
					type: 'CALL',
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

			expect(response.type).toBe('RESULT');
			expect(response.data.success).toBe(true);
			expect(response.data.error).toContain('Already using');

			ws.close();
		});
	});

	describe('models.list', () => {
		// Note: Models API doesn't support OAuth, only API key
		test.skipIf(!hasApiKey())('should return list of models with cache', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'models-list-1',
					type: 'CALL',
					method: 'models.list',
					data: {
						useCache: true,
						forceRefresh: false,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.models).toBeArray();

			ws.close();
		});

		test.skipIf(!hasApiKey())('should return list of models without cache', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'models-list-2',
					type: 'CALL',
					method: 'models.list',
					data: {
						useCache: false,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.models).toBeArray();
			expect(response.data.cached).toBe(false);

			ws.close();
		});

		test.skipIf(!hasApiKey())('should force refresh cache', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws, 10000);

			ws.send(
				JSON.stringify({
					id: 'models-list-3',
					type: 'CALL',
					method: 'models.list',
					data: {
						useCache: true,
						forceRefresh: true,
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.models).toBeArray();

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
					type: 'CALL',
					method: 'models.clearCache',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.success).toBe(true);

			ws.close();
		});
	});

	describe('agent.getState', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'agent-state-1',
					type: 'CALL',
					method: 'agent.getState',
					data: {
						sessionId: 'non-existent',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');

			ws.close();
		});

		test('should return agent state for existing session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-state',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'agent-state-2',
					type: 'CALL',
					method: 'agent.getState',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.state).toBeDefined();
			expect(response.data.state.status).toBe('idle');

			ws.close();
		});
	});
});
