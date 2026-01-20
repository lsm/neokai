/**
 * ProviderService - Provider operations and environment variable management
 *
 * This file serves two purposes:
 *
 * 1. **Compatibility Layer** - Delegates provider operations to the provider registry.
 *    The new provider system is in `packages/daemon/src/lib/providers/`.
 *    Methods like `getDefaultProvider()`, `detectProviderFromModel()`, etc. delegate to the registry.
 *
 * 2. **Process-level Environment Management** - Handles process.env manipulation.
 *    Methods like `applyEnvVarsToProcess()` and `restoreEnvVars()` modify process.env
 *    before SDK query creation. This is necessary because:
 *    - The SDK subprocess inherits environment variables when spawned
 *    - Provider-specific env vars (ANTHROPIC_BASE_URL, API keys) must be set in the parent process
 *    - This cannot be handled by ProviderContext or options.env alone
 *
 * ## User Settings Override Behavior
 *
 * When users configure custom env vars in ~/.Claude/settings.json:
 *
 * 1. **Non-provider env vars** (e.g., custom tool vars) are passed through to the SDK
 *    - Loaded via settingsManager.prepareSDKOptions()
 *    - Merged with session.config.env in query-options-builder.ts
 *    - Passed to SDK via options.env
 *
 * 2. **Provider-specific env vars** are managed by the provider system:
 *    - ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 *    - ANTHROPIC_DEFAULT_*_MODEL (tier mappings)
 *    - API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
 *    - These are filtered out from user settings
 *    - Applied to process.env by applyEnvVarsToProcess()
 *    - Always OVERRIDE user settings to ensure provider works correctly
 *
 * This ensures that when a user selects "glm-4.7" model:
 * - GLM's ANTHROPIC_BASE_URL points to GLM's endpoint (not user's custom Anthropic endpoint)
 * - GLM's API key is used (not user's Anthropic key)
 * - User's other custom env vars are still passed through
 *
 * Architecture:
 * - Provider registry (providers/) - Provider definitions, model lists, SDK config
 * - ProviderContext - Per-session provider configuration
 * - ProviderService (this file) - Process-level env var management + legacy API compatibility
 *
 * This file should NOT be removed - it provides essential process-level functionality
 * that cannot be moved to the provider registry.
 */

import type { Provider, ProviderInfo, Session } from '@liuboer/shared';
import type { ProviderSdkConfig, ProviderInfo as NewProviderInfo } from '@liuboer/shared/provider';
import { initializeProviders } from './providers/index.js';

/**
 * Convert new ProviderInfo to legacy ProviderInfo
 */
function toLegacyProviderInfo(newInfo: NewProviderInfo): ProviderInfo {
	return {
		id: newInfo.id as Provider,
		name: newInfo.name,
		baseUrl: undefined, // Legacy field, not used in new system
		models: newInfo.models,
		available: newInfo.available,
	};
}

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
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string; // Map haiku tier to provider model
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string; // Map default/sonnet tier to provider model
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string; // Map opus tier to provider model
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
 * Convert ProviderSdkConfig to ProviderEnvVars
 *
 * The new provider system returns ProviderSdkConfig with envVars and sdkOptions.
 * We need to convert this to the legacy ProviderEnvVars format.
 */
function sdkConfigToEnvVars(sdkConfig: ProviderSdkConfig): ProviderEnvVars {
	const envVars: ProviderEnvVars = { ...sdkConfig.envVars };

	// Add sdkOptions as ANTHROPIC_* env vars if they exist
	if (sdkConfig.sdkOptions) {
		for (const [key, value] of Object.entries(sdkConfig.sdkOptions)) {
			if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
				envVars[key as keyof ProviderEnvVars] = value;
			}
		}
	}

	return envVars;
}

export class ProviderService {
	/**
	 * Ensure provider system is initialized
	 */
	private getRegistry() {
		return initializeProviders();
	}

