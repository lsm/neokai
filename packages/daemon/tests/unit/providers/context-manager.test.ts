/**
 * Unit tests for ProviderContextManager
 *
 * Tests provider context creation and management.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderId } from '@neokai/shared/provider';
import type { Session, ModelInfo } from '@neokai/shared';
import type { Provider, ProviderSdkConfig } from '@neokai/shared/provider';
import { ProviderContextManager } from '../../../src/lib/providers/context-manager';
import { ProviderRegistry, resetProviderRegistry } from '../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../src/lib/providers/factory';

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
	}

	isAvailable(): boolean {
		return this.available;
	}

	async getModels(): Promise<ModelInfo[]> {
		return [
			{
				id: `${this.modelPrefix}model-1`,
				name: 'Mock Model 1',
				alias: 'mock1',
				family: 'mock',
				provider: this.id,
				contextWindow: 100000,
				description: 'Mock model',
				releaseDate: '',
				available: true,
			},
		];
	}

	ownsModel(modelId: string): boolean {
		return modelId.toLowerCase().startsWith(this.modelPrefix);
	}

	getModelForTier(tier: string): string | undefined {
		return `${this.modelPrefix}${tier}`;
	}

	buildSdkConfig(
		modelId: string,
		sessionConfig?: { apiKey?: string; baseUrl?: string }
	): ProviderSdkConfig {
		return {
			envVars: {
				ANTHROPIC_BASE_URL: sessionConfig?.baseUrl || 'https://mock.api.com',
				ANTHROPIC_AUTH_TOKEN: sessionConfig?.apiKey || 'mock-api-key',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	translateModelIdForSdk(modelId: string): string {
		return `sdk-${modelId}`;
	}
}

// Anthropic-like provider that doesn't translate models
class AnthropicMockProvider extends MockProvider {
	readonly id = 'anthropic' as const;
	readonly displayName = 'Anthropic';

	constructor(available: boolean = true) {
		super('anthropic', 'Anthropic', available, 'claude-');
	}

	ownsModel(modelId: string): boolean {
		return (
			modelId.toLowerCase().startsWith('claude-') ||
			['default', 'sonnet', 'haiku', 'opus'].includes(modelId.toLowerCase())
		);
	}

	buildSdkConfig(
		modelId: string,
		sessionConfig?: { apiKey?: string; baseUrl?: string }
	): ProviderSdkConfig {
		const envVars: Record<string, string> = {};
		if (sessionConfig?.apiKey) {
			envVars.ANTHROPIC_AUTH_TOKEN = sessionConfig.apiKey;
		}
		if (sessionConfig?.baseUrl) {
			envVars.ANTHROPIC_BASE_URL = sessionConfig.baseUrl;
		}
		return {
			envVars,
			isAnthropicCompatible: true,
		};
	}

	// Anthropic doesn't translate model IDs
	translateModelIdForSdk = undefined;
}

// GLM-like provider
class GlmMockProvider extends MockProvider {
	readonly id = 'glm' as const;
	readonly displayName = 'GLM Provider';

	constructor(available: boolean = true) {
		super('glm', 'GLM Provider', available, 'glm-');
	}

	ownsModel(modelId: string): boolean {
		return modelId.toLowerCase().startsWith('glm-') || modelId.toLowerCase().includes('glm');
	}

	translateModelIdForSdk(modelId: string): string {
		// GLM translates models to anthropic-compatible names
		return modelId.replace('glm-', 'claude-');
	}
}

describe('ProviderContextManager', () => {
	let manager: ProviderContextManager;
	let registry: ProviderRegistry;

	beforeEach(() => {
		resetProviderRegistry();
		resetProviderFactory();

		registry = new ProviderRegistry();
		registry.register(new AnthropicMockProvider(true));
		registry.register(new GlmMockProvider(true));

		manager = new ProviderContextManager(registry);
	});

	afterEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
	});

	describe('createContext', () => {
		it('should create context for session with explicit provider', () => {
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

			const context = manager.createContext(session);

			expect(context.provider.id).toBe('glm');
			expect(context.modelId).toBe('glm-4');
		});

		it('should detect provider from model ID', () => {
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

			const context = manager.createContext(session);

			expect(context.provider.id).toBe('anthropic');
		});

		it('should default to anthropic for unknown model', () => {
			const session: Session = {
				id: 'test-session',
				title: 'Test',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'unknown-model',
					maxTokens: 8192,
					temperature: 1.0,
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

			const context = manager.createContext(session);

			expect(context.provider.id).toBe('anthropic');
		});

		it('should use "default" model ID when not specified', () => {
			const session: Session = {
				id: 'test-session',
				title: 'Test',
				workspacePath: '/test',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					maxTokens: 8192,
					temperature: 1.0,
				} as Session['config'],
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			const context = manager.createContext(session);

			expect(context.modelId).toBe('default');
		});

		it('should fall back to detection when explicit provider not found', () => {
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
					provider: 'nonexistent' as unknown as ProviderId,
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

			const context = manager.createContext(session);

			// Falls back to detection, which finds anthropic
			expect(context.provider.id).toBe('anthropic');
		});

		it('should throw when no provider available', () => {
			registry.clear(); // Remove all providers

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

			expect(() => manager.createContext(session)).toThrow('No provider available');
		});

		it('should include session provider config', () => {
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
						apiKey: 'custom-key',
						baseUrl: 'https://custom.api.com',
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

			const context = manager.createContext(session);

			expect(context.sessionConfig).toEqual({
				apiKey: 'custom-key',
				baseUrl: 'https://custom.api.com',
			});
		});
	});

	describe('context getSdkModelId', () => {
		it('should translate model ID for providers that support it', () => {
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

			const context = manager.createContext(session);
			const sdkModelId = context.getSdkModelId();

			expect(sdkModelId).toBe('claude-4'); // GLM translates glm- to claude-
		});

		it('should return original model ID for anthropic', () => {
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

			const context = manager.createContext(session);
			const sdkModelId = context.getSdkModelId();

			expect(sdkModelId).toBe('claude-3-opus');
		});
	});

	describe('context buildSdkOptions', () => {
		it('should merge provider env vars with base options', async () => {
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

			const context = manager.createContext(session);
			const options = await context.buildSdkOptions({
				maxTokens: 4096,
				env: { CUSTOM_VAR: 'value' },
			});

			expect(options.model).toBe('claude-4'); // Translated
			expect(options.maxTokens).toBe(4096);
			expect(options.env).toEqual(
				expect.objectContaining({
					CUSTOM_VAR: 'value',
					ANTHROPIC_BASE_URL: 'https://mock.api.com',
				})
			);
		});

		it('should override model with SDK model ID', async () => {
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

			const context = manager.createContext(session);
			const options = await context.buildSdkOptions({
				model: 'original-model',
			});

			expect(options.model).toBe('claude-4'); // Overridden with translated
		});

		it('should not include env if empty', async () => {
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

			const context = manager.createContext(session);
			const options = await context.buildSdkOptions({
				maxTokens: 4096,
			});

			// Anthropic returns empty env vars, and no base env provided
			expect(options.env).toBeUndefined();
		});
	});

	describe('requiresQueryRestart', () => {
		it('should return true for cross-provider switch', () => {
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

			const requires = manager.requiresQueryRestart(session, 'glm-4');
			expect(requires).toBe(true);
		});

		it('should return false for same-provider switch', () => {
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

			const requires = manager.requiresQueryRestart(session, 'claude-3-sonnet');
			expect(requires).toBe(false);
		});

		it('should return true when new provider cannot be detected', () => {
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

			const requires = manager.requiresQueryRestart(session, 'unknown-model-xyz');
			expect(requires).toBe(true);
		});
	});

	describe('getProvider', () => {
		it('should return provider by ID', () => {
			const provider = manager.getProvider('anthropic');
			expect(provider).toBeDefined();
			expect(provider?.id).toBe('anthropic');
		});

		it('should return undefined for unknown provider', () => {
			const provider = manager.getProvider('unknown' as unknown as ProviderId);
			expect(provider).toBeUndefined();
		});
	});

	describe('detectProvider', () => {
		it('should detect provider from model ID', () => {
			const provider = manager.detectProvider('claude-3-opus');
			expect(provider?.id).toBe('anthropic');
		});

		it('should detect GLM provider', () => {
			const provider = manager.detectProvider('glm-4');
			expect(provider?.id).toBe('glm');
		});

		it('should return undefined for unknown model', () => {
			const provider = manager.detectProvider('unknown-model-xyz');
			expect(provider).toBeUndefined();
		});
	});

	describe('validateProviderSwitch', () => {
		it('should validate available provider', async () => {
			const result = await manager.validateProviderSwitch('anthropic');
			expect(result.valid).toBe(true);
		});

		it('should reject unavailable provider', async () => {
			registry.clear();
			registry.register(new GlmMockProvider(false));

			const result = await manager.validateProviderSwitch('glm');
			expect(result.valid).toBe(false);
			expect(result.error).toContain('not available');
		});

		it('should accept unavailable provider with API key', async () => {
			registry.clear();
			registry.register(new GlmMockProvider(false));

			const result = await manager.validateProviderSwitch('glm', 'test-key');
			expect(result.valid).toBe(true);
		});

		it('should reject unknown provider', async () => {
			const result = await manager.validateProviderSwitch('unknown' as unknown as ProviderId);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('Unknown provider');
		});
	});

	describe('getAvailableProviders', () => {
		it('should return available providers', async () => {
			const providers = await manager.getAvailableProviders();

			expect(providers.length).toBe(2);
			expect(providers.map((p) => p.id)).toContain('anthropic');
			expect(providers.map((p) => p.id)).toContain('glm');
		});

		it('should filter unavailable providers', async () => {
			registry.clear();
			registry.register(new AnthropicMockProvider(true));
			registry.register(new GlmMockProvider(false));

			const providers = await manager.getAvailableProviders();

			expect(providers.length).toBe(1);
			expect(providers[0].id).toBe('anthropic');
		});
	});
});
