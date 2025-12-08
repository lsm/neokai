/**
 * End-to-End Workflow Integration Tests
 *
 * Tests complete workflows that span multiple components:
 * - Create session → Add messages → Get state → Delete session
 * - Multi-tab scenarios with state synchronization
 * - Concurrent operations
 *
 * These tests verify that all components work together correctly
 * without making actual Claude API calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';
import { STATE_CHANNELS } from '@liuboer/shared';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('End-to-End Workflow Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Complete Session Lifecycle', () => {
		test('should handle full session lifecycle', async () => {
			// 1. Create session
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			expect(created.sessionId).toBeString();

			// 2. Verify session exists
			const retrieved = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId: created.sessionId,
			});

			expect(retrieved.session.id).toBe(created.sessionId);
			expect(retrieved.messages).toBeArray();
			expect(retrieved.messages.length).toBe(0);

			// 3. Add a test message to database (simulating message flow)
			ctx.db.saveSDKMessage(created.sessionId, {
				type: 'user',
				message: {
					role: 'user',
					content: 'Hello, world!',
				},
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: created.sessionId,
			});

			// 4. Get messages
			const messages = await callRPCHandler(ctx.messageHub, 'message.list', {
				sessionId: created.sessionId,
			});

			expect(messages.messages.length).toBe(1);
			expect(messages.messages[0].content).toBe('Hello, world!');

			// 5. Update session
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: created.sessionId,
				title: 'Test Lifecycle',
			});

			const updated = await ctx.db.getSession(created.sessionId);
			expect(updated?.title).toBe('Test Lifecycle');

			// 6. Delete session
			await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: created.sessionId,
			});

			// 7. Verify session is gone
			const deleted = ctx.db.getSession(created.sessionId);
			expect(deleted).toBeNull();

			// 8. Verify messages were cascade deleted
			const deletedMessages = ctx.db.getSDKMessages(created.sessionId);
			expect(deletedMessages.length).toBe(0);
		});

		test('should handle multiple sessions independently', async () => {
			// Create three sessions
			const session1 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});
			const session2 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});
			const session3 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Add messages to each
			ctx.db.saveSDKMessage(session1.sessionId, {
				type: 'user',
				message: { role: 'user', content: 'Message 1' },
				parent_tool_use_id: null,
				uuid: 'msg-1-1',
				session_id: session1.sessionId,
			});

			ctx.db.saveSDKMessage(session2.sessionId, {
				type: 'user',
				message: { role: 'user', content: 'Message 2' },
				parent_tool_use_id: null,
				uuid: 'msg-2-1',
				session_id: session2.sessionId,
			});

			// Verify isolation
			const msgs1 = await callRPCHandler(ctx.messageHub, 'message.list', {
				sessionId: session1.sessionId,
			});
			const msgs2 = await callRPCHandler(ctx.messageHub, 'message.list', {
				sessionId: session2.sessionId,
			});
			const msgs3 = await callRPCHandler(ctx.messageHub, 'message.list', {
				sessionId: session3.sessionId,
			});

			expect(msgs1.messages.length).toBe(1);
			expect(msgs1.messages[0].content).toBe('Message 1');

			expect(msgs2.messages.length).toBe(1);
			expect(msgs2.messages[0].content).toBe('Message 2');

			expect(msgs3.messages.length).toBe(0);

			// Delete one session
			await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: session2.sessionId,
			});

			// Others should still exist
			const list = await callRPCHandler(ctx.messageHub, 'session.list', {});
			expect(list.sessions.length).toBe(2);

			const ids = list.sessions.map((s: unknown) => s.id);
			expect(ids).toContain(session1.sessionId);
			expect(ids).toContain(session3.sessionId);
			expect(ids).not.toContain(session2.sessionId);
		});
	});

	describe('Concurrent Operations', () => {
		test('should handle concurrent session creation', async () => {
			const promises = Array.from({ length: 5 }, (_, i) =>
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-concurrent-${i}`,
				})
			);

			const results = await Promise.all(promises);

			expect(results.length).toBe(5);
			const sessionIds = results.map((r) => r.sessionId);

			// All should be unique
			const uniqueIds = new Set(sessionIds);
			expect(uniqueIds.size).toBe(5);

			// All should be in database
			const list = await callRPCHandler(ctx.messageHub, 'session.list', {});
			expect(list.sessions.length).toBe(5);
		});

		test('should handle concurrent session operations', async () => {
			// Create sessions
			const sessions = await Promise.all([
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-workspace`,
				}),
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-workspace`,
				}),
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-workspace`,
				}),
			]);

			// Concurrent updates
			const updatePromises = sessions.map((s, i) =>
				callRPCHandler(ctx.messageHub, 'session.update', {
					sessionId: s.sessionId,
					title: `Updated ${i}`,
				})
			);

			await Promise.all(updatePromises);

			// Verify all updates
			const list = await callRPCHandler(ctx.messageHub, 'session.list', {});
			const titles = list.sessions.map((s: unknown) => s.title).sort();
			expect(titles).toEqual(['Updated 0', 'Updated 1', 'Updated 2']);

			// Concurrent deletes
			const deletePromises = sessions.map((s) =>
				callRPCHandler(ctx.messageHub, 'session.delete', {
					sessionId: s.sessionId,
				})
			);

			await Promise.all(deletePromises);

			// All should be deleted
			const finalList = await callRPCHandler(ctx.messageHub, 'session.list', {});
			expect(finalList.sessions.length).toBe(0);
		}, 15000);
	});

	describe('State Snapshot Consistency', () => {
		test('should provide consistent global snapshot', async () => {
			// Create multiple sessions
			await Promise.all([
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-workspace`,
				}),
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-workspace`,
				}),
			]);

			// Get snapshot
			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.GLOBAL_SNAPSHOT, {});

			// Verify all components are consistent
			expect(snapshot.sessions.sessions.length).toBe(2);
			expect(snapshot.system.health.sessions.total).toBe(2);
			expect(snapshot.system.health.sessions.active).toBe(2);
		});

		test('should provide consistent session snapshot', async () => {
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			// Add messages
			ctx.db.saveSDKMessage(created.sessionId, {
				type: 'user',
				message: { role: 'user', content: 'Test' },
				parent_tool_use_id: null,
				uuid: 'msg-1',
				session_id: created.sessionId,
			});

			const snapshot = await callRPCHandler(ctx.messageHub, STATE_CHANNELS.SESSION_SNAPSHOT, {
				sessionId: created.sessionId,
			});

			expect(snapshot.session.session.id).toBe(created.sessionId);
			expect(snapshot.sdkMessages.sdkMessages.length).toBe(1);
		});
	});

	describe('Error Recovery', () => {
		test('should recover from failed operations', async () => {
			// Attempt invalid operation
			await expect(
				callRPCHandler(ctx.messageHub, 'session.get', {
					sessionId: 'non-existent',
				})
			).rejects.toThrow();

			// Server should still work
			const created = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-workspace`,
			});

			expect(created.sessionId).toBeString();
		});

		test('should handle rapid create/delete cycles', async () => {
			for (let i = 0; i < 5; i++) {
				const created = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-cycle-${i}`,
				});

				await callRPCHandler(ctx.messageHub, 'session.delete', {
					sessionId: created.sessionId,
				});
			}

			// Should have no sessions left
			const list = await callRPCHandler(ctx.messageHub, 'session.list', {});
			expect(list.sessions.length).toBe(0);

			// Database should be clean
			expect(ctx.db.listSessions().length).toBe(0);
		}, 30000); // 30 second timeout for rapid cycles
	});
});
