/**
 * Kimi Provider - Moonshot AI（月之暗面）
 *
 * Moonshot exposes an OpenAI-compatible API at https://api.moonshot.cn/v1.
 * NeoKai routes Claude Agent SDK Anthropic Messages requests through a small
 * local bridge that translates to OpenAI chat completions.
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
import { createKimiAnthropicBridgeServer, type KimiBridgeServer } from './kimi-bridge-server.js';

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/$/, '');
}

export class KimiProvider implements Provider {
	readonly id = 'kimi';
	readonly displayName = 'Kimi (Moonshot AI)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 131072,
		functionCalling: true,
		vision: false,
	};

	static readonly BASE_URL = 'https://api.moonshot.cn/v1';
	static readonly DEFAULT_MODEL = 'moonshot-v1-32k';

	static readonly MODELS: ModelInfo[] = [
		{
			id: 'moonshot-v1-8k',
			name: 'Moonshot v1 8K',
			alias: 'kimi-8k',
			family: 'kimi',
			provider: 'kimi',
			contextWindow: 8192,
			description: 'Kimi / Moonshot OpenAI-compatible chat model with 8K context',
			releaseDate: '',
			available: true,
		},
		{
			id: 'moonshot-v1-32k',
			name: 'Moonshot v1 32K',
			alias: 'kimi',
			family: 'kimi',
			provider: 'kimi',
			contextWindow: 32768,
			description: 'Kimi / Moonshot OpenAI-compatible chat model with 32K context',
			releaseDate: '',
			available: true,
		},
		{
			id: 'moonshot-v1-128k',
			name: 'Moonshot v1 128K',
			alias: 'kimi-128k',
			family: 'kimi',
			provider: 'kimi',
			contextWindow: 131072,
			description: 'Kimi / Moonshot OpenAI-compatible chat model with 128K context',
			releaseDate: '',
			available: true,
		},
	];

	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch;
	private readonly bridgeServers = new Map<string, KimiBridgeServer>();

	constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
		this.env = env;
		this.fetchImpl = fetchImpl;
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
		return id === 'kimi' || id.startsWith('moonshot-') || id.startsWith('kimi-');
	}

	getModelForTier(_tier: ModelTier): string | undefined {
		return KimiProvider.DEFAULT_MODEL;
	}

	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const apiKey = sessionConfig?.apiKey || this.getApiKey();
		if (!apiKey) {
			throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
		}

		const upstreamBaseUrl = normalizeBaseUrl(sessionConfig?.baseUrl || KimiProvider.BASE_URL);
		const bridge = this.getOrCreateBridge(upstreamBaseUrl, apiKey);
		const normalizedModelId = modelId.toLowerCase();
		const routingModelId =
			this.ownsModel(modelId) && normalizedModelId !== 'kimi'
				? modelId
				: KimiProvider.DEFAULT_MODEL;

		return {
			envVars: {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
				ANTHROPIC_AUTH_TOKEN: 'kimi-bridge',
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
		for (const bridge of this.bridgeServers.values()) bridge.stop();
		this.bridgeServers.clear();
	}

	private getOrCreateBridge(baseUrl: string, apiKey: string): KimiBridgeServer {
		const key = `${baseUrl}\u0000${apiKey}`;
		const existingBridge = this.bridgeServers.get(key);
		if (existingBridge) return existingBridge;
		const bridge = createKimiAnthropicBridgeServer({
			baseUrl,
			apiKey,
			fetchImpl: this.fetchImpl,
		});
		this.bridgeServers.set(key, bridge);
		return bridge;
	}
}
