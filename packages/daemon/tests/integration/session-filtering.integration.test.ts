/**
 * Integration tests for server-side session filtering based on showArchived setting
 *
 * Tests the complete flow: showArchived setting → StateManager filtering → Client receives filtered sessions
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';
import type { Session } from '@liuboer/shared';

describe('Session Filtering Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Server-side filtering based on showArchived', () => {
		test('filters out archived sessions by default', async () => {
			// Create 3 sessions
			const session1 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			const session2 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			const session3 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});

			// Archive session2
			await ctx.sessionManager.updateSession(session2.id, { status: 'archived' });

			// Get sessions via state manager (simulates what client receives)
			const sessionsState = await ctx.stateManager['getSessionsState']();

			// Should only return active sessions (session1 and session3)
			expect(sessionsState.sessions).toHaveLength(2);
			expect(sessionsState.sessions.find((s) => s.id === session1.id)).toBeDefined();
			expect(sessionsState.sessions.find((s) => s.id === session3.id)).toBeDefined();
			expect(sessionsState.sessions.find((s) => s.id === session2.id)).toBeUndefined();

			// Should indicate that archived sessions exist
			expect(sessionsState.hasArchivedSessions).toBe(true);
		});

		test('includes archived sessions when showArchived is true', async () => {
			// Create and archive a session
			const session1 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			const session2 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			await ctx.sessionManager.updateSession(session2.id, { status: 'archived' });

			// Enable showArchived
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});

			// Get sessions via state manager
			const sessionsState = await ctx.stateManager['getSessionsState']();

			// Should include both active and archived sessions
			expect(sessionsState.sessions).toHaveLength(2);
			expect(sessionsState.sessions.find((s) => s.id === session1.id)).toBeDefined();
			expect(sessionsState.sessions.find((s) => s.id === session2.id)).toBeDefined();
			expect(sessionsState.hasArchivedSessions).toBe(true);
		});

		test('hasArchivedSessions is false when no archived sessions exist', async () => {
			// Create only active sessions
			await ctx.sessionManager.createSession({ workspacePath: ctx.workspacePath });
			await ctx.sessionManager.createSession({ workspacePath: ctx.workspacePath });

			const sessionsState = await ctx.stateManager['getSessionsState']();

			expect(sessionsState.hasArchivedSessions).toBe(false);
			expect(sessionsState.sessions).toHaveLength(2);
		});

		test('hasArchivedSessions is true even when showArchived is false', async () => {
			// Create and archive a session
			const session = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			await ctx.sessionManager.updateSession(session.id, { status: 'archived' });

			// Ensure showArchived is false (default)
			const settings = ctx.settingsManager.getGlobalSettings();
			expect(settings.showArchived).toBe(false);

			const sessionsState = await ctx.stateManager['getSessionsState']();

			// Archived session should not be in the list
			expect(sessionsState.sessions).toHaveLength(0);

			// But hasArchivedSessions should still be true
			expect(sessionsState.hasArchivedSessions).toBe(true);
		});

		test('toggling showArchived updates filtered sessions', async () => {
			// Create sessions
			const activeSession = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			const archivedSession = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			await ctx.sessionManager.updateSession(archivedSession.id, { status: 'archived' });

			// Initially, only active session is visible
			let sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(1);
			expect(sessionsState.sessions[0].id).toBe(activeSession.id);

			// Enable showArchived
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});

			// Now both sessions should be visible
			sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(2);

			// Disable showArchived again
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: false },
			});

			// Back to only active session
			sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(1);
			expect(sessionsState.sessions[0].id).toBe(activeSession.id);
		});

		test('filters work with multiple archived sessions', async () => {
			// Create 5 sessions, archive 3 of them
			const sessions: Session[] = [];
			for (let i = 0; i < 5; i++) {
				const session = await ctx.sessionManager.createSession({
					workspacePath: ctx.workspacePath,
				});
				sessions.push(session);
			}

			// Archive sessions at indices 1, 2, and 4
			await ctx.sessionManager.updateSession(sessions[1].id, { status: 'archived' });
			await ctx.sessionManager.updateSession(sessions[2].id, { status: 'archived' });
			await ctx.sessionManager.updateSession(sessions[4].id, { status: 'archived' });

			// Default: should show only 2 active sessions
			let sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(2);
			expect(sessionsState.hasArchivedSessions).toBe(true);

			// Enable showArchived: should show all 5
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});
			sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(5);
			expect(sessionsState.hasArchivedSessions).toBe(true);
		});
	});

	describe('Edge cases', () => {
		test('handles empty session list', async () => {
			const sessionsState = await ctx.stateManager['getSessionsState']();

			expect(sessionsState.sessions).toHaveLength(0);
			expect(sessionsState.hasArchivedSessions).toBe(false);
		});

		test('handles all sessions being archived', async () => {
			// Create sessions and archive all
			const session1 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});
			const session2 = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});

			await ctx.sessionManager.updateSession(session1.id, { status: 'archived' });
			await ctx.sessionManager.updateSession(session2.id, { status: 'archived' });

			// With showArchived=false, should show empty list
			let sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(0);
			expect(sessionsState.hasArchivedSessions).toBe(true);

			// With showArchived=true, should show both
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});
			sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(2);
			expect(sessionsState.hasArchivedSessions).toBe(true);
		});

		test('handles session status change from active to archived', async () => {
			const session = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});

			// Initially visible
			let sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(1);
			expect(sessionsState.hasArchivedSessions).toBe(false);

			// Archive it
			await ctx.sessionManager.updateSession(session.id, { status: 'archived' });

			// Should be filtered out
			sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(0);
			expect(sessionsState.hasArchivedSessions).toBe(true);

			// Unarchive it
			await ctx.sessionManager.updateSession(session.id, { status: 'active' });

			// Should be visible again
			sessionsState = await ctx.stateManager['getSessionsState']();
			expect(sessionsState.sessions).toHaveLength(1);
			expect(sessionsState.hasArchivedSessions).toBe(false);
		});
	});
});
