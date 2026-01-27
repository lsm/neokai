/**
 * State Synchronization Behavior Tests
 *
 * Tests state consistency through RPC snapshots (behavior-driven).
 *
 * Pattern:
 * - Perform actions via RPC (create, update, delete)
 * - Verify state via RPC snapshots (state.global.snapshot, state.session.snapshot)
 * - NO direct StateManager access
 * - NO mocks (real state queries)
 *
 * Note: State channel subscriptions are tested in online tests where
 * the full WebSocket infrastructure is running. These tests focus on
 * state consistency observable through RPC queries.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';
import { createSession, updateSession, deleteSession } from '../helpers/rpc-behavior-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('State Synchronization (Behavior)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Session State Consistency', () => {
		test('should reflect new session in global snapshot', async () => {
			// ✅ Get initial snapshot
			const initialSnapshot = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});
			const initialSessions = (initialSnapshot.sessions as { sessions: unknown[] }).sessions;

			// ✅ Create session via RPC
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/state-test-create`,
				title: 'State Test Session',
			});

			// ✅ Get updated snapshot
			const updatedSnapshot = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});
			const updatedSessions = (updatedSnapshot.sessions as { sessions: Array<{ id: string }> })
				.sessions;

			// Verify new session appears
			expect(updatedSessions.length).toBe(initialSessions.length + 1);
			const sessionIds = updatedSessions.map((s) => s.id);
			expect(sessionIds).toContain(sessionId);
		});

		test('should reflect session updates in session snapshot', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/state-test-update`,
				title: 'Original Title',
			});

			// ✅ Get initial snapshot
			const initialSnapshot = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId,
			});
			expect(
				(initialSnapshot.session as { sessionInfo: { title: string } }).sessionInfo.title
			).toBe('Original Title');

			// ✅ Update session via RPC
			await updateSession(ctx.messageHub, sessionId, {
				title: 'Updated Title',
			});

			// ✅ Get updated snapshot
			const updatedSnapshot = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId,
			});
			expect(
				(updatedSnapshot.session as { sessionInfo: { title: string } }).sessionInfo.title
			).toBe('Updated Title');
		});

		test('should reflect deletion in global snapshot', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/state-test-delete`,
			});

			// ✅ Verify in snapshot
			const snapshotBefore = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});
			const sessionsBefore = (snapshotBefore.sessions as { sessions: Array<{ id: string }> })
				.sessions;
			expect(sessionsBefore.map((s) => s.id)).toContain(sessionId);

			// ✅ Delete session
			await deleteSession(ctx.messageHub, sessionId);

			// ✅ Verify removed from snapshot
			const snapshotAfter = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});
			const sessionsAfter = (snapshotAfter.sessions as { sessions: Array<{ id: string }> })
				.sessions;
			expect(sessionsAfter.map((s) => s.id)).not.toContain(sessionId);
		});
	});

	describe('Global System State', () => {
		test('should provide system state snapshot', async () => {
			// ✅ Get system state via RPC
			const systemState = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});

			// Verify structure
			expect(systemState.system).toBeDefined();
			expect(systemState.system.health).toBeDefined();
			expect(systemState.sessions).toBeDefined();
		});

		test('should update system health on session changes', async () => {
			// ✅ Get initial state
			const initialState = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});
			const initialSessionCount = (
				initialState.system as { health: { sessions: { total: number } } }
			).health.sessions.total;

			// ✅ Create session
			await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/health-test`,
			});

			// ✅ Get updated state
			const updatedState = await callRPCHandler(ctx.messageHub, 'state.global.snapshot', {});
			const updatedSessionCount = (
				updatedState.system as { health: { sessions: { total: number } } }
			).health.sessions.total;

			expect(updatedSessionCount).toBe(initialSessionCount + 1);
		});
	});

	describe('Session-Scoped State', () => {
		test('should provide session snapshot with correct structure', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/snapshot-test`,
				title: 'Snapshot Test',
			});

			// ✅ Get session snapshot via RPC
			const snapshot = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId,
			});

			// Verify structure
			expect(snapshot.session).toBeDefined();
			expect((snapshot.session as { sessionInfo: unknown }).sessionInfo).toBeDefined();
			expect((snapshot.session as { sessionInfo: { id: string } }).sessionInfo.id).toBe(sessionId);
			expect((snapshot.session as { sessionInfo: { title: string } }).sessionInfo.title).toBe(
				'Snapshot Test'
			);
			expect(snapshot.sdkMessages).toBeDefined();
		});

		test('should isolate session snapshots by sessionId', async () => {
			// ✅ Create two sessions
			const sessionId1 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/isolation-1`,
				title: 'Session 1',
			});

			const sessionId2 = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/isolation-2`,
				title: 'Session 2',
			});

			// ✅ Update session 2
			await updateSession(ctx.messageHub, sessionId2, {
				title: 'Session 2 Updated',
			});

			// ✅ Get session 1 snapshot (should NOT see session 2 changes)
			const snapshot1 = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId: sessionId1,
			});

			// ✅ Get session 2 snapshot (should see its changes)
			const snapshot2 = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId: sessionId2,
			});

			// Verify isolation
			expect((snapshot1.session as { sessionInfo: { title: string } }).sessionInfo.title).toBe(
				'Session 1'
			);
			expect((snapshot2.session as { sessionInfo: { title: string } }).sessionInfo.title).toBe(
				'Session 2 Updated'
			);
		});
	});

	describe('Config Updates in State', () => {
		test('should reflect config changes in snapshot', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/config-propagation`,
			});

			// ✅ Update config via RPC
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				config: {
					autoScroll: true,
				},
			});

			// ✅ Get snapshot
			const snapshot = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId,
			});

			// Verify config change
			expect(
				(snapshot.session as { sessionInfo: { config: { autoScroll: boolean } } }).sessionInfo
					.config.autoScroll
			).toBe(true);
		});

		test('should preserve config across multiple updates', async () => {
			// ✅ Create session
			const sessionId = await createSession(ctx.messageHub, {
				workspacePath: `${TMP_DIR}/config-multiple`,
			});

			// ✅ Update config multiple times
			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				config: {
					autoScroll: true,
				},
			});

			await callRPCHandler(ctx.messageHub, 'session.update', {
				sessionId,
				title: 'Updated Title',
			});

			// ✅ Get snapshot
			const snapshot = await callRPCHandler(ctx.messageHub, 'state.session.snapshot', {
				sessionId,
			});

			// Both updates should be reflected
			expect((snapshot.session as { sessionInfo: { title: string } }).sessionInfo.title).toBe(
				'Updated Title'
			);
			expect(
				(snapshot.session as { sessionInfo: { config: { autoScroll: boolean } } }).sessionInfo
					.config.autoScroll
			).toBe(true);
		});
	});
});
