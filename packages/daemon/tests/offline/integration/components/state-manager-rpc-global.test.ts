/**
 * StateManager RPC Tests - Global State Channels
 *
 * Tests for global-scoped state channel RPC handlers:
 * - Global State Snapshot
 * - System State
 * - Sessions State
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../../test-utils';
import { STATE_CHANNELS } from '@liuboer/shared';

describe('StateManager RPC - Global State', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Global State Snapshot', () => {
		test('should return global snapshot via RPC', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'snapshot-1',
					type: 'CALL',
					method: STATE_CHANNELS.GLOBAL_SNAPSHOT,
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.sessions).toBeDefined();
			expect(response.data.system).toBeDefined();
			expect(response.data.meta).toBeDefined();
			expect(response.data.meta.channel).toBe('global');

			ws.close();
		});
	});

	describe('System State', () => {
		test('should return system state via RPC', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'system-1',
					type: 'CALL',
					method: STATE_CHANNELS.GLOBAL_SYSTEM,
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.version).toBeDefined();
			expect(response.data.claudeSDKVersion).toBeDefined();
			expect(response.data.defaultModel).toBeDefined();
			expect(response.data.auth).toBeDefined();
			expect(response.data.health).toBeDefined();
			expect(response.data.health.status).toBe('ok');

			ws.close();
		});
	});

	describe('Sessions State', () => {
		test('should return sessions state via RPC', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sessions-1',
					type: 'CALL',
					method: STATE_CHANNELS.GLOBAL_SESSIONS,
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.sessions).toBeArray();
			expect(response.data.timestamp).toBeNumber();

			ws.close();
		});
	});
});
