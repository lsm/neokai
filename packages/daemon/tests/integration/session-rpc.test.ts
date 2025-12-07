/**
 * Session RPC Integration Tests
 *
 * Tests session management RPC handlers with real MessageHub integration.
 * Does NOT make actual SDK calls to Claude - focuses on testing the daemon's
 * session management layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Session RPC Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.create', () => {
		test('should create a new session', async () => {
			const workspacePath = `${TMP_DIR}/test-workspace`;
			const result = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath,
			});

			expect(result).toBeDefined();
			expect(result.sessionId).toBeString();
			expect(result.sessionId.length).toBeGreaterThan(0);

			// Verify session was saved to database
			const session = ctx.db.getSession(result.sessionId);
			expect(session).toBeDefined();
			expect(session?.workspacePath).toBe(workspacePath);
			expect(session?.status).toBe('active');
		});

		test('should create session with custom config', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
				config: {
					model: 'claude-3-5-sonnet-20241022',
					maxTokens: 4096,
					temperature: 0.5,
				},
			});

			const session = ctx.db.getSession(result.sessionId);
			expect(session?.config.model).toBe('claude-3-5-sonnet-20241022');
			expect(session?.config.maxTokens).toBe(4096);
			expect(session?.config.temperature).toBe(0.5);
		});

		test('should broadcast session.created event via EventBus', async () => {
			// Subscribe to session creation event
			let createdSession = null;
			const eventPromise = new Promise((resolve) => {
				(ctx.stateManager as unknown).eventBus.on('session:created', (data: unknown) => {
					createdSession = data.session;
					resolve(data);
				});
			});

			// Create session
			const result = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Wait for event
			await eventPromise;

			expect(createdSession).toBeDefined();
			expect((createdSession as unknown).id).toBe(result.sessionId);
		});
	});

	describe('session.list', () => {
		test('should list all sessions', async () => {
			// Create multiple sessions
			const session1 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-1`,
			});
			const session2 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-2`,
			});

			const result = await callRPCHandler(ctx.messageHub, 'session.list', {});

			expect(result.sessions).toBeArray();
			expect(result.sessions.length).toBe(2);

			const sessionIds = result.sessions.map((s: unknown) => s.id);
			expect(sessionIds).toContain(session1.sessionId);
			expect(sessionIds).toContain(session2.sessionId);
		});

		test('should return empty array when no sessions exist', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'session.list', {});

			expect(result.sessions).toBeArray();
			expect(result.sessions.length).toBe(0);
		});
	});

	describe('session.get', () => {
		test('should get session details', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			const result = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId: created.sessionId,
			});

			expect(result.session).toBeDefined();
			expect(result.session.id).toBe(created.sessionId);
			expect(result.session.workspacePath).toBe(`${TMP_DIR}/test-workspace`);
			expect(result.messages).toBeArray();
			expect(result.context).toBeDefined();
		});

		test('should throw error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.get', {
					sessionId: 'non-existent-id',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.update', () => {
		test('should update session title', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			const result = await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: created.sessionId,
				title: 'Updated Title',
			});

			expect(result.success).toBe(true);

			const session = ctx.db.getSession(created.sessionId);
			expect(session?.title).toBe('Updated Title');
		});

		test('should emit session:updated event via EventBus', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			let eventReceived = false;
			const eventPromise = new Promise((resolve) => {
				(ctx.stateManager as unknown).eventBus.on('session:updated', (data: unknown) => {
					if (data.sessionId === created.sessionId) {
						eventReceived = true;
						resolve(data);
					}
				});
			});

			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: created.sessionId,
				title: 'New Title',
			});

			await eventPromise;
			expect(eventReceived).toBe(true);
		});
	});

	describe('session.delete', () => {
		test('should delete session', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			const result = await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: created.sessionId,
			});

			expect(result.success).toBe(true);

			// Verify session was deleted from database
			const session = ctx.db.getSession(created.sessionId);
			expect(session).toBeNull();
		});

		test('should emit session:deleted event via EventBus', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			let deletedSessionId = null;
			const eventPromise = new Promise((resolve) => {
				(ctx.stateManager as unknown).eventBus.on('session:deleted', (data: unknown) => {
					deletedSessionId = data.sessionId;
					resolve(data);
				});
			});

			await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: created.sessionId,
			});

			await eventPromise;
			expect(deletedSessionId).toBe(created.sessionId);
		});

		test('should cascade delete SDK messages', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Add a test SDK message directly to database
			ctx.db.saveSDKMessage(created.sessionId, {
				type: 'user',
				message: {
					role: 'user',
					content: 'test message',
				},
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: created.sessionId,
			});

			// Verify message exists
			expect(ctx.db.getSDKMessages(created.sessionId).length).toBe(1);

			// Delete session
			await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: created.sessionId,
			});

			// Verify messages were cascade deleted
			expect(ctx.db.getSDKMessages(created.sessionId).length).toBe(0);
		});
	});
});
