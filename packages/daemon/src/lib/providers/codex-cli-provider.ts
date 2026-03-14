/**
 * OpenAI Provider using Codex CLI (codex exec)
 *
 * Uses the OpenAI Codex CLI as an execution backend instead of direct API calls.
 * Codex CLI runs as a subprocess and handles tool execution autonomously.
 *
 * IMPORTANT: This provider delegates COMPLETE autonomous execution to Codex CLI.
 * It is NOT a transparent API passthrough. Tool calls defined in ProviderQueryOptions
 * are ignored — Codex uses its own built-in tools.
 *
 * Use cases:
 * - Delegating entire subtasks to Codex's autonomous agent
 * - Leveraging Codex's sandboxed execution environment
 * - Testing Codex capabilities within NeoKai's session framework
 *
 * For transparent model access with NeoKai tool control, use OpenAiProvider (pi-mono adapter).
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
import { codexExecQueryGenerator, findCodexCli } from './codex-cli-adapter.js';
import { Logger } from '../logger.js';

const logger = new Logger('codex-cli-provider');

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

/**
 * Codex CLI model list.
 *
 * NOTE (POC): These model IDs are illustrative placeholders based on the Codex CLI
 * documentation available as of March 2026. Actual available model IDs depend on the
 * installed Codex CLI version and OpenAI account subscription. Users should verify
 * available models via `codex model/list` or the Codex CLI documentation, and pass
 * the correct model ID explicitly when creating sessions with this provider.
 *
 * If an invalid model ID is passed to Codex CLI, the subprocess will exit with a
 * non-zero code and the adapter will yield an error result message.
 */
const CODEX_CLI_MODELS: ModelInfo[] = [
	{
		id: 'gpt-5.4',
		name: 'GPT-5.4',
		alias: 'codex-latest',
		family: 'codex',
		provider: 'openai-codex-cli',
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
		provider: 'openai-codex-cli',
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
		provider: 'openai-codex-cli',
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
 * CodexCliProvider — runs OpenAI Codex via the `codex exec` CLI subprocess.
 *
 * This provider is NOT auto-detected from model IDs (`ownsModel` returns false).
 * It must be explicitly selected in session configuration.
 */
export class CodexCliProvider implements Provider {
	readonly id = 'openai-codex-cli';
	readonly displayName = 'OpenAI (Codex CLI)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 200000,
		functionCalling: true, // Codex has its own built-in tool calling
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
		return this.cachedCodexPath;
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
		return this.isAvailable() ? CODEX_CLI_MODELS : [];
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
	 * Codex CLI manages its own authentication — no SDK env vars needed.
	 */
	buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		return {
			envVars: {},
			isAnthropicCompatible: false,
		};
	}

	/**
	 * Create a custom query generator that delegates to Codex CLI.
	 * Returns null when codex is not available on PATH.
	 */
	createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): AsyncGenerator<SDKMessage, void> | null {
		const codexPath = this.resolveCodexPath();
		if (!codexPath) {
			logger.warn('Codex CLI not found on PATH. Install the OpenAI Codex CLI or set codexPath.');
			return null;
		}

		const apiKey = this.env['OPENAI_API_KEY'] ?? this.env['CODEX_API_KEY'];
		if (!apiKey) {
			logger.warn('No OPENAI_API_KEY or CODEX_API_KEY found. Codex CLI requires an API key.');
			return null;
		}

		// Resolve model alias to canonical ID
		const modelEntry = CODEX_CLI_MODELS.find(
			(m) => m.id === options.model || m.alias === options.model
		);
		const canonicalModelId = modelEntry?.id ?? options.model;

		return codexExecQueryGenerator(prompt, { ...options, model: canonicalModelId }, context, {
			codexPath,
			model: canonicalModelId,
			apiKey,
			sandbox: 'workspace-write',
			approvalMode: 'never',
		});
	}
}
