/**
 * OpenAI Provider using Codex App Server (`codex app-server`)
 *
 * Unlike CodexCliProvider (which uses `codex exec` and cannot intercept tools),
 * this provider uses the long-lived `codex app-server` JSON-RPC daemon with the
 * Dynamic Tools API (experimentalApi: true). When the LLM wants to call a tool,
 * Codex sends an `item/tool/call` server request to NeoKai, which can execute it
 * via its own MCP handlers and return the result.
 *
 * This makes the Codex App Server a TRANSPARENT backend: NeoKai retains full
 * control over tool execution, approval, logging, and permission checks — just
 * like with the Claude Agent SDK.
 *
 * Current POC limitation: The `toolExecutor` callback is not yet wired from
 * AgentSession into this provider. Tool calls will fail gracefully with an error
 * response. The full integration requires threading the MCP tool executor from
 * packages/daemon/src/lib/agent/ into the provider's createQuery() call.
 *
 * For the fully autonomous (no tool interception) version, use CodexCliProvider.
 */

import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import { codexAppServerQueryGenerator } from './codex-app-server-adapter.js';
import { findCodexCli } from './codex-cli-adapter.js';
import { Logger } from '../logger.js';

const logger = new Logger('codex-app-server-provider');

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

/**
 * Codex App Server model list.
 *
 * NOTE (POC): These model IDs are illustrative placeholders based on the Codex CLI
 * documentation available as of March 2026. Actual available model IDs depend on the
 * installed Codex CLI version and OpenAI account subscription. Users should verify
 * available models via `codex model/list` or the Codex CLI documentation, and pass
 * the correct model ID explicitly when creating sessions with this provider.
 *
 * If an invalid model ID is passed to Codex App Server, the subprocess will exit with
 * a non-zero code and the adapter will yield an error result message.
 */
const CODEX_APP_SERVER_MODELS: ModelInfo[] = [
	{
		id: 'gpt-5.4',
		name: 'GPT-5.4',
		alias: 'codex-latest',
		family: 'codex',
		provider: 'openai-codex-app-server',
		contextWindow: 200000,
		description: 'GPT-5.4 · Latest Codex model',
		releaseDate: '2026-01-01',
		available: true,
	},
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex',
		alias: 'codex',
		family: 'codex',
		provider: 'openai-codex-app-server',
		contextWindow: 200000,
		description: 'GPT-5.3 Codex · Stable Codex model',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		id: 'gpt-5.1-codex',
		name: 'GPT-5.1 Codex',
		alias: 'codex-v1',
		family: 'codex',
		provider: 'openai-codex-app-server',
		contextWindow: 128000,
		description: 'GPT-5.1 Codex · Previous Codex model',
		releaseDate: '2025-06-01',
		available: true,
	},
];

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * CodexAppServerProvider — runs OpenAI Codex via the `codex app-server` JSON-RPC daemon.
 *
 * This provider is NOT auto-detected from model IDs (`ownsModel` returns false).
 * It must be explicitly selected in session configuration.
 */
export class CodexAppServerProvider implements Provider {
	readonly id = 'openai-codex-app-server';
	readonly displayName = 'OpenAI (Codex App Server)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 200000,
		functionCalling: true, // Tool interception via Dynamic Tools API
		vision: true,
	};

	/**
	 * Cached result of `findCodexCli()` to avoid repeated synchronous `which` syscalls.
	 * `undefined` = not yet resolved; `null` = resolved as not found; `string` = resolved path.
	 */
	private cachedCodexPath: string | null | undefined = undefined;

	constructor(private readonly env: Record<string, string | undefined> = process.env) {}

	/**
	 * Resolve the codex binary path, caching the result after the first call.
	 */
	private resolveCodexPath(): string | null {
		if (this.cachedCodexPath === undefined) {
			this.cachedCodexPath = findCodexCli();
		}
		return this.cachedCodexPath ?? null;
	}

	/**
	 * Provider is available when the codex binary exists on PATH and at least one
	 * supported API key is present in the environment.
	 */
	isAvailable(): boolean {
		const codexOnPath = this.resolveCodexPath() !== null;
		const hasApiKey = Boolean(this.env['OPENAI_API_KEY']) || Boolean(this.env['CODEX_API_KEY']);
		return codexOnPath && hasApiKey;
	}

	/**
	 * Return the model list when the provider is available, empty array otherwise.
	 */
	async getModels(): Promise<ModelInfo[]> {
		return this.isAvailable() ? CODEX_APP_SERVER_MODELS : [];
	}

	/**
	 * This provider is never auto-detected from a model ID.
	 * It must be explicitly configured in the session.
	 */
	ownsModel(_modelId: string): boolean {
		return false;
	}

	/**
	 * Map generic tiers to Codex model IDs.
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			opus: 'gpt-5.4',
			sonnet: 'gpt-5.3-codex',
			haiku: 'gpt-5.3-codex',
			default: 'gpt-5.4',
		};
		return tierMap[tier];
	}

	/**
	 * Codex App Server manages its own authentication — no SDK env vars needed.
	 */
	buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		return {
			envVars: {},
			isAnthropicCompatible: false,
		};
	}

	/**
	 * Create a custom query generator that delegates to Codex App Server.
	 * Returns null when codex is not available on PATH.
	 *
	 * NOTE (POC): `toolExecutor` is passed as `undefined` here. Full tool interception
	 * requires threading the MCP tool executor from AgentSession (packages/daemon/src/lib/agent/)
	 * into this createQuery() call. Until that wiring is in place, tool calls will fail
	 * gracefully with an error response sent back to the LLM.
	 */
	createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): AsyncGenerator<SDKMessage, void> | null {
		const codexPath = this.resolveCodexPath();
		if (!codexPath) {
			logger.warn(
				'Codex App Server not found on PATH. Install the OpenAI Codex CLI or set codexPath.'
			);
			return null;
		}

		const apiKey = this.env['OPENAI_API_KEY'] ?? this.env['CODEX_API_KEY'];
		if (!apiKey) {
			logger.warn(
				'No OPENAI_API_KEY or CODEX_API_KEY found. Codex App Server requires an API key.'
			);
			return null;
		}

		// Resolve model alias to canonical ID
		const modelEntry = CODEX_APP_SERVER_MODELS.find(
			(m) => m.id === options.model || m.alias === options.model
		);
		const canonicalModelId = modelEntry?.id ?? options.model;

		return codexAppServerQueryGenerator(
			prompt,
			{ ...options, model: canonicalModelId },
			context,
			{
				codexPath,
				model: canonicalModelId,
				apiKey,
			},
			// toolExecutor is undefined — see POC limitation note in file header
			undefined
		);
	}
}
