/**
 * Auto-Title Generation Integration Tests
 *
 * These tests verify that the auto-title generation feature works correctly
 * with real SDK calls. The feature should:
 * - Generate a title during workspace initialization on first message
 * - Use Haiku model for title generation
 * - Update session metadata with titleGenerated flag
 * - Only generate title once per session
 * - Handle workspace paths correctly (critical for SDK query)
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp } from '../test-utils';
import { sendMessageSync } from '../helpers/test-message-sender';

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
		timeoutMs = 20000 // 20s to allow for title generation
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

	/**
	 * Helper: Wait for title generation to complete
	 * Title generation now happens in PARALLEL with SDK query (fire-and-forget)
	 * We need to poll until titleGenerated is true or timeout
	 */
	async function waitForTitleGeneration(
		agentSession: NonNullable<Awaited<ReturnType<typeof ctx.sessionManager.getSessionAsync>>>,
		timeoutMs = 20000
	): Promise<void> {
		// First wait for agent to be idle
		await waitForIdle(agentSession, timeoutMs);

		// Then poll for title generation (runs in parallel, may take longer)
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			const sessionData = agentSession.getSessionData();
			if (sessionData.metadata.titleGenerated) {
				return; // Title generated successfully
			}
			await Bun.sleep(100);
		}

		// Check if we timed out
		const sessionData = agentSession.getSessionData();
		if (!sessionData.metadata.titleGenerated && sessionData.title === 'New Session') {
			console.warn('Title not generated after timeout');
		}
	}

	test('should auto-generate title after first user message', async () => {
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

		// Send first message (triggers workspace initialization with title generation)
		await sendMessageSync(agentSession!, {
			content: 'What is 2+2?',
		});

		// Wait for first response (title generated during workspace initialization)
		await waitForTitleGeneration(agentSession!);

		// Title should be generated now (via background queue)
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
	}, 30000); // 30s timeout for the entire test (1 message)

	test('should only generate title once per session', async () => {
		// Create session
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: ctx.config.workspaceRoot,
			config: { model: 'haiku' },
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		expect(agentSession).toBeDefined();

		// Send first message
		await sendMessageSync(agentSession!, {
			content: 'What is 2+2?',
		});

		// Wait for first response (title generated during workspace initialization)
		await waitForTitleGeneration(agentSession!);

		// Get the generated title
		let sessionData = agentSession!.getSessionData();
		const firstTitle = sessionData.title;
		expect(firstTitle).not.toBe('New Session');
		expect(sessionData.metadata.titleGenerated).toBe(true);

		// Send second message
		await sendMessageSync(agentSession!, {
			content: 'What is 3+3?',
		});

		// Wait for processing
		await waitForIdle(agentSession!);

		// Wait a bit to ensure no title regeneration happens
		await Bun.sleep(2000);

		// Title should remain the same (not regenerated)
		let sessionData2 = agentSession!.getSessionData();
		expect(sessionData2.title).toBe(firstTitle);

		// Send third message
		await sendMessageSync(agentSession!, {
			content: 'What is 5+5?',
		});

		// Wait for processing
		await waitForIdle(agentSession!);

		// Wait a bit to ensure no title regeneration happens
		await Bun.sleep(2000);

		// Title should still remain the same
		const thirdTitle = agentSession!.getSessionData().title;
		expect(thirdTitle).toBe(firstTitle);
	}, 40000); // 40s timeout (3 messages)

	test('should handle title generation with workspace path correctly', async () => {
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

		// Send first message (title generation should happen after this)
		await sendMessageSync(agentSession!, {
			content: 'What is 1+1?',
		});

		// Wait for processing AND title generation (async via queue)
		await waitForTitleGeneration(agentSession!);

		// Title should be generated (workspace path should be passed to SDK)
		const finalSessionData = agentSession!.getSessionData();
		expect(finalSessionData.title).not.toBe('New Session');
		expect(finalSessionData.metadata.titleGenerated).toBe(true);

		console.log(`Generated title with workspace path: "${finalSessionData.title}"`);
	}, 30000); // 30s timeout (1 message)

	test('should handle title generation failure gracefully', async () => {
		// Create session
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: ctx.config.workspaceRoot,
			config: { model: 'haiku' },
		});

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		expect(agentSession).toBeDefined();

		// Send first message with minimal content
		await sendMessageSync(agentSession!, {
			content: 'ok',
		});

		// Wait for first response (title generation happens during this)
		await waitForIdle(agentSession!);

		// Session should still be functional even if title generation fails
		let sessionData = agentSession!.getSessionData();
		// Title might be generated or might remain default - either is acceptable
		// The key is that the session is still functional
		expect(sessionData.metadata.titleGenerated).toBeBoolean();

		// Send another message to verify session is still working
		await sendMessageSync(agentSession!, {
			content: 'What is 5+5?',
		});

		await waitForIdle(agentSession!);

		// Session should be idle and functional
		expect(agentSession!.getProcessingState().status).toBe('idle');
	}, 30000); // 30s timeout (2 messages)
});
