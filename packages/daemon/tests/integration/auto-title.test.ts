/**
 * Auto-Title Generation Integration Tests
 *
 * These tests verify that the auto-title generation feature works correctly
 * with real SDK calls. The feature should:
 * - Generate a title after we have MORE than 1 assistant response (at least 2)
 * - Use Haiku model for title generation
 * - Update session metadata with titleGenerated flag
 * - Only generate title once per session
 * - Handle workspace paths correctly (critical for SDK query)
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Tests are skipped if credentials are not available
 * - Makes real API calls (costs money, uses rate limits)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, hasAnyCredentials } from '../test-utils';

describe('Auto-Title Generation', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	/**
	 * Helper: Wait for agent session to return to idle state
	 */
	async function waitForIdle(
		agentSession: NonNullable<Awaited<ReturnType<typeof ctx.sessionManager.getSessionAsync>>>,
		timeoutMs = 20000 // 20s to allow for title generation (2 API calls)
	): Promise<void> {
		const startTime = Date.now();
		let lastState: string = '';
		while (Date.now() - startTime < timeoutMs) {
			const state = agentSession.getProcessingState();
			if (state.status !== lastState) {
				lastState = state.status;
			}
			if (state.status === 'idle') {
				return;
			}
			await Bun.sleep(100);
		}
		const finalState = agentSession.getProcessingState();
		const phase = 'phase' in finalState ? finalState.phase : 'N/A';
		throw new Error(
			`Timeout waiting for idle state after ${timeoutMs}ms. Final state: ${finalState.status}, phase: ${phase}`
		);
	}

	test.skipIf(!hasAnyCredentials())(
		'should auto-generate title after first assistant response',
		async () => {
			// Create session with workspace path
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: ctx.config.workspaceRoot,
				config: { model: 'haiku' },
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Get initial session data
			let sessionData = agentSession!.getSessionData();
			expect(sessionData.title).toBe('New Session');
			expect(sessionData.metadata.titleGenerated).toBe(false);

			// Send first message
			await agentSession!.handleMessageSend({
				content: 'What is 2+2?',
			});

			// Wait for first response
			await waitForIdle(agentSession!);

			// Title should NOT be generated yet (need >1 assistant responses)
			sessionData = agentSession!.getSessionData();
			expect(sessionData.title).toBe('New Session');
			expect(sessionData.metadata.titleGenerated).toBe(false);

			// Send second message to trigger title generation
			await agentSession!.handleMessageSend({
				content: 'Write a short poem about TypeScript',
			});

			// Wait for processing to complete (includes title generation)
			await waitForIdle(agentSession!);

			// Give title generation a bit more time (it runs in background)
			await Bun.sleep(2000);

			// Check that title was generated
			sessionData = agentSession!.getSessionData();
			expect(sessionData.title).not.toBe('New Session');
			expect(sessionData.title.length).toBeGreaterThan(0);
			expect(sessionData.title.length).toBeLessThan(100); // Should be concise
			expect(sessionData.metadata.titleGenerated).toBe(true);

			// Verify title doesn't have formatting artifacts
			expect(sessionData.title).not.toMatch(/^["'`]/); // No leading quotes
			expect(sessionData.title).not.toMatch(/["'`]$/); // No trailing quotes
			expect(sessionData.title).not.toMatch(/\*\*/); // No bold markdown
			expect(sessionData.title).not.toMatch(/`/); // No backticks

			console.log(`Generated title: "${sessionData.title}"`);
		},
		40000 // 40s timeout for the entire test (2 messages)
	);

	test.skipIf(!hasAnyCredentials())(
		'should only generate title once per session',
		async () => {
			// Create session
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: ctx.config.workspaceRoot,
				config: { model: 'haiku' },
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Send first message
			await agentSession!.handleMessageSend({
				content: 'What is 2+2?',
			});

			// Wait for first response
			await waitForIdle(agentSession!);

			// Title should NOT be generated yet (need >1 assistant responses)
			let sessionData = agentSession!.getSessionData();
			expect(sessionData.title).toBe('New Session');
			expect(sessionData.metadata.titleGenerated).toBe(false);

			// Send second message to trigger title generation
			await agentSession!.handleMessageSend({
				content: 'What is 3+3?',
			});

			// Wait for processing and title generation
			await waitForIdle(agentSession!);
			await Bun.sleep(2000);

			// Get the generated title
			sessionData = agentSession!.getSessionData();
			const firstTitle = sessionData.title;
			expect(firstTitle).not.toBe('New Session');
			expect(sessionData.metadata.titleGenerated).toBe(true);

			// Send third message
			await agentSession!.handleMessageSend({
				content: 'What is 5+5?',
			});

			// Wait for processing
			await waitForIdle(agentSession!);
			await Bun.sleep(1000);

			// Title should remain the same (not regenerated)
			const secondTitle = agentSession!.getSessionData().title;
			expect(secondTitle).toBe(firstTitle);
		},
		40000 // 40s timeout (3 messages)
	);

	test.skipIf(!hasAnyCredentials())(
		'should handle title generation with workspace path correctly',
		async () => {
			// This test specifically verifies the workspace path fix
			// Create session with explicit workspace path
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: ctx.config.workspaceRoot,
				config: { model: 'haiku' },
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Verify workspace path is set
			const sessionData = agentSession!.getSessionData();
			expect(sessionData.workspacePath).toBe(ctx.config.workspaceRoot);

			// Send first message
			await agentSession!.handleMessageSend({
				content: 'What is 1+1?',
			});

			// Wait for first response
			await waitForIdle(agentSession!);

			// Send second message to trigger title generation
			await agentSession!.handleMessageSend({
				content: 'Explain the concept of recursion briefly',
			});

			// Wait for processing and title generation
			await waitForIdle(agentSession!);
			await Bun.sleep(2000);

			// Title should be generated (workspace path should be passed to SDK)
			const finalSessionData = agentSession!.getSessionData();
			expect(finalSessionData.title).not.toBe('New Session');
			expect(finalSessionData.metadata.titleGenerated).toBe(true);

			console.log(`Generated title with workspace path: "${finalSessionData.title}"`);
		},
		40000 // 40s timeout (2 messages)
	);

	test.skipIf(!hasAnyCredentials())(
		'should handle title generation failure gracefully',
		async () => {
			// Create session
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: ctx.config.workspaceRoot,
				config: { model: 'haiku' },
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(agentSession).toBeDefined();

			// Send first message with minimal content
			await agentSession!.handleMessageSend({
				content: 'ok',
			});

			// Wait for first response
			await waitForIdle(agentSession!);

			// Title should NOT be generated yet
			let sessionData = agentSession!.getSessionData();
			expect(sessionData.title).toBe('New Session');
			expect(sessionData.metadata.titleGenerated).toBe(false);

			// Send second message with minimal content (might not produce a good title)
			await agentSession!.handleMessageSend({
				content: 'yes',
			});

			// Wait for processing and title generation
			await waitForIdle(agentSession!);
			await Bun.sleep(2000);

			// Session should still be functional even if title generation fails
			sessionData = agentSession!.getSessionData();
			// Title might be generated or might remain default - either is acceptable
			// The key is that the session is still functional
			expect(sessionData.metadata.titleGenerated).toBeBoolean();

			// Send another message to verify session is still working
			await agentSession!.handleMessageSend({
				content: 'What is 5+5?',
			});

			await waitForIdle(agentSession!);

			// Session should be idle and functional
			expect(agentSession!.getProcessingState().status).toBe('idle');
		},
		40000 // 40s timeout (3 messages)
	);
});
