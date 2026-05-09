/**
 * Gemini Model Discovery
 *
 * Previously dynamically fetched available models from Google's Code Assist API.
 * The discovery endpoints (daily-cloudcode-pa.googleapis.com) now return 403 for
 * all accounts, so discovery is disabled.  Only static fallback models are used.
 *
 * If Google restores public discovery in the future, the fetchAvailableModels()
 * function can be re-enabled by adding working endpoints to DISCOVERY_ENDPOINTS.
 */

import { createLogger } from '@neokai/shared/logger';
import type { ModelInfo } from '@neokai/shared';

const log = createLogger('kai:providers:gemini:discovery');

// ---------------------------------------------------------------------------
// Discovery endpoints — DISABLED (all return 403)
// ---------------------------------------------------------------------------

/** Discovery is disabled because Google's Code Assist discovery endpoints
 *  (daily-cloudcode-pa.googleapis.com) are no longer publicly accessible.
 *  Kept empty so the code structure is preserved if Google restores access. */
const _DISCOVERY_ENDPOINTS: string[] = [];

const _FETCH_AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels';

// ---------------------------------------------------------------------------
// Denylist — models to hide from the UI
// ---------------------------------------------------------------------------

const _MODEL_DENYLIST = new Set([
	'chat_20706',
	'chat_23310',
	'gemini-2.5-flash-thinking',
	'gemini-3-pro-low',
]);

// ---------------------------------------------------------------------------
// Static model list (discovery disabled — Code Assist endpoints return 403)
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
		releaseDate: '2025-05-01',
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
		releaseDate: '2025-05-01',
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
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-2.0-flash',
		name: 'Gemini 2.0 Flash',
		alias: 'gemini-2.0-flash',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.0 Flash via Code Assist (OAuth)',
		releaseDate: '2025-02-01',
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
interface _DiscoveryApiResponse {
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
 * Discovery is currently disabled because all known endpoints return 403.
 * This function immediately returns null so callers fall back to the static
 * model list.  If Google restores public discovery, re-enable by populating
 * DISCOVERY_ENDPOINTS.
 */
export async function fetchAvailableModels(
	_options: FetchDiscoveryModelsOptions
): Promise<ModelInfo[] | null> {
	log.warn('Model discovery is disabled — Code Assist endpoints are no longer publicly accessible');
	return null;
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
