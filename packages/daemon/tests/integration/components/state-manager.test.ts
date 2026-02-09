/**
 * StateManager Integration Tests
 *
 * Consolidated tests for StateManager:
 * - Broadcast methods (sessions, system, SDK messages, session state)
 * - EventBus integration (automatic broadcasts on session events)
 * - RPC handlers for global state channels
 * - RPC handlers for session-specific state channels
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../helpers/test-app';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';
import { STATE_CHANNELS } from '@neokai/shared';

// =============================================================================
// Broadcast Methods
// =============================================================================

describe.skip('StateManager Broadcast Methods (DEPRECATED - uses old SUBSCRIBE protocol)', () => {
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

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-1',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: STATE_CHANNELS.GLOBAL_SESSIONS,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
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

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-2',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
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

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-3',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: STATE_CHANNELS.GLOBAL_SYSTEM,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
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

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-4',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: STATE_CHANNELS.SESSION_SDK_MESSAGES,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
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

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-5',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
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

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-6',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: STATE_CHANNELS.SESSION,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
		await ctx.stateManager.broadcastSessionStateChange(sessionId);
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.SESSION);
		expect(event.data.sessionInfo).toBeDefined();
		expect(event.data.agentState).toBeDefined();

		ws.close();
	});

	test('broadcastSessionStateChange should handle deleted session gracefully', async () => {
		await expect(
			ctx.stateManager.broadcastSessionStateChange('non-existent-session')
		).resolves.toBeUndefined();
	});

	test('broadcastSessionStateChange should broadcast correct agentState after state changes', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/agentstate-test',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-agentstate',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: STATE_CHANNELS.SESSION,
				sessionId,
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws, 2000);
		await ctx.stateManager.broadcastSessionStateChange(sessionId);
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.SESSION);
		expect(event.data.agentState).toBeDefined();
		expect(event.data.agentState.status).toBe('idle');

		ws.close();
	});
});

// =============================================================================
// EventBus Integration
// =============================================================================

describe.skip('StateManager EventBus Integration (DEPRECATED - uses old SUBSCRIBE protocol)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test('should broadcast delta on session:created event', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-eb-1',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/eventbus',
		});
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
		expect(event.data.added).toBeArray();
		expect(event.data.added.length).toBe(1);
		expect(event.data.added[0].id).toBe(sessionId);

		ws.close();
	});

	test('should broadcast delta on session:deleted event', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/eventbus',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-eb-2',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
		await ctx.sessionManager.deleteSession(sessionId);
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
		expect(event.data.removed).toBeArray();
		expect(event.data.removed).toContain(sessionId);

		ws.close();
	});

	test('should broadcast removed delta when session is archived and showArchived is false', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/archive-filter',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-archive-1',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
		await ctx.sessionManager.updateSession(sessionId, {
			status: 'archived',
			archivedAt: new Date().toISOString(),
		});
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
		expect(event.data.removed).toBeArray();
		expect(event.data.removed).toContain(sessionId);

		ws.close();
	});

	test('should broadcast updated delta when session is archived and showArchived is true', async () => {
		await ctx.settingsManager.updateGlobalSettings({ showArchived: true });

		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/archive-filter-show',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-archive-2',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
		await ctx.sessionManager.updateSession(sessionId, {
			status: 'archived',
			archivedAt: new Date().toISOString(),
		});
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
		expect(event.data.updated).toBeArray();
		expect(event.data.updated.length).toBe(1);
		expect(event.data.updated[0].id).toBe(sessionId);
		expect(event.data.updated[0].status).toBe('archived');

		await ctx.settingsManager.updateGlobalSettings({ showArchived: false });
		ws.close();
	});

	test('should update hasArchivedSessions flag when archiving first session', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/archive-flag',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-archive-3',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: STATE_CHANNELS.GLOBAL_SESSIONS,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const eventPromise = waitForWebSocketMessage(ws);
		await ctx.sessionManager.updateSession(sessionId, {
			status: 'archived',
			archivedAt: new Date().toISOString(),
		});
		const event = await eventPromise;

		expect(event.type).toBe('EVENT');
		expect(event.method).toBe(STATE_CHANNELS.GLOBAL_SESSIONS);
		expect(event.data.hasArchivedSessions).toBe(true);

		ws.close();
	});

	test('should NOT broadcast corrupted data when session.updated event has partial data for uncached session', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const subPromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sub-partial-1',
				type: 'SUBSCRIBE', // DEPRECATED - needs room-based rewrite
				method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		await subPromise;

		const fakeSessionId = 'uncached-session-' + Date.now();
		await ctx.eventBus.emit('session.updated', {
			sessionId: fakeSessionId,
			source: 'metadata',
			session: {
				metadata: { totalCost: 0.05, messageCount: 5 },
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 200));

		const checkPromise = Promise.race([
			waitForWebSocketMessage(ws),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
		]);

		const result = await checkPromise;
		expect(result).toBeNull();

		ws.close();
	});
});

// =============================================================================
// RPC - Global State Channels
// =============================================================================

describe.skip('StateManager RPC - Global State (DEPRECATED - uses old SUBSCRIBE protocol)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test('should return global snapshot via RPC', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'snapshot-1',
				type: 'REQ',
				method: STATE_CHANNELS.GLOBAL_SNAPSHOT,
				data: {},
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.data.sessions).toBeDefined();
		expect(response.data.system).toBeDefined();
		expect(response.data.meta).toBeDefined();
		expect(response.data.meta.channel).toBe('global');

		ws.close();
	});

	test('should return system state via RPC', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'system-1',
				type: 'REQ',
				method: STATE_CHANNELS.GLOBAL_SYSTEM,
				data: {},
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.data.version).toBeDefined();
		expect(response.data.claudeSDKVersion).toBeDefined();
		expect(response.data.defaultModel).toBeDefined();
		expect(response.data.auth).toBeDefined();
		expect(response.data.health).toBeDefined();
		expect(response.data.health.status).toBe('ok');

		ws.close();
	});

	test('should return sessions state via RPC', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sessions-1',
				type: 'REQ',
				method: STATE_CHANNELS.GLOBAL_SESSIONS,
				data: {},
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.data.sessions).toBeArray();
		expect(response.data.timestamp).toBeNumber();

		ws.close();
	});
});

// =============================================================================
// RPC - Session-Specific State Channels
// =============================================================================

describe.skip('StateManager RPC - Session State (DEPRECATED - uses old SUBSCRIBE protocol)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test('should return session state via RPC', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/state-manager',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'session-state-1',
				type: 'REQ',
				method: STATE_CHANNELS.SESSION,
				data: { sessionId },
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.data.sessionInfo).toBeDefined();
		expect(response.data.sessionInfo.id).toBe(sessionId);
		expect(response.data.agentState).toBeDefined();
		expect(response.data.commandsData).toBeDefined();

		ws.close();
	});

	test('should throw error for non-existent session', async () => {
		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'session-state-2',
				type: 'REQ',
				method: STATE_CHANNELS.SESSION,
				data: { sessionId: 'non-existent' },
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.error).toBeDefined();
		expect(response.error).toContain('Session not found');

		ws.close();
	});

	test('should return session snapshot via RPC', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/state-manager',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'snapshot-2',
				type: 'REQ',
				method: STATE_CHANNELS.SESSION_SNAPSHOT,
				data: { sessionId },
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.data.session).toBeDefined();
		expect(response.data.sdkMessages).toBeDefined();
		expect(response.data.meta).toBeDefined();
		expect(response.data.meta.sessionId).toBe(sessionId);

		ws.close();
	});

	test('should return SDK messages state via RPC', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: '/test/state-manager',
		});

		const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
		await waitForWebSocketState(ws, WebSocket.OPEN);
		await firstMessagePromise;

		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: 'sdk-msgs-1',
				type: 'REQ',
				method: STATE_CHANNELS.SESSION_SDK_MESSAGES,
				data: { sessionId },
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		const response = await responsePromise;

		expect(response.type).toBe('RSP');
		expect(response.data.sdkMessages).toBeArray();
		expect(response.data.timestamp).toBeNumber();

		ws.close();
	});
});
