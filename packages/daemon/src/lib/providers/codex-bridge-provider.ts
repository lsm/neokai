/**
 * Codex Bridge Provider
 *
 * Starts a local HTTP server that speaks the Anthropic Messages API
 * (POST /v1/messages with SSE streaming) backed by `codex app-server`.
 *
 * The NeoKai Anthropic SDK talks to this bridge transparently — zero changes
 * to AgentSession or query-runner are required. The bridge intercepts Codex
 * tool calls via Dynamic Tools (experimentalApi: true) and forwards them to
 * the Anthropic SDK as `tool_use` content blocks, completing the round-trip
 * when the SDK sends back `tool_result` blocks.
 */

import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { type BridgeServer, createBridgeServer } from './codex-anthropic-bridge/server.js';
import { Logger } from '../logger.js';

const logger = new Logger('codex-bridge-provider');

// ---------------------------------------------------------------------------
// Codex model catalogue exposed by this provider
// ---------------------------------------------------------------------------

const CODEX_BRIDGE_MODELS: ModelInfo[] = [
	{
		id: 'codex-1',
		name: 'Codex 1',
		alias: 'codex-bridge',
		family: 'codex',
		provider: 'openai-codex-bridge',
		contextWindow: 200000,
		description: 'Codex 1 · Transparent Codex model via Anthropic-compatible bridge',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'o4-mini',
		name: 'o4-mini',
		alias: 'codex-mini',
		family: 'codex',
		provider: 'openai-codex-bridge',
		contextWindow: 128000,
		description: 'o4-mini · Fast Codex model via Anthropic-compatible bridge',
		releaseDate: '2025-01-01',
		available: true,
	},
];

// ---------------------------------------------------------------------------
// findCodexCli — locate the `codex` binary on PATH
// ---------------------------------------------------------------------------

function findCodexCli(codexPath = 'codex'): string | null {
	try {
		const result = Bun.spawnSync(['which', codexPath], { stderr: 'pipe' });
		if (result.exitCode === 0) {
			const found = result.stdout.toString().trim();
			return found.length > 0 ? found : codexPath;
		}
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// CodexBridgeProvider
// ---------------------------------------------------------------------------

export class CodexBridgeProvider implements Provider {
	readonly id = 'openai-codex-bridge';
	readonly displayName = 'OpenAI (Codex Bridge)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 200000,
		functionCalling: true,
		vision: false,
	};

	private bridgeServer: BridgeServer | null = null;

	isAvailable(): boolean {
		return !!((process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) && findCodexCli());
	}

	async getModels(): Promise<ModelInfo[]> {
		if (!this.isAvailable()) return [];
		return CODEX_BRIDGE_MODELS;
	}

	ownsModel(modelId: string): boolean {
		// Only owns models explicitly listed in our catalogue; never claims generic
		// model names that could belong to another provider (e.g. 'gpt-4o').
		return CODEX_BRIDGE_MODELS.some((m) => m.id === modelId);
	}

	getModelForTier(tier: ModelTier): string | undefined {
		const map: Record<ModelTier, string> = {
			sonnet: 'codex-1',
			haiku: 'o4-mini',
			opus: 'codex-1',
			default: 'codex-1',
		};
		return map[tier];
	}

	/**
	 * Build SDK configuration.
	 *
	 * Starts the bridge server on first call (lazy) and returns env vars that
	 * route the Anthropic SDK to the bridge's local HTTP endpoint.
	 */
	buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		if (!this.bridgeServer) {
			const codexBinaryPath = findCodexCli() ?? 'codex';
			const apiKey = process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? '';
			this.bridgeServer = createBridgeServer({
				codexBinaryPath,
				apiKey,
				cwd: process.cwd(),
			});
			logger.info(`CodexBridgeProvider: bridge server started on port ${this.bridgeServer.port}`);
		}

		return {
			envVars: {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.bridgeServer.port}`,
				ANTHROPIC_API_KEY: 'codex-bridge-placeholder',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/** Stop the bridge server. Called at provider shutdown (e.g. tests). */
	stopBridgeServer(): void {
		this.bridgeServer?.stop();
		this.bridgeServer = null;
	}
}
