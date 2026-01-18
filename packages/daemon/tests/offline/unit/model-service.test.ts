/**
 * Model Service Tests
 *
 * Tests dynamic model loading, caching, and validation.
 * Note: These tests do NOT call the real SDK - they test the caching and utility logic.
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
import type { ModelInfo as SDKModelInfo } from '@liuboer/shared/sdk';

describe('Model Service', () => {
	// Sample SDK model data for testing
	const mockSDKModels: SDKModelInfo[] = [
		{
			value: 'default',
			displayName: 'Claude Sonnet',
			description: 'Sonnet 4.5 · Best for everyday tasks',
		},
		{
			value: 'opus',
			displayName: 'Claude Opus',
			description: 'Opus 4.5 · Highest capability',
		},
		{
			value: 'haiku',
			displayName: 'Claude Haiku',
			description: 'Haiku 4.5 · Fast and efficient',
		},
	];

	beforeEach(() => {
		// Clear cache before each test
		clearModelsCache();
	});

	afterEach(() => {
		// Clean up after tests
		clearModelsCache();
	});

	describe('cache management', () => {
		it('should start with empty cache', () => {
			const cache = getModelsCache();
			expect(cache.size).toBe(0);
		});

		it('should set and restore cache', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);

			setModelsCache(testCache);

			const restoredCache = getModelsCache();
			expect(restoredCache.size).toBe(1);
			expect(restoredCache.get('global')).toEqual(mockSDKModels);
		});

		it('should clear specific cache key', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
			testCache.set('session-1', mockSDKModels);
			setModelsCache(testCache);

			clearModelsCache('global');

			const cache = getModelsCache();
			expect(cache.has('global')).toBe(false);
			expect(cache.has('session-1')).toBe(true);
		});

		it('should clear all cache when no key specified', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
			testCache.set('session-1', mockSDKModels);
			setModelsCache(testCache);

			clearModelsCache();

			const cache = getModelsCache();
			expect(cache.size).toBe(0);
		});
	});

	describe('getAvailableModels', () => {
		beforeEach(() => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
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

		it('should convert SDK models to ModelInfo format', () => {
			const models = getAvailableModels();

			const sonnet = models.find((m) => m.id === 'default');
			expect(sonnet).toBeDefined();
			expect(sonnet?.name).toBe('Sonnet 4.5');
			expect(sonnet?.family).toBe('sonnet');
		});

		it('should extract display name from description', () => {
			const models = getAvailableModels();

			const opus = models.find((m) => m.id === 'opus');
			expect(opus?.name).toBe('Opus 4.5');

			const haiku = models.find((m) => m.id === 'haiku');
			expect(haiku?.name).toBe('Haiku 4.5');
		});

		it('should determine model family correctly', () => {
			const models = getAvailableModels();

			expect(models.find((m) => m.id === 'default')?.family).toBe('sonnet');
			expect(models.find((m) => m.id === 'opus')?.family).toBe('opus');
			expect(models.find((m) => m.id === 'haiku')?.family).toBe('haiku');
		});

		it('should filter out custom model entries', () => {
			const modelsWithCustom = [
				...mockSDKModels,
				{
					value: 'custom',
					displayName: 'Custom Model',
					description: 'Custom model - Specify your own model ID',
				},
			];
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', modelsWithCustom);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models.find((m) => m.id === 'custom')).toBeUndefined();
		});

		it('should support different cache keys', () => {
			const sessionModels = [mockSDKModels[0]]; // Only sonnet
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
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
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
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
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
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
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
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
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('test-key', mockSDKModels);
			setModelsCache(testCache);

			const models = await getSupportedModelsFromQuery(null, 'test-key');
			expect(models).toEqual(mockSDKModels);
		});

		it('should return empty array if no cache and no query', async () => {
			const models = await getSupportedModelsFromQuery(null, 'new-key');
			expect(models).toEqual([]);
		});

		it('should get models from query object when available', async () => {
			const mockQuery = {
				supportedModels: mock(async () => mockSDKModels),
			};

			const models = await getSupportedModelsFromQuery(mockQuery as unknown, 'query-key');

			expect(models).toEqual(mockSDKModels);
			expect(mockQuery.supportedModels).toHaveBeenCalled();
		});

		it('should cache models from query', async () => {
			const mockQuery = {
				supportedModels: mock(async () => mockSDKModels),
			};

			await getSupportedModelsFromQuery(mockQuery as unknown, 'cache-test-key');

			// Should now be in cache
			const cache = getModelsCache();
			expect(cache.get('cache-test-key')).toEqual(mockSDKModels);
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

	describe('model family detection', () => {
		it('should detect opus family', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', [
				{
					value: 'test-opus',
					displayName: 'Test',
					description: 'Opus 4.5 · Test',
				},
			]);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].family).toBe('opus');
		});

		it('should detect haiku family', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', [
				{
					value: 'test-haiku',
					displayName: 'Test',
					description: 'Haiku 4.5 · Test',
				},
			]);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].family).toBe('haiku');
		});

		it('should default to sonnet family', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', [
				{
					value: 'test-unknown',
					displayName: 'Test',
					description: 'Unknown · Test',
				},
			]);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].family).toBe('sonnet');
		});
	});

	describe('initializeModels', () => {
		it('should skip initialization when already initialized', async () => {
			// Pre-populate cache to simulate already initialized state
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', mockSDKModels);
			setModelsCache(testCache);

			// Should return immediately without throwing (no SDK call needed)
			await expect(initializeModels()).resolves.toBeUndefined();

			// Cache should still contain our models
			const cache = getModelsCache();
			expect(cache.get('global')).toEqual(mockSDKModels);
		});
	});

	describe('display name extraction', () => {
		it('should extract name before separator', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', [
				{
					value: 'test',
					displayName: 'Test',
					description: 'Model Name · Some description',
				},
			]);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].name).toBe('Model Name');
		});

		it('should fallback to displayName when no separator', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', [
				{
					value: 'test',
					displayName: 'Fallback Name',
					description: 'No separator',
				},
			]);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].name).toBe('Fallback Name');
		});

		it('should fallback to value when no displayName', () => {
			const testCache = new Map<string, SDKModelInfo[]>();
			testCache.set('global', [{ value: 'model-id', description: 'No separator here' } as unknown]);
			setModelsCache(testCache);

			const models = getAvailableModels();
			expect(models[0].name).toBe('model-id');
		});
	});
});
