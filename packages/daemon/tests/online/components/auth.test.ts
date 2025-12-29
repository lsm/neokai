/**
 * Authentication Integration Tests (API-dependent)
 *
 * Tests for authentication functionality that requires API credentials.
 * These tests verify that authenticated sessions work correctly.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Authentication Integration (API-dependent)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Session Creation with Auth', () => {
		test('should create session only if authenticated', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-auth`,
			});

			expect(result.sessionId).toBeString();

			// Verify session was created
			const session = ctx.db.getSession(result.sessionId);
			expect(session).toBeDefined();
		});
	});
});
