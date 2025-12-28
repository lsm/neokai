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
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

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

	test('should capture SDK session ID on first message', async () => {
		// Create a new session
		const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
			workspacePath: `${TMP_DIR}/test-session-resume`,
		});

		expect(sessionId).toBeDefined();

		// Get session from database - initially no SDK session ID
		let session = ctx.db.getSession(sessionId);
		expect(session).toBeDefined();
		expect(session?.sdkSessionId).toBeUndefined();

		// Set up a promise that resolves when SDK session ID is captured
		// Note: Workspace initialization (including title generation) can take up to 15s,
		// so we need a longer timeout here. The SDK session ID is captured after SDK query starts.
		const sdkSessionIdCaptured = new Promise<void>((resolve) => {
			const checkInterval = setInterval(() => {
				const updatedSession = ctx.db.getSession(sessionId);
				if (updatedSession?.sdkSessionId) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);

			// Timeout after 20 seconds (workspace init can take 15s + SDK query setup)
			setTimeout(() => {
				clearInterval(checkInterval);
				resolve();
			}, 20000);
		});

		// Send a message to trigger SDK initialization
		await callRPCHandler(ctx.messageHub, 'message.send', {
			sessionId,
			content: 'Hello',
		});

		// Wait for SDK session ID to be captured
		await sdkSessionIdCaptured;

		// Retrieve session from database - SDK session ID should now be captured
		session = ctx.db.getSession(sessionId);
		expect(session?.sdkSessionId).toBeDefined();
		expect(typeof session?.sdkSessionId).toBe('string');
	}, 30000);
});
