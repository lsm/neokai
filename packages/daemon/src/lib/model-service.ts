/**
 * Model Service - Unified model loading from providers
 *
 * This service manages model information by:
 * 1. Delegating to registered providers for model lists
 * 2. Caching models with 4-hour TTL
 * 3. Lazy background refresh when cache is stale
 *
 * The provider system (Phase 1) replaced ad-hoc model loading with a proper abstraction.
 * This file now acts as a facade over the provider registry.
 */

import type { ModelInfo } from '@neokai/shared';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import { initializeProviders } from './providers/factory.js';
import { getProviderRegistry } from './providers/registry.js';
import type { Provider } from '@neokai/shared/provider';

/**
 * Legacy model ID mappings to SDK model IDs
 * Maps old-style full IDs and aliases to current SDK identifiers
 * This is needed for backward compatibility with existing sessions
 */
const LEGACY_MODEL_MAPPINGS: Record<string, string> = {
	// Old alias mappings
	sonnet: 'default', // SDK uses 'default' for Sonnet
	// Full model IDs (any sonnet variant maps to default)
	'claude-sonnet-4-5-20250929': 'default',
	'claude-sonnet-4-20241022': 'default',
	'claude-3-5-sonnet-20241022': 'default',
	// Opus - SDK uses 'opus'
	'claude-opus-4-5-20251101': 'opus',
	'claude-opus-4-20250514': 'opus',
	// Haiku - SDK uses 'haiku'
	'claude-haiku-4-5-20251001': 'haiku',
	'claude-3-5-haiku-20241022': 'haiku',
};

/**
 * In-memory cache of loaded models
 * Key: unique cache key (e.g., 'global' or session ID)
 * Value: array of ModelInfo
 */
const modelsCache = new Map<string, ModelInfo[]>();

/**
 * Timestamp tracking for cache freshness
 * Key: unique cache key
 * Value: timestamp (ms) when models were loaded
 */
const cacheTimestamps = new Map<string, number>();

/**
 * Cache TTL in milliseconds (4 hours)
 */
const CACHE_TTL = 4 * 60 * 60 * 1000;

/**
 * Track if a background refresh is in progress for a given cache key
 */
const refreshInProgress = new Map<string, Promise<void>>();

/**
 * Get supported models from an existing Claude SDK query object
 * This uses the AnthropicProvider to convert SDK models to ModelInfo
 *
 * @param queryObject - Existing SDK query object from a session
 * @param cacheKey - Unique key for caching (e.g., session ID or 'global')
 * @returns Array of ModelInfo, or empty array if query doesn't support it
 */
export async function getSupportedModelsFromQuery(
	queryObject: Query | null,
	cacheKey: string = 'global'
): Promise<ModelInfo[]> {
	// Return cached if available
	if (modelsCache.has(cacheKey)) {
		return modelsCache.get(cacheKey)!;
	}

	// Try to get models from query object using AnthropicProvider
	if (queryObject && typeof queryObject.supportedModels === 'function') {
		try {
			const { getAnthropicModelsFromQuery } = await import('./providers/anthropic-provider.js');
			const models = await getAnthropicModelsFromQuery(queryObject);
			if (models.length > 0) {
				// Cache the result with timestamp
				modelsCache.set(cacheKey, models);
				cacheTimestamps.set(cacheKey, Date.now());
				return models;
			}
		} catch {
			// Failed to load models from SDK
		}
	}

	return [];
}

/**
 * Get all available providers
 */
function getAvailableProviders(): Provider[] {
	const registry = getProviderRegistry();
	// Synchronous check - we'll filter later if needed
	return registry.getAll();
}

/**
 * Trigger background refresh of models if cache is stale
 * Does not block - runs asynchronously
 */
async function triggerBackgroundRefresh(cacheKey: string): Promise<void> {
	// Check if refresh already in progress
	if (refreshInProgress.has(cacheKey)) {
		return;
	}

	// Start background refresh
	const refreshPromise = (async () => {
		try {
			const models = await loadModelsFromProviders();
			if (models.length > 0) {
				modelsCache.set(cacheKey, models);
				cacheTimestamps.set(cacheKey, Date.now());
			}
		} catch {
			// Background refresh failed
		} finally {
			refreshInProgress.delete(cacheKey);
		}
	})();

	refreshInProgress.set(cacheKey, refreshPromise);
}

/**
 * Load models from all available providers
 */
async function loadModelsFromProviders(): Promise<ModelInfo[]> {
	const providers = getAvailableProviders();
	const allModels: ModelInfo[] = [];

	for (const provider of providers) {
		try {
			const available = await provider.isAvailable();
			if (!available) continue;

			const models = await provider.getModels();
			allModels.push(...models);
		} catch {
			// Failed to load models from provider
		}
	}

	return allModels;
}

