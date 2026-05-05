/**
 * Unit tests for Kimi Provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider';

describe('KimiProvider', () => {
	let provider: KimiProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.KIMI_API_KEY;
		delete process.env.MOONSHOT_API_KEY;
		provider = new KimiProvider();
	});

	afterEach(async () => {
		await provider.shutdown();
		process.env = originalEnv;
	});

	describe('basic properties', () => {
		it('should have correct ID and display name', () => {
			expect(provider.id).toBe('kimi');
			expect(provider.displayName).toBe('Kimi (Moonshot AI)');
		});

		it('should have correct capabilities', () => {
			expect(provider.capabilities).toEqual({
				streaming: true,
				extendedThinking: false,
				maxContextWindow: 262144,
				functionCalling: true,
				vision: false,
			});
		});
	});

	describe('isAvailable', () => {
		it('should return true when KIMI_API_KEY is set', () => {
			process.env.KIMI_API_KEY = 'test-key';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should return true when MOONSHOT_API_KEY is set', () => {
			process.env.MOONSHOT_API_KEY = 'test-key';
			expect(provider.isAvailable()).toBe(true);
		});

		it('should prefer KIMI_API_KEY over MOONSHOT_API_KEY', () => {
			process.env.KIMI_API_KEY = 'kimi-key';
			process.env.MOONSHOT_API_KEY = 'moonshot-key';
			expect(provider.getApiKey()).toBe('kimi-key');
		});

		it('should return false when no API key is set', () => {
			expect(provider.isAvailable()).toBe(false);
		});
	});

	describe('getModels', () => {
		it('should return Kimi models when API key is available', async () => {
			process.env.KIMI_API_KEY = 'test-key';

			const models = await provider.getModels();

			expect(models.map((m) => m.id)).toEqual(['kimi-k2', 'kimi-k2.5', 'kimi-k2.6']);
			expect(models.every((m) => m.provider === 'kimi')).toBe(true);
		});

		it('should return empty array when API key is not available', async () => {
			const models = await provider.getModels();
			expect(models).toEqual([]);
		});
	});

	describe('ownsModel', () => {
		it('should own kimi and moonshot model IDs', () => {
			expect(provider.ownsModel('kimi-k2')).toBe(true);
			expect(provider.ownsModel('kimi-k2.5')).toBe(true);
			expect(provider.ownsModel('kimi-k2.6')).toBe(true);
			expect(provider.ownsModel('kimi')).toBe(true);
			expect(provider.ownsModel('moonshot-v1-32k')).toBe(true);
		});

		it('should not own other provider models', () => {
			expect(provider.ownsModel('default')).toBe(false);
			expect(provider.ownsModel('glm-5')).toBe(false);
			expect(provider.ownsModel('claude-sonnet-4-5')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('should map all tiers to default Kimi model', () => {
			expect(provider.getModelForTier('haiku')).toBe('kimi-k2.5');
			expect(provider.getModelForTier('sonnet')).toBe('kimi-k2.5');
			expect(provider.getModelForTier('opus')).toBe('kimi-k2.5');
			expect(provider.getModelForTier('default')).toBe('kimi-k2.5');
		});
	});

	describe('buildSdkConfig', () => {
		it('should build direct-connect config for kimi-k2.6', () => {
			process.env.KIMI_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('kimi-k2.6');

			expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding');
			expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
			expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
			expect(config.envVars.API_TIMEOUT_MS).toBe('3000000');
			expect(config.envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
			expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.6');
			expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.6');
			expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.6');
			expect(config.isAnthropicCompatible).toBe(true);
			expect(config.apiVersion).toBe('v1');
		});

		it('should fall back to default Kimi model for non-Kimi IDs', () => {
			process.env.KIMI_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('default');

			expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.5');
			expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.5');
			expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.5');
		});

		it('should fall back to default Kimi model for mixed-case Kimi alias', () => {
			process.env.KIMI_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('Kimi');

			expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.5');
			expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.5');
			expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.5');
		});

		it('should lowercase mixed-case model IDs for routing', () => {
			process.env.KIMI_API_KEY = 'test-key';

			const config = provider.buildSdkConfig('Kimi-K2.6');

			expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.6');
			expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.6');
			expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.6');
		});

		it('should use session config API key and base URL overrides', () => {
			process.env.KIMI_API_KEY = 'env-key';

			const config = provider.buildSdkConfig('kimi-k2', {
				apiKey: 'session-key',
				baseUrl: 'https://api.moonshot.cn/anthropic',
			});

			expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
			expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('session-key');
			expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2');
		});

		it('should throw when no API key is configured', () => {
			expect(() => provider.buildSdkConfig('kimi-k2.5')).toThrow('Kimi API key not configured');
		});
	});

	describe('translateModelIdForSdk', () => {
		it('should translate Kimi models to default', () => {
			expect(provider.translateModelIdForSdk('kimi-k2.5')).toBe('default');
		});
	});

	describe('static models', () => {
		it('should have correct static model definitions', () => {
			expect(KimiProvider.BASE_URL).toBe('https://api.kimi.com/coding');
			expect(KimiProvider.MODELS).toHaveLength(3);
			expect(KimiProvider.MODELS.find((m) => m.id === 'kimi-k2.6')?.contextWindow).toBe(262144);
		});
	});
});
