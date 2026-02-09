/**
 * Agent RPC Handlers Tests (Offline)
 *
 * Tests for agent state and query management RPC handlers:
 * - agent.getState
 * - session.resetQuery
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Agent RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
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

	describe('session.resetQuery', () => {
		test('should return error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'reset-1',
					type: 'CALL',
					method: 'session.resetQuery',
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

		test('should accept reset query request for existing session', async () => {
			// EventBus-centric: RPC accepts request, reset happens async via EventBus
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/reset-query',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'reset-2',
					type: 'CALL',
					method: 'session.resetQuery',
					data: { sessionId, restartQuery: true },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			// RPC returns success/failure directly
			expect(response.data.success).toBe(true);

			ws.close();
		});

		test('should accept reset request without restarting query when restartQuery=false', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/reset-no-restart',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'reset-3',
					type: 'CALL',
					method: 'session.resetQuery',
					data: { sessionId, restartQuery: false },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			// RPC returns success/failure directly
			expect(response.data.success).toBe(true);

			ws.close();
		});

		test('should reset agent state to idle after reset', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/reset-state',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Reset the query
			const resetPromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'reset-4',
					type: 'CALL',
					method: 'session.resetQuery',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const resetResponse = await resetPromise;
			expect(resetResponse.type).toBe('RESULT');
			// RPC returns success/failure directly
			expect(resetResponse.data.success).toBe(true);

			// Verify state is idle
			const statePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'reset-5',
					type: 'CALL',
					method: 'agent.getState',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const stateResponse = await statePromise;
			expect(stateResponse.type).toBe('RESULT');
			expect(stateResponse.data.state.status).toBe('idle');

			ws.close();
		});
	});
});
