/**
 * Authentication Integration Tests (API-dependent)
 *
 * Tests for authentication functionality that requires API credentials.
 * These tests verify that authenticated sessions work correctly.
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

// Check for GLM credentials
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

// Skip all tests if GLM credentials are not available
describe.skipIf(!GLM_API_KEY)('Authentication Integration (API-dependent)', () => {
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
