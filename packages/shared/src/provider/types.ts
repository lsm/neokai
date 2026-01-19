/**
 * Multi-Provider Architecture - Type Definitions
 *
 * This file defines the interfaces and types for the new provider system.
 * Each provider implements the Provider interface to enable multi-provider support.
 */

import type { ModelInfo } from '../models.js';

/**
 * Model tier identifiers used for mapping generic tiers to provider-specific models
 */
export type ModelTier = 'sonnet' | 'haiku' | 'opus' | 'default';

/**
 * Provider identifier - any string to allow extensibility
 */
export type ProviderId = string;

/**
 * Provider capabilities describe what features a provider supports
 */
export interface ProviderCapabilities {
	/** Supports streaming responses */
	streaming: boolean;
	/** Supports extended thinking */
	extendedThinking: boolean;
	/** Maximum context window in tokens */
	maxContextWindow: number;
	/** Supports function calling / tool use */
	functionCalling: boolean;
	/** Supports vision (image inputs) */
	vision: boolean;
}

/**
 * SDK configuration returned by a provider
 * Contains environment variables and SDK options needed to use this provider
 */
export interface ProviderSdkConfig {
	/** Environment variables to set before creating SDK query */
	envVars: Record<string, string>;
	/** Additional SDK options to merge */
	sdkOptions?: Record<string, unknown>;
	/** Whether this provider uses Anthropic-compatible API */
	isAnthropicCompatible: boolean;
	/** API version (if applicable) */
	apiVersion?: string;
}

/**
 * Per-session provider configuration
 * Allows overriding API keys, base URLs, etc. for a specific session
 */
export interface ProviderSessionConfig {
	/** Provider-specific API key override */
	apiKey?: string;
	/** Custom base URL override */
	baseUrl?: string;
	/** Additional provider-specific settings */
	[key: string]: unknown;
}

/**
 * Core provider interface that all providers must implement
 *
 * This interface enables:
 * - Dynamic provider registration
 * - Provider-specific model management
 * - Isolated configuration without global state mutation
 * - Easy addition of new providers
 */
export interface Provider {
	/**
	 * Unique provider identifier
	 * Used in SessionConfig.provider and ModelInfo.provider
	 */
	readonly id: ProviderId;

	/**
	 * Human-readable display name
	 * Shown in UI for provider selection
	 */
	readonly displayName: string;

	/**
	 * Provider capabilities
	 * Describes what features this provider supports
	 */
	readonly capabilities: ProviderCapabilities;

	/**
	 * Check if provider is available (has valid credentials)
	 * Can be synchronous (check env vars) or asynchronous (validate API key)
	 */
	isAvailable(): Promise<boolean> | boolean;

	/**
	 * Get list of available models from this provider
	 * Can be static (from config) or dynamic (API call)
	 */
	getModels(): Promise<ModelInfo[]>;

	/**
	 * Validate that a model ID belongs to this provider
	 * Used for auto-detecting provider from model ID
	 */
	ownsModel(modelId: string): boolean;

	/**
	 * Get the model to use for a specific tier
	 * Maps generic tiers (sonnet/haiku/opus) to provider-specific models
	 * Returns undefined if provider doesn't have a model for that tier
	 */
	getModelForTier(tier: ModelTier): string | undefined;

	/**
	 * Build SDK configuration for this provider
	 * Returns env vars and SDK options needed to use this provider
	 *
	 * @param modelId - The model ID to use
	 * @param sessionConfig - Optional per-session configuration overrides
	 */
	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig;

	/**
	 * Translate a provider model ID to SDK-compatible ID if needed
	 * Some providers (like GLM) need to translate their model IDs to Anthropic tiers
	 *
	 * @param modelId - The provider's model ID
	 * @returns SDK-compatible model ID (or original if no translation needed)
	 */
	translateModelIdForSdk?(modelId: string): string;
}

/**
 * Provider context created for a session
 * Encapsulates provider-specific configuration for query building
 */
export interface ProviderContext {
	/** The provider instance */
	readonly provider: Provider;
	/** SDK configuration for this provider/context */
	readonly sdkConfig: ProviderSdkConfig;
	/** The original model ID (provider-specific) */
	readonly modelId: string;
	/** Session-specific config (may have API key override) */
	readonly sessionConfig?: ProviderSessionConfig;

	/**
	 * Get the SDK-compatible model ID
	 * Applies translation if provider needs it
	 */
	getSdkModelId(): string;

	/**
	 * Build SDK options with provider configuration applied
	 * Merges base options with provider-specific env vars and settings
	 */
	buildSdkOptions<T extends Record<string, unknown>>(baseOptions: T): Promise<T>;
}

/**
 * Provider information for UI display
 */
export interface ProviderInfo {
	/** Provider identifier */
	id: ProviderId;
	/** Display name */
	name: string;
	/** Whether this provider is configured (has API key) */
	available: boolean;
	/** Capabilities */
	capabilities: ProviderCapabilities;
	/** Available model IDs */
	models: string[];
}
