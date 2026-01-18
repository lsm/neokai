/**
 * SDK SIGINT Cleanup Test (Offline)
 *
 * Tests for the bug where pressing Ctrl+C causes the server to hang
 * during "Stopping agent sessions..." phase.
 *
 * The bug occurs because:
 * 1. When SIGINT is received, the server initiates graceful shutdown
 * 2. AgentSession.cleanup() calls queryObject.interrupt()
 * 3. The SDK subprocess ALSO receives SIGINT (same process group)
 * 4. SDK subprocess's exitHandler rejects with "Claude Code process terminated by signal SIGINT"
 * 5. This causes cleanup to hang instead of completing
 *
 * This file contains offline tests that verify cleanup behavior
 * without requiring API credentials.
 *
 * For online tests that reproduce the actual SIGINT bug,
 * see tests/online/sigint-cleanup.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp } from '../../test-utils';

describe('SDK SIGINT Cleanup (Offline)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('cleanup with idle session', () => {
		test('should cleanup idle session without hanging', async () => {
			// Create a session but don't send a message
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/idle-cleanup',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Idle sessions should cleanup immediately
			const cleanupStart = Date.now();
			await agentSession!.cleanup();
			const cleanupDuration = Date.now() - cleanupStart;

			// Should be very fast for idle sessions
			expect(cleanupDuration).toBeLessThan(2000);
		});

		test('should cleanup session that never started processing', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/never-started',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Session exists but no query started
			expect(agentSession!.getProcessingState().status).toBe('idle');

			// Cleanup should handle this case
			await agentSession!.cleanup();
			// If we get here without throwing, the test passes
			expect(true).toBe(true);
		});

		test('should handle multiple session cleanup', async () => {
			// Create multiple sessions
			const sessionIds = await Promise.all([
				ctx.sessionManager.createSession({ workspacePath: '/test/sigint-1' }),
				ctx.sessionManager.createSession({ workspacePath: '/test/sigint-2' }),
				ctx.sessionManager.createSession({ workspacePath: '/test/sigint-3' }),
			]);

			// Verify all sessions exist
			for (const sessionId of sessionIds) {
				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();
				expect(agentSession!.getProcessingState().status).toBe('idle');
			}

			// Cleanup all sessions at once (simulating graceful shutdown)
			const cleanupStart = Date.now();
			await ctx.sessionManager.cleanup();
			const cleanupDuration = Date.now() - cleanupStart;

			// Should complete quickly for idle sessions
			expect(cleanupDuration).toBeLessThan(5000);
		});
	});

	describe('cleanup timing and error handling', () => {
		test('should respect cleanup timeout', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/cleanup-timeout',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Cleanup should complete within the timeout period
			// Current implementation uses 15s timeout for cleanup
			const cleanupStart = Date.now();
			await agentSession!.cleanup();
			const cleanupDuration = Date.now() - cleanupStart;

			// Should complete well before the 15s timeout
			expect(cleanupDuration).toBeLessThan(15000);
		});

		test('should handle cleanup called multiple times', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/multiple-cleanup',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Call cleanup multiple times - should be idempotent
			await agentSession!.cleanup();
			await agentSession!.cleanup();
			await agentSession!.cleanup();

			// All calls should complete without error
			expect(true).toBe(true);
		});
	});
});
