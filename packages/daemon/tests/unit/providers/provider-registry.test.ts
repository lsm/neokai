/**
 * Unit tests for Provider Registry
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ModelInfo } from '@neokai/shared';
import { Logger } from '@neokai/shared/logger';
import type { Provider, ProviderSdkConfig } from '@neokai/shared/provider';
import { resetProviderFactory } from '../../../src/lib/providers/factory';
import { ProviderRegistry, resetProviderRegistry } from '../../../src/lib/providers/registry';

// Mock provider for testing
class MockProvider implements Provider {
	readonly id = 'mock';
	readonly displayName = 'Mock Provider';
	readonly capabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 100000,
		functionCalling: true,
		vision: false,
	};

	constructor(
		private available: boolean = true,
		private modelPrefix: string = 'mock-'
	) {}

	isAvailable(): boolean {
		return this.available;
	}

	async getModels(): Promise<ModelInfo[]> {
		return [
			{
				id: 'mock-1',
				name: 'Mock Model 1',
				alias: 'mock1',
				family: 'mock',
				provider: 'mock',
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

	getModelForTier(): string | undefined {
		return 'mock-1';
	}

	buildSdkConfig(): ProviderSdkConfig {
		return {
			envVars: {},
			isAnthropicCompatible: true,
		};
	}
}

// Provider subclass factories for collision tests
function makeAnthropicProvider() {
	return new (class extends MockProvider {
		readonly id = 'anthropic' as const;
		readonly displayName = 'Anthropic';
		ownsModel(modelId: string): boolean {
			return modelId.startsWith('claude-');
		}
	})();
}

function makeAnthropicCopilotProvider() {
	return new (class extends MockProvider {
		readonly id = 'anthropic-copilot' as const;
		readonly displayName = 'Anthropic Copilot';
		ownsModel(modelId: string): boolean {
			return modelId.startsWith('claude-');
		}
	})();
}

function makeAnthropicCodexProvider() {
	return new (class extends MockProvider {
		readonly id = 'anthropic-codex' as const;
		readonly displayName = 'Anthropic Codex';
		ownsModel(modelId: string): boolean {
			return modelId.startsWith('gpt-') || modelId.startsWith('claude-');
		}
	})();
}

describe('ProviderRegistry', () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
		registry = new ProviderRegistry();
	});

	afterEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
	});

	describe('register', () => {
		it('should register a provider', () => {
			const provider = new MockProvider();
			registry.register(provider);

			expect(registry.size).toBe(1);
			expect(registry.get('mock')).toBe(provider);
		});

		it('should throw when registering duplicate provider ID', () => {
			const provider = new MockProvider();
			registry.register(provider);

			expect(() => registry.register(new MockProvider())).toThrow(
				'Provider mock is already registered'
			);
		});
	});

	describe('unregister', () => {
		it('should unregister a provider', () => {
			const provider = new MockProvider();
			registry.register(provider);
			expect(registry.size).toBe(1);

			registry.unregister('mock');
			expect(registry.size).toBe(0);
			expect(registry.get('mock')).toBeUndefined();
		});

		it('should handle unregistering non-existent provider', () => {
			expect(() => registry.unregister('nonexistent')).not.toThrow();
		});
	});

	describe('get', () => {
		it('should get a registered provider', () => {
			const provider = new MockProvider();
			registry.register(provider);

			expect(registry.get('mock')).toBe(provider);
		});

		it('should return undefined for non-existent provider', () => {
			expect(registry.get('nonexistent')).toBeUndefined();
		});
	});

	describe('has', () => {
		it('should return true for registered provider', () => {
			const provider = new MockProvider();
			registry.register(provider);

			expect(registry.has('mock')).toBe(true);
		});

		it('should return false for non-existent provider', () => {
			expect(registry.has('nonexistent')).toBe(false);
		});
	});

	describe('getAll', () => {
		it('should return all registered providers', () => {
			const mock1 = new MockProvider();

			// Create another mock provider with different ID
			const mock2 = new (class extends MockProvider {
				readonly id = 'mock2' as const;
				readonly displayName = 'Mock Provider 2';
			})();

			registry.register(mock1);
			registry.register(mock2);

			const all = registry.getAll();
			expect(all).toHaveLength(2);
			expect(all.map((p) => p.id)).toEqual(['mock', 'mock2']);
		});

		it('should return empty array when no providers registered', () => {
			expect(registry.getAll()).toEqual([]);
		});
	});

	describe('getAvailable', () => {
		it('should return only available providers', async () => {
			const availableProvider = new MockProvider(true);

			// Create another provider class that is always unavailable
			class UnavailableMock extends MockProvider {
				readonly id = 'unavailable' as const;
				readonly displayName = 'Unavailable';
				constructor() {
					super(false); // Explicitly pass false for unavailable
				}
			}

			registry.register(availableProvider);
			registry.register(new UnavailableMock());

			const available = await registry.getAvailable();
			expect(available).toHaveLength(1);
			expect(available[0].id).toBe('mock');
		});

		it('should return empty array when no providers available', async () => {
			registry.register(new MockProvider(false));

			const available = await registry.getAvailable();
			expect(available).toEqual([]);
		});
	});

	describe('detectProvider', () => {
		it('should detect provider from model ID', () => {
			const provider = new MockProvider(true, 'custom-');
			registry.register(provider);

			expect(registry.detectProvider('custom-model')?.id).toBe('mock');
		});

		it('should return undefined when no provider owns the model', () => {
			const provider = new MockProvider(true, 'mock-');
			registry.register(provider);

			expect(registry.detectProvider('unknown-model')).toBeUndefined();
		});

		it('should return undefined when no providers registered', () => {
			expect(registry.detectProvider('any-model')).toBeUndefined();
		});

		it('should return the same result as before (backwards compatible) when multiple providers claim a model', () => {
			// Register anthropic first — it should be the first match
			registry.register(makeAnthropicProvider());
			registry.register(makeAnthropicCopilotProvider());

			const result = registry.detectProvider('claude-opus-4.6');
			expect(result?.id).toBe('anthropic');
		});
	});

	describe('detectProviderForModel', () => {
		it('should return preferred provider when it claims the model', () => {
			registry.register(makeAnthropicProvider());
			registry.register(makeAnthropicCopilotProvider());

			const result = registry.detectProviderForModel('claude-opus-4.6', 'anthropic-copilot');
			expect(result?.id).toBe('anthropic-copilot');
		});

		it('should return first registered provider and log collision when no preference and multiple matches', () => {
			const warnSpy = spyOn(Logger.prototype, 'warn').mockImplementation(mock(() => {}));

			try {
				registry.register(makeAnthropicProvider());
				registry.register(makeAnthropicCopilotProvider());

				const result = registry.detectProviderForModel('claude-opus-4.6');
				expect(result?.id).toBe('anthropic');

				// Warn should have been called once with collision info
				expect(warnSpy).toHaveBeenCalledTimes(1);
				const warnArg = warnSpy.mock.calls[0][0] as string;
				expect(warnArg).toContain('anthropic');
				expect(warnArg).toContain('anthropic-copilot');
				expect(warnArg).toContain('claude-opus-4.6');
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('should return codex provider when preferred and model starts with gpt-', () => {
			// anthropic-codex owns both claude- and gpt- models; register anthropic first
			registry.register(makeAnthropicProvider());
			registry.register(makeAnthropicCodexProvider());

			const result = registry.detectProviderForModel('gpt-5.3-codex', 'anthropic-codex');
			expect(result?.id).toBe('anthropic-codex');
		});

		it('should return undefined when no provider claims the model', () => {
			registry.register(makeAnthropicProvider());

			expect(registry.detectProviderForModel('unknown-xyz-model')).toBeUndefined();
		});

		it('should return single match without logging collision', () => {
			const warnSpy = spyOn(Logger.prototype, 'warn').mockImplementation(mock(() => {}));

			try {
				registry.register(makeAnthropicProvider());

				const result = registry.detectProviderForModel('claude-opus-4.6');
				expect(result?.id).toBe('anthropic');
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('should fall back to first match when preferred provider does not claim the model', () => {
			registry.register(makeAnthropicProvider());
			registry.register(makeAnthropicCopilotProvider());

			// 'anthropic-codex' is not registered but even if it were it doesn't own this model
			const result = registry.detectProviderForModel('claude-opus-4.6', 'nonexistent-provider');
			// Falls back to first match
			expect(result?.id).toBe('anthropic');
		});
	});

	describe('validateProviderSwitch', () => {
		it('should validate available provider', async () => {
			registry.register(new MockProvider(true));

			const result = await registry.validateProviderSwitch('mock');
			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should reject unavailable provider', async () => {
			registry.register(new MockProvider(false));

			const result = await registry.validateProviderSwitch('mock');
			expect(result.valid).toBe(false);
			expect(result.error).toContain('not available');
		});

		it('should accept unavailable provider with API key', async () => {
			registry.register(new MockProvider(false));

			const result = await registry.validateProviderSwitch('mock', 'test-key');
			expect(result.valid).toBe(true);
		});

		it('should reject unknown provider', async () => {
			const result = await registry.validateProviderSwitch('unknown');
			expect(result.valid).toBe(false);
			expect(result.error).toContain('Unknown provider');
		});
	});

	describe('clear', () => {
		it('should clear all providers', () => {
			registry.register(new MockProvider());
			registry.register(
				new (class extends MockProvider {
					readonly id = 'mock2' as const;
				})()
			);

			expect(registry.size).toBe(2);

			registry.clear();
			expect(registry.size).toBe(0);
		});
	});

	describe('getDefaultProvider', () => {
		it('should use DEFAULT_PROVIDER env var when set', async () => {
			const original = process.env.DEFAULT_PROVIDER;
			process.env.DEFAULT_PROVIDER = 'mock';

			try {
				registry.register(new MockProvider());

				const provider = await registry.getDefaultProvider();
				expect(provider.id).toBe('mock');
			} finally {
				if (original !== undefined) {
					process.env.DEFAULT_PROVIDER = original;
				} else {
					delete process.env.DEFAULT_PROVIDER;
				}
			}
		});

		it('should use first available provider when no env var', async () => {
			registry.register(new MockProvider(true));

			const provider = await registry.getDefaultProvider();
			expect(provider.id).toBe('mock');
		});

		it('should fall back to first registered when none available', async () => {
			registry.register(new MockProvider(false));

			const provider = await registry.getDefaultProvider();
			expect(provider.id).toBe('mock');
		});

		it('should throw when no providers registered', async () => {
			await expect(registry.getDefaultProvider()).rejects.toThrow('No providers registered');
		});
	});
});
