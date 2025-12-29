/**
 * Session Resume Integration Tests (API-dependent)
 *
 * Tests the full flow of SDK session resumption that require actual API access.
 * These tests make real SDK calls to capture and verify session IDs.
 *
 * NOTE: The failing test "should capture SDK session ID on first message" has been
 * moved to sdk-streaming-failures.test.ts for separate debugging.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test } from 'bun:test';

// Placeholder describe to prevent empty file linter error
describe('Session Resume (API-dependent)', () => {
	test.skip('tests moved to sdk-streaming-failures.test.ts', () => {
		// This file's tests have been moved to sdk-streaming-failures.test.ts
	});
});
