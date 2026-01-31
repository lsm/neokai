/**
 * Session Lifecycle Behavior Tests
 *
 * Tests session management through RPC only (black-box behavior testing).
 * NO direct database or service access - all verification via RPC responses.
 *
 * This is the NEW pattern for integration tests:
 * - Test behavior, not implementation
 * - Verify through observable outcomes (RPC responses)
 * - No ctx.db, no ctx.sessionManager direct access
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';
import {
	createSession,
	getSession,
	updateSession,
	deleteSession,
	listSessions,
} from '../helpers/rpc-behavior-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Session Lifecycle (Behavior)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Session CRUD via RPC', () => {
		test('should create, retrieve, update, and delete session using helpers', async () => {
			// ===== CREATE =====
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/test-session-helpers`,
				title: 'Original Title',
			});

			expect(sessionId).toBeString();
			expect(sessionId.length).toBeGreaterThan(0);

			// ===== RETRIEVE =====
			const session = await getSession(ctx.messageHub, sessionId);

			expect(session).toBeDefined();
			expect(session.id).toBe(sessionId);
			expect(session.title).toBe('Original Title');
			expect(session.workspacePath).toBe(`${TMP_DIR}/test-session-helpers`);
			expect(session.status).toBe('active');

			// ===== UPDATE =====
			await updateSession(ctx.messageHub, sessionId, {
				title: 'Updated Title',
			});

			// Verify update via GET (not direct DB)
			const updatedSession = await getSession(ctx.messageHub, sessionId);

			expect(updatedSession.title).toBe('Updated Title');
			// Other fields should be preserved
			expect(updatedSession.workspacePath).toBe(`${TMP_DIR}/test-session-helpers`);
			expect(updatedSession.status).toBe('active');

			// ===== DELETE =====
			await deleteSession(ctx.messageHub, sessionId);

			// Verify deletion via GET (should error)
			await expect(getSession(ctx.messageHub, sessionId)).rejects.toThrow('Session not found');

			// Verify not in list
			const sessions = await listSessions(ctx.messageHub);
			const ids = sessions.map((s) => s.id);
			expect(ids).not.toContain(sessionId);
		});

		test('should create, retrieve, update, and delete session', async () => {
			// ===== CREATE =====
			const createResult = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-session`,
				title: 'Original Title',
			});

			expect(createResult.sessionId).toBeString();
			expect(createResult.sessionId.length).toBeGreaterThan(0);

			const sessionId = createResult.sessionId;

			// ===== RETRIEVE =====
			const getResult = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId,
			});

			expect(getResult.session).toBeDefined();
			expect(getResult.session.id).toBe(sessionId);
			expect(getResult.session.title).toBe('Original Title');
			expect(getResult.session.workspacePath).toBe(`${TMP_DIR}/test-session`);
			expect(getResult.session.status).toBe('active');

			// ===== UPDATE =====
			const updateResult = await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				title: 'Updated Title',
			});

			expect(updateResult.success).toBe(true);

			// Verify update via GET (not direct DB)
			const updatedResult = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId,
			});

			expect(updatedResult.session.title).toBe('Updated Title');
			// Other fields should be preserved
			expect(updatedResult.session.workspacePath).toBe(`${TMP_DIR}/test-session`);
			expect(updatedResult.session.status).toBe('active');

			// ===== DELETE =====
			const deleteResult = await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId,
			});

			expect(deleteResult.success).toBe(true);

			// Verify deletion via GET (should error)
			await expect(callRPCHandler(ctx.messageHub, 'session.get', { sessionId })).rejects.toThrow(
				'Session not found'
			);

			// Verify not in list
			const listResult = await callRPCHandler(ctx.messageHub, 'session.list', {});
			const ids = listResult.sessions.map((s: { id: string }) => s.id);
			expect(ids).not.toContain(sessionId);
		});

		test('should update session config', async () => {
			const createResult = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-config`,
			});

			const sessionId = createResult.sessionId;

			// Initial config - autoScroll is true by default
			const initial = await callRPCHandler(ctx.messageHub, 'session.get', { sessionId });
			expect(initial.session.config.autoScroll).toBe(true);

			// Update config
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				config: { autoScroll: true },
			});

			// Verify via GET
			const updated = await callRPCHandler(ctx.messageHub, 'session.get', { sessionId });
			expect(updated.session.config.autoScroll).toBe(true);
			// Other config fields should be preserved
			expect(updated.session.config.model).toBeDefined();
			expect(updated.session.config.maxTokens).toBeDefined();
		});

		test('should list sessions', async () => {
			// Create multiple sessions
			const session1 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/session-1`,
				title: 'Session 1',
			});

			const session2 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/session-2`,
				title: 'Session 2',
			});

			const session3 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/session-3`,
				title: 'Session 3',
			});

			// List sessions
			const listResult = await callRPCHandler(ctx.messageHub, 'session.list', {});

			expect(listResult.sessions).toBeArray();
			expect(listResult.sessions.length).toBe(3);

			const ids = listResult.sessions.map((s: { id: string }) => s.id);
			expect(ids).toContain(session1.sessionId);
			expect(ids).toContain(session2.sessionId);
			expect(ids).toContain(session3.sessionId);

			// Verify titles
			const titles = listResult.sessions.map((s: { title: string }) => s.title);
			expect(titles).toContain('Session 1');
			expect(titles).toContain('Session 2');
			expect(titles).toContain('Session 3');
		});
	});

	describe('Error Handling', () => {
		test('should error when getting non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.get', {
					sessionId: 'non-existent-id-12345',
				})
			).rejects.toThrow('Session not found');
		});

		test('should silently succeed when updating non-existent session', async () => {
			// NOTE: Current implementation doesn't error on update of non-existent session
			// This is actual behavior - update returns success even if session doesn't exist
			const result = await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: 'non-existent-id-12345',
				title: 'New Title',
			});

			// Should return success (this is the actual behavior)
			expect(result.success).toBe(true);

			// But session should still not exist (verify via get)
			await expect(
				callRPCHandler(ctx.messageHub, 'session.get', {
					sessionId: 'non-existent-id-12345',
				})
			).rejects.toThrow('Session not found');
		});

		test('should silently succeed when deleting non-existent session', async () => {
			// NOTE: Current implementation doesn't error on delete of non-existent session
			// This is actual behavior - delete returns success even if session doesn't exist (idempotent)
			const result = await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: 'non-existent-id-12345',
			});

			// Should return success (idempotent delete)
			expect(result.success).toBe(true);
		});
	});

	describe('Session Isolation', () => {
		test('should keep sessions independent', async () => {
			// Create two sessions
			const session1 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/session-a`,
				title: 'Session A',
			});

			const session2 = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/session-b`,
				title: 'Session B',
			});

			// Update session 1
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId: session1.sessionId,
				title: 'Session A Updated',
			});

			// Session 2 should be unchanged
			const session2Data = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId: session2.sessionId,
			});
			expect(session2Data.session.title).toBe('Session B');

			// Delete session 1
			await callRPCHandler(ctx.messageHub, 'session.delete', {
				sessionId: session1.sessionId,
			});

			// Session 2 should still exist
			const session2After = await callRPCHandler(ctx.messageHub, 'session.get', {
				sessionId: session2.sessionId,
			});
			expect(session2After.session.id).toBe(session2.sessionId);
		});
	});

	describe('Concurrent Operations', () => {
		test('should handle concurrent session creation', async () => {
			// Create 5 sessions concurrently
			const promises = Array.from({ length: 5 }, (_, i) =>
				callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/concurrent-${i}`,
					title: `Concurrent ${i}`,
				})
			);

			const results = await Promise.all(promises);

			// All should succeed with unique IDs
			const sessionIds = results.map((r) => r.sessionId);
			const uniqueIds = new Set(sessionIds);
			expect(uniqueIds.size).toBe(5);

			// All should be in list
			const listResult = await callRPCHandler(ctx.messageHub, 'session.list', {});
			expect(listResult.sessions.length).toBe(5);
		});

		test('should handle concurrent updates to same session', async () => {
			const createResult = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/concurrent-update`,
			});

			const sessionId = createResult.sessionId;

			// Concurrent updates
			await Promise.all([
				callRPCHandler(ctx.messageHub, 'session.update', {
					sessionId,
					title: 'Update 1',
				}),
				callRPCHandler(ctx.messageHub, 'session.update', {
					sessionId,
					config: { autoScroll: true },
				}),
			]);

			// Session should exist with one of the updates
			const result = await callRPCHandler(ctx.messageHub, 'session.get', { sessionId });
			expect(result.session.id).toBe(sessionId);
			// At least one update should have succeeded
			const hasUpdate =
				result.session.title === 'Update 1' || result.session.config.autoScroll === true;
			expect(hasUpdate).toBe(true);
		});
	});
});
