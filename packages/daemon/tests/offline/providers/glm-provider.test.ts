/**
 * Unit tests for GLM Provider
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';

describe('GlmProvider', () => {
	let provider: GlmProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Store original env
		originalEnv = { ...process.env };
		provider = new GlmProvider();
	});

	afterEach(() => {
		// Restore env
		process.env = originalEnv;
	});

	describe('basic properties', () => {
		it('should have correct ID', () => {
			expect(provider.id).toBe('glm');
		});

		it('should have correct display name', () => {
			expect(provider.displayName).toBe('GLM (智谱AI)');
		});

		it('should have correct capabilities', () => {
			expect(provider.capabilities).toEqual({
				streaming: true,
				extendedThinking: false, // GLM doesn't support extended thinking
				maxContextWindow: 128000,
				functionCalling: true,
				vision: true,
			});
		});
	});

	describe('isAvailable', () => {
		it('should return true when GLM_API_KEY is set', () => {
			process.env.GLM_API_KEY = 'test-key';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should return true when ZHIPU_API_KEY is set', () => {
			process.env.ZHIPU_API_KEY = 'test-key';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should prefer GLM_API_KEY over ZHIPU_API_KEY', () => {
			process.env.GLM_API_KEY = 'glm-key';
			process.env.ZHIPU_API_KEY = 'zhipu-key';
			expect(provider.getApiKey()).toBe('glm-key');
		});

		it('should return false when no API key is set', () => {
			delete process.env.GLM_API_KEY;
			delete process.env.ZHIPU_API_KEY;
			expect(provider.isAvailable()).toBe(false);
		});
	});

	describe('getModels', () => {
		it('should return GLM models when API key is available', async () => {
			process.env.GLM_API_KEY = 'test-key';

			const models = await provider.getModels();

			expect(models).toHaveLength(2);
			expect(models.map((m) => m.id)).toEqual(['glm-4.7', 'glm-4.5-air']);
		});

		it('should return empty array when API key is not available', async () => {
			delete process.env.GLM_API_KEY;
			delete process.env.ZHIPU_API_KEY;

			const models = await provider.getModels();
			expect(models).toEqual([]);
		});

		it('should include provider field in models', async () => {
			process.env.GLM_API_KEY = 'test-key';

			const models = await provider.getModels();

			for (const model of models) {
				expect(model.provider).toBe('glm');
			}
		});
	});

	describe('ownsModel', () => {
		it('should own glm- prefixed models', () => {
			expect(provider.ownsModel('glm-4.7')).toBe(true);
			expect(provider.ownsModel('glm-4.5-air')).toBe(true);
			expect(provider.ownsModel('GLM-4')).toBe(true); // case insensitive
		});

		it('should not own other provider models', () => {
			expect(provider.ownsModel('default')).toBe(false);
			expect(provider.ownsModel('opus')).toBe(false);
			expect(provider.ownsModel('claude-sonnet-4-5')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('should map haiku tier to glm-4.5-air', () => {
			expect(provider.getModelForTier('haiku')).toBe('glm-4.5-air');
		});

		it('should map other tiers to glm-4.7', () => {
			expect(provider.getModelForTier('sonnet')).toBe('glm-4.7');
			expect(provider.getModelForTier('opus')).toBe('glm-4.7');
			expect(provider.getModelForTier('default')).toBe('glm-4.7');
		});
	});

	describe('buildSdkConfig', () => {
		it('should build correct config for glm-4.7', () => {
			process.env.GLM_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('glm-4.7');

			expect(config.envVars).toEqual({
				ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
				ANTHROPIC_AUTH_TOKEN: 'test-key',
				API_TIMEOUT_MS: '3000000',
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
				ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
			});
			expect(config.isAnthropicCompatible).toBe(true);
		});

		it('should build correct config for glm-4.5-air', () => {
			process.env.GLM_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('glm-4.5-air');

			expect(config.envVars).toEqual({
				ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
				ANTHROPIC_AUTH_TOKEN: 'test-key',
				API_TIMEOUT_MS: '3000000',
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
			});
		});

		it('should use session config API key override', () => {
			process.env.GLM_API_KEY = 'env-key';

			const config = provider.buildSdkConfig('glm-4.7', {
				apiKey: 'session-key',
			});

			expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
		});

		it('should use session config baseUrl override', () => {
			process.env.GLM_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('glm-4.7', {
				baseUrl: 'https://custom.example.com',
			});

			expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com');
		});

		it('should throw when no API key is configured', () => {
			delete process.env.GLM_API_KEY;
			delete process.env.ZHIPU_API_KEY;

			expect(() => provider.buildSdkConfig('glm-4.7')).toThrow('GLM API key not configured');
		});
	});

	describe('translateModelIdForSdk', () => {
		it('should translate glm-4.5-air to haiku', () => {
			expect(provider.translateModelIdForSdk('glm-4.5-air')).toBe('haiku');
		});

		it('should translate glm-4.7 to default', () => {
			expect(provider.translateModelIdForSdk('glm-4.7')).toBe('default');
		});

		it('should translate other GLM models to default', () => {
			expect(provider.translateModelIdForSdk('glm-4')).toBe('default');
		});
	});

	describe('getTitleGenerationModel', () => {
		it('should return glm-4.5-air for title generation', () => {
			expect(provider.getTitleGenerationModel()).toBe('glm-4.5-air');
		});
	});

	describe('static models', () => {
		it('should have static models defined', () => {
			expect(GlmProvider.MODELS).toHaveLength(2);
			expect(GlmProvider.MODELS.map((m) => m.id)).toEqual(['glm-4.7', 'glm-4.5-air']);
		});

		it('should have correct base URL', () => {
			expect(GlmProvider.BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
		});
	});
});
