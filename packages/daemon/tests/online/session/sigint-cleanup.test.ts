/**
 * SDK SIGINT Cleanup Test (Online)
 *
 * Reproduces the bug where pressing Ctrl+C causes the server to hang
 * during "Stopping agent sessions..." phase.
 *
 * The bug occurs because:
 * 1. When SIGINT is received, the server initiates graceful shutdown
 * 2. AgentSession.cleanup() calls queryObject.interrupt()
 * 3. The SDK subprocess ALSO receives SIGINT (same process group)
 * 4. SDK subprocess's exitHandler rejects with "Claude Code process terminated by signal SIGINT"
 * 5. This causes cleanup to hang instead of completing
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available
 *
 * This test sends an actual SIGINT signal to reproduce the exact bug.
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

	describe('SIGINT during active SDK query', () => {
		test(
			'should complete cleanup when SIGINT received during active query',
			async () => {
				// Create session
				const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-sigint-active-query`,
				});

				// Send a message to start the SDK query
				// Use a long-running prompt to ensure the query is still active when we send SIGINT
				await callRPCHandler(ctx.messageHub, 'message.send', {
					sessionId,
					content: 'Please write a detailed 500-word essay about the history of computing.',
				});

				// Wait for the SDK query to start and begin processing
				// We need to wait long enough for the subprocess to be active
				await new Promise((resolve) => setTimeout(resolve, 3000));

				// Get the agent session to verify it's processing
				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();

				const processingState = agentSession!.getProcessingState();
				// Should be in processing state
				console.log('[TEST] Processing state before SIGINT:', processingState);

				// Track cleanup timing
				const cleanupStart = Date.now();

				// Send SIGINT to the current process
				// This simulates pressing Ctrl+C in the terminal
				console.log('[TEST] Sending SIGINT to process...');
				process.kill(process.pid, 'SIGINT');

				// Wait a moment for the signal to be delivered
				await new Promise((resolve) => setTimeout(resolve, 500));

				// Now try to cleanup - this is where the bug manifests
				// The bug causes cleanup to hang because:
				// 1. The SDK subprocess received SIGINT and is dying
				// 2. We're trying to call interrupt() on a dying process
				console.log('[TEST] Starting cleanup after SIGINT...');

				try {
					await agentSession!.cleanup();
					const cleanupDuration = Date.now() - cleanupStart;

					console.log(`[TEST] Cleanup completed in ${cleanupDuration}ms`);

					// Cleanup should complete within a reasonable time
					// Current implementation has a 15-second timeout
					expect(cleanupDuration).toBeLessThan(20000);

					// Test passes if cleanup completes without hanging
					expect(true).toBe(true);
				} catch (error) {
					console.error('[TEST] Cleanup failed with error:', error);
					// If we get an error, log it but the test might still pass
					// depending on the error type
					throw error;
				}
			},
			{ timeout: 30000 }
		);

		test(
			'should handle SIGINT during sessionManager.cleanup()',
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

				// Send SIGINT to the process
				console.log('[TEST] Sending SIGINT with multiple active sessions...');
				process.kill(process.pid, 'SIGINT');

				// Wait for signal delivery
				await new Promise((resolve) => setTimeout(resolve, 500));

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

		test(
			'should cleanup successfully even after SIGINT error from SDK',
			async () => {
				const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-sigint-error`,
				});

				// Start a query
				await callRPCHandler(ctx.messageHub, 'message.send', {
					sessionId,
					content: 'Tell me a long story about artificial intelligence.',
				});

				await new Promise((resolve) => setTimeout(resolve, 3000));

				const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
				expect(agentSession).toBeDefined();

				// Send SIGINT
				console.log('[TEST] Sending SIGINT to trigger SDK error...');
				process.kill(process.pid, 'SIGINT');

				await new Promise((resolve) => setTimeout(resolve, 500));

				// Cleanup should handle SDK SIGINT errors gracefully
				// The test passes if cleanup completes without hanging
				console.log('[TEST] Attempting cleanup after SIGINT...');

				const cleanupStart = Date.now();
				await agentSession!.cleanup();
				const cleanupDuration = Date.now() - cleanupStart;

				console.log(`[TEST] Cleanup completed in ${cleanupDuration}ms`);

				// Should complete within timeout
				expect(cleanupDuration).toBeLessThan(20000);
			},
			{ timeout: 30000 }
		);
	});

	describe('cleanup behavior during various states', () => {
		test(
			'should cleanup session that completed query before SIGINT',
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

				// Send SIGINT after query completed
				process.kill(process.pid, 'SIGINT');
				await new Promise((resolve) => setTimeout(resolve, 500));

				// Cleanup should work normally
				const cleanupStart = Date.now();
				await agentSession!.cleanup();
				const cleanupDuration = Date.now() - cleanupStart;

				console.log(`[TEST] Cleanup completed in ${cleanupDuration}ms`);
				expect(cleanupDuration).toBeLessThan(5000);
			},
			{ timeout: 20000 }
		);
	});
});
