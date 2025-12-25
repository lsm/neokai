/**
 * StateManager Tests
 *
 * Tests for StateManager broadcast methods and state channels
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../test-utils';
import { STATE_CHANNELS } from '@liuboer/shared';

describe('StateManager', () => {
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

	describe('Session State', () => {
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
					type: 'CALL',
					method: STATE_CHANNELS.SESSION,
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			// Unified session state uses sessionInfo (not session)
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
					type: 'CALL',
					method: STATE_CHANNELS.SESSION,
					data: { sessionId: 'non-existent' },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('Session not found');

			ws.close();
		});
	});

	describe('Session Snapshot', () => {
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
					type: 'CALL',
					method: STATE_CHANNELS.SESSION_SNAPSHOT,
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.session).toBeDefined();
			expect(response.data.sdkMessages).toBeDefined();
			expect(response.data.meta).toBeDefined();
			expect(response.data.meta.sessionId).toBe(sessionId);

			ws.close();
		});
	});

	describe('SDK Messages State', () => {
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
					type: 'CALL',
					method: STATE_CHANNELS.SESSION_SDK_MESSAGES,
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.sdkMessages).toBeArray();
			expect(response.data.timestamp).toBeNumber();

			ws.close();
		});
	});

	describe('Broadcast Methods', () => {
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
						config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1.0 },
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
	});

	describe('EventBus Integration', () => {
		test('should broadcast delta on session:created event', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-eb-1',
					type: 'SUBSCRIBE',
					method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Set up event listener before creating session
			const eventPromise = waitForWebSocketMessage(ws);

			// Create a session (triggers session:created event)
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/eventbus',
			});

			// Should receive delta with added session
			const event = await eventPromise;

			expect(event.type).toBe('EVENT');
			expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
			expect(event.data.added).toBeArray();
			expect(event.data.added.length).toBe(1);
			expect(event.data.added[0].id).toBe(sessionId);

			ws.close();
		});

		test('should broadcast delta on session:deleted event', async () => {
			// Create a session first
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/eventbus',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-eb-2',
					type: 'SUBSCRIBE',
					method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Set up event listener before deleting session
			const eventPromise = waitForWebSocketMessage(ws);

			// Delete the session
			await ctx.sessionManager.deleteSession(sessionId);

			// Should receive delta with removed session
			const event = await eventPromise;

			expect(event.type).toBe('EVENT');
			expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
			expect(event.data.removed).toBeArray();
			expect(event.data.removed).toContain(sessionId);

			ws.close();
		});

		test('should broadcast removed delta when session is archived and showArchived is false', async () => {
			// Create a session first
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/archive-filter',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe to delta channel
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-archive-1',
					type: 'SUBSCRIBE',
					method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Set up event listener before archiving
			const eventPromise = waitForWebSocketMessage(ws);

			// Archive the session (non-worktree, no confirmation needed)
			await ctx.sessionManager.updateSession(sessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
			});

			// Should receive delta with removed session (since showArchived defaults to false)
			const event = await eventPromise;

			expect(event.type).toBe('EVENT');
			expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
			expect(event.data.removed).toBeArray();
			expect(event.data.removed).toContain(sessionId);

			ws.close();
		});

		test('should broadcast updated delta when session is archived and showArchived is true', async () => {
			// Enable showArchived
			await ctx.settingsManager.updateGlobalSettings({ showArchived: true });

			// Create a session first
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/archive-filter-show',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe to delta channel
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-archive-2',
					type: 'SUBSCRIBE',
					method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Set up event listener before archiving
			const eventPromise = waitForWebSocketMessage(ws);

			// Archive the session
			await ctx.sessionManager.updateSession(sessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
			});

			// Should receive delta with updated session (since showArchived is true)
			const event = await eventPromise;

			expect(event.type).toBe('EVENT');
			expect(event.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
			expect(event.data.updated).toBeArray();
			expect(event.data.updated.length).toBe(1);
			expect(event.data.updated[0].id).toBe(sessionId);
			expect(event.data.updated[0].status).toBe('archived');

			// Reset showArchived to default
			await ctx.settingsManager.updateGlobalSettings({ showArchived: false });

			ws.close();
		});

		test('should update hasArchivedSessions flag when archiving first session', async () => {
			// Create a session first
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/archive-flag',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			// Subscribe to sessions channel to get hasArchivedSessions updates
			const subPromise = waitForWebSocketMessage(ws);
			ws.send(
				JSON.stringify({
					id: 'sub-archive-3',
					type: 'SUBSCRIBE',
					method: STATE_CHANNELS.GLOBAL_SESSIONS,
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);
			await subPromise;

			// Set up event listener before archiving
			const eventPromise = waitForWebSocketMessage(ws);

			// Archive the session
			await ctx.sessionManager.updateSession(sessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
			});

			// Should receive full sessions state with hasArchivedSessions = true
			const event = await eventPromise;

			expect(event.type).toBe('EVENT');
			expect(event.method).toBe(STATE_CHANNELS.GLOBAL_SESSIONS);
			expect(event.data.hasArchivedSessions).toBe(true);

			ws.close();
		});
	});
});
