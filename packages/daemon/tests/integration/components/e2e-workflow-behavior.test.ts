/**
 * End-to-End Workflow Behavior Tests (REFACTORED)
 *
 * Tests complete workflows through pure RPC behavior:
 * - Create session → Add messages → Get state → Delete session
 * - Multi-session scenarios
 * - Concurrent operations
 * - Error recovery
 *
 * Pattern:
 * - All operations via callRPCHandler() or helpers
 * - All verification via RPC responses
 * - NO direct ctx.db access
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';
import { STATE_CHANNELS } from '@neokai/shared';
import {
	createSession,
	getSession,
	deleteSession,
	listSessions,
	getSDKMessages,
} from '../helpers/rpc-behavior-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('End-to-End Workflow (Behavior)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Complete Session Lifecycle', () => {
		test('should handle full session lifecycle via RPC', async () => {
			// ✅ 1. Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			expect(sessionId).toBeString();

			// ✅ 2. Verify session exists
			const session = await getSession(ctx.messageHub, sessionId);
			expect(session.id).toBe(sessionId);

			// 3. Add test message (simulates SDK message save)
			ctx.db.saveSDKMessage(sessionId, {
				type: 'user',
				message: {
					role: 'user',
					content: 'Hello, world!',
				},
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: sessionId,
			});

			// ✅ 4. Get SDK messages via RPC
			const messages = await getSDKMessages(ctx.messageHub, sessionId);

			expect(messages.length).toBe(1);
			expect((messages[0] as { message: { content: string } }).message.content).toBe(
				'Hello, world!'
			);

			// ✅ 5. Update session via RPC
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				title: 'Test Lifecycle',
			});

			// ✅ Verify update via RPC (not ctx.db)
			const updatedSession = await getSession(ctx.messageHub, sessionId);
			expect(updatedSession.title).toBe('Test Lifecycle');

			// ✅ 6. Delete session
			await deleteSession(ctx.messageHub, sessionId);

			// ✅ 7. Verify session is gone via RPC
			await expect(getSession(ctx.messageHub, sessionId)).rejects.toThrow('Session not found');

			// ✅ 8. Verify messages were cascade deleted via RPC
			await expect(getSDKMessages(ctx.messageHub, sessionId)).rejects.toThrow();
		});

		test('should handle multiple sessions independently', async () => {
			// ✅ Create three sessions via helpers
			const sessionId1 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace-1`,
			});
			const sessionId2 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace-2`,
			});
			const sessionId3 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace-3`,
			});

			// Add messages to each (simulates SDK)
			ctx.db.saveSDKMessage(sessionId1, {
				type: 'user',
				message: { role: 'user', content: 'Message 1' },
				parent_tool_use_id: null,
				uuid: 'msg-1-1',
				session_id: sessionId1,
			});

			ctx.db.saveSDKMessage(sessionId2, {
				type: 'user',
				message: { role: 'user', content: 'Message 2' },
				parent_tool_use_id: null,
				uuid: 'msg-2-1',
				session_id: sessionId2,
			});

			// ✅ Verify isolation via RPC
			const msgs1 = await getSDKMessages(ctx.messageHub, sessionId1);
			const msgs2 = await getSDKMessages(ctx.messageHub, sessionId2);
			const msgs3 = await getSDKMessages(ctx.messageHub, sessionId3);

			expect(msgs1.length).toBe(1);
			expect((msgs1[0] as { message: { content: string } }).message.content).toBe('Message 1');

			expect(msgs2.length).toBe(1);
			expect((msgs2[0] as { message: { content: string } }).message.content).toBe('Message 2');

			expect(msgs3.length).toBe(0);

			// ✅ Delete one session via RPC
			await deleteSession(ctx.messageHub, sessionId2);

			// ✅ Verify others still exist via RPC
			const sessions = await listSessions(ctx.messageHub);
			expect(sessions.length).toBe(2);

			const ids = sessions.map((s) => s.id);
			expect(ids).toContain(sessionId1);
			expect(ids).toContain(sessionId3);
			expect(ids).not.toContain(sessionId2);
		});
	});

	describe('Concurrent Operations', () => {
		test('should handle concurrent session creation', async () => {
			// ✅ Create 5 sessions concurrently
			const promises = Array.from({ length: 5 }, (_, i) =>
				createSession(ctx.messageHub, {
					workspacePath: `${TMP_DIR}/test-concurrent-${i}`,
				})
			);

			const sessionIds = await Promise.all(promises);

			expect(sessionIds.length).toBe(5);

			// All should be unique
			const uniqueIds = new Set(sessionIds);
			expect(uniqueIds.size).toBe(5);

			// ✅ All should be in list via RPC
			const sessions = await listSessions(ctx.messageHub);
			expect(sessions.length).toBe(5);
		});

		test('should handle concurrent session operations', async () => {
			// ✅ Create sessions concurrently
			const sessionIds = await Promise.all([
				createSession(ctx.messageHub, { workspacePath: `${TMP_DIR}/test-workspace` }),
				createSession(ctx.messageHub, { workspacePath: `${TMP_DIR}/test-workspace` }),
				createSession(ctx.messageHub, { workspacePath: `${TMP_DIR}/test-workspace` }),
			]);

			// ✅ Concurrent updates via RPC
			await Promise.all(
				sessionIds.map((id, i) =>
					callRPCHandler(ctx.messageHub, 'session.update', {
						sessionId: id,
						title: `Updated ${i}`,
					})
				)
			);

			// ✅ Verify all updates via RPC
			const sessions = await listSessions(ctx.messageHub);
			const titles = sessions.map((s) => s.title).sort();
			expect(titles).toEqual(['Updated 0', 'Updated 1', 'Updated 2']);

			// ✅ Concurrent deletes via RPC
			await Promise.all(sessionIds.map((id) => deleteSession(ctx.messageHub, id)));

			// ✅ Verify all deleted via RPC
			const finalSessions = await listSessions(ctx.messageHub);
			expect(finalSessions.length).toBe(0);
		}, 15000);
	});

	describe('State Snapshot Consistency', () => {
		test('should provide consistent global snapshot', async () => {
			// ✅ Create multiple sessions
			await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace-1`,
			});
			await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace-2`,
			});

			// ✅ Get snapshot via RPC
			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			// Verify all components are consistent
			expect((snapshot.sessions as { sessions: unknown[] }).sessions.length).toBe(2);
			expect(
				(snapshot.system as { health: { sessions: { total: number } } }).health.sessions.total
			).toBe(2);
			expect(
				(snapshot.system as { health: { sessions: { active: number } } }).health.sessions.active
			).toBe(2);
		});

		test('should provide consistent session snapshot', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Add message (simulates SDK)
			ctx.db.saveSDKMessage(sessionId, {
				type: 'user',
				message: { role: 'user', content: 'Test' },
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: sessionId,
			});

			// ✅ Get snapshot via RPC
			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.SESSION_SNAPSHOT, {
				sessionId,
			});

			expect((snapshot.session as { sessionInfo: { id: string } }).sessionInfo.id).toBe(sessionId);
			expect((snapshot.sdkMessages as { sdkMessages: unknown[] }).sdkMessages.length).toBe(1);
		});
	});

	describe('Error Recovery', () => {
		test('should recover from failed operations', async () => {
			// ✅ Attempt invalid operation
			await expect(
				callRPCHandler(ctx.messageHub, 'session.get', {
					sessionId: 'non-existent',
				})
			).rejects.toThrow();

			// ✅ Server should still work
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			expect(sessionId).toBeString();
		});

		test('should handle rapid create/delete cycles', async () => {
			for (let i = 0; i < 5; i++) {
				// ✅ Create via RPC
				const sessionId = await createSession(ctx.messageHub, {
					workspacePath: `${TMP_DIR}/test-cycle-${i}`,
				});

				// ✅ Delete via RPC
				await deleteSession(ctx.messageHub, sessionId);
			}

			// ✅ Verify no sessions left via RPC
			const sessions = await listSessions(ctx.messageHub);
			expect(sessions.length).toBe(0);
		}, 30000);
	});
});
