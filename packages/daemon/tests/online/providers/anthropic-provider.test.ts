/**
 * Online tests for Anthropic Provider
 * Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AnthropicProvider } from '../../../src/lib/providers/anthropic-provider';

describe('AnthropicProvider (Online)', () => {
	let provider: AnthropicProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Store original env
		originalEnv = { ...process.env };
		provider = new AnthropicProvider();
	});

	afterEach(() => {
		// Restore env
		process.env = originalEnv;
	});

	describe('getModels with API credentials', () => {
		it('should load models from SDK when credentials are available', async () => {
			// This test requires real credentials
			if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
				console.log('Skipping - no API credentials');
				return;
			}

			// Clear cache to force SDK load
			provider.clearModelCache();

			const models = await provider.getModels();

			// SDK should return at least 3 models
			expect(models.length).toBeGreaterThanOrEqual(3);

			// Check for expected models
			const modelIds = models.map((m) => m.id);
			expect(modelIds).toContain('sonnet'); // 'default' is now 'sonnet'
			expect(modelIds).toContain('opus');
			expect(modelIds).toContain('haiku');

			// All models should have provider field
			for (const model of models) {
				expect(model.provider).toBe('anthropic');
			}
		}, 10000); // 10 second timeout for SDK call

		it('should filter duplicate model IDs', async () => {
			// This test requires real credentials
			if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
				console.log('Skipping - no API credentials');
				return;
			}

			// Clear cache to force SDK load
			provider.clearModelCache();

			const models = await provider.getModels();
			const modelIds = models.map((m) => m.id);

			// Should not contain duplicate full version IDs when canonical ID exists
			// Example: should not have both 'default' and 'claude-sonnet-4-5-20250929'
			const uniqueIds = new Set(modelIds);
			expect(modelIds.length).toBe(uniqueIds.size);

			// Should not contain legacy full version ID if DEFAULT_MODEL was set to it
			const hasLegacyId = modelIds.some((id) => id === 'claude-sonnet-4-5-20250929');
			expect(hasLegacyId).toBe(false);
		}, 10000); // 10 second timeout for SDK call

		it('should complete SDK call within timeout', async () => {
			// This test requires real credentials
			if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
				console.log('Skipping - no API credentials');
				return;
			}

			// Clear cache to force SDK load
			provider.clearModelCache();

			const startTime = Date.now();
			const models = await provider.getModels();
			const duration = Date.now() - startTime;

			// Should return models
			expect(models.length).toBeGreaterThanOrEqual(3);

			// Should complete within reasonable time
			// Note: In CI, this might be slower, but should still be under 5s
			expect(duration).toBeLessThan(5000);
		}, 10000); // 10 second timeout
	});
});
