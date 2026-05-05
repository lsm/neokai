/**
 * Kimi Provider - Moonshot AI（月之暗面）
 *
 * Kimi exposes a native Anthropic-compatible API at
 * https://api.kimi.com/coding — designed specifically for coding agents.
 *
 * No bridge server or protocol translation is needed — the Anthropic SDK
 * communicates directly with Kimi's Anthropic-compatible endpoint.
 *
 * API Documentation: https://platform.kimi.com/docs
 */

import type {
	Provider,
	ProviderAuthStatusInfo,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/$/, '');
}

export class KimiProvider implements Provider {
	readonly id = 'kimi';
	readonly displayName = 'Kimi (Moonshot AI)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 262144,
		functionCalling: true,
		vision: false,
	};

	/** Default Anthropic-compatible base URL (Kimi For Coding). */
	static readonly BASE_URL = 'https://api.kimi.com/coding';
	/** Moonshot platform Anthropic-compatible base URL (China region). */
	static readonly BASE_URL_MOONSHOT_CN = 'https://api.moonshot.cn/anthropic';
	/** Moonshot platform Anthropic-compatible base URL (international). */
	static readonly BASE_URL_MOONSHOT_AI = 'https://api.moonshot.ai/anthropic';
	static readonly DEFAULT_MODEL = 'kimi-k2.5';

	static readonly MODELS: ModelInfo[] = [
		{
			id: 'kimi-k2',
			name: 'Kimi K2',
			alias: 'kimi',
			family: 'kimi',
			provider: 'kimi',
			contextWindow: 131072,
			description: 'Kimi K2 open frontier model with 128K context',
			releaseDate: '',
			available: true,
		},
		{
			id: 'kimi-k2.5',
			name: 'Kimi K2.5',
			alias: 'kimi-k25',
			family: 'kimi',
			provider: 'kimi',
			contextWindow: 262144,
			description: 'Kimi K2.5 trillion-parameter model with 256K context',
			releaseDate: '',
			available: true,
		},
		{
			id: 'kimi-k2.6',
			name: 'Kimi K2.6',
			alias: 'kimi-k26',
			family: 'kimi',
			provider: 'kimi',
			contextWindow: 262144,
			description: 'Kimi K2.6 latest model with Agent Swarm support',
			releaseDate: '',
			available: true,
		},
	];

	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
	}

	isAvailable(): boolean {
		return !!this.getApiKey();
	}

	getApiKey(): string | undefined {
		return this.env.KIMI_API_KEY?.trim() || this.env.MOONSHOT_API_KEY?.trim() || undefined;
	}

	async getModels(): Promise<ModelInfo[]> {
		return this.isAvailable() ? KimiProvider.MODELS : [];
	}

	ownsModel(modelId: string): boolean {
		const id = modelId.toLowerCase();
		return id === 'kimi' || id.startsWith('kimi-') || id.startsWith('moonshot-');
	}

	getModelForTier(_tier: ModelTier): string | undefined {
		return KimiProvider.DEFAULT_MODEL;
	}

	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const apiKey = sessionConfig?.apiKey || this.getApiKey();
		if (!apiKey) {
			throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
		}

		const baseUrl = normalizeBaseUrl(sessionConfig?.baseUrl || KimiProvider.BASE_URL);
		const normalizedModelId = modelId.toLowerCase();
		const routingModelId =
			this.ownsModel(modelId) && normalizedModelId !== 'kimi'
				? normalizedModelId
				: KimiProvider.DEFAULT_MODEL;

		return {
			envVars: {
				ANTHROPIC_BASE_URL: baseUrl,
				ANTHROPIC_AUTH_TOKEN: apiKey,
				ANTHROPIC_API_KEY: '',
				API_TIMEOUT_MS: '3000000',
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
				ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
				ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	translateModelIdForSdk(_modelId: string): string {
		return 'default';
	}

	getTitleGenerationModel(): string {
		return KimiProvider.DEFAULT_MODEL;
	}

	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		const apiKey = this.getApiKey();
		return {
			isAuthenticated: !!apiKey,
			method: 'api_key',
			error: apiKey ? undefined : 'Set KIMI_API_KEY or MOONSHOT_API_KEY to enable Kimi models.',
		};
	}

	async shutdown(): Promise<void> {
		// No resources to clean up — direct API connection, no bridge server.
	}
}
