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
import type { ModelInfo } from '@liuboer/shared';
import { resetProviderRegistry, resetProviderFactory } from '../../../src/lib/providers';

describe('Model Service', () => {
	// Sample ModelInfo data for testing (as returned by providers)
	const mockModels: ModelInfo[] = [
		{
			id: 'default',
			name: 'Sonnet 4.5',
			alias: 'default',
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

			const sonnet = models.find((m) => m.id === 'default');
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
			const model = await getModelInfo('default');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('default');
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
			const model = await getModelInfo('claude-sonnet-4-5-20250929');
			expect(model).not.toBeNull();
			expect(model?.id).toBe('default');
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
			const isValid = await isValidModel('default');
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
			const resolved = await resolveModelAlias('default');
			expect(resolved).toBe('default');
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
			const resolved = await resolveModelAlias('claude-sonnet-4-5-20250929');
			expect(resolved).toBe('default');
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

			const defaultModel = models.find((m) => m.id === 'default');
			expect(defaultModel?.family).toBe('sonnet');

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
});
