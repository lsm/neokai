/**
 * Model Service - Hybrid model management with dynamic loading and static fallback
 *
 * This service manages model information by:
 * 1. Dynamically loading models from SDK query objects (when available)
 * 2. Caching loaded models per session
 * 3. Falling back to hardcoded models when SDK is unavailable
 */

import type { ModelInfo as SDKModelInfo } from '@liuboer/shared/sdk';
import type { ModelInfo } from '@liuboer/shared';
import { CLAUDE_MODELS, MODEL_ALIASES } from '@liuboer/shared';
import type { Query } from '@liuboer/shared/sdk';

/**
 * In-memory cache of dynamically loaded models
 * Key: unique cache key (e.g., 'global' or session ID)
 * Value: array of SDK model info
 */
const modelsCache = new Map<string, SDKModelInfo[]>();

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
 * This is the preferred method - uses an active query to fetch models
 *
 * @param queryObject - Existing SDK query object from a session
 * @param cacheKey - Unique key for caching (e.g., session ID or 'global')
 * @returns Array of SDK model info, or empty array if query doesn't support it
 */
export async function getSupportedModelsFromQuery(
	queryObject: Query | null,
	cacheKey: string = 'global'
): Promise<SDKModelInfo[]> {
	// Return cached if available
	if (modelsCache.has(cacheKey)) {
		return modelsCache.get(cacheKey)!;
	}

	// Try to get models from query object
	if (queryObject && typeof queryObject.supportedModels === 'function') {
		try {
			const models = await queryObject.supportedModels();
			// Cache the result with timestamp
			modelsCache.set(cacheKey, models);
			cacheTimestamps.set(cacheKey, Date.now());
			return models;
		} catch (error) {
			// Failed to get models from SDK, will fall back to static
			console.warn('Failed to load models from SDK:', error);
		}
	}

	// Return empty array - caller should use static fallback
	return [];
}

/**
 * Convert SDK model info to our ModelInfo format
 */
function convertSDKModelToModelInfo(sdkModel: SDKModelInfo): ModelInfo {
	// SDK ModelInfo has: value, displayName, description
	const modelId = sdkModel.value;

	// Determine family from model ID
	let family: 'opus' | 'sonnet' | 'haiku' = 'sonnet';
	if (modelId.includes('opus')) family = 'opus';
	else if (modelId.includes('haiku')) family = 'haiku';

	// Determine alias (use existing alias or extract from ID)
	let alias = modelId;
	for (const [aliasKey, existingModelId] of MODEL_ALIASES.entries()) {
		if (existingModelId === modelId) {
			alias = aliasKey;
			break;
		}
	}

	return {
		id: modelId,
		name: sdkModel.displayName || modelId,
		alias,
		family,
		contextWindow: 200000, // Default context window
		description: sdkModel.description || '',
		releaseDate: '', // SDK doesn't provide this
		available: true,
	};
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
			const { query } = await import('@anthropic-ai/claude-agent-sdk');

			// Create a temporary query to fetch models
			const tmpQuery = query({
				prompt: '',
				options: {
					model: 'claude-sonnet-4-5-20250929', // Use default model
					cwd: process.cwd(),
					maxTurns: 0,
				},
			});

			try {
				const models = await tmpQuery.supportedModels();
				if (models && models.length > 0) {
					modelsCache.set(cacheKey, models);
					cacheTimestamps.set(cacheKey, Date.now());
					console.log(
						`[model-service] Background refresh complete: ${models.length} models loaded`
					);
				}
			} finally {
				try {
					await tmpQuery.interrupt();
				} catch {
					// Ignore cleanup errors
				}
			}
		} catch (error) {
			console.warn('[model-service] Background refresh failed:', error);
		} finally {
			refreshInProgress.delete(cacheKey);
		}
	})();

	refreshInProgress.set(cacheKey, refreshPromise);
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
 * Get all available models (dynamic + static fallback)
 * Implements lazy refresh: returns cache immediately, triggers background refresh if stale
 *
 * @param cacheKey - Cache key to look up dynamic models
 * @returns Array of ModelInfo
 */