	/**
	 * Get the default provider based on environment configuration
	 *
	 * Delegates to registry.getDefaultProvider()
	 */
	async getDefaultProvider(): Promise<Provider> {
		const registry = this.getRegistry();
		const provider = await registry.getDefaultProvider();
		return provider.id as Provider;
	}

	/**
	 * Get API key for a specific provider from environment variables
	 *
	 * TODO: This should be replaced by checking provider.isAvailable()
	 * and using session.config.providerConfig.apiKey for overrides
	 */
	getProviderApiKey(providerId: Provider): string | undefined {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return undefined;
		}

		// Check provider-specific env vars
		if (providerId === 'anthropic') {
			return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;
		}
		if (providerId === 'glm') {
			return process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;
		}

		return undefined;
	}

	/**
	 * Check if a provider is available (has API key configured)
	 *
	 * Delegates to provider.isAvailable()
	 */
	async isProviderAvailable(providerId: Provider): Promise<boolean> {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return false;
		}

		return await provider.isAvailable();
	}

	/**
	 * Get provider information
	 *
	 * Delegates to registry.getProviderInfo()
	 */
	async getProviderInfo(providerId: Provider): Promise<ProviderInfo> {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return {
				id: providerId,
				name: providerId,
				baseUrl: undefined,
				models: [],
				available: false,
			};
		}

		const available = await provider.isAvailable();
		const models = await provider.getModels();

		// Build base URL from SDK config
		const sdkConfig = provider.buildSdkConfig(models[0]?.id || 'default');
		const baseUrl = Object.keys(sdkConfig.envVars).includes('ANTHROPIC_BASE_URL')
			? sdkConfig.envVars.ANTHROPIC_BASE_URL
			: undefined;

		return {
			id: provider.id as Provider,
			name: provider.displayName,
			baseUrl,
			models: models.map((m) => m.id),
			available,
		};
	}

	/**
	 * List all available providers (those with API keys configured)
	 *
	 * Delegates to registry.getProviderInfo()
	 */
	async getAvailableProviders(): Promise<ProviderInfo[]> {
		const registry = this.getRegistry();
		const newProviderInfos = await registry.getProviderInfo();
		return newProviderInfos.map(toLegacyProviderInfo);
	}

	/**
	 * Validate that a provider switch is possible
	 *
	 * Delegates to registry.validateProviderSwitch()
	 */
	async validateProviderSwitch(
		providerId: Provider,
		apiKey?: string
	): Promise<{ valid: boolean; error?: string }> {
		const registry = this.getRegistry();
		return await registry.validateProviderSwitch(providerId, apiKey);
	}

	/**
	 * Get the default model for a provider
	 */
	async getDefaultModelForProvider(providerId: Provider): Promise<string> {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return 'default';
		}

		const models = await provider.getModels();
		return models[0]?.id || 'default';
	}

	/**
	 * Get title generation configuration for a provider
	 * Returns the model ID, base URL, and API version to use for direct API calls
	 */
	async getTitleGenerationConfig(providerId: Provider): Promise<{
		modelId: string;
		baseUrl: string;
		apiVersion: string;
	}> {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			// Fallback to Anthropic
			return {
				modelId: 'haiku',
				baseUrl: 'https://api.anthropic.com',
				apiVersion: 'v1',
			};
		}

		const models = await provider.getModels();

		// Use haiku tier model for title generation (fast/cheap)
		const modelId = provider.getModelForTier('haiku') || models[0]?.id || 'default';

		// Get base URL from SDK config
		const sdkConfig = provider.buildSdkConfig(modelId);
		const baseUrl = sdkConfig.envVars.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

		// API version (currently all providers use v1)
		const apiVersion = sdkConfig.apiVersion || 'v1';

		return { modelId, baseUrl, apiVersion };
	}

	/**
	 * Check if a model is valid for a provider
	 */
	async isModelValidForProvider(providerId: Provider, model: string): Promise<boolean> {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider) {
			return false;
		}

		return provider.ownsModel(model);
	}

	/**
	 * Detect if a model ID belongs to GLM provider
	 *
	 * Delegates to registry.detectProvider()
	 */
	isGlmModel(modelId: string): boolean {
		const registry = this.getRegistry();
		const provider = registry.detectProvider(modelId);
		return provider?.id === 'glm';
	}

	/**
	 * Detect provider from model ID
	 *
	 * Delegates to registry.detectProvider()
	 */
	detectProviderFromModel(modelId: string): Provider {
		const registry = this.getRegistry();
		const provider = registry.detectProvider(modelId);
		return (provider?.id as Provider) || 'anthropic';
	}

	/**
	 * Translate a model ID to an SDK-recognized model ID
	 *
	 * Delegates to provider.translateModelIdForSdk()
	 */
	translateModelIdForSdk(modelId: string): string {
		const registry = this.getRegistry();
		const provider = registry.detectProvider(modelId);

		if (provider && provider.translateModelIdForSdk) {
			return provider.translateModelIdForSdk(modelId);
		}

		// Anthropic models pass through
		return modelId;
	}

	/**
	 * Get environment variables for SDK subprocess based on model ID
	 *
	 * Delegates to provider.buildSdkConfig()
	 */
	getEnvVarsForModel(modelId: string): ProviderEnvVars {
		const registry = this.getRegistry();
		const provider = registry.detectProvider(modelId);

		if (!provider || provider.id === 'anthropic') {
			return {};
		}

		const sdkConfig = provider.buildSdkConfig(modelId);
		return sdkConfigToEnvVars(sdkConfig);
	}

	/**
	 * Get environment variables for SDK subprocess based on session's provider
	 *
	 * Delegates to provider.buildSdkConfig() with session config
	 */
	getProviderEnvVars(session: Session): ProviderEnvVars {
		const registry = this.getRegistry();
		const providerId = session.config.provider || 'anthropic';
		const provider = registry.get(providerId);

		if (!provider || providerId === 'anthropic') {
			return {};
		}

		// Build SDK config with session override
		const sessionConfig = session.config.providerConfig
			? {
					apiKey: session.config.providerConfig.apiKey,
					baseUrl: session.config.providerConfig.baseUrl,
				}
			: undefined;

		const modelId = session.config.model || 'default';
		const sdkConfig = provider.buildSdkConfig(modelId, sessionConfig);
		return sdkConfigToEnvVars(sdkConfig);
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

		return this.applyEnvVars(envVars);
	}

	/**
	 * Apply provider environment variables to process.env with explicit provider
	 *
	 * This variant takes an explicit provider parameter instead of detecting from model ID.
	 * Use this when the model ID is a shorthand (like 'haiku') that doesn't identify the provider.
	 *
	 * @param providerId - The provider to get env vars for
	 * @param modelId - The model ID for setting tier mappings
	 * @returns Original env vars that should be restored after SDK query
	 */
	applyEnvVarsToProcessForProvider(providerId: Provider, modelId?: string): OriginalEnvVars {
		const registry = this.getRegistry();
		const provider = registry.get(providerId);

		if (!provider || providerId === 'anthropic') {
			return {};
		}

		const sessionConfig = modelId ? { apiKey: undefined } : undefined;
		const sdkConfig = provider.buildSdkConfig(modelId || 'default', sessionConfig);
		const envVars = sdkConfigToEnvVars(sdkConfig);

		return this.applyEnvVars(envVars);
	}

	/**
	 * Internal helper to apply env vars and save originals
	 */
	private applyEnvVars(envVars: ProviderEnvVars): OriginalEnvVars {
		const original: OriginalEnvVars = {};

		// Save and set each env var
		if (envVars.ANTHROPIC_AUTH_TOKEN !== undefined) {
			original.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
			process.env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_AUTH_TOKEN;
		}
		if (envVars.ANTHROPIC_API_KEY !== undefined) {
			// Save as ANTHROPIC_AUTH_TOKEN for consistency
			original.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
			process.env.ANTHROPIC_AUTH_TOKEN = envVars.ANTHROPIC_API_KEY;
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
	async isGlmAvailable(): Promise<boolean> {
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
