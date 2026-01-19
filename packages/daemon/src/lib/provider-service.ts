/**
 * ProviderService - Manages AI provider configurations
 *
 * Provides environment variable resolution for different AI providers
 * (Anthropic, GLM) based on model ID detection.
 *
 * GLM uses Anthropic-compatible API at https://open.bigmodel.cn/api/anthropic
 * so we can reuse the SDK by overriding ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY.
 *
 * Model-based detection:
 * - Models starting with "glm-" are routed to GLM provider
 * - All other models use Anthropic (default)
 */

import type { Provider, ProviderInfo, Session } from '@liuboer/shared';
import { getAvailableModels } from './model-service';

/**
 * Environment variables for provider routing
 *
 * IMPORTANT: These must be set in process.env (parent process) before SDK query creation.
 * The SDK subprocess inherits these environment variables when spawned.
 * Passing via options.env does NOT work for GLM.
 */
export interface ProviderEnvVars {
	ANTHROPIC_BASE_URL?: string;
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_AUTH_TOKEN?: string;
	ANTHROPIC_MODEL?: string; // Override default model
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string; // Map haiku tier to GLM model
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string; // Map default/sonnet tier to GLM model
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string; // Map opus tier to GLM model
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
}

/**
 * Stores original environment variable values for restoration
 */
interface OriginalEnvVars {
	ANTHROPIC_AUTH_TOKEN?: string;
	ANTHROPIC_BASE_URL?: string;
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
}

/**
 * Internal provider configuration
 */
interface ProviderDefinition {
	id: Provider;
	name: string;
	baseUrl?: string; // undefined = use SDK default
	models: string[];
	envKeyNames: string[]; // Environment variable names to check for API key
	titleGenerationModel?: string; // Model ID to use for title generation (fast/cheap model)
}

/**
 * Static provider definitions
 */
const PROVIDER_DEFINITIONS: Record<Provider, ProviderDefinition> = {
	anthropic: {
		id: 'anthropic',
		name: 'Anthropic',
		baseUrl: 'https://api.anthropic.com',
		models: ['default', 'opus', 'haiku', 'sonnet'],
		envKeyNames: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
		titleGenerationModel: 'haiku',
	},
	glm: {
		id: 'glm',
		name: 'GLM (智谱AI)',
		baseUrl: 'https://open.bigmodel.cn/api/anthropic',
		models: ['glm-4.7'],
		envKeyNames: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
		titleGenerationModel: 'glm-4.5-air',
	},
};

export class ProviderService {
	/**
	 * Get the default provider based on environment configuration
	 *
	 * Priority:
	 * 1. DEFAULT_PROVIDER env var (explicit override)
	 * 2. GLM if GLM_API_KEY or ZHIPU_API_KEY is set (auto-detect)
	 * 3. Anthropic (default)
	 */
	getDefaultProvider(): Provider {
		// 1. Check explicit DEFAULT_PROVIDER override
		const defaultProvider = process.env.DEFAULT_PROVIDER;
		if (defaultProvider === 'glm' || defaultProvider === 'anthropic') {
			return defaultProvider;
		}

		// 2. Auto-detect: prefer GLM if API key is available
		if (this.isProviderAvailable('glm')) {
			return 'glm';
		}

		// 3. Default to Anthropic
		return 'anthropic';
	}

	/**
	 * Get API key for a specific provider from environment variables
	 */
	getProviderApiKey(provider: Provider): string | undefined {
		const definition = PROVIDER_DEFINITIONS[provider];
		for (const envKey of definition.envKeyNames) {
			const value = process.env[envKey];
			if (value) {
				return value;
			}
		}
		return undefined;
	}

	/**
	 * Check if a provider is available (has API key configured)
	 */
	isProviderAvailable(provider: Provider): boolean {
		// Anthropic is always "available" if the default auth works
		if (provider === 'anthropic') {
			return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
		}
		return !!this.getProviderApiKey(provider);
	}

	/**
	 * Get provider information
	 */
	getProviderInfo(provider: Provider): ProviderInfo {
		const definition = PROVIDER_DEFINITIONS[provider];
		return {
			id: definition.id,
			name: definition.name,
			baseUrl: definition.baseUrl,
			models: definition.models,
			available: this.isProviderAvailable(provider),
		};
	}

	/**
	 * List all available providers (those with API keys configured)
	 */
	getAvailableProviders(): ProviderInfo[] {
		return Object.values(PROVIDER_DEFINITIONS).map((def) => this.getProviderInfo(def.id));
	}

