/**
 * Custom Endpoint types
 *
 * User-configurable OpenAI-compatible API endpoints. These let users plug in
 * local model servers (Ollama OpenAI mode, LM Studio, vLLM), self-hosted
 * deployments, and proxies (LiteLLM, custom OpenRouter) that all speak the
 * OpenAI Chat Completions API surface.
 *
 * Each endpoint is registered with the provider registry at daemon startup
 * as a `CustomEndpointProvider` instance. The provider routes traffic through
 * an embedded Anthropic ↔ OpenAI Chat Completions bridge.
 */

/**
 * Per-model capability hints. The provider honours these when reporting
 * `ProviderCapabilities` and when building SDK options. Features marked
 * `false` here are silently skipped instead of producing upstream errors
 * (e.g. no thinking blocks emitted, no prompt caching headers added).
 */
export interface CustomEndpointModelCapabilities {
	/** Streaming responses (SSE). Required — most endpoints support it. */
	streaming: boolean;
	/** Function/tool calling via OpenAI `tools[]` + `tool_calls`. */
	toolUse: boolean;
	/** Vision inputs (image URLs or base64 data URLs). */
	vision: boolean;
	/** Extended thinking / reasoning blocks. */
	thinking: boolean;
	/** Prompt caching support (Anthropic-style `cache_control`). */
	caching: boolean;
	/** Maximum input context window in tokens. */
	maxContextTokens: number;
}

/**
 * A model exposed by a custom endpoint. `id` is the user-facing label;
 * `providerModelId` is the string sent in the upstream Chat Completions
 * request body. Often they're equal (e.g. for Ollama models like
 * `qwen2.5-coder:14b`), but split lets the user surface a friendly name.
 */
export interface CustomEndpointModel {
	/** User-facing model ID. Must be unique within the endpoint. */
	id: string;
	/** Optional display name shown in pickers (defaults to `id`). */
	name?: string;
	/** The model string sent to the upstream API. Defaults to `id`. */
	providerModelId?: string;
	/** Per-model capabilities. Defaults applied by the provider. */
	capabilities?: Partial<CustomEndpointModelCapabilities>;
}

/**
 * A user-defined endpoint backed by an OpenAI Chat Completions API.
 *
 * Stored as JSON inside `GlobalSettings.customEndpoints`. Each entry becomes
 * its own provider in the registry, with `id = "custom:" + endpoint.id`.
 */
export interface CustomEndpointConfig {
	/**
	 * Unique endpoint identifier. The resulting provider ID is
	 * `custom:<id>`. Should be a short slug like `lmstudio` or `litellm-prod`.
	 */
	id: string;
	/** Display name shown in UIs. */
	name: string;
	/** Upstream base URL (no trailing slash needed). Required. */
	baseUrl: string;
	/** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
	apiKey?: string;
	/** Extra HTTP headers attached to every upstream request. */
	headers?: Record<string, string>;
	/** Models exposed by this endpoint. At least one entry required. */
	models: CustomEndpointModel[];
	/** Default model ID (must match an entry in `models`). */
	defaultModelId?: string;
}

/** Default capabilities applied when a model omits a field. */
export const DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES: CustomEndpointModelCapabilities = {
	streaming: true,
	toolUse: true,
	vision: false,
	thinking: false,
	caching: false,
	maxContextTokens: 128000,
};
