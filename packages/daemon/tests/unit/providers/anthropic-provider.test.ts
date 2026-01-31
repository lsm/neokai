/**
 * Unit tests for Anthropic Provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AnthropicProvider } from '../../../src/lib/providers/anthropic-provider';

describe('AnthropicProvider', () => {
	let provider: AnthropicProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Store original env
		originalEnv = { ...process.env };
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		provider = new AnthropicProvider();
	});

	afterEach(() => {
		// Restore env
		process.env = originalEnv;
	});

	describe('basic properties', () => {
		it('should have correct ID', () => {
			expect(provider.id).toBe('anthropic');
		});

		it('should have correct display name', () => {
			expect(provider.displayName).toBe('Anthropic');
		});

		it('should have full capabilities', () => {
			expect(provider.capabilities).toEqual({
				streaming: true,
				extendedThinking: true,
				maxContextWindow: 200000,
				functionCalling: true,
				vision: true,
			});
		});
	});

	describe('isAvailable', () => {
		it('should return true when ANTHROPIC_API_KEY is set', () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should return true when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should return false when no credentials are set', () => {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			expect(provider.isAvailable()).toBe(false);
		});
	});

	describe('getApiKey', () => {
		it('should prefer ANTHROPIC_API_KEY over OAuth token', () => {
			process.env.ANTHROPIC_API_KEY = 'api-key';
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
			expect(provider.getApiKey()).toBe('api-key');
		});

		it('should return OAuth token when API key not set', () => {
			delete process.env.ANTHROPIC_API_KEY;
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
			expect(provider.getApiKey()).toBe('oauth-token');
		});

		it('should return undefined when neither is set', () => {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			expect(provider.getApiKey()).toBeUndefined();
		});
	});

	describe('getModels without credentials', () => {
		it('should return empty array when no credentials are available', async () => {
			// Remove credentials
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

			// Create new provider instance without credentials
			const providerWithoutCreds = new AnthropicProvider();

			const models = await providerWithoutCreds.getModels();

			// Should return empty array (no static fallback)
			expect(models).toEqual([]);
		});

		it('should not attempt SDK call when credentials are missing', async () => {
			// Remove credentials
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

			const providerWithoutCreds = new AnthropicProvider();

			// This should complete quickly (no SDK call)
			const startTime = Date.now();
			const models = await providerWithoutCreds.getModels();
			const duration = Date.now() - startTime;

			// Should return empty array quickly (< 100ms)
			expect(models).toEqual([]);
			expect(duration).toBeLessThan(100);
		});
	});

	describe('ownsModel', () => {
		it('should own SDK short IDs', () => {
			expect(provider.ownsModel('default')).toBe(true);
			expect(provider.ownsModel('opus')).toBe(true);
			expect(provider.ownsModel('haiku')).toBe(true);
			expect(provider.ownsModel('sonnet')).toBe(true);
		});

		it('should own claude- prefixed models', () => {
			expect(provider.ownsModel('claude-sonnet-4-5-20250929')).toBe(true);
			expect(provider.ownsModel('claude-opus-4-5-20251101')).toBe(true);
			expect(provider.ownsModel('claude-haiku-4-5-20251001')).toBe(true);
		});

		it('should not own other provider models', () => {
			expect(provider.ownsModel('glm-4.7')).toBe(false);
			expect(provider.ownsModel('deepseek-coder')).toBe(false);
			expect(provider.ownsModel('gpt-4')).toBe(false);
		});

		it('should default to owning unknown models (for compatibility)', () => {
			expect(provider.ownsModel('some-unknown-model')).toBe(true);
		});
	});

	describe('getModelForTier', () => {
		it('should map tiers correctly', () => {
			expect(provider.getModelForTier('sonnet')).toBe('default');
			expect(provider.getModelForTier('haiku')).toBe('haiku');
			expect(provider.getModelForTier('opus')).toBe('opus');
			expect(provider.getModelForTier('default')).toBe('default');
		});
	});

	describe('buildSdkConfig', () => {
		it('should return empty env vars for Anthropic', () => {
			const config = provider.buildSdkConfig('default');

			expect(config.envVars).toEqual({});
			expect(config.isAnthropicCompatible).toBe(true);
			expect(config.apiVersion).toBe('v1');
		});
	});

	describe('model cache', () => {
		it('should allow setting model cache', async () => {
			const customModels = [
				{
					id: 'custom-model',
					name: 'Custom',
					alias: 'custom',
					family: 'sonnet' as const,
					provider: 'anthropic' as const,
					contextWindow: 100000,
					description: 'Custom model',
					releaseDate: '',
					available: true,
				},
			];

			provider.setModelCache(customModels);
			const models = await provider.getModels();

			expect(models).toEqual(customModels);
		});

		it('should allow clearing model cache', async () => {
			// Set cache first
			provider.setModelCache([
				{
					id: 'cached',
					name: 'Cached',
					alias: 'cached',
					family: 'sonnet' as const,
					provider: 'anthropic' as const,
					contextWindow: 100000,
					description: 'Cached',
					releaseDate: '',
					available: true,
				},
			]);

			// Clear cache
			provider.clearModelCache();

			// Should return empty array when cache is cleared and no credentials
			const models = await provider.getModels();
			expect(models).toEqual([]);
		});
	});
});
