/**
 * Interrupt RPC Handlers Tests (Offline)
 *
 * Tests for client interrupt functionality:
 * - client.interrupt
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Interrupt RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
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
			// EventBus-centric: RPC returns accepted, actual result via EventBus
			expect(response.data.accepted).toBe(true);

			ws.close();
		});
	});
});
