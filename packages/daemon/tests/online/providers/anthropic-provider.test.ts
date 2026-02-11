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

			// Check for expected models (at least one from each family)
			const modelIds = models.map((m) => m.id);
			const hasSonnet = modelIds.some((id) => id.includes('sonnet') || id === 'default');
			const hasOpus = modelIds.some((id) => id.includes('opus'));
			const hasHaiku = modelIds.some((id) => id.includes('haiku'));
			expect(hasSonnet).toBe(true);
			expect(hasOpus).toBe(true);
			expect(hasHaiku).toBe(true);

			// All models should have provider field
			for (const model of models) {
				expect(model.provider).toBe('anthropic');
			}
		}, 30000);

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

			// Should not contain duplicate IDs
			const uniqueIds = new Set(modelIds);
			expect(modelIds.length).toBe(uniqueIds.size);
		}, 30000);

		it('should complete SDK call within timeout', async () => {
			// This test requires real credentials
			if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
				console.log('Skipping - no API credentials');
				return;
			}

			// Clear cache to force SDK load
			provider.clearModelCache();

			const models = await provider.getModels();

			// Should return models
			expect(models.length).toBeGreaterThanOrEqual(3);

			// The bun:test timeout (below) enforces the time constraint.
			// We don't assert duration explicitly since CI latency varies widely.
		}, 30000);
	});
});
