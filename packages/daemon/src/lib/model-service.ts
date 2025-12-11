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
			// Cache the result
			modelsCache.set(cacheKey, models);
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
 * Get all available models (dynamic + static fallback)
 * Tries to use cached dynamic models first, falls back to static
 *
 * @param cacheKey - Cache key to look up dynamic models
 * @returns Array of ModelInfo
 */
export function getAvailableModels(cacheKey: string = 'global'): ModelInfo[] {
	// Try to get dynamic models from cache
	const dynamicModels = modelsCache.get(cacheKey);
	if (dynamicModels && dynamicModels.length > 0) {
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
 * Clear the models cache for a specific key or all
 */
export function clearModelsCache(cacheKey?: string): void {
	if (cacheKey) {
		modelsCache.delete(cacheKey);
	} else {
		modelsCache.clear();
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