export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
	// Try to get dynamic models from cache
	const dynamicModels = modelsCache.get(cacheKey);

	// If cache exists, check if it's stale and trigger background refresh
	if (dynamicModels && dynamicModels.length > 0) {
		// Trigger background refresh if stale (non-blocking)
		if (isCacheStale(cacheKey)) {
			// Don't await - let it run in background
			triggerBackgroundRefresh(cacheKey).catch(() => {
				// Ignore errors - we already have cached data
			});
		}

		// Convert SDK models to our format and filter to latest versions only
		const converted = dynamicModels.map(convertSDKModelToModelInfo);

		// Keep only the latest version of each family
		const latestByFamily = new Map<string, ModelInfo>();
		for (const model of converted) {
			const existing = latestByFamily.get(model.family);
			if (!existing || model.id > existing.id) {
				// Newer models have later dates in their ID
				latestByFamily.set(model.family, model);
			}
		}

		return Array.from(latestByFamily.values());
	}

	// Fallback to static hardcoded models
	return CLAUDE_MODELS;
}

/**
 * Initialize models on app startup
 * Loads models into the global cache to serve as fallback
 * This is the ultimate fallback when static models are removed
 *
 * @returns Promise that resolves when models are loaded (or fails gracefully)
 */
export async function initializeModels(): Promise<void> {
	const cacheKey = 'global';

	// Skip if already initialized
	if (modelsCache.has(cacheKey)) {
		console.log('[model-service] Models already initialized, skipping');
		return;
	}

	console.log('[model-service] Loading models on app startup...');

	try {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');

		// Create a temporary query to fetch models
		const tmpQuery = query({
			prompt: '',
			options: {
				model: 'claude-sonnet-4-5-20250929', // Use default model
				cwd: process.cwd(),
				maxTurns: 0,
			},
		});

		try {
			const models = await tmpQuery.supportedModels();
			if (models && models.length > 0) {
				modelsCache.set(cacheKey, models);
				cacheTimestamps.set(cacheKey, Date.now());
				console.log(
					`[model-service] Startup initialization complete: ${models.length} models loaded`
				);
			} else {
				console.warn('[model-service] No models returned from SDK on startup');
			}
		} finally {
			try {
				await tmpQuery.interrupt();
			} catch {
				// Ignore cleanup errors
			}
		}
	} catch (error) {
		console.error('[model-service] Failed to load models on startup:', error);
		console.warn('[model-service] Will fall back to static models');
		// Don't throw - allow app to continue with static fallback
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
 * Get model info by ID or alias
 * Checks dynamic models first, then falls back to hardcoded models
 */
export async function getModelInfo(
	idOrAlias: string,
	cacheKey: string = 'global'
): Promise<ModelInfo | null> {
	// Try to get from dynamic models first
	const availableModels = getAvailableModels(cacheKey);

	// Check if it's an alias
	const aliasModelId = MODEL_ALIASES.get(idOrAlias);
	const searchId = aliasModelId || idOrAlias;

	// Try exact ID match
	let model = availableModels.find((m) => m.id === searchId);

	// Try alias match if not found
	if (!model && !aliasModelId) {
		const modelIdFromAlias = MODEL_ALIASES.get(idOrAlias);
		if (modelIdFromAlias) {
			model = availableModels.find((m) => m.id === modelIdFromAlias);
		}
	}

	return model || null;
}

/**
 * Validate if a model ID or alias is valid
 * Checks both dynamic SDK models and hardcoded aliases
 */
export async function isValidModel(
	idOrAlias: string,
	cacheKey: string = 'global'
): Promise<boolean> {
	const modelInfo = await getModelInfo(idOrAlias, cacheKey);
	return modelInfo !== null;
}

/**
 * Resolve a model alias to its full ID
 * Checks aliases first, then verifies against available models
 */
export async function resolveModelAlias(
	idOrAlias: string,
	cacheKey: string = 'global'
): Promise<string> {
	// Check if it's a known alias
	const aliasModelId = MODEL_ALIASES.get(idOrAlias);
	if (aliasModelId) {
		// Verify the aliased model exists
		const modelInfo = await getModelInfo(aliasModelId, cacheKey);
		if (modelInfo) {
			return aliasModelId;
		}
	}

	// Not an alias, return as-is if it's valid
	const modelInfo = await getModelInfo(idOrAlias, cacheKey);
	return modelInfo?.id || idOrAlias;
}

/**
 * Get current model info from a model ID
 * Used by AgentSession.getCurrentModel()
 */
export async function getCurrentModelInfo(
	modelId: string,
	cacheKey: string = 'global'
): Promise<{
	id: string;
	info: ModelInfo | null;
}> {
	const info = await getModelInfo(modelId, cacheKey);
	return {
		id: modelId,
		info,
	};
}
