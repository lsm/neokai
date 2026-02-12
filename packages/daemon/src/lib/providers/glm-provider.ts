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
	 * GLM-5 has 200K context window
	 */
	static readonly MODELS: ModelInfo[] = [
		{
			id: 'glm-5',
			name: 'GLM-5',
			alias: 'glm',
			family: 'glm',
			provider: 'glm',
			contextWindow: 200000,
			description: "GLM-5 · Zhipu AI's Next-Generation Frontier Model",
			releaseDate: '2026-02-11',
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
		return modelId === 'glm-5' || modelId.toLowerCase().startsWith('glm-');
	}

	/**
	 * Get model for a specific tier
	 * Maps Anthropic tiers to GLM models
	 * All tiers use glm-5 (flagship model)
	 */
	getModelForTier(_tier: ModelTier): string | undefined {
		// All tiers use glm-5
		return 'glm-5';
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
			// Map all Anthropic tiers to glm-5
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5',
			ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
		};

		return {
			envVars,
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/**
	 * Translate GLM model ID to SDK-compatible ID
	 *
	 * GLM model IDs (glm-5) are not recognized by the SDK.
	 * The SDK only knows Anthropic model IDs: default, opus, haiku.
	 *
	 * Translation:
	 * - glm-5 → default (flagship, balanced)
	 */
	translateModelIdForSdk(_modelId: string): string {
		return 'default'; // glm-5 uses 'default' (Sonnet tier)
	}

	/**
	 * Get the title generation model for GLM
	 * Uses glm-5
	 */
	getTitleGenerationModel(): string {
		return 'glm-5';
	}
}
