/**
 * Unit tests for ProviderService
 *
 * Tests provider operations and environment variable management.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderId } from '@neokai/shared/provider';
import type { Session } from '@neokai/shared';
import type { ModelInfo } from '@neokai/shared';
import type { Provider, ProviderSdkConfig } from '@neokai/shared/provider';
import { ProviderService, getProviderService } from '../../../src/lib/provider-service';
import { resetProviderFactory } from '../../../src/lib/providers/factory';
import { ProviderRegistry, resetProviderRegistry } from '../../../src/lib/providers/registry';

// Mock provider for testing
class MockProvider implements Provider {
	readonly id: string;
	readonly displayName: string;
	readonly capabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 100000,
		functionCalling: true,
		vision: false,
	};

	private available: boolean;
	private modelPrefix: string;
	private models: ModelInfo[];

	constructor(
		id: string = 'mock',
		displayName: string = 'Mock Provider',
		available: boolean = true,
		modelPrefix: string = 'mock-'
	) {
		this.id = id;
		this.displayName = displayName;
		this.available = available;
		this.modelPrefix = modelPrefix;
		this.models = [
			{
				id: `${modelPrefix}1`,
				name: 'Mock Model 1',
				alias: 'mock1',
				family: 'mock',
				provider: id,
				contextWindow: 100000,
				description: 'Mock model',
				releaseDate: '',
				available: true,
			},
		];
	}

	isAvailable(): boolean {
		return this.available;
	}

	async getModels(): Promise<ModelInfo[]> {
		return this.models;
	}

	ownsModel(modelId: string): boolean {
		return modelId.toLowerCase().startsWith(this.modelPrefix);
	}

	getModelForTier(tier: string): string | undefined {
		if (tier === 'haiku') return `${this.modelPrefix}haiku`;
		return `${this.modelPrefix}1`;
	}

	buildSdkConfig(
		modelId: string,
		sessionConfig?: { apiKey?: string; baseUrl?: string }
	): ProviderSdkConfig {
		return {
			envVars: {
				ANTHROPIC_BASE_URL: 'https://mock.api.com',
				ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || 'mock-api-key',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	translateModelIdForSdk(modelId: string): string {
		return modelId.replace(this.modelPrefix, 'translated-');
	}
}

// GLM-like provider for testing
class GlmMockProvider extends MockProvider {
	readonly id = 'glm' as const;
	readonly displayName = 'GLM Provider';

	constructor(available: boolean = true) {
		super('glm', 'GLM Provider', available, 'glm-');
	}

	ownsModel(modelId: string): boolean {
		return modelId.toLowerCase().startsWith('glm-') || modelId.toLowerCase().includes('glm');
	}

	buildSdkConfig(
		modelId: string,
		sessionConfig?: { apiKey?: string; baseUrl?: string }
	): ProviderSdkConfig {
		return {
			envVars: {
				ANTHROPIC_BASE_URL: 'https://api.glm.example.com',
				ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || process.env.GLM_API_KEY || 'glm-key',
				API_TIMEOUT_MS: '120000',
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4-flash',
				ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4',
			},
			isAnthropicCompatible: true,
		};
	}
}

// Anthropic-like provider for testing
class AnthropicMockProvider extends MockProvider {
	readonly id = 'anthropic' as const;
	readonly displayName = 'Anthropic';

	constructor(available: boolean = true) {
		super('anthropic', 'Anthropic', available, 'claude-');
	}

	ownsModel(modelId: string): boolean {
		// Anthropic owns default, sonnet, haiku, opus, and claude-* models
		return (
			modelId.toLowerCase().startsWith('claude-') ||
			['default', 'sonnet', 'haiku', 'opus'].includes(modelId.toLowerCase())
		);
	}

	buildSdkConfig(): ProviderSdkConfig {
		// Anthropic returns empty env vars (uses default)
		return {
			envVars: {},
			isAnthropicCompatible: true,
		};
	}

	translateModelIdForSdk(modelId: string): string {
		// Anthropic models pass through
		return modelId;
	}
}

describe('ProviderService', () => {
	let service: ProviderService;
	let registry: ProviderRegistry;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		// Save original env vars
		originalEnv = {
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
			ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
			ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
			CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
			GLM_API_KEY: process.env.GLM_API_KEY,
			ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
			API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
			ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
			ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
		};

		// Clear env vars for clean tests
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.GLM_API_KEY;
		delete process.env.ZHIPU_API_KEY;
		delete process.env.API_TIMEOUT_MS;
		delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

		// Reset singletons
		resetProviderRegistry();
		resetProviderFactory();

		// Get fresh registry and register test providers
		registry = new ProviderRegistry();
		registry.register(new AnthropicMockProvider(true));
		registry.register(new GlmMockProvider(true));

		// Create service
		service = new ProviderService();

		// Patch the getRegistry method to use our test registry
		// @ts-expect-error - accessing private method for testing
		service.getRegistry = () => registry;
	});

	afterEach(() => {
		// Restore original env vars
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}

		resetProviderRegistry();
		resetProviderFactory();
	});

	describe('getDefaultProvider', () => {
		it('should return the default provider', async () => {
			const provider = await service.getDefaultProvider();
			expect(provider).toBe('anthropic');
		});
	});

	describe('getProviderApiKey', () => {
		it('should return ANTHROPIC_API_KEY for anthropic provider', () => {
			process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
			const key = service.getProviderApiKey('anthropic');
			expect(key).toBe('test-anthropic-key');
		});

		it('should return CLAUDE_CODE_OAUTH_TOKEN for anthropic if no API key', () => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
			const key = service.getProviderApiKey('anthropic');
			expect(key).toBe('test-oauth-token');
		});

		it('should return GLM_API_KEY for glm provider', () => {
			process.env.GLM_API_KEY = 'test-glm-key';
			const key = service.getProviderApiKey('glm');
			expect(key).toBe('test-glm-key');
		});

		it('should return ZHIPU_API_KEY for glm if no GLM_API_KEY', () => {
			process.env.ZHIPU_API_KEY = 'test-zhipu-key';
			const key = service.getProviderApiKey('glm');
			expect(key).toBe('test-zhipu-key');
		});

		it('should return undefined for unknown provider', () => {
			const key = service.getProviderApiKey('unknown' as unknown as ProviderId);
			expect(key).toBeUndefined();
		});

		it('should return undefined for unregistered provider', () => {
			registry.clear();
			const key = service.getProviderApiKey('anthropic');
			expect(key).toBeUndefined();
		});
	});

	describe('isProviderAvailable', () => {
		it('should return true for available provider', async () => {
			const available = await service.isProviderAvailable('anthropic');
			expect(available).toBe(true);
		});

		it('should return false for unavailable provider', async () => {
			registry.clear();
			registry.register(new AnthropicMockProvider(false));

			const available = await service.isProviderAvailable('anthropic');
			expect(available).toBe(false);
		});

		it('should return false for unknown provider', async () => {
			const available = await service.isProviderAvailable('unknown' as unknown as ProviderId);
			expect(available).toBe(false);
		});
	});

	describe('getProviderInfo', () => {
		it('should return provider info for registered provider', async () => {
			const info = await service.getProviderInfo('anthropic');

			expect(info.id).toBe('anthropic');
			expect(info.name).toBe('Anthropic');
			expect(info.available).toBe(true);
			expect(info.models).toBeDefined();
		});

		it('should return default info for unknown provider', async () => {
			const info = await service.getProviderInfo('unknown' as unknown as ProviderId);

			expect(info.id).toBe('unknown');
			expect(info.name).toBe('unknown');
			expect(info.available).toBe(false);
			expect(info.models).toEqual([]);
		});

		it('should include base URL from SDK config', async () => {
			const info = await service.getProviderInfo('glm');

			expect(info.baseUrl).toBe('https://api.glm.example.com');
		});
	});

	describe('getAvailableProviders', () => {
		it('should return all registered providers with availability status', async () => {
			const providers = await service.getAvailableProviders();

			expect(providers.length).toBe(2);
			expect(providers.map((p) => p.id)).toContain('anthropic');
			expect(providers.map((p) => p.id)).toContain('glm');
		});

		it('should include availability status for each provider', async () => {
			registry.clear();
			registry.register(new AnthropicMockProvider(true));
			registry.register(new GlmMockProvider(false));

			const providers = await service.getAvailableProviders();

			// Method returns all providers with their availability flag
			expect(providers.length).toBe(2);

			const anthropicProvider = providers.find((p) => p.id === 'anthropic');
			const glmProvider = providers.find((p) => p.id === 'glm');

			expect(anthropicProvider?.available).toBe(true);
			expect(glmProvider?.available).toBe(false);
		});
	});

	describe('validateProviderSwitch', () => {
		it('should validate available provider', async () => {
			const result = await service.validateProviderSwitch('anthropic');
			expect(result.valid).toBe(true);
		});

		it('should reject unavailable provider without API key', async () => {
			registry.clear();
			registry.register(new GlmMockProvider(false));

			const result = await service.validateProviderSwitch('glm');
			expect(result.valid).toBe(false);
			expect(result.error).toContain('not available');
		});

		it('should accept unavailable provider with API key', async () => {
			registry.clear();
			registry.register(new GlmMockProvider(false));

			const result = await service.validateProviderSwitch('glm', 'test-key');
			expect(result.valid).toBe(true);
		});
	});

	describe('getDefaultModelForProvider', () => {
		it('should return default model for provider', async () => {
			const model = await service.getDefaultModelForProvider('glm');
			expect(model).toBe('glm-1');
		});

		it('should return "default" for unknown provider', async () => {
			const model = await service.getDefaultModelForProvider('unknown' as unknown as ProviderId);
			expect(model).toBe('default');
		});
	});

	describe('getTitleGenerationConfig', () => {
		it('should return config for registered provider', async () => {
			const config = await service.getTitleGenerationConfig('glm');

			expect(config.modelId).toBe('glm-haiku');
			expect(config.baseUrl).toBe('https://api.glm.example.com');
			expect(config.apiVersion).toBe('v1');
		});

		it('should return fallback config for unknown provider', async () => {
			const config = await service.getTitleGenerationConfig('unknown' as unknown as ProviderId);

			expect(config.modelId).toBe('haiku');
			expect(config.baseUrl).toBe('https://api.anthropic.com');
			expect(config.apiVersion).toBe('v1');
		});
	});

	describe('isModelValidForProvider', () => {
		it('should return true for valid model', async () => {
			const valid = await service.isModelValidForProvider('glm', 'glm-4');
			expect(valid).toBe(true);
		});

		it('should return false for invalid model', async () => {
			const valid = await service.isModelValidForProvider('glm', 'claude-3-opus');
			expect(valid).toBe(false);
		});

		it('should return false for unknown provider', async () => {
			const valid = await service.isModelValidForProvider(
				'unknown' as unknown as ProviderId,
				'any-model'
			);
			expect(valid).toBe(false);
		});
	});

	describe('isGlmModel', () => {
		it('should return true for GLM model', () => {
			const isGlm = service.isGlmModel('glm-4');
			expect(isGlm).toBe(true);
		});

		it('should return false for non-GLM model', () => {
			const isGlm = service.isGlmModel('claude-3-opus');
			expect(isGlm).toBe(false);
		});
	});

	describe('detectProviderFromModel', () => {
		it('should detect anthropic provider', () => {
			const provider = service.detectProviderFromModel('claude-3-opus');
			expect(provider).toBe('anthropic');
		});

		it('should detect glm provider', () => {
			const provider = service.detectProviderFromModel('glm-4');
			expect(provider).toBe('glm');
		});

		it('should default to anthropic for unknown model', () => {
			const provider = service.detectProviderFromModel('unknown-model');
			expect(provider).toBe('anthropic');
		});
	});

	describe('translateModelIdForSdk', () => {
		it('should translate GLM model ID', () => {
			const translated = service.translateModelIdForSdk('glm-4');
			expect(translated).toBe('translated-4');
		});

		it('should pass through anthropic model ID', () => {
			const translated = service.translateModelIdForSdk('claude-3-opus');
			expect(translated).toBe('claude-3-opus');
		});

		it('should pass through unknown model ID', () => {
			const translated = service.translateModelIdForSdk('unknown-model');
			expect(translated).toBe('unknown-model');
		});
	});

	describe('getEnvVarsForModel', () => {
		it('should return empty object for anthropic model', () => {
			const envVars = service.getEnvVarsForModel('claude-3-opus');
			expect(envVars).toEqual({});
		});

		it('should return env vars for GLM model', () => {
			const envVars = service.getEnvVarsForModel('glm-4');

			expect(envVars.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
			expect(envVars.API_TIMEOUT_MS).toBe('120000');
		});

		it('should return empty object for unknown model', () => {
			const envVars = service.getEnvVarsForModel('unknown-model');
			expect(envVars).toEqual({});
		});
	});

	describe('getProviderEnvVars', () => {
		it('should return empty object for anthropic session', () => {
			const session: Session = {
				id: 'test-session',
				title: 'Test',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-3-opus',
					maxTokens: 8192,
					temperature: 1.0,
					provider: 'anthropic',
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			const envVars = service.getProviderEnvVars(session);
			expect(envVars).toEqual({});
		});

		it('should return env vars for GLM session', () => {
			const session: Session = {
				id: 'test-session',
				title: 'Test',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'glm-4',
					maxTokens: 8192,
					temperature: 1.0,
					provider: 'glm',
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			const envVars = service.getProviderEnvVars(session);
			expect(envVars.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
		});

		it('should use session config API key override', () => {
			const session: Session = {
				id: 'test-session',
				title: 'Test',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'glm-4',
					maxTokens: 8192,
					temperature: 1.0,
					provider: 'glm',
					providerConfig: {
						apiKey: 'custom-api-key',
					},
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			const envVars = service.getProviderEnvVars(session);
			expect(envVars.ANTHROPIC_AUTH_TOKEN).toBe('custom-api-key');
		});
	});

	describe('applyEnvVarsToProcess', () => {
		it('should return empty object for anthropic model', () => {
			const original = service.applyEnvVarsToProcess('claude-3-opus');
			expect(original).toEqual({});
		});

		it('should apply GLM env vars and return original values', () => {
			process.env.ANTHROPIC_AUTH_TOKEN = 'original-token';
			process.env.ANTHROPIC_BASE_URL = 'original-url';

			const original = service.applyEnvVarsToProcess('glm-4');

			// Check original values were saved
			expect(original.ANTHROPIC_AUTH_TOKEN).toBe('original-token');
			expect(original.ANTHROPIC_BASE_URL).toBe('original-url');

			// Check env vars were updated
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
		});
	});

	describe('applyEnvVarsToProcessForProvider', () => {
		it('should return empty object for anthropic provider', () => {
			const original = service.applyEnvVarsToProcessForProvider('anthropic');
			expect(original).toEqual({});
		});

		it('should apply GLM env vars for GLM provider', () => {
			const original = service.applyEnvVarsToProcessForProvider('glm', 'glm-4');

			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');
			expect(original).toBeDefined();
		});
	});

	describe('restoreEnvVars', () => {
		it('should restore original env vars', () => {
			process.env.ANTHROPIC_AUTH_TOKEN = 'original-token';
			process.env.ANTHROPIC_BASE_URL = 'original-url';

			// Apply GLM env vars
			const original = service.applyEnvVarsToProcess('glm-4');

			// Verify env vars changed
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');

			// Restore
			service.restoreEnvVars(original);

			// Verify restored
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('original-token');
			expect(process.env.ANTHROPIC_BASE_URL).toBe('original-url');
		});

		it('should delete env vars that were not originally set', () => {
			// Ensure env vars are not set
			delete process.env.ANTHROPIC_AUTH_TOKEN;
			delete process.env.ANTHROPIC_BASE_URL;

			// Apply GLM env vars
			const original = service.applyEnvVarsToProcess('glm-4');

			// Verify env vars were set
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.glm.example.com');

			// Restore
			service.restoreEnvVars(original);

			// Verify deleted
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
		});

		it('should do nothing for empty original object', () => {
			process.env.ANTHROPIC_AUTH_TOKEN = 'some-token';

			service.restoreEnvVars({});

			// Should not change anything
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('some-token');
		});

		it('should restore all supported env vars', () => {
			// Set all supported env vars
			process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
			process.env.ANTHROPIC_BASE_URL = 'base-url';
			process.env.API_TIMEOUT_MS = '30000';
			process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '0';
			process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-model';
			process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'haiku-model';
			process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'opus-model';

			// Apply GLM env vars
			const original = service.applyEnvVarsToProcess('glm-4');

			// Restore
			service.restoreEnvVars(original);

			// Verify all restored
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('auth-token');
			expect(process.env.ANTHROPIC_BASE_URL).toBe('base-url');
			expect(process.env.API_TIMEOUT_MS).toBe('30000');
			expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('0');
			expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-model');
			expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-model');
			expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-model');
		});
	});

	describe('isGlmAvailable', () => {
		it('should return true when GLM provider is available', async () => {
			const available = await service.isGlmAvailable();
			expect(available).toBe(true);
		});

		it('should return false when GLM provider is not available', async () => {
			registry.clear();
			registry.register(new AnthropicMockProvider(true));
			registry.register(new GlmMockProvider(false));

			const available = await service.isGlmAvailable();
			expect(available).toBe(false);
		});
	});
});

describe('getProviderService', () => {
	beforeEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
	});

	afterEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
	});

	it('should return singleton instance', () => {
		const service1 = getProviderService();
		const service2 = getProviderService();

		expect(service1).toBe(service2);
	});

	it('should return ProviderService instance', () => {
		const service = getProviderService();
		expect(service).toBeInstanceOf(ProviderService);
	});
});
