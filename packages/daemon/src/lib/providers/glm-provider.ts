/**
 * GLM Provider - Zhipu AI (智谱AI)
 *
 * This provider uses GLM's Anthropic-compatible API endpoint.
 * Requires environment variable mapping to work with the Claude Agent SDK.
 *
 * API Documentation: https://open.bigmodel.cn/dev/api
 */

import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';

/**
 * GLM provider implementation
 */
export class GlmProvider implements Provider {
	readonly id = 'glm';
	readonly displayName = 'GLM (智谱AI)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false, // GLM doesn't support extended thinking
		maxContextWindow: 200000,
		functionCalling: true,
		vision: true,
	};

	/**
	 * GLM API base URL (Anthropic-compatible endpoint)
	 */
	static readonly BASE_URL = 'https://open.bigmodel.cn/api/anthropic';

	/**
	 * Static model definitions for GLM
	 * These cannot be loaded dynamically from SDK
	 *
	 * All GLM-4.7 series models have 200K context window
	 * Source: https://llm-stats.com/models/glm-4.7
	 * Official docs: https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7
	 */
	static readonly MODELS: ModelInfo[] = [
		{
			id: 'glm-4.7',
			name: 'GLM-4.7',
			alias: 'glm',
			family: 'glm',
			provider: 'glm',
			contextWindow: 200000,
			description: 'GLM-4.7 · Coding-focused model for complex tasks',
			releaseDate: '2025-12-22',
			available: true,
		},
		{
			id: 'glm-4.7-FlashX',
			name: 'GLM-4.7-FlashX',
			alias: 'glm-flashx',
			family: 'glm',
			provider: 'glm',
			contextWindow: 200000,
			description: 'GLM-4.7-FlashX · Fast and efficient model',
			releaseDate: '2025-12-22',
			available: true,
		},
	];

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	/**
	 * Check if GLM is available
	 * Requires GLM_API_KEY or ZHIPU_API_KEY
	 */
	isAvailable(): boolean {
		return !!this.getApiKey();
	}

	/**
	 * Get API key from environment
	 * Supports both GLM_API_KEY and ZHIPU_API_KEY
	 */
	getApiKey(): string | undefined {
		return this.env.GLM_API_KEY || this.env.ZHIPU_API_KEY;
	}

	/**
	 * Get available models from GLM
	 * Returns static model list (GLM doesn't have dynamic model listing)
	 */
	async getModels(): Promise<ModelInfo[]> {
		// Only return models if API key is available
		return this.isAvailable() ? GlmProvider.MODELS : [];
	}

	/**
	 * Check if a model ID belongs to GLM
	 * GLM models start with 'glm-'
	 */
	ownsModel(modelId: string): boolean {
		return modelId.toLowerCase().startsWith('glm-');
	}

	/**
	 * Get model for a specific tier
	 * Maps Anthropic tiers to GLM models
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		// GLM model mapping by tier:
		// - haiku tier -> glm-4.7-FlashX (fastest)
		// - sonnet/default tiers -> glm-4.7 (flagship, balanced)
		// - opus tier -> glm-4.7 (most capable)
		if (tier === 'haiku') {
			return 'glm-4.7-FlashX';
		}
		return 'glm-4.7'; // sonnet, default, and opus use the main model
	}

	/**
	 * Build SDK configuration for GLM
	 *
	 * GLM requires environment variable overrides to work with the SDK:
	 * - ANTHROPIC_BASE_URL: Points to GLM's Anthropic-compatible endpoint
	 * - ANTHROPIC_AUTH_TOKEN: GLM API key
	 * - ANTHROPIC_DEFAULT_*_MODEL: Maps Anthropic tiers to GLM models
	 * - API_TIMEOUT_MS: Extended timeout for GLM (50 minutes)
	 * - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Disable telemetry
	 */
	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		// Get API key: session override > global env
		const apiKey = sessionConfig?.apiKey || this.getApiKey();
		if (!apiKey) {
			throw new Error('GLM API key not configured');
		}

		// Get base URL: session override > default
		const baseUrl = sessionConfig?.baseUrl || GlmProvider.BASE_URL;

		// Build environment variables
		const envVars: Record<string, string> = {
			ANTHROPIC_BASE_URL: baseUrl,
			ANTHROPIC_AUTH_TOKEN: apiKey,
			// Extended timeout for GLM (50 minutes)
			API_TIMEOUT_MS: '3000000',
			// Disable non-essential traffic (telemetry, etc.)
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		};

		// Map Anthropic tier IDs to GLM model IDs
		// When SDK uses 'haiku', 'default', or 'opus', translate to actual GLM model
		if (modelId === 'glm-4.7-FlashX') {
			envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.7-FlashX';
		} else {
			// glm-4.7 maps to all tiers (flagship model)
			envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.7';
			envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.7';
			envVars.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-4.7';
		}

		return {
			envVars,
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/**
	 * Translate GLM model ID to SDK-compatible ID
	 *
	 * GLM model IDs (glm-4.7, glm-4.5-air) are not recognized by the SDK.
	 * The SDK only knows Anthropic model IDs: default, opus, haiku.
	 *
	 * Translation:
	 * - glm-4.7-FlashX → haiku (fast tier)
	 * - glm-4.7 → default (flagship, balanced)
	 */
	translateModelIdForSdk(modelId: string): string {
		if (modelId === 'glm-4.7-FlashX') {
			return 'haiku';
		}
		return 'default'; // glm-4.7 uses 'default' (Sonnet tier)
	}

	/**
	 * Get the title generation model for GLM
	 * Uses the faster glm-4.7-FlashX model
	 */
	getTitleGenerationModel(): string {
		return 'glm-4.7-FlashX';
	}
}
