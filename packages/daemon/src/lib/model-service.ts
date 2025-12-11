/**
 * Model Service - Centralized model management using SDK as source of truth
 *
 * This service manages model information by querying the Claude Agent SDK's
 * supportedModels() API and caching the results. It replaces hardcoded model
 * lists with dynamic SDK data to ensure model IDs always match.
 */

import type { ModelInfo as SDKModelInfo } from '@liuboer/shared/sdk';
import type { ModelInfo } from '@liuboer/shared';
import { CLAUDE_MODELS, MODEL_ALIASES } from '@liuboer/shared';

/**
 * Get supported models from Claude Agent SDK
 * Uses a temporary query object and caches results for 1 hour
 *
 * NOTE: This function is intentionally commented out because creating a temporary
 * query just to fetch models is unreliable (requires API key, makes real API calls,
 * slow, can timeout). We use hardcoded models instead.
 *
 * If needed in the future, use an existing query object's supportedModels() method.
 */
export async function getSupportedModels(_forceRefresh = false): Promise<SDKModelInfo[]> {
	// Return empty array - caller should use hardcoded models
	// This prevents creating unnecessary query objects that require API keys
	return [];

	/* Original implementation - commented out for reliability
	const now = Date.now();

	// Return cached data if valid
	if (!forceRefresh && modelsCacheData && now - modelsCacheData.timestamp < MODELS_CACHE_DURATION) {
		return modelsCacheData.models;
	}

	// Create a temporary query to fetch models
	// We use a simple prompt since we just need the query object
	const tmpQuery = query({
		prompt: 'list models',
		options: {
			cwd: process.cwd(),
			maxTurns: 1,
		},
	});

	try {
		// Get supported models from SDK
		const models = await tmpQuery.supportedModels();

		// Update cache
		modelsCacheData = {
			models,
			timestamp: now,
		};

		// Interrupt the query since we don't need it to run
		await tmpQuery.interrupt();

		return models;
	} catch (error) {
		// Clean up query on error
		try {
			await tmpQuery.interrupt();
		} catch {
			// Ignore interrupt errors
		}
		throw error;
	}
	*/
}

/**
 * Clear the models cache (no-op since we use hardcoded models)
 */
export function clearModelsCache(): void {
	// No-op: We use hardcoded models now, no cache to clear
}

/**
 * Get model info by ID or alias
 * Uses hardcoded models as the source of truth (reliable, fast, no API calls needed)
 */
export async function getModelInfo(idOrAlias: string): Promise<ModelInfo | null> {
	// Check if it's an alias from hardcoded models
	const aliasModelId = MODEL_ALIASES.get(idOrAlias);
	const searchId = aliasModelId || idOrAlias;

	// Try exact ID match in hardcoded models
	let model = CLAUDE_MODELS.find((m) => m.id === searchId);

	// Try alias match if not found
	if (!model && !aliasModelId) {
		const modelIdFromAlias = MODEL_ALIASES.get(idOrAlias);
		if (modelIdFromAlias) {
			model = CLAUDE_MODELS.find((m) => m.id === modelIdFromAlias);
		}
	}

	return model || null;
}

/**
 * Validate if a model ID or alias is valid
 * Checks both SDK models and hardcoded aliases
 */
export async function isValidModel(idOrAlias: string): Promise<boolean> {
	const modelInfo = await getModelInfo(idOrAlias);
	return modelInfo !== null;
}

/**
 * Resolve a model alias to its full ID
 * Checks aliases first, then verifies against SDK models
 */
export async function resolveModelAlias(idOrAlias: string): Promise<string> {
	// Check if it's a known alias
	const aliasModelId = MODEL_ALIASES.get(idOrAlias);
	if (aliasModelId) {
		// Verify the aliased model exists in SDK
		const modelInfo = await getModelInfo(aliasModelId);
		if (modelInfo) {
			return aliasModelId;
		}
	}

	// Not an alias, return as-is if it's valid
	const modelInfo = await getModelInfo(idOrAlias);
	return modelInfo?.id || idOrAlias;
}

/**
 * Get current model info from a model ID
 * Used by AgentSession.getCurrentModel()
 */
export async function getCurrentModelInfo(modelId: string): Promise<{
	id: string;
	info: ModelInfo | null;
}> {
	const info = await getModelInfo(modelId);
	return {
		id: modelId,
		info,
	};
}