	/**
	 * Get environment variables for SDK subprocess based on session's provider
	 *
	 * For GLM:
	 * - Sets ANTHROPIC_BASE_URL to GLM's Anthropic-compatible endpoint
	 * - Sets ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN to the GLM API key
	 * - Sets API_TIMEOUT_MS to 3000000 (50 minutes) for long-running requests
	 * - Sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC to disable telemetry
	 *
	 * For Anthropic:
	 * - Returns empty object (use default environment)
	 */
	getProviderEnvVars(session: Session): ProviderEnvVars {
		const provider = session.config.provider || 'anthropic';
		const definition = PROVIDER_DEFINITIONS[provider];

		// Anthropic uses default environment
		if (provider === 'anthropic') {
			return {};
		}

		// Get API key: session override > global env
		const apiKey = session.config.providerConfig?.apiKey || this.getProviderApiKey(provider);

		if (!apiKey) {
			console.warn(`[ProviderService] No API key found for provider ${provider}`);
			return {};
		}

		// Get base URL: session override > provider default
		const baseUrl = session.config.providerConfig?.baseUrl || definition.baseUrl;

		const envVars: ProviderEnvVars = {};

		if (baseUrl) {
			envVars.ANTHROPIC_BASE_URL = baseUrl;
		}

		// Set both API key forms for maximum compatibility
		envVars.ANTHROPIC_API_KEY = apiKey;
		envVars.ANTHROPIC_AUTH_TOKEN = apiKey;

		// GLM-specific settings
		if (provider === 'glm') {
			// Extended timeout for GLM (50 minutes)
			envVars.API_TIMEOUT_MS = '3000000';
			// Disable non-essential traffic (telemetry, etc.)
			envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
		}

		return envVars;
	}

	/**
	 * Validate that a provider switch is possible
	 */
	validateProviderSwitch(provider: Provider, apiKey?: string): { valid: boolean; error?: string } {
		// Check if provider is known
		if (!PROVIDER_DEFINITIONS[provider]) {
			return { valid: false, error: `Unknown provider: ${provider}` };
		}

		// Check if provider has API key (either provided or in env)
		if (provider !== 'anthropic') {
			const hasKey = apiKey || this.getProviderApiKey(provider);
			if (!hasKey) {
				return {
					valid: false,
					error: `No API key configured for ${provider}. Set ${PROVIDER_DEFINITIONS[provider].envKeyNames[0]} environment variable or provide apiKey.`,
				};
			}
		}

		return { valid: true };
	}

	/**
	 * Get the default model for a provider
	 */
	getDefaultModelForProvider(provider: Provider): string {
		const definition = PROVIDER_DEFINITIONS[provider];
		return definition.models[0] || 'default';
	}

	/**
	 * Get title generation configuration for a provider
	 * Returns the model ID, base URL, and API version to use for direct API calls
	 */
	getTitleGenerationConfig(provider: Provider): {
		modelId: string;
		baseUrl: string;
		apiVersion: string;
	} {
		const definition = PROVIDER_DEFINITIONS[provider];

		// Use provider-specific title generation model (shorthand like 'haiku' or full ID)
		let modelId = definition.titleGenerationModel || definition.models[0] || 'default';

		// Resolve shorthand to full model ID for Anthropic
		// For GLM, the model ID is already the full ID
		if (
			provider === 'anthropic' &&
			(modelId === 'haiku' || modelId === 'sonnet' || modelId === 'opus')
		) {
			// Use model service to get the full model ID from the cache
			const models = getAvailableModels('global');
			const model = models.find((m: { family: string }) => m.family === modelId);
			if (model) {
				modelId = model.id;
			}
		}

		// Base URL for direct API calls (all providers use Anthropic-compatible API)
		const baseUrl = definition.baseUrl || 'https://api.anthropic.com';

		// API version (currently all providers use v1)
		const apiVersion = 'v1';

		return { modelId, baseUrl, apiVersion };
	}

	/**
	 * Check if a model is valid for a provider
	 */
	isModelValidForProvider(provider: Provider, model: string): boolean {
		const definition = PROVIDER_DEFINITIONS[provider];
		// For Anthropic, we allow any model (dynamic from SDK)
		if (provider === 'anthropic') {
			return true;
		}
		// For other providers, check against known models
		return definition.models.includes(model);
	}

	/**
	 * Detect if a model ID belongs to GLM provider
	 * GLM model IDs start with "glm-" (e.g., "glm-4.7")
	 */
	isGlmModel(modelId: string): boolean {
		return modelId.toLowerCase().startsWith('glm-');
	}

	/**
	 * Detect provider from model ID
	 * Returns 'glm' for GLM models, 'anthropic' for everything else
	 */
	detectProviderFromModel(modelId: string): Provider {
		return this.isGlmModel(modelId) ? 'glm' : 'anthropic';
	}

