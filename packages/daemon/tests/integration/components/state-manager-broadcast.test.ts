/**
 * StateManager Broadcast Method Tests
 *
 * Tests for StateManager's explicit broadcast methods:
 * - broadcastSessionsChange
 * - broadcastSessionsDelta
 * - broadcastSystemChange
 * - broadcastSDKMessagesChange
 * - broadcastSDKMessagesDelta
 * - broadcastSessionStateChange
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../test-utils';
import { STATE_CHANNELS } from '@liuboer/shared';

describe('StateManager Broadcast Methods', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test('broadcastSessionsChange should broadcast full sessions list', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe to sessions channel
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-1',
				type: 'SUBSCRIBE',
				method: STATE_CHANNELS.GLOBAL_SESSIONS,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener before triggering broadcast
		const eventPromise = waitForWebSocketMessage(ws);

		// Trigger broadcast
		await ctx.stateManager.broadcastSessionsChange();

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.GLOBAL_SESSIONS);
		expect(event.data.sessions).toBeArray();
		expect(event.data.version).toBeNumber();

		ws.close();
	});

	test('broadcastSessionsDelta should broadcast delta update', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-2',
				type: 'SUBSCRIBE',
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener
		const eventPromise = waitForWebSocketMessage(ws);

		// Trigger delta broadcast
		await ctx.stateManager.broadcastSessionsDelta({
			added: [
				{
					id: 'test-session',
					title: 'Test',
					workspacePath: '/test',
					createdAt: new Date().toISOString(),
					lastActiveAt: new Date().toISOString(),
					status: 'active',
					config: {
						model: 'claude-sonnet-4-5-20250929',
						maxTokens: 8192,
						temperature: 1.0,
					},
					metadata: {},
				},
			],
			timestamp: Date.now(),
		});

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
		expect(event.data.added).toBeArray();
		expect(event.data.added.length).toBe(1);
		expect(event.data.version).toBeNumber();

		ws.close();
	});

	test('broadcastSystemChange should broadcast system state', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-3',
				type: 'SUBSCRIBE',
				method: STATE_CHANNELS.GLOBAL_SYSTEM,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener
		const eventPromise = waitForWebSocketMessage(ws);

		// Trigger broadcast
		await ctx.stateManager.broadcastSystemChange();

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.GLOBAL_SYSTEM);
		expect(event.data.version).toBeDefined();
		expect(event.data.health).toBeDefined();

		ws.close();
	});

	test('broadcastSDKMessagesChange should broadcast SDK messages', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/state-manager',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-4',
				type: 'SUBSCRIBE',
				method: STATE_CHANNELS.SESSION_SDK_MESSAGES,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener
		const eventPromise = waitForWebSocketMessage(ws);

		// Trigger broadcast
		await ctx.stateManager.broadcastSDKMessagesChange(sessionId);

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.SESSION_SDK_MESSAGES);
		expect(event.data.sdkMessages).toBeArray();

		ws.close();
	});

	test('broadcastSDKMessagesDelta should broadcast SDK message delta', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/state-manager',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-5',
				type: 'SUBSCRIBE',
				method: `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener
		const eventPromise = waitForWebSocketMessage(ws);

		// Trigger delta broadcast
		await ctx.stateManager.broadcastSDKMessagesDelta(sessionId, {
			added: [
				{
					type: 'user' as const,
					message: { role: 'user' as const, content: 'Test' },
					parent_tool_use_id: null,
					uuid: 'test-uuid',
					session_id: sessionId,
				},
			],
			timestamp: Date.now(),
		});

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`);
		expect(event.data.added).toBeArray();
		expect(event.data.version).toBeNumber();

		ws.close();
	});

	test('broadcastSessionStateChange should broadcast unified session state', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/state-manager',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-6',
				type: 'SUBSCRIBE',
				method: STATE_CHANNELS.SESSION,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener
		const eventPromise = waitForWebSocketMessage(ws);

		// Trigger broadcast
		await ctx.stateManager.broadcastSessionStateChange(sessionId);

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.SESSION);
		// Unified session state uses sessionInfo (not session)
		expect(event.data.sessionInfo).toBeDefined();
		expect(event.data.agentState).toBeDefined();

		ws.close();
	});

	test('broadcastSessionStateChange should handle deleted session gracefully', async () => {
		// This should not throw
		await expect(
			ctx.stateManager.broadcastSessionStateChange('non-existent-session')
		).resolves.toBeUndefined();
	});

	test('broadcastSessionStateChange should broadcast correct agentState after state changes', async () => {
		// This test verifies that the broadcast correctly reflects agent state changes
		// The fallback mechanism (for race conditions) is an internal safeguard
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/agentstate-test',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		// Subscribe to session state
		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-agentstate',
				type: 'SUBSCRIBE',
				method: STATE_CHANNELS.SESSION,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		// Set up event listener
		const eventPromise = waitForWebSocketMessage(ws, 2000);

		// Trigger broadcast - should include agentState with idle status
		await ctx.stateManager.broadcastSessionStateChange(sessionId);

		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.SESSION);
		expect(event.data.agentState).toBeDefined();
		// New sessions should have idle status
		expect(event.data.agentState.status).toBe('idle');

		ws.close();
	});
});
