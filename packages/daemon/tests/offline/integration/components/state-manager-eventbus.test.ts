/**
 * StateManager EventBus Integration Tests
 *
 * Tests for automatic broadcasts triggered by EventBus events:
 * - session:created events
 * - session:deleted events
 * - session archive handling with showArchived setting
 * - hasArchivedSessions flag updates
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

describe('StateManager EventBus Integration', () => {
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