	/**
	 * Translate a model ID to an SDK-recognized model ID
	 *
	 * GLM model IDs (glm-4.7, glm-4.5-air) are not recognized by the SDK.
	 * The SDK only knows Anthropic model IDs: default, opus, haiku.
	 *
	 * For GLM models, we map them to Anthropic IDs:
	 * - glm-4.7 → default (Sonnet tier, SDK's default)
	 * - glm-4.5-air → haiku (Haiku tier, faster)
	 *
	 * The actual GLM model is selected via ANTHROPIC_DEFAULT_SONNET_MODEL env var.
	 *
	 * @param modelId - The model ID to translate
	 * @returns SDK-recognized model ID
	 */
	translateModelIdForSdk(modelId: string): string {
		if (this.isGlmModel(modelId)) {
			// Map GLM models to Anthropic-style IDs that SDK recognizes
			if (modelId === 'glm-4.5-air') {
				return 'haiku';
			}
			// glm-4.7 and any other GLM models use 'default' (Sonnet tier)
			return 'default';
		}
		// Anthropic models pass through
		return modelId;
	}

	/**
	 * Get environment variables for SDK subprocess based on model ID
	 *
	 * This is the primary method for model-based provider detection.
	 * It automatically detects GLM models and returns appropriate env vars.
	 *
	 * When a GLM model is requested (e.g., "glm-4.7"), we:
	 * 1. Translate it to an SDK-recognized tier ID (default, haiku, opus)
	 * 2. Set ANTHROPIC_DEFAULT_*_MODEL env var to map that tier back to the GLM model
	 *
	 * Example flow for glm-4.7:
	 * - User requests model: "glm-4.7"
	 * - translateModelIdForSdk("glm-4.7") → "default" (Sonnet tier)
	 * - SDK receives model: "default"
	 * - ANTHROPIC_DEFAULT_SONNET_MODEL="glm-4.7" tells SDK to use glm-4.7
	 *
	 * @param modelId - The model ID (e.g., "glm-4.7", "default", "opus")
	 * @returns Environment variables for the SDK subprocess
	 */
	getEnvVarsForModel(modelId: string): ProviderEnvVars {
		// Detect provider from model ID
		const provider = this.detectProviderFromModel(modelId);

		// Anthropic uses default environment
		if (provider === 'anthropic') {
			return {};
		}

		// GLM provider
		const apiKey = this.getProviderApiKey('glm');
		if (!apiKey) {
			console.warn(`[ProviderService] No API key found for GLM model ${modelId}`);
			return {};
		}

		const definition = PROVIDER_DEFINITIONS.glm;
		const envVars: ProviderEnvVars = {
			ANTHROPIC_BASE_URL: definition.baseUrl,
			// Use ANTHROPIC_AUTH_TOKEN for GLM (matching Claude Code behavior)
			// Note: ANTHROPIC_API_KEY does NOT work when passed via options.env
			ANTHROPIC_AUTH_TOKEN: apiKey,
			// Extended timeout for GLM (50 minutes)
			API_TIMEOUT_MS: '3000000',
			// Disable non-essential traffic (telemetry, etc.)
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		};

		// Map Anthropic tier IDs to GLM model IDs
		// When SDK uses 'haiku', 'default', or 'opus', translate to the actual GLM model
		if (modelId === 'glm-4.5-air') {
			envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
		} else {
			// glm-4.7 and other GLM models map to default (Sonnet) and Opus tiers
			envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
			envVars.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
		}

		return envVars;
	}

	/**
	 * Apply provider environment variables to process.env
	 *
	 * IMPORTANT: These must be set in the parent process before SDK query creation.
	 * The SDK subprocess inherits these environment variables when spawned.
	 *
	 * This method saves the original values and returns them for restoration.
	 *
	 * @param modelId - The model ID to get env vars for
	 * @returns Original env vars that should be restored after SDK query
	 */
	applyEnvVarsToProcess(modelId: string): OriginalEnvVars {
		const envVars = this.getEnvVarsForModel(modelId);

		// No env vars needed for Anthropic
		if (Object.keys(envVars).length === 0) {
			return {};
		}

		const original: OriginalEnvVars = {};

		// Save and set each env var
		if (envVars.ANTHROPIC_AUTH_TOKEN !== undefined) {
			original.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
			process.env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_AUTH_TOKEN;
		}
		if (envVars.ANTHROPIC_BASE_URL !== undefined) {
			original.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
			process.env.ANTHROPIC_BASE_URL = envVars.ANTHROPIC_BASE_URL;
		}
		if (envVars.API_TIMEOUT_MS !== undefined) {
			original.API_TIMEOUT_MS = process.env.API_TIMEOUT_MS;
			process.env.API_TIMEOUT_MS = envVars.API_TIMEOUT_MS;
		}
		if (envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
			original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
			process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
				envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		}
		if (envVars.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
			process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = envVars.ANTHROPIC_DEFAULT_SONNET_MODEL;
		}
		if (envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_HAIKU_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
			process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		}
		if (envVars.ANTHROPIC_DEFAULT_OPUS_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
			process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = envVars.ANTHROPIC_DEFAULT_OPUS_MODEL;
		}

		return original;
	}

