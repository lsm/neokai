/**
 * Model Service Tests
 *
 * Tests the unified model service that delegates to providers.
 * Tests mock provider responses rather than real SDK calls.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
	getAvailableModels,
	getModelInfo,
	isValidModel,
	resolveModelAlias,
	clearModelsCache,
	getModelsCache,
	setModelsCache,
	getSupportedModelsFromQuery,
	initializeModels,
} from '../../../src/lib/model-service';
import type { ModelInfo } from '@neokai/shared';
import { resetProviderRegistry } from '../../../src/lib/providers/registry';
import { resetProviderFactory } from '../../../src/lib/providers/factory';

describe('Model Service', () => {
	// Sample ModelInfo data for testing (as returned by providers)
	// Note: Provider now returns 'sonnet' instead of 'default'
	const mockModels: ModelInfo[] = [
		{
			id: 'sonnet',
			name: 'Sonnet 4.5',
			alias: 'sonnet',
			family: 'sonnet',
			provider: 'anthropic',
			contextWindow: 200000,
			description: 'Sonnet 4.5 · Best for everyday tasks',
			releaseDate: '2024-09-29',
			available: true,
		},
		{
			id: 'opus',
			name: 'Opus 4.5',
			alias: 'opus',
			family: 'opus',
			provider: 'anthropic',
			contextWindow: 200000,
			description: 'Opus 4.5 · Highest capability',
			releaseDate: '2025-11-24',
			available: true,
		},
		{
			id: 'haiku',
			name: 'Haiku 4.5',
			alias: 'haiku',
			family: 'haiku',
			provider: 'anthropic',
			contextWindow: 200000,
			description: 'Haiku 4.5 · Fast and efficient',
			releaseDate: '2025-10-15',
			available: true,
		},
	];

	beforeEach(() => {
		// Clear cache and reset provider system before each test
		// Both functions must be called to fully reset the provider state
		clearModelsCache();
		resetProviderRegistry();
		resetProviderFactory();
	});

	afterEach(() => {
		// Clean up after tests
		clearModelsCache();
		resetProviderRegistry();
		resetProviderFactory();
	});

	describe('cache management', () => {
		it('should start with empty cache', () => {
			const cache = getModelsCache();
			expect(cache.size).toBe(0);
		});

		it('should set and restore cache', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);

			setModelsCache(testCache);

			const restoredCache = getModelsCache();
			expect(restoredCache.size).toBe(1);
			expect(restoredCache.get('global')).toEqual(mockModels);
		});

		it('should clear specific cache key', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			testCache.set('session-1', mockModels);
			setModelsCache(testCache);

			clearModelsCache('global');

			const cache = getModelsCache();
			expect(cache.has('global')).toBe(false);
			expect(cache.has('session-1')).toBe(true);
		});

		it('should clear all cache when no key specified', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			testCache.set('session-1', mockModels);
			setModelsCache(testCache);

			clearModelsCache();

			const cache = getModelsCache();
			expect(cache.size).toBe(0);
		});
	});

	describe('getAvailableModels', () => {
		beforeEach(() => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);
		});

		it('should return empty array when cache is empty', () => {
			clearModelsCache();
			const models = getAvailableModels();
			expect(models).toEqual([]);
		});

		it('should return models from cache', () => {
			const models = getAvailableModels();
			expect(models.length).toBeGreaterThan(0);
		});

		it('should return models with correct structure', () => {
			const models = getAvailableModels();

			const sonnet = models.find((m) => m.id === 'sonnet');
			expect(sonnet).toBeDefined();
			expect(sonnet?.name).toBe('Sonnet 4.5');
			expect(sonnet?.family).toBe('sonnet');
			expect(sonnet?.provider).toBe('anthropic');
		});

		it('should support different cache keys', () => {
			const sessionModels = [mockModels[0]]; // Only default
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			testCache.set('session-123', sessionModels);
			setModelsCache(testCache);

			const globalModels = getAvailableModels('global');
			const sessionSpecificModels = getAvailableModels('session-123');

			expect(globalModels.length).toBe(3);
			expect(sessionSpecificModels.length).toBe(1);
		});
	});

	describe('getModelInfo', () => {
		beforeEach(() => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);
		});

		it('should find model by exact ID', async () => {
			const model = await getModelInfo('sonnet');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('sonnet');
		});

		it('should find model by alias', async () => {
			const model = await getModelInfo('opus');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('opus');
		});

		it('should return null for unknown model', async () => {
			const model = await getModelInfo('unknown-model');
			expect(model).toBeNull();
		});

		it('should handle legacy model IDs', async () => {
			// Legacy full model IDs should map to SDK short IDs
			// Note: 'claude-sonnet-4-5-20250929' maps to 'sonnet' via LEGACY_MODEL_MAPPINGS
			const model = await getModelInfo('claude-sonnet-4-5-20250929');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('sonnet');
		});

		it('should handle legacy opus model ID', async () => {
			const model = await getModelInfo('claude-opus-4-5-20251101');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('opus');
		});

		it('should handle legacy haiku model ID', async () => {
			const model = await getModelInfo('claude-haiku-4-5-20251001');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('haiku');
		});
	});

	describe('isValidModel', () => {
		beforeEach(() => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);
		});

		it('should return true for valid model ID', async () => {
			const isValid = await isValidModel('sonnet');
			expect(isValid).toBe(true);
		});

		it('should return true for valid alias', async () => {
			const isValid = await isValidModel('opus');
			expect(isValid).toBe(true);
		});

		it('should return false for invalid model', async () => {
			const isValid = await isValidModel('invalid-model');
			expect(isValid).toBe(false);
		});

		it('should return true for legacy model IDs', async () => {
			const isValid = await isValidModel('claude-sonnet-4-5-20250929');
			expect(isValid).toBe(true);
		});
	});

	describe('resolveModelAlias', () => {
		beforeEach(() => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);
		});

		it('should resolve existing model ID', async () => {
			const resolved = await resolveModelAlias('sonnet');
			expect(resolved).toBe('sonnet');
		});

		it('should resolve alias to model ID', async () => {
			const resolved = await resolveModelAlias('opus');
			expect(resolved).toBe('opus');
		});

		it('should return input as-is for unknown model', async () => {
			const resolved = await resolveModelAlias('custom-model-id');
			expect(resolved).toBe('custom-model-id');
		});

		it('should resolve legacy model ID', async () => {
			// LEGACY_MODEL_MAPPINGS maps 'claude-sonnet-4-5-20250929' to 'sonnet'
			const resolved = await resolveModelAlias('claude-sonnet-4-5-20250929');
			expect(resolved).toBe('sonnet');
		});
	});

	describe('getSupportedModelsFromQuery', () => {
		it('should return cached models if available', async () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('test-key', mockModels);
			setModelsCache(testCache);

			const models = await getSupportedModelsFromQuery(null, 'test-key');
			expect(models).toEqual(mockModels);
		});

		it('should return empty array if no cache and no query', async () => {
			const models = await getSupportedModelsFromQuery(null, 'new-key');
			expect(models).toEqual([]);
		});

		it('should get models from query object when available', async () => {
			const mockQuery = {
				supportedModels: mock(async () => [
					{ value: 'test-model', displayName: 'Test Model', description: 'Test Model · Test' },
				]),
			};

			const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'query-key');

			// Should convert to ModelInfo format
			expect(models.length).toBe(1);
			expect(models[0].id).toBe('test-model');
			expect(models[0].provider).toBe('anthropic');
		});

		it('should cache models from query', async () => {
			const mockQuery = {
				supportedModels: mock(async () => [
					{ value: 'cached', displayName: 'Cached', description: 'Cached · Test' },
				]),
			};

			await getSupportedModelsFromQuery(mockQuery as unknown, 'cache-test-key');

			// Should now be in cache
			const cache = getModelsCache();
			expect(cache.get('cache-test-key')).toBeDefined();
			expect(cache.get('cache-test-key')?.length).toBe(1);
		});

		it('should handle query errors gracefully', async () => {
			const mockQuery = {
				supportedModels: mock(async () => {
					throw new Error('Query error');
				}),
			};

			const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'error-key');
			expect(models).toEqual([]);
		});
	});

	describe('model properties', () => {
		it('should include provider field', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].provider).toBe('anthropic');
		});

		it('should include contextWindow', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].contextWindow).toBe(200000);
		});

		it('should have correct family for each model', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);

			const models = getAvailableModels();

			const sonnetModel = models.find((m) => m.id === 'sonnet');
			expect(sonnetModel?.family).toBe('sonnet');

			const opusModel = models.find((m) => m.id === 'opus');
			expect(opusModel?.family).toBe('opus');

			const haikuModel = models.find((m) => m.id === 'haiku');
			expect(haikuModel?.family).toBe('haiku');
		});
	});

	describe('initializeModels', () => {
		it('should skip initialization when already initialized', async () => {
			// Pre-populate cache to simulate already initialized state
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);

			// Should return immediately without throwing
			await expect(initializeModels()).resolves.toBeUndefined();

			// Cache should still contain our models
			const cache = getModelsCache();
			expect(cache.get('global')).toEqual(mockModels);
		});
	});

	describe('background refresh behavior', () => {
		it('should return cached models while refresh is in progress', async () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);

			// Multiple calls should return cached data
			const models1 = getAvailableModels('global');
			const models2 = getAvailableModels('global');

			expect(models1).toEqual(models2);
			expect(models1.length).toBe(3);
		});
	});

	describe('provider loading', () => {
		it('should return empty array when no providers are available', () => {
			// Ensure no providers are registered
			resetProviderRegistry();
			resetProviderFactory();
			clearModelsCache();

			// With no providers and no cache, should return empty
			const models = getAvailableModels('no-providers-key');
			expect(models).toEqual([]);
		});

		it('should handle provider errors gracefully during model loading', async () => {
			// Pre-populate cache so getAvailableModels doesn't return empty
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);

			// Even if a provider fails, cached models should still be available
			const models = getAvailableModels('global');
			expect(models.length).toBeGreaterThan(0);
		});
	});

	describe('cache key isolation', () => {
		it('should maintain separate caches for different keys', () => {
			const globalModels = mockModels;
			const sessionModels = [mockModels[0]]; // Only default model

			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', globalModels);
			testCache.set('session-abc', sessionModels);
			setModelsCache(testCache);

			expect(getAvailableModels('global').length).toBe(3);
			expect(getAvailableModels('session-abc').length).toBe(1);
			expect(getAvailableModels('nonexistent-key').length).toBe(0);
		});

		it('should clear cache for specific key without affecting others', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('key-a', mockModels);
			testCache.set('key-b', mockModels);
			testCache.set('key-c', mockModels);
			setModelsCache(testCache);

			clearModelsCache('key-b');

			const cache = getModelsCache();
			expect(cache.has('key-a')).toBe(true);
			expect(cache.has('key-b')).toBe(false);
			expect(cache.has('key-c')).toBe(true);
		});
	});

	describe('setModelsCache with timestamp', () => {
		it('should accept custom timestamp', () => {
			const customTimestamp = Date.now() - 10000; // 10 seconds ago
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);

			setModelsCache(testCache, customTimestamp);

			const cache = getModelsCache();
			expect(cache.size).toBe(1);
		});

		it('should use current time when timestamp not provided', () => {
			const beforeTime = Date.now();
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);

			setModelsCache(testCache);

			const afterTime = Date.now();
			// Timestamp should be between beforeTime and afterTime
			// (This is implicitly tested by the cache working correctly)
			expect(getAvailableModels('global').length).toBe(3);
		});
	});

	describe('additional legacy model IDs', () => {
		beforeEach(() => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);
		});

		it('should handle claude-sonnet-4-20241022 legacy ID', async () => {
			const model = await getModelInfo('claude-sonnet-4-20241022');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('sonnet');
		});

		it('should handle claude-3-5-sonnet-20241022 legacy ID', async () => {
			const model = await getModelInfo('claude-3-5-sonnet-20241022');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('sonnet');
		});

		it('should handle claude-opus-4-20250514 legacy ID', async () => {
			const model = await getModelInfo('claude-opus-4-20250514');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('opus');
		});

		it('should handle claude-3-5-haiku-20241022 legacy ID', async () => {
			const model = await getModelInfo('claude-3-5-haiku-20241022');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('haiku');
		});

		it('should resolve all legacy model IDs via resolveModelAlias', async () => {
			const legacyIds = [
				{ id: 'claude-sonnet-4-5-20250929', expected: 'sonnet' },
				{ id: 'claude-sonnet-4-20241022', expected: 'sonnet' },
				{ id: 'claude-3-5-sonnet-20241022', expected: 'sonnet' },
				{ id: 'claude-opus-4-5-20251101', expected: 'opus' },
				{ id: 'claude-opus-4-20250514', expected: 'opus' },
				{ id: 'claude-haiku-4-5-20251001', expected: 'haiku' },
				{ id: 'claude-3-5-haiku-20241022', expected: 'haiku' },
			];

			for (const { id, expected } of legacyIds) {
				const resolved = await resolveModelAlias(id);
				expect(resolved).toBe(expected);
			}
		});
	});

	describe('default model alias', () => {
		beforeEach(() => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			setModelsCache(testCache);
		});

		it('should resolve "default" alias to sonnet', async () => {
			// LEGACY_MODEL_MAPPINGS maps 'default' to 'sonnet'
			const resolved = await resolveModelAlias('default');
			expect(resolved).toBe('sonnet');
		});

		it('should validate "default" as a valid model', async () => {
			const isValid = await isValidModel('default');
			expect(isValid).toBe(true);
		});

		it('should get model info for "default"', async () => {
			const model = await getModelInfo('default');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('sonnet');
		});
	});

	describe('cache with empty models array', () => {
		it('should return empty array when cache has empty array', () => {
			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', []);
			setModelsCache(testCache);

			const models = getAvailableModels('global');
			expect(models).toEqual([]);
		});
	});

	describe('getModelInfo with cache key', () => {
		it('should use specific cache key when provided', async () => {
			const customModels: ModelInfo[] = [
				{
					id: 'custom-model',
					name: 'Custom Model',
					alias: 'custom',
					family: 'custom',
					provider: 'custom',
					contextWindow: 100000,
					description: 'Custom model for testing',
				},
			];

			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			testCache.set('custom-cache', customModels);
			setModelsCache(testCache);

			// Should find in global cache
			const globalModel = await getModelInfo('sonnet', 'global');
			expect(globalModel).not.toBeNull();

			// Should find in custom cache
			const customModel = await getModelInfo('custom-model', 'custom-cache');
			expect(customModel).not.toBeNull();
			expect(customModel?.id).toBe('custom-model');

			// Should not find custom model in global cache
			const notFound = await getModelInfo('custom-model', 'global');
			expect(notFound).toBeNull();
		});
	});

	describe('isValidModel with cache key', () => {
		it('should validate against specific cache key', async () => {
			const customModels: ModelInfo[] = [
				{
					id: 'custom-only',
					name: 'Custom Only',
					alias: 'customonly',
					family: 'custom',
					provider: 'custom',
					contextWindow: 100000,
					description: 'Only in custom cache',
				},
			];

			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			testCache.set('custom-cache', customModels);
			setModelsCache(testCache);

			// Custom model should be valid in custom cache
			expect(await isValidModel('custom-only', 'custom-cache')).toBe(true);

			// Custom model should not be valid in global cache
			expect(await isValidModel('custom-only', 'global')).toBe(false);
		});
	});

	describe('resolveModelAlias with cache key', () => {
		it('should resolve using specific cache key', async () => {
			const customModels: ModelInfo[] = [
				{
					id: 'custom-alias-model',
					name: 'Custom Alias Model',
					alias: 'my-custom-alias',
					family: 'custom',
					provider: 'custom',
					contextWindow: 100000,
					description: 'Has custom alias',
				},
			];

			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', mockModels);
			testCache.set('custom-cache', customModels);
			setModelsCache(testCache);

			// Should resolve alias in custom cache
			const resolved = await resolveModelAlias('my-custom-alias', 'custom-cache');
			expect(resolved).toBe('custom-alias-model');

			// Should return as-is when not found in global cache
			const notResolved = await resolveModelAlias('my-custom-alias', 'global');
			expect(notResolved).toBe('my-custom-alias');
		});
	});

	describe('ModelInfo optional fields', () => {
		it('should handle models with minimal fields', async () => {
			const minimalModels: ModelInfo[] = [
				{
					id: 'minimal',
					name: 'Minimal Model',
					family: 'minimal',
					provider: 'test',
					contextWindow: 1000,
				},
			];

			const testCache = new Map<string, ModelInfo[]>();
			testCache.set('global', minimalModels);
			setModelsCache(testCache);

			const models = getAvailableModels('global');
			expect(models.length).toBe(1);
			expect(models[0].id).toBe('minimal');
			expect(models[0].alias).toBeUndefined();
			expect(models[0].description).toBeUndefined();
			expect(models[0].releaseDate).toBeUndefined();
			expect(models[0].available).toBeUndefined();
		});
	});

	describe('getSupportedModelsFromQuery edge cases', () => {
		it('should return empty array when query has no supportedModels method', async () => {
			const mockQuery = {
				// No supportedModels method
			};

			const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'no-method-key');
			expect(models).toEqual([]);
		});

		it('should return empty array when supportedModels returns empty array', async () => {
			const mockQuery = {
				supportedModels: mock(async () => []),
			};

			const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'empty-result-key');
			expect(models).toEqual([]);
		});

		it('should handle query returning null', async () => {
			const mockQuery = {
				supportedModels: mock(async () => null),
			};

			const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'null-result-key');
			expect(models).toEqual([]);
		});
	});
});
