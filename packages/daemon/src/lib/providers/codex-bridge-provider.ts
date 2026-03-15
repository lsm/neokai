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
 *
 * Workspace isolation: each unique workspace path gets its own bridge server
 * so that Codex is always rooted at the correct directory.  The bridge server
 * is created lazily on first use and reused for subsequent turns in the same
 * workspace.
 */

import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
	ProviderAuthStatusInfo,
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

	/** Per-workspace bridge servers — keyed by absolute workspace path. */
	private readonly bridgeServers = new Map<string, BridgeServer>();

	isAvailable(): boolean {
		return !!((process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) && findCodexCli());
	}

	/**
	 * Return authentication status for the CodexBridgeProvider.
	 *
	 * The provider requires one of OPENAI_API_KEY / CODEX_API_KEY and the
	 * `codex` binary to be present on PATH.  Unlike Anthropic or GLM, it does
	 * NOT require Anthropic credentials, so QueryRunner's fallback Anthropic/GLM
	 * check must not fire for this provider — implementing getAuthStatus() here
	 * causes QueryRunner to use this method instead of the fallback.
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		const hasKey = !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
		if (!hasKey) {
			return {
				isAuthenticated: false,
				error: 'OPENAI_API_KEY or CODEX_API_KEY is required for the Codex Bridge provider.',
			};
		}
		const codexPath = findCodexCli();
		if (!codexPath) {
			return {
				isAuthenticated: false,
				error: 'codex binary not found on PATH. Install Codex CLI to use this provider.',
			};
		}
		return { isAuthenticated: true, method: 'api_key' };
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
	 * Lazily starts a per-workspace bridge server and returns env vars that
	 * route the Anthropic SDK to that bridge's local HTTP endpoint.
	 *
	 * Using per-workspace servers (keyed by workspacePath) ensures Codex is
	 * always rooted in the correct directory and prevents cross-session
	 * contamination when multiple sessions target different workspaces.
	 */
	buildSdkConfig(_modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const workspace = sessionConfig?.workspacePath ?? process.cwd();
		let bridgeServer = this.bridgeServers.get(workspace);

		if (!bridgeServer) {
			const codexBinaryPath = findCodexCli() ?? 'codex';
			const apiKey = process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? '';
			bridgeServer = createBridgeServer({
				codexBinaryPath,
				apiKey,
				cwd: workspace,
			});
			this.bridgeServers.set(workspace, bridgeServer);
			logger.info(
				`CodexBridgeProvider: bridge server started on port ${bridgeServer.port} for workspace=${workspace}`
			);
		}

		return {
			envVars: {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridgeServer.port}`,
				ANTHROPIC_API_KEY: 'codex-bridge-placeholder',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/** Stop all bridge servers. Called at provider shutdown (e.g. tests). */
	stopAllBridgeServers(): void {
		for (const server of this.bridgeServers.values()) {
			server.stop();
		}
		this.bridgeServers.clear();
	}

	/** @deprecated Use stopAllBridgeServers(). Retained for backwards compatibility. */
	stopBridgeServer(): void {
		this.stopAllBridgeServers();
	}
}