	/**
	 * Apply provider environment variables to process.env with explicit provider
	 *
	 * This variant takes an explicit provider parameter instead of detecting from model ID.
	 * Use this when the model ID is a shorthand (like 'haiku') that doesn't identify the provider.
	 *
	 * @param provider - The provider to get env vars for
	 * @param modelId - The model ID for setting tier mappings
	 * @returns Original env vars that should be restored after SDK query
	 */
	applyEnvVarsToProcessForProvider(provider: Provider, modelId?: string): OriginalEnvVars {
		// Anthropic uses default environment
		if (provider === 'anthropic') {
			return {};
		}

		// Get API key for the provider
		const apiKey = this.getProviderApiKey(provider);
		if (!apiKey) {
			console.warn(`[ProviderService] No API key found for provider ${provider}`);
			return {};
		}

		const definition = PROVIDER_DEFINITIONS[provider];
		const envVars: ProviderEnvVars = {
			ANTHROPIC_BASE_URL: definition.baseUrl,
			ANTHROPIC_AUTH_TOKEN: apiKey,
		};

		// Add provider-specific settings
		if (provider === 'glm') {
			envVars.API_TIMEOUT_MS = '3000000';
			envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

			// Map tier IDs to GLM model IDs if a model is specified
			if (modelId === 'glm-4.5-air') {
				envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
			} else if (modelId) {
				// Other GLM models map to default (Sonnet) and Opus tiers
				envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
				envVars.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
			}
		}

		// Apply env vars
		const original: OriginalEnvVars = {};

		if (envVars.ANTHROPIC_AUTH_TOKEN !== undefined) {
			original.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
			process.env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_AUTH_TOKEN;
		}
		if (envVars.ANTHROPIC_BASE_URL !== undefined) {
			original.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
			process.env.ANTHROPIC_BASE_URL = envVars.ANTHROPIC_BASE_URL;
		}
		if (envVars.API_TIMEOUT_MS !== undefined) {
			original.API_TIMEOUT_MS = process.env.API_TIMEOUT_MS;
			process.env.API_TIMEOUT_MS = envVars.API_TIMEOUT_MS;
		}
		if (envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
			original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
			process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
				envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		}
		if (envVars.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
			process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = envVars.ANTHROPIC_DEFAULT_SONNET_MODEL;
		}
		if (envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_HAIKU_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
			process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		}
		if (envVars.ANTHROPIC_DEFAULT_OPUS_MODEL !== undefined) {
			original.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
			process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = envVars.ANTHROPIC_DEFAULT_OPUS_MODEL;
		}

		return original;
	}

	/**
	 * Restore original environment variables after SDK query completes
	 *
	 * @param original - The original env vars returned by applyEnvVarsToProcess
	 */
	restoreEnvVars(original: OriginalEnvVars): void {
		if (Object.keys(original).length === 0) {
			return;
		}

		// Restore each env var or delete if it wasn't originally set
		if (original.ANTHROPIC_AUTH_TOKEN !== undefined) {
			process.env.ANTHROPIC_AUTH_TOKEN = original.ANTHROPIC_AUTH_TOKEN;
		} else {
			delete process.env.ANTHROPIC_AUTH_TOKEN;
		}
		if (original.ANTHROPIC_BASE_URL !== undefined) {
			process.env.ANTHROPIC_BASE_URL = original.ANTHROPIC_BASE_URL;
		} else {
			delete process.env.ANTHROPIC_BASE_URL;
		}
		if (original.API_TIMEOUT_MS !== undefined) {
			process.env.API_TIMEOUT_MS = original.API_TIMEOUT_MS;
		} else {
			delete process.env.API_TIMEOUT_MS;
		}
		if (original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
			process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
				original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		} else {
			delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		}
		if (original.ANTHROPIC_DEFAULT_SONNET_MODEL !== undefined) {
			process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = original.ANTHROPIC_DEFAULT_SONNET_MODEL;
		} else {
			delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
		}
		if (original.ANTHROPIC_DEFAULT_HAIKU_MODEL !== undefined) {
			process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = original.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		} else {
			delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		}
		if (original.ANTHROPIC_DEFAULT_OPUS_MODEL !== undefined) {
			process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = original.ANTHROPIC_DEFAULT_OPUS_MODEL;
		} else {
			delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
		}
	}

	/**
	 * Check if GLM API key is available
	 * Used to determine if GLM models should be shown in the model list
	 */
	isGlmAvailable(): boolean {
		return this.isProviderAvailable('glm');
	}
}

// Singleton instance
let providerServiceInstance: ProviderService | null = null;

export function getProviderService(): ProviderService {
	if (!providerServiceInstance) {
		providerServiceInstance = new ProviderService();
	}
	return providerServiceInstance;
}
