/**
 * Session Resume Integration Tests (API-dependent)
 *
 * Tests the full flow of SDK session resumption that require actual API access.
 * These tests make real SDK calls to capture and verify session IDs.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, beforeEach, afterEach, expect, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp } from '../../test-utils';
import { sendMessageSync } from '../../helpers/test-message-sender';

describe('Session Resume (API-dependent)', () => {
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
		agentSession: NonNullable<Awaited<ReturnType<typeof ctx.sessionManager.getSessionAsync>>>
	): Promise<void> {
		const timeout = 15000;
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const state = agentSession.getProcessingState();
			if (state.status === 'idle') {
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error(`Timeout waiting for idle state (${timeout}ms)`);
	}

	test('should capture SDK session ID on first message', async () => {
		// Create a new session using cwd (avoid temp path issues on CI)
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		expect(sessionId).toBeDefined();

		// Get session from database - initially no SDK session ID
		let session = ctx.db.getSession(sessionId);
		expect(session).toBeDefined();
		expect(session?.sdkSessionId).toBeUndefined();

		// Get the agent session
		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		expect(agentSession).toBeDefined();

		// Send a message using sendMessageSync - this properly waits for message to be enqueued
		// and the SDK query to start
		await sendMessageSync(agentSession!, {
			content: 'What is 1+1? Just the number.',
		});

		// Wait for SDK to process and return to idle
		await waitForIdle(agentSession!);

		// Now check for SDK session ID - it should be captured after SDK responds
		session = ctx.db.getSession(sessionId);
		expect(session?.sdkSessionId).toBeDefined();
		expect(typeof session?.sdkSessionId).toBe('string');
	}, 30000);
});
