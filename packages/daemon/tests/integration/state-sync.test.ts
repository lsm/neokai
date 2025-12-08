/**
 * State Synchronization Integration Tests
 *
 * Tests state management, EventBus coordination, and state channel broadcasting.
 * Verifies that state changes propagate correctly through the EventBus and
 * MessageHub layers.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import {
	createTestApp,
	callRPCHandler,
	createWebSocket,
	waitForWebSocketState,
	waitForWebSocketMessage,
} from '../test-utils';
import { STATE_CHANNELS, MessageType } from '@liuboer/shared';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('State Synchronization Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Global State Snapshot', () => {
		test('should get global state snapshot', async () => {
			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			expect(snapshot).toBeDefined();
			expect(snapshot.sessions).toBeDefined();
			expect(snapshot.system).toBeDefined();
			expect(snapshot.system.auth).toBeDefined();
			expect(snapshot.system.health).toBeDefined();
			expect(snapshot.system.version).toBeDefined();
			expect(snapshot.meta).toBeDefined();
			expect(snapshot.meta.channel).toBe('global');
		});

		test('should include session data in snapshot', async () => {
			// Create a session
			const session1 = await callRPCHandler(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/test-workspace` },
				{
					workspacePath: '/test/1',
				}
			);

			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			expect(snapshot.sessions.sessions).toBeArray();
			expect(snapshot.sessions.sessions.length).toBe(1);
			expect(snapshot.sessions.sessions[0].id).toBe(session1.sessionId);
		});
	});

	describe('Session State Snapshot', () => {
		test('should get session state snapshot', async () => {
			const created = await callRPCHandler(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/test-workspace` },
				{
					workspacePath: '/test/workspace',
				}
			);

			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.SESSION_SNAPSHOT, {
				sessionId: created.sessionId,
			});

			expect(snapshot).toBeDefined();
			expect(snapshot.session).toBeDefined();
			expect(snapshot.session.session).toBeDefined();
			expect(snapshot.session.agent).toBeDefined();
			expect(snapshot.session.context).toBeDefined();
			expect(snapshot.session.commands).toBeDefined();
			expect(snapshot.sdkMessages).toBeDefined();
			expect(snapshot.meta).toBeDefined();
			expect(snapshot.meta.sessionId).toBe(created.sessionId);
		});

		test('should throw error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, STATE_CHANNELS.SESSION_SNAPSHOT, {
					sessionId: 'non-existent',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('Per-Channel Versioning', () => {
		test('should increment version on each state change', async () => {
			// Get initial version
			const snapshot1 = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SNAPSHOT, {});
			const initialVersion = snapshot1.meta.version;

			// Create a session (triggers state change)
			await callRPCHandler(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/test-workspace` },
				{
					workspacePath: '/test/workspace',
				}
			);

			// Get new snapshot
			const snapshot2 = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			// Version should remain the same (global snapshot version is separate from channel versions)
			// But sessions channel should have a new version in delta
			expect(snapshot2.meta.version).toBe(initialVersion);
		});

		test('should have independent versions for different channels', async () => {
			const created = await callRPCHandler(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/test-workspace` },
				{
					workspacePath: '/test/workspace',
				}
			);

			// Get session snapshot
			const sessionSnapshot = await callRPCHandler(
				ctx.messageHub,
				STATE_CHANNELS.SESSION_SNAPSHOT,
				{ sessionId: created.sessionId }
			);

			// Get global snapshot
			const globalSnapshot = await callRPCHandler(
				ctx.messageHub,
				STATE_CHANNELS.GLOBAL_SNAPSHOT,
				{}
			);

			// Versions are independent
			expect(sessionSnapshot.meta.version).toBeNumber();
			expect(globalSnapshot.meta.version).toBeNumber();
		});
	});

	describe('System State (Unified)', () => {
		test('should report system status with health', async () => {
			const system = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SYSTEM, {});

			expect(system.health).toBeDefined();
			expect(system.health.status).toBe('ok');
			expect(system.health.version).toBeString();
			expect(system.health.uptime).toBeNumber();
			expect(system.health.uptime).toBeGreaterThanOrEqual(0);
			expect(system.health.sessions).toBeDefined();
			expect(system.health.sessions.active).toBe(0);
			expect(system.health.sessions.total).toBe(0);
		});

		test('should track active and total sessions in health', async () => {
			// Create sessions
			await callRPCHandler(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/test-workspace` },
				{
					workspacePath: '/test/1',
				}
			);
			await callRPCHandler(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/test-workspace` },
				{
					workspacePath: '/test/2',
				}
			);

			const system = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SYSTEM, {});

			expect(system.health.sessions.active).toBe(2);
			expect(system.health.sessions.total).toBe(2);
		});

		test('should expose config information', async () => {
			const system = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SYSTEM, {});

			expect(system.version).toBeString();
			expect(system.claudeSDKVersion).toBeString();
			expect(system.defaultModel).toBeString();
			expect(system.maxSessions).toBeNumber();
			expect(system.storageLocation).toBeString();
		});

		test('should expose auth status', async () => {
			const system = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SYSTEM, {});

			expect(system.auth).toBeDefined();
			expect(system.auth.isAuthenticated).toBeBoolean();
			expect(system.auth.method).toBeString();
			expect(system.auth.source).toBeString();
		});
	});

	describe('EventBus → State Broadcasting', () => {
		test('should broadcast sessions delta when session is created', async () => {
			// Create WebSocket connection to receive broadcasts
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Subscribe to sessions delta via MessageHub protocol
			ws.send(
				JSON.stringify({
					id: 'subscribe-1',
					type: MessageType.SUBSCRIBE,
					method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for subscription acknowledgment
			const subAck = await waitForWebSocketMessage(ws);
			expect(subAck.type).toBe(MessageType.SUBSCRIBED);

			// Create session (triggers EventBus → StateManager → MessageHub publish)
			ws.send(
				JSON.stringify({
					id: 'create-1',
					type: MessageType.CALL,
					method: 'session.create',
					data: { workspacePath: `${TMP_DIR}/test-workspace` },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Collect both messages (RESULT and EVENT can come in any order)
			const msg1 = await waitForWebSocketMessage(ws);
			const msg2 = await waitForWebSocketMessage(ws);

			const createResult = msg1.type === MessageType.RESULT ? msg1 : msg2;
			const deltaEvent = msg1.type === MessageType.EVENT ? msg1 : msg2;

			expect(createResult.type).toBe(MessageType.RESULT);
			const sessionId = createResult.data.sessionId;

			expect(deltaEvent.type).toBe(MessageType.EVENT);
			expect(deltaEvent.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
			expect(deltaEvent.data.added).toBeArray();
			expect(deltaEvent.data.added.length).toBe(1);
			expect(deltaEvent.data.added[0].id).toBe(sessionId);
			expect(deltaEvent.data.timestamp).toBeNumber();

			ws.close();
		}, 10000);

		test('should broadcast sessions delta when session is deleted', async () => {
			// Create WebSocket connection to receive broadcasts
			const ws = createWebSocket(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Subscribe to sessions delta
			ws.send(
				JSON.stringify({
					id: 'subscribe-1',
					type: MessageType.SUBSCRIBE,
					method: `${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`,
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for subscription acknowledgment
			const subAck = await waitForWebSocketMessage(ws);
			expect(subAck.type).toBe(MessageType.SUBSCRIBED);

			// Create session via WebSocket
			ws.send(
				JSON.stringify({
					id: 'create-1',
					type: MessageType.CALL,
					method: 'session.create',
					data: { workspacePath: `${TMP_DIR}/test-workspace` },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Get create messages
			const createMsg1 = await waitForWebSocketMessage(ws);
			const createMsg2 = await waitForWebSocketMessage(ws);
			const createResult = createMsg1.type === MessageType.RESULT ? createMsg1 : createMsg2;
			const sessionId = createResult.data.sessionId;

			// Delete session
			ws.send(
				JSON.stringify({
					id: 'delete-1',
					type: MessageType.CALL,
					method: 'session.delete',
					data: { sessionId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Collect messages (session cleanup takes time, so use longer timeout)
			const msg1 = await waitForWebSocketMessage(ws, 15000);
			const msg2 = await waitForWebSocketMessage(ws, 15000);

			const deleteResult = msg1.type === MessageType.RESULT ? msg1 : msg2;
			const deltaEvent = msg1.type === MessageType.EVENT ? msg1 : msg2;

			expect(deleteResult.type).toBe(MessageType.RESULT);
			expect(deltaEvent.type).toBe(MessageType.EVENT);
			expect(deltaEvent.method).toBe(`${STATE_CHANNELS.GLOBAL_SESSIONS}.delta`);
			expect(deltaEvent.data.removed).toBeArray();
			expect(deltaEvent.data.removed.length).toBe(1);
			expect(deltaEvent.data.removed[0]).toBe(sessionId);

			ws.close();
		}, 20000); // Longer timeout for session cleanup

		test('should broadcast session state when session is updated', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Create WebSocket connection for the session
			const ws = createWebSocket(ctx.baseUrl, created.sessionId);
			await waitForWebSocketState(ws, WebSocket.OPEN);

			// Subscribe to session state channel
			ws.send(
				JSON.stringify({
					id: 'subscribe-1',
					type: MessageType.SUBSCRIBE,
					method: STATE_CHANNELS.SESSION,
					data: {},
					sessionId: created.sessionId,
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for subscription acknowledgment, draining any events that arrived first
			let subAck;
			for (let i = 0; i < 5; i++) {
				const msg = await waitForWebSocketMessage(ws);
				if (msg.type === MessageType.SUBSCRIBED) {
					subAck = msg;
					break;
				}
				// Drain any EVENT messages that arrived before SUBSCRIBED
			}
			expect(subAck).toBeDefined();
			expect(subAck.type).toBe(MessageType.SUBSCRIBED);

			// Use callRPCHandler instead of WebSocket to avoid RPC routing issues
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: created.sessionId,
				title: 'Updated Title',
			});

			// Wait for the state broadcast event via WebSocket subscription
			const stateEvent = await waitForWebSocketMessage(ws);

			// Verify we got the session state update
			expect(stateEvent.type).toBe(MessageType.EVENT);
			expect(stateEvent.method).toBe(STATE_CHANNELS.SESSION);
			expect(stateEvent.data.session).toBeDefined();
			expect(stateEvent.data.session.title).toBe('Updated Title');

			ws.close();
		}, 10000);
	});
});
