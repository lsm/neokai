/**
 * Gemini Model Discovery
 *
 * Dynamically fetches available models from Google's Code Assist API
 * using the fetchAvailableModels endpoint.
 *
 * Adapted from Pi's antigravity discovery implementation.
 */

import { createLogger } from '@neokai/shared/logger';
import type { ModelInfo } from '@neokai/shared';

const log = createLogger('kai:providers:gemini:discovery');

// ---------------------------------------------------------------------------
// Discovery endpoints
// ---------------------------------------------------------------------------

const DISCOVERY_ENDPOINTS = [
	'https://daily-cloudcode-pa.googleapis.com',
	'https://daily-cloudcode-pa.sandbox.googleapis.com',
];

const FETCH_AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels';

// ---------------------------------------------------------------------------
// Denylist — models to hide from the UI
// ---------------------------------------------------------------------------

const MODEL_DENYLIST = new Set([
	'chat_20706',
	'chat_23310',
	'gemini-2.5-flash-thinking',
	'gemini-3-pro-low',
	'gemini-2.5-pro',
]);

// ---------------------------------------------------------------------------
// Fallback models (used when discovery fails)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS: ModelInfo[] = [
	{
		id: 'gemini-2.5-pro',
		name: 'Gemini 2.5 Pro',
		alias: 'gemini-2.5-pro',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Pro via Code Assist (OAuth)',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'gemini-2.5-flash',
		name: 'Gemini 2.5 Flash',
		alias: 'gemini-2.5-flash',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Flash via Code Assist (OAuth)',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'gemini-2.5-flash-lite',
		name: 'Gemini 2.5 Flash Lite',
		alias: 'gemini-2.5-flash-lite',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Flash Lite via Code Assist (OAuth)',
		releaseDate: '2025-01-01',
		available: true,
	},
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw model metadata from the discovery API. */
interface DiscoveryApiModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	thinkingBudget?: number;
	recommended?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	model?: string;
	apiProvider?: string;
	modelProvider?: string;
	isInternal?: boolean;
	supportsVideo?: boolean;
}

/** Response from the discovery endpoint. */
interface DiscoveryApiResponse {
	models?: Record<string, DiscoveryApiModel>;
}

/** Options for fetching discovered models. */
export interface FetchDiscoveryModelsOptions {
	/** OAuth access token. */
	token: string;
	/** Optional endpoint override. */
	endpoint?: string;
	/** Optional fetch implementation override for tests. */
	fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Fetch available models from Google's Code Assist discovery endpoint.
 *
 * Tries multiple endpoints in order. Returns null on complete failure
 * (network error, auth failure, or unparseable response).
 */
export async function fetchAvailableModels(
	options: FetchDiscoveryModelsOptions
): Promise<ModelInfo[] | null> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const endpoints = options.endpoint
		? [trimTrailingSlashes(options.endpoint)]
		: DISCOVERY_ENDPOINTS.map(trimTrailingSlashes);

	for (const endpoint of endpoints) {
		let response: Response;
		try {
			response = await fetchImpl(`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${options.token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({}),
			});
		} catch (err) {
			log.warn(
				`Discovery endpoint ${endpoint} unreachable: ${err instanceof Error ? err.message : err}`
			);
			continue;
		}

		if (!response.ok) {
			log.warn(`Discovery endpoint ${endpoint} returned ${response.status}`);
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			log.warn(`Discovery endpoint ${endpoint} returned invalid JSON`);
			continue;
		}

		const models = parseDiscoveryResponse(payload);
		if (models === null) {
			log.warn(`Discovery endpoint ${endpoint} returned unparseable payload`);
			continue;
		}

		log.info(`Discovered ${models.length} models from ${endpoint}`);
		return models;
	}

	log.warn('All discovery endpoints failed, falling back to static model list');
	return null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseDiscoveryResponse(payload: unknown): ModelInfo[] | null {
	if (typeof payload !== 'object' || payload === null) return null;

	const response = payload as DiscoveryApiResponse;
	if (!response.models || typeof response.models !== 'object') return null;

	const models: ModelInfo[] = [];

	for (const [modelId, rawModel] of Object.entries(response.models)) {
		if (MODEL_DENYLIST.has(modelId)) continue;
		if (!rawModel || typeof rawModel !== 'object') continue;

		const model = rawModel as DiscoveryApiModel;
		if (model.isInternal === true) continue;

		// Only include IDs that the bridge can actually route
		if (!modelId.startsWith('gemini-') && !modelId.startsWith('gemma-')) continue;

		models.push(discoveryModelToModelInfo(modelId, model));
	}

	return models;
}

function discoveryModelToModelInfo(modelId: string, model: DiscoveryApiModel): ModelInfo {
	const displayName = model.displayName || modelId;
	const contextWindow = toPositiveNumber(model.maxTokens, 1_000_000);

	return {
		id: modelId,
		name: displayName,
		alias: modelId,
		family: inferFamily(modelId),
		provider: 'google-gemini-oauth',
		contextWindow,
		description: `${displayName} via Code Assist (OAuth)`,
		releaseDate: '2025-01-01',
		available: true,
		// Map discovery metadata to NeoKai model features
		thinkingModes: model.supportsThinking === true ? 'on' : 'off',
		preferContextWindowMetadata: true,
	};
}

function inferFamily(modelId: string): string {
	if (modelId.startsWith('gemma-')) return 'gemma';
	if (modelId.startsWith('gemini-')) return 'gemini';
	return 'gemini';
}

function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value;
	}
	return fallback;
}

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * Get the fallback static model list.
 * Used when dynamic discovery is unavailable.
 */
export function getFallbackModels(): ModelInfo[] {
	return [...FALLBACK_MODELS];
}
