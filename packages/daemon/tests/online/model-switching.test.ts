/**
 * Model Switching Integration Tests (API-dependent)
 *
 * These tests verify model switching functionality that requires the model cache
 * to be populated. The model cache is only populated when API credentials are
 * available (via initializeModels() which calls the SDK).
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp } from '../test-utils';

describe('Model Switching (API-dependent)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('handleModelSwitch', () => {
		test('should indicate already using model if same model', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const currentModel = agentSession!.getCurrentModel().id;

			const result = await agentSession!.handleModelSwitch(currentModel);

			expect(result.success).toBe(true);
			expect(result.error).toContain('Already using');
		});

		test('should resolve model aliases', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Try with alias - this may or may not work depending on current model
			// The alias 'sonnet' should resolve to a valid model ID
			const result = await agentSession!.handleModelSwitch('sonnet');

			// Either success or already using (if session already has sonnet)
			expect(result.success).toBe(true);
		});
	});
});
