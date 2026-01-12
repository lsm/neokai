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

/**
 * Environment variables to pass to SDK subprocess for provider routing
 */
export interface ProviderEnvVars {
	ANTHROPIC_BASE_URL?: string;
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_AUTH_TOKEN?: string;
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
	// GLM-specific: map Anthropic model aliases to GLM models
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
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
}

/**
 * Static provider definitions
 */
const PROVIDER_DEFINITIONS: Record<Provider, ProviderDefinition> = {
	anthropic: {
		id: 'anthropic',
		name: 'Anthropic',
		baseUrl: undefined, // Use SDK default
		models: ['default', 'opus', 'haiku', 'sonnet'],
		envKeyNames: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
	},
	glm: {
		id: 'glm',
		name: 'GLM (智谱AI)',
		baseUrl: 'https://open.bigmodel.cn/api/anthropic',
		models: ['glm-4.7'],
		envKeyNames: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
	},
};

export class ProviderService {
	/**
	 * Get the default provider based on environment configuration
	 * Returns 'anthropic' unless DEFAULT_PROVIDER is set to 'glm'
	 */
	getDefaultProvider(): Provider {
		const defaultProvider = process.env.DEFAULT_PROVIDER;
		if (defaultProvider === 'glm') {
			return 'glm';
		}
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

		return {
			ANTHROPIC_BASE_URL: definition.baseUrl,
			ANTHROPIC_API_KEY: apiKey,
			// ANTHROPIC_AUTH_TOKEN: apiKey,
			API_TIMEOUT_MS: '3000000',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
			// Map Anthropic model aliases to GLM models
			// ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
			// ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
			// ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
		};
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
