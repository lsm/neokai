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
} from '@liuboer/shared/provider';
import type { ModelInfo } from '@liuboer/shared';

/**
 * GLM provider implementation
 */
export class GlmProvider implements Provider {
	readonly id = 'glm';
	readonly displayName = 'GLM (智谱AI)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false, // GLM doesn't support extended thinking
		maxContextWindow: 128000,
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
	 */
	static readonly MODELS: ModelInfo[] = [
		{
			id: 'glm-4.7',
			name: 'GLM-4.7',
			alias: 'glm',
			family: 'glm',
			provider: 'glm',
			contextWindow: 128000,
			description: 'GLM-4.7 · Best for coding and software development',
			releaseDate: '2024-10-01',
			available: true,
		},
		{
			id: 'glm-4.5-air',
			name: 'GLM-4.5-Air',
			alias: 'glm-air',
			family: 'glm',
			provider: 'glm',
			contextWindow: 128000,
			description: 'GLM-4.5-Air · Fast and efficient model',
			releaseDate: '2024-10-01',
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
		// GLM has two main models:
		// - glm-4.5-air: Fast model (maps to haiku tier)
		// - glm-4.7: Capable model (maps to sonnet/opus/default tiers)
		if (tier === 'haiku') {
			return 'glm-4.5-air';
		}
		return 'glm-4.7';
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
		if (modelId === 'glm-4.5-air') {
			envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
		} else {
			// glm-4.7 and other GLM models map to default (Sonnet) and Opus tiers
			envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
			envVars.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
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
	 * - glm-4.5-air → haiku (fast tier)
	 * - glm-4.7 → default (sonnet tier)
	 */
	translateModelIdForSdk(modelId: string): string {
		if (modelId === 'glm-4.5-air') {
			return 'haiku';
		}
		return 'default'; // All other GLM models use 'default' (Sonnet tier)
	}

	/**
	 * Get the title generation model for GLM
	 * Uses the faster glm-4.5-air model
	 */
	getTitleGenerationModel(): string {
		return 'glm-4.5-air';
	}
}
