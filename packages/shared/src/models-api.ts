/**
 * Claude Models API Client
 *
 * This module provides functionality to query available Claude models
 * from the Anthropic API at runtime.
 */

/**
 * Model object returned by the Anthropic API
 */
export interface AnthropicModel {
	/** Unique model identifier */
	id: string;
	/** RFC 3339 datetime string representing the time at which the model was released */
	created_at: string;
	/** A human-readable name for the model */
	display_name: string;
	/** Type of object, always "model" */
	type: 'model';
}

/**
 * Response from the Models API
 */
export interface ListModelsResponse {
	/** Array of available models */
	data: AnthropicModel[];
	/** First model ID for pagination */
	first_id: string | null;
	/** Last model ID for pagination */
	last_id: string | null;
	/** Whether there are more results */
	has_more: boolean;
}

/**
 * Options for listing models
 */
export interface ListModelsOptions {
	/** API key for authentication */
	apiKey?: string;
	/** Cursor for pagination - return models after this ID */
	after_id?: string;
	/** Cursor for pagination - return models before this ID */
	before_id?: string;
	/** Maximum number of models to return (default 20) */
	limit?: number;
	/** Enable beta features */
	beta?: string;
}

/**
 * Fetch available models from the Anthropic API
 *
 * @param options - Options for the API request
 * @returns Promise resolving to the list of available models
 *
 * @example
 * ```typescript
 * const models = await fetchAvailableModels({
 *   apiKey: process.env.ANTHROPIC_API_KEY
 * });
 * console.log(models.data.map(m => m.display_name));
 * ```
 */
export async function fetchAvailableModels(
	options: ListModelsOptions = {}
): Promise<ListModelsResponse> {
	// Get API key from options or environment
	const apiKey =
		options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;

	if (!apiKey) {
		throw new Error(
			'API key required. Set ANTHROPIC_API_KEY environment variable or pass apiKey option.'
		);
	}

	// Build query parameters
	const params = new URLSearchParams();
	if (options.after_id) params.set('after_id', options.after_id);
	if (options.before_id) params.set('before_id', options.before_id);
	if (options.limit) params.set('limit', options.limit.toString());

	const queryString = params.toString();
	const url = `https://api.anthropic.com/v1/models${queryString ? `?${queryString}` : ''}`;

	// Build headers
	const headers: Record<string, string> = {
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
	};

	if (options.beta) {
		headers['anthropic-beta'] = options.beta;
	}

	// Make API request
	const response = await fetch(url, {
		method: 'GET',
		headers,
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(
			`Failed to fetch models: ${response.status} ${response.statusText}. ${JSON.stringify(error)}`
		);
	}

	return response.json() as Promise<ListModelsResponse>;
}

/**
 * Get all available models (handles pagination automatically)
 *
 * @param options - Options for the API request
 * @returns Promise resolving to array of all available models
 *
 * @example
 * ```typescript
 * const models = await getAllAvailableModels({
 *   apiKey: process.env.ANTHROPIC_API_KEY
 * });
 * console.log(`Found ${models.length} models`);
 * ```
 */
export async function getAllAvailableModels(
	options: ListModelsOptions = {}
): Promise<AnthropicModel[]> {
	const allModels: AnthropicModel[] = [];
	let hasMore = true;
	let afterId: string | undefined;

	while (hasMore) {
		const response = await fetchAvailableModels({
			...options,
			after_id: afterId,
		});

		allModels.push(...response.data);
		hasMore = response.has_more;
		afterId = response.last_id || undefined;
	}

	return allModels;
}

/**
 * Check if a model ID exists in the Anthropic API
 *
 * @param modelId - The model ID to check
 * @param options - Options for the API request
 * @returns Promise resolving to true if model exists, false otherwise
 *
 * @example
 * ```typescript
 * const exists = await isModelAvailable("claude-opus-4-20250514", {
 *   apiKey: process.env.ANTHROPIC_API_KEY
 * });
 * console.log(`Model available: ${exists}`);
 * ```
 */
export async function isModelAvailable(
	modelId: string,
	options: ListModelsOptions = {}
): Promise<boolean> {
	try {
		const models = await getAllAvailableModels(options);
		return models.some((model) => model.id === modelId);
	} catch (error) {
		console.error('Error checking model availability:', error);
		return false;
	}
}

/**
 * Get detailed information about a specific model
 *
 * @param modelId - The model ID to look up
 * @param options - Options for the API request
 * @returns Promise resolving to model info or null if not found
 *
 * @example
 * ```typescript
 * const model = await getModelInfo("claude-opus-4-20250514", {
 *   apiKey: process.env.ANTHROPIC_API_KEY
 * });
 * if (model) {
 *   console.log(`${model.display_name} released ${model.created_at}`);
 * }
 * ```
 */
export async function getModelInfoFromAPI(
	modelId: string,
	options: ListModelsOptions = {}
): Promise<AnthropicModel | null> {
	try {
		const models = await getAllAvailableModels(options);
		return models.find((model) => model.id === modelId) || null;
	} catch (error) {
		console.error('Error fetching model info:', error);
		return null;
	}
}

/**
 * Cached model list to avoid repeated API calls
 */
let cachedModels: {
	data: AnthropicModel[];
	timestamp: number;
} | null = null;

/**
 * Cache duration in milliseconds (1 hour)
 */
const CACHE_DURATION = 60 * 60 * 1000;

/**
 * Get available models with caching
 *
 * @param options - Options for the API request
 * @param forceRefresh - Force refresh even if cache is valid
 * @returns Promise resolving to array of available models
 *
 * @example
 * ```typescript
 * // Use cached data if available
 * const models = await getCachedAvailableModels();
 *
 * // Force refresh
 * const freshModels = await getCachedAvailableModels({}, true);
 * ```
 */
export async function getCachedAvailableModels(
	options: ListModelsOptions = {},
	forceRefresh = false
): Promise<AnthropicModel[]> {
	const now = Date.now();

	// Return cached data if valid
	if (!forceRefresh && cachedModels && now - cachedModels.timestamp < CACHE_DURATION) {
		return cachedModels.data;
	}

	// Fetch fresh data
	const models = await getAllAvailableModels(options);

	// Update cache
	cachedModels = {
		data: models,
		timestamp: now,
	};

	return models;
}

/**
 * Clear the model cache
 */
export function clearModelCache(): void {
	cachedModels = null;
}
