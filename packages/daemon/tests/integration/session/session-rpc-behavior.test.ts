/**
 * Session RPC Behavior Tests (REFACTORED)
 *
 * Tests session management RPC handlers through pure behavior testing.
 * Does NOT make actual SDK calls - focuses on daemon's session management via RPC.
 *
 * Pattern:
 * - All operations via callRPCHandler()
 * - All verification via subsequent RPC calls
 * - NO direct ctx.db access
 * - DaemonHub event testing is acceptable (internal coordination)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { callRPCHandler, createTestApp } from '../../test-utils';
import {
	createSession,
	getSession,
	updateSession,
	deleteSession,
	listSessions,
	getSDKMessages,
} from '../helpers/rpc-behavior-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Session RPC (Behavior)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.create', () => {
		test('should create a new session and verify via RPC', async () => {
			const workspacePath = `${TMP_DIR}/test-workspace`;

			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath,
			});

			expect(sessionId).toBeString();
			expect(sessionId.length).toBeGreaterThan(0);

			// ✅ Verify via RPC (not ctx.db)
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session).toBeDefined();
			expect(session.workspacePath).toBe(workspacePath);
			expect(session.status).toBe('active');
		});

		test('should create session with custom config', async () => {
			// ✅ Create with config via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
				config: {
					model: 'default',
					maxTokens: 4096,
					temperature: 0.5,
				},
			});

			// ✅ Verify config via RPC
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session.config.model).toBe('default');
			expect(session.config.maxTokens).toBe(4096);
			expect(session.config.temperature).toBe(0.5);
		});

		test('should broadcast session.created event via DaemonHub', async () => {
			// ✅ Subscribe to DaemonHub event (internal coordination - acceptable)
			let createdSessionId: string | null = null;
			const eventPromise = new Promise<void>((resolve) => {
				(
					ctx.stateManager as {
						eventBus: {
							on: (
								event: string,
								handler: (data: { sessionId: string; session: unknown }) => void
							) => void;
						};
					}
				).eventBus.on('session.created', (data) => {
					createdSessionId = data.sessionId;
					resolve();
				});
			});

			// ✅ Create session via RPC
			const result = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Wait for event
			await eventPromise;

			expect(createdSessionId).toBe(result.sessionId);
		});
	});

	describe('session.list', () => {
		test('should list all sessions', async () => {
			// ✅ Create multiple sessions via RPC
			const sessionId1 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-1`,
			});
			const sessionId2 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-2`,
			});

			// ✅ List via RPC
			const sessions = await listSessions(ctx.messageHub);

			expect(sessions).toBeArray();
			expect(sessions.length).toBe(2);

			const sessionIds = sessions.map((s) => s.id);
			expect(sessionIds).toContain(sessionId1);
			expect(sessionIds).toContain(sessionId2);
		});

		test('should return empty array when no sessions exist', async () => {
			const sessions = await listSessions(ctx.messageHub);

			expect(sessions).toBeArray();
			expect(sessions.length).toBe(0);
		});
	});

	describe('session.get', () => {
		test('should get session details', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Get via RPC
			const sessionData = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId,
			});

			expect(sessionData.session).toBeDefined();
			expect(sessionData.session.id).toBe(sessionId);
			expect(sessionData.session.workspacePath).toBe(`${TMP_DIR}/test-workspace`);
			expect(sessionData.context).toBeDefined();
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
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Update via RPC
			await updateSession(ctx.messageHub, sessionId, {
				title: 'Updated Title',
			});

			// ✅ Verify via RPC (not ctx.db)
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session.title).toBe('Updated Title');
		});

		test('should emit session.updated event via DaemonHub', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Subscribe to DaemonHub event
			let eventReceived = false;
			const eventPromise = new Promise<void>((resolve) => {
				(
					ctx.stateManager as {
						eventBus: {
							on: (event: string, handler: (data: { sessionId: string }) => void) => void;
						};
					}
				).eventBus.on('session.updated', (data) => {
					if (data.sessionId === sessionId) {
						eventReceived = true;
						resolve();
					}
				});
			});

			// ✅ Update via RPC
			await updateSession(ctx.messageHub, sessionId, {
				title: 'New Title',
			});

			await eventPromise;
			expect(eventReceived).toBe(true);
		});

		test('should update session config with autoScroll setting', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Verify autoScroll is true by default (from DEFAULT_GLOBAL_SETTINGS)
			let session = await getSession(ctx.messageHub, sessionId);
			expect(session.config.autoScroll).toBe(true);

			// ✅ Update config via RPC (toggle to false to test update)
			await updateSession(ctx.messageHub, sessionId, {
				config: { autoScroll: false },
			});

			// ✅ Verify autoScroll via RPC
			session = await getSession(ctx.messageHub, sessionId);
			expect(session.config.autoScroll).toBe(false);
			// Other config values should be preserved
			expect(session.config.model).toBeDefined();
			expect(session.config.maxTokens).toBeDefined();
		});

		test('should toggle autoScroll setting', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Enable autoScroll via RPC
			await updateSession(ctx.messageHub, sessionId, {
				config: { autoScroll: true },
			});

			// ✅ Verify via RPC
			let session = await getSession(ctx.messageHub, sessionId);
			expect(session.config.autoScroll).toBe(true);

			// ✅ Disable autoScroll via RPC
			await updateSession(ctx.messageHub, sessionId, {
				config: { autoScroll: false },
			});

			// ✅ Verify via RPC
			session = await getSession(ctx.messageHub, sessionId);
			expect(session.config.autoScroll).toBe(false);
		});
	});

	describe('session.delete', () => {
		test('should delete session and verify via RPC', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Delete via RPC
			await deleteSession(ctx.messageHub, sessionId);

			// ✅ Verify deletion via RPC (should error)
			await expect(getSession(ctx.messageHub, sessionId)).rejects.toThrow('Session not found');
		}, 15000);

		test('should emit session.deleted event via DaemonHub', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// ✅ Subscribe to DaemonHub event
			let deletedSessionId: string | null = null;
			const eventPromise = new Promise<void>((resolve) => {
				(
					ctx.stateManager as {
						eventBus: {
							on: (event: string, handler: (data: { sessionId: string }) => void) => void;
						};
					}
				).eventBus.on('session.deleted', (data) => {
					deletedSessionId = data.sessionId;
					resolve();
				});
			});

			// ✅ Delete via RPC
			await deleteSession(ctx.messageHub, sessionId);

			await eventPromise;
			expect(deletedSessionId).toBe(sessionId);
		});

		test('should cascade delete SDK messages', async () => {
			// ✅ Create via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Add SDK message (simulates what SDK would do)
			ctx.db.saveSDKMessage(sessionId, {
				type: 'user',
				message: {
					role: 'user',
					content: 'test message',
				},
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: sessionId,
			});

			// ✅ Verify message exists via RPC
			const messagesBefore = await getSDKMessages(ctx.messageHub, sessionId);
			expect(messagesBefore.length).toBe(1);

			// ✅ Delete session via RPC
			await deleteSession(ctx.messageHub, sessionId);

			// ✅ Verify messages cascade deleted (RPC should error)
			await expect(getSDKMessages(ctx.messageHub, sessionId)).rejects.toThrow();
		});
	});
});