/**
 * Check if cache is stale (older than CACHE_TTL)
 */
function isCacheStale(cacheKey: string): boolean {
	const timestamp = cacheTimestamps.get(cacheKey);
	if (!timestamp) return true;
	return Date.now() - timestamp > CACHE_TTL;
}

/**
 * Get all available models - unified list from all providers
 *
 * Implements lazy refresh: returns cache immediately, triggers background refresh if stale
 *
 * @param cacheKey - Cache key to look up dynamic models
 * @returns Array of ModelInfo including all available providers
 */
export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
	const cachedModels = modelsCache.get(cacheKey);

	if (!cachedModels || cachedModels.length === 0) {
		// Models not loaded or failed to load - return empty array
		// Callers should initialize models first via initializeModels()
		return [];
	}

	// Trigger background refresh if stale (non-blocking)
	if (isCacheStale(cacheKey)) {
		triggerBackgroundRefresh(cacheKey).catch(() => {
			// Ignore errors - we already have cached data
		});
	}

	return cachedModels;
}

/**
 * Initialize models on app startup
 * MUST be called before any other model functions
 *
 * @returns Promise that resolves when models are loaded
 * @throws Error if all providers fail to load models
 */
export async function initializeModels(): Promise<void> {
	const cacheKey = 'global';

	// Skip if already initialized
	if (modelsCache.has(cacheKey)) {
		return;
	}

	// Initialize the provider system (registers built-in providers)
	initializeProviders();

	try {
		const models = await loadModelsFromProviders();
		if (models.length > 0) {
			// Cache the models
			modelsCache.set(cacheKey, models);
			cacheTimestamps.set(cacheKey, Date.now());
		} else {
			throw new Error('No models returned from providers');
		}
	} catch (error) {
		// Log the error but don't fail startup - use static fallback models
		console.error('[model-service] Failed to load models from providers:', error);

		// Set empty cache to prevent repeated initialization attempts
		// getAvailableModels() will handle empty cache gracefully
		modelsCache.set(cacheKey, []);
		cacheTimestamps.set(cacheKey, Date.now());
	}
}

/**
 * Clear the models cache for a specific key or all
 */
export function clearModelsCache(cacheKey?: string): void {
	if (cacheKey) {
		modelsCache.delete(cacheKey);
		cacheTimestamps.delete(cacheKey);
	} else {
		modelsCache.clear();
		cacheTimestamps.clear();
	}
}

/**
 * Get current models cache (for testing)
 * @returns Map of cached models
 */
export function getModelsCache(): Map<string, ModelInfo[]> {
	return new Map(modelsCache);
}

/**
 * Set models cache (for testing - allows reusing cached models)
 * @param cache Map of cached models to restore
 */
export function setModelsCache(cache: Map<string, ModelInfo[]>): void {
	modelsCache.clear();
	cacheTimestamps.clear();
	const now = Date.now();
	for (const [key, models] of cache.entries()) {
		modelsCache.set(key, models);
		cacheTimestamps.set(key, now);
	}
}

/**
 * Get model info by ID or alias
 * Searches available models with support for legacy model IDs
 */
export async function getModelInfo(
	idOrAlias: string,
	cacheKey: string = 'global'
): Promise<ModelInfo | null> {
	const availableModels = getAvailableModels(cacheKey);

	// 1. Try exact ID match first (works for SDK's short IDs like 'opus', 'default')
	let model = availableModels.find((m) => m.id === idOrAlias);

	// 2. Try alias match in model's alias field
	if (!model) {
		model = availableModels.find((m) => m.alias === idOrAlias);
	}

	// 3. Try legacy model mapping (maps old full IDs to SDK short IDs)
	// This handles existing sessions with legacy model IDs like 'claude-sonnet-4-5-20250929'
	if (!model) {
		const legacyMappedId = LEGACY_MODEL_MAPPINGS[idOrAlias];
		if (legacyMappedId) {
			model = availableModels.find((m) => m.id === legacyMappedId);
		}
	}

	return model || null;
}

/**
 * Validate if a model ID or alias is valid
 */
export async function isValidModel(
	idOrAlias: string,
	cacheKey: string = 'global'
): Promise<boolean> {
	const modelInfo = await getModelInfo(idOrAlias, cacheKey);
	return modelInfo !== null;
}

/**
 * Resolve a model alias to its actual ID in the available models
 * Returns the model ID as it exists in the SDK/cache
 */
export async function resolveModelAlias(
	idOrAlias: string,
	cacheKey: string = 'global'
): Promise<string> {
	// Try to find the model directly
	const modelInfo = await getModelInfo(idOrAlias, cacheKey);
	if (modelInfo) {
		return modelInfo.id;
	}

	// Return as-is if nothing found
	return idOrAlias;
}
