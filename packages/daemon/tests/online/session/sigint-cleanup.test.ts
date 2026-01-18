/**
 * SDK SIGINT Cleanup Test (Online)
 *
 * Tests the behavior when the SDK subprocess receives SIGINT during
 * an active query. The bug being tested is that cleanup would hang
 * when trying to call interrupt() on a dying SDK subprocess.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available
 *
 * NOTE: Due to SDK limitations, the spawnClaudeCodeProcess hook is not
 * used for default local spawn. Therefore, this test uses a simplified
 * approach that verifies cleanup completes without hanging when the query
 * is already in an error state.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('SDK SIGINT Cleanup (Online)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(
		async () => {
			await ctx.cleanup();
		},
		{ timeout: 30000 }
	);

	describe('Cleanup behavior during various states', () => {
		test(
			'should cleanup session that completed query successfully',
			async () => {
				const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-sigint-completed`,
				});

				// Send a short message that will complete quickly
				await callRPCHandler(ctx.messageHub, 'message.send', {
					sessionId,
					content: 'Say "Hello World" and nothing else.',
				});

				// Wait for query to complete
				await new Promise((resolve) => setTimeout(resolve, 5000));

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				const processingState = agentSession!.getProcessingState();

				console.log('[TEST] Processing state after query completion:', processingState);
				// Should be back to idle
				expect(processingState.status).toBe('idle');

				// Cleanup should work normally
				const cleanupStart = Date.now();
				await agentSession!.cleanup();
				const cleanupDuration = Date.now() - cleanupStart;

				console.log(`[TEST] Cleanup completed in ${cleanupDuration}ms`);
				expect(cleanupDuration).toBeLessThan(5000);
			},
			{ timeout: 20000 }
		);

		test(
			'should cleanup session with active query within timeout',
			async () => {
				const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-sigint-active-query`,
				});

				// Send a long-running message to start an active query
				await callRPCHandler(ctx.messageHub, 'message.send', {
					sessionId,
					content: 'Please write a detailed 500-word essay about the history of computing.',
				});

				// Wait for the SDK query to start and begin processing
				await new Promise((resolve) => setTimeout(resolve, 3000));

				// Get the agent session to verify it's processing
				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();

				const processingState = agentSession!.getProcessingState();
				// Should be in processing state
				console.log('[TEST] Processing state:', processingState);
				expect(processingState.status).toBe('processing');

				// Cleanup should complete within the 15-second timeout
				// This tests that cleanup doesn't hang when interrupting an active query
				const cleanupStart = Date.now();
				console.log('[TEST] Starting cleanup with active query...');

				await agentSession!.cleanup();
				const cleanupDuration = Date.now() - cleanupStart;

				console.log(`[TEST] Cleanup completed in ${cleanupDuration}ms`);

				// Cleanup should complete within 20 seconds (15s timeout + buffer)
				expect(cleanupDuration).toBeLessThan(20000);
			},
			{ timeout: 30000 }
		);

		test(
			'should cleanup multiple sessions with active queries',
			async () => {
				// Create multiple sessions with active queries
				const { sessionId: sessionId1 } = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-sigint-multi-1`,
				});

				const { sessionId: sessionId2 } = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-sigint-multi-2`,
				});

				// Send messages to start SDK queries
				await callRPCHandler(ctx.messageHub, 'message.send', {
					sessionId: sessionId1,
					content: 'Explain quantum computing in detail.',
				});

				await callRPCHandler(ctx.messageHub, 'message.send', {
					sessionId: sessionId2,
					content: 'Explain machine learning algorithms.',
				});

				// Wait for SDK queries to start
				await new Promise((resolve) => setTimeout(resolve, 3000));

				// Cleanup all sessions (simulating graceful shutdown)
				const cleanupStart = Date.now();
				console.log('[TEST] Starting sessionManager cleanup...');

				await ctx.sessionManager.cleanup();

				const cleanupDuration = Date.now() - cleanupStart;
				console.log(`[TEST] SessionManager cleanup completed in ${cleanupDuration}ms`);

				// Should complete within reasonable time
				expect(cleanupDuration).toBeLessThan(25000);
			},
			{ timeout: 35000 }
		);
	});
});
