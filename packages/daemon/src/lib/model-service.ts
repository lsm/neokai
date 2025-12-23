/**
 * Model Service - Dynamic model loading from SDK
 *
 * This service manages model information by:
 * 1. Loading models from SDK on app startup
 * 2. Caching models with 4-hour TTL
 * 3. Lazy background refresh when cache is stale
 *
 * The model list is solely sourced from SDK's supportedModels() API.
 */

import type { ModelInfo as SDKModelInfo } from '@liuboer/shared/sdk';
import { Logger } from './logger';
import type { ModelInfo } from '@liuboer/shared';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';

const log = new Logger('ModelService');

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
			log.warn('Failed to load models from SDK:', error);
		}
	}

	return [];
}

/**
 * Extract model name with version from SDK description
 * SDK description format: "Sonnet 4.5 · Best for everyday tasks"
 * Returns the part before " · " (e.g., "Sonnet 4.5")
 */
function extractDisplayName(sdkModel: SDKModelInfo): string {
	const description = sdkModel.description || '';

	// Try to extract "Model X.Y" from description (format: "Model X.Y · description")
	const separatorIndex = description.indexOf(' · ');
	if (separatorIndex > 0) {
		return description.substring(0, separatorIndex);
	}

	// Fallback to SDK's displayName or model ID
	return sdkModel.displayName || sdkModel.value;
}

/**
 * Convert SDK model info to our ModelInfo format
 */
function convertSDKModelToModelInfo(sdkModel: SDKModelInfo): ModelInfo {
	// SDK ModelInfo has: value, displayName, description
	const modelId = sdkModel.value;

	// Extract display name dynamically from description (e.g., "Sonnet 4.5")
	const displayName = extractDisplayName(sdkModel);

	// Determine family from model ID or display name
	let family: 'opus' | 'sonnet' | 'haiku' = 'sonnet';
	const nameLower = displayName.toLowerCase();
	if (nameLower.includes('opus')) {
		family = 'opus';
	} else if (nameLower.includes('haiku')) {
		family = 'haiku';
	}

	return {
		id: modelId,
		name: displayName,
		alias: modelId, // Use the model ID as alias (SDK uses short IDs like 'opus', 'default')
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
			// Use 'default' as the model since SDK uses this for Sonnet
			const tmpQuery = query({
				prompt: '',
				options: {
					model: 'default',
					cwd: process.cwd(),
					maxTurns: 0,
				},
			});

			try {
				const models = await tmpQuery.supportedModels();
				if (models && models.length > 0) {
					modelsCache.set(cacheKey, models);
					cacheTimestamps.set(cacheKey, Date.now());
					log.info(`[model-service] Background refresh complete: ${models.length} models loaded`);
				}
			} finally {
				try {
					await tmpQuery.interrupt();
				} catch {
					// Ignore cleanup errors
				}
			}
		} catch (error) {
			log.warn('[model-service] Background refresh failed:', error);
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
 * Get all available models from SDK cache
 * Implements lazy refresh: returns cache immediately, triggers background refresh if stale
 *
 * Filtering logic:
 * 1. Exclude "Custom model" entries (these are for explicit model ID selection)
 * 2. Keep only the recommended models (default, opus, haiku)
 * 3. One model per family
 *
 * @param cacheKey - Cache key to look up dynamic models
 * @returns Array of ModelInfo from SDK
 * @throws Error if models have not been initialized
 */
export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
	const dynamicModels = modelsCache.get(cacheKey);

	if (!dynamicModels || dynamicModels.length === 0) {
		// Models not loaded - this should not happen if initializeModels() was called
		log.error('[model-service] Models cache is empty. Was initializeModels() called?');
		return [];
	}

	// Trigger background refresh if stale (non-blocking)
	if (isCacheStale(cacheKey)) {
		triggerBackgroundRefresh(cacheKey).catch(() => {
			// Ignore errors - we already have cached data
		});
	}

	// Filter out "Custom model" entries - these are for explicit model ID selection
	// Keep only the recommended models with proper descriptions
	const recommendedModels = dynamicModels.filter(
		(m) => m.description && !m.description.toLowerCase().includes('custom model')
	);

	// Convert SDK models to our format
	const converted = recommendedModels.map(convertSDKModelToModelInfo);

	// Keep only one model per family (shouldn't have duplicates after filtering, but just in case)
	const byFamily = new Map<string, ModelInfo>();
	for (const model of converted) {
		if (!byFamily.has(model.family)) {
			byFamily.set(model.family, model);
		}
	}

	return Array.from(byFamily.values());
}

/**
 * Initialize models on app startup
 * MUST be called before any other model functions
 *
 * @returns Promise that resolves when models are loaded
 * @throws Error if SDK fails to load models
 */
export async function initializeModels(): Promise<void> {
	const cacheKey = 'global';

	// Skip if already initialized
	if (modelsCache.has(cacheKey)) {
		log.info('[model-service] Models already initialized, skipping');
		return;
	}

	log.info('[model-service] Loading models on app startup...');

	try {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');

		// Create a temporary query to fetch models
		// Use 'default' as the model since SDK uses this for Sonnet
		const tmpQuery = query({
			prompt: '',
			options: {
				model: 'default',
				cwd: process.cwd(),
				maxTurns: 0,
			},
		});

		try {
			const sdkModels = await tmpQuery.supportedModels();
			if (sdkModels && sdkModels.length > 0) {
				// Cache the raw SDK models (will be converted to ModelInfo when retrieved)
				modelsCache.set(cacheKey, sdkModels);
				cacheTimestamps.set(cacheKey, Date.now());
				log.info(
					`[model-service] Startup initialization complete: ${sdkModels.length} models loaded`
				);
			} else {
				throw new Error('No models returned from SDK');
			}
		} finally {
			// Fire-and-forget interrupt - awaiting can hang indefinitely
			// The SDK's AsyncGenerator cleanup blocks if not actively consumed
			// This is a known SDK 0.1.69 behavior
			tmpQuery.interrupt().catch(() => {});
		}
	} catch (error) {
		log.error('[model-service] Failed to load models on startup:', error);
		throw error; // Re-throw - models are required
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
export function getModelsCache(): Map<string, SDKModelInfo[]> {
	return new Map(modelsCache);
}

/**
 * Set models cache (for testing - allows reusing cached models)
 * @param cache Map of cached models to restore
 */
export function setModelsCache(cache: Map<string, SDKModelInfo[]>): void {
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
 * Searches SDK models with support for legacy model IDs
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
