/**
 * Unit tests for MiniMax Provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';

describe('MinimaxProvider', () => {
	let provider: MinimaxProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.MINIMAX_API_KEY;
		provider = new MinimaxProvider();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('basic properties', () => {
		it('should have correct ID', () => {
			expect(provider.id).toBe('minimax');
		});

		it('should have correct display name', () => {
			expect(provider.displayName).toBe('MiniMax');
		});

		it('should have correct capabilities', () => {
			expect(provider.capabilities).toEqual({
				streaming: true,
				extendedThinking: false,
				maxContextWindow: 200000,
				functionCalling: true,
				vision: true,
			});
		});
	});

	describe('isAvailable', () => {
		it('should return true when MINIMAX_API_KEY is set', () => {
			process.env.MINIMAX_API_KEY = 'test-key';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should return false when no API key is set', () => {
			delete process.env.MINIMAX_API_KEY;
			expect(provider.isAvailable()).toBe(false);
		});
	});

	describe('getModels', () => {
		it('should return MiniMax models when API key is available', async () => {
			process.env.MINIMAX_API_KEY = 'test-key';

			const models = await provider.getModels();

			expect(models).toHaveLength(1);
			expect(models.map((m) => m.id)).toEqual(['MiniMax-M2.5']);
		});

		it('should return empty array when API key is not available', async () => {
			delete process.env.MINIMAX_API_KEY;

			const models = await provider.getModels();
			expect(models).toEqual([]);
		});

		it('should include provider field in models', async () => {
			process.env.MINIMAX_API_KEY = 'test-key';

			const models = await provider.getModels();

			for (const model of models) {
				expect(model.provider).toBe('minimax');
			}
		});
	});

	describe('ownsModel', () => {
		it('should own minimax- prefixed models', () => {
			expect(provider.ownsModel('MiniMax-M2.5')).toBe(true);
			expect(provider.ownsModel('minimax-m2.5')).toBe(true);
		});

		it('should not own other provider models', () => {
			expect(provider.ownsModel('default')).toBe(false);
			expect(provider.ownsModel('opus')).toBe(false);
			expect(provider.ownsModel('glm-5')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('should map all tiers to MiniMax-M2.5', () => {
			expect(provider.getModelForTier('haiku')).toBe('MiniMax-M2.5');
			expect(provider.getModelForTier('sonnet')).toBe('MiniMax-M2.5');
			expect(provider.getModelForTier('opus')).toBe('MiniMax-M2.5');
			expect(provider.getModelForTier('default')).toBe('MiniMax-M2.5');
		});
	});

	describe('buildSdkConfig', () => {
		it('should build correct config for MiniMax-M2.5', () => {
			process.env.MINIMAX_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('MiniMax-M2.5');

			expect(config.envVars).toEqual({
				ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
				ANTHROPIC_AUTH_TOKEN: 'test-key',
				API_TIMEOUT_MS: '3000000',
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.5',
				ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.5',
				ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.5',
			});
			expect(config.isAnthropicCompatible).toBe(true);
		});

		it('should use session config API key override', () => {
			process.env.MINIMAX_API_KEY = 'env-key';

			const config = provider.buildSdkConfig('MiniMax-M2.5', {
				apiKey: 'session-key',
			});

			expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
		});

		it('should use session config baseUrl override', () => {
			process.env.MINIMAX_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('MiniMax-M2.5', {
				baseUrl: 'https://custom.example.com',
			});

			expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://custom.example.com');
		});

		it('should throw when no API key is configured', () => {
			delete process.env.MINIMAX_API_KEY;

			expect(() => provider.buildSdkConfig('MiniMax-M2.5')).toThrow(
				'MiniMax API key not configured'
			);
		});
	});

	describe('translateModelIdForSdk', () => {
		it('should translate MiniMax-M2.5 to default', () => {
			expect(provider.translateModelIdForSdk('MiniMax-M2.5')).toBe('default');
		});
	});

	describe('getTitleGenerationModel', () => {
		it('should return MiniMax-M2.5 for title generation', () => {
			expect(provider.getTitleGenerationModel()).toBe('MiniMax-M2.5');
		});
	});

	describe('static models', () => {
		it('should have static models defined', () => {
			expect(MinimaxProvider.MODELS).toHaveLength(1);
			expect(MinimaxProvider.MODELS.map((m) => m.id)).toEqual(['MiniMax-M2.5']);
		});

		it('should have correct base URL', () => {
			expect(MinimaxProvider.BASE_URL).toBe('https://api.minimax.io/anthropic');
		});
	});
});
