/**
 * GitHub Copilot SDK Provider
 *
 * A NeoKai provider that uses @github/copilot-sdk as the backend. Unlike
 * `CopilotCliProvider` (which spawns a fresh subprocess per query via NDJSON),
 * this provider maintains a long-lived `CopilotClient` singleton that manages
 * the CLI subprocess lifecycle via JSON-RPC 2.0 over stdio.
 *
 * ## Comparison with CopilotCliProvider
 *
 * | Feature              | CopilotCliProvider              | CopilotSdkProvider                |
 * |----------------------|---------------------------------|-----------------------------------|
 * | Transport            | NDJSON one-shot subprocess      | JSON-RPC 2.0 over stdio (SDK)     |
 * | Session persistence  | `--resume <id>` CLI flag        | `client.resumeSession(id, cfg)`   |
 * | Client lifecycle     | New subprocess per query        | Singleton CopilotClient           |
 * | Tool streaming       | Parsed from NDJSON events       | Typed SDK event handlers          |
 * | Provider ID          | `github-copilot-cli`            | `github-copilot-sdk`              |
 *
 * ## Authentication
 *
 * Inherits credentials from the same sources as CopilotCliProvider:
 * - `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` env vars
 * - Stored `gh auth login` credentials
 *
 * ## Client Lifecycle
 *
 * The `CopilotClient` singleton is created lazily on the first `createQuery()`
 * call and reused across all subsequent queries. The `autoStart: true` option
 * (SDK default) starts the CLI subprocess on first use. The singleton is cached
 * per provider instance; when the daemon process exits, the subprocess is
 * cleaned up by the OS.
 *
 * @see packages/daemon/src/lib/providers/copilot-sdk-adapter.ts
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
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import { CopilotClient } from '@github/copilot-sdk';
import { copilotSdkQueryGenerator } from './copilot-sdk-adapter.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('copilot-sdk-provider');

/**
 * Model IDs also available through GitHubCopilotProvider (direct API) and
 * CopilotCliProvider. Excluded from ownsModel() to prevent routing ambiguity
 * when a user selects by bare model ID. Use `copilot-sdk-*` aliases instead.
 */
const SHARED_MODEL_IDS = new Set(['claude-opus-4.6', 'claude-sonnet-4.6']);

/**
 * GitHub Copilot SDK model definitions.
 *
 * Model IDs match the values accepted by the `copilot` CLI's `--model` flag.
 * Aliases use the `copilot-sdk-` prefix to avoid conflicts with
 * `CopilotCliProvider` aliases (`copilot-cli-*`).
 */
const COPILOT_SDK_MODELS: ModelInfo[] = [
	{
		id: 'claude-opus-4.6',
		name: 'Claude Opus 4.6 (Copilot SDK)',
		alias: 'copilot-sdk-opus',
		family: 'opus',
		provider: 'github-copilot-sdk',
		contextWindow: 200000,
		description: 'Claude Opus 4.6 via GitHub Copilot SDK · Most capable',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'claude-sonnet-4.6',
		name: 'Claude Sonnet 4.6 (Copilot SDK)',
		alias: 'copilot-sdk-sonnet',
		family: 'sonnet',
		provider: 'github-copilot-sdk',
		contextWindow: 200000,
		description: 'Claude Sonnet 4.6 via GitHub Copilot SDK · Balanced',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex (Copilot SDK)',
		alias: 'copilot-sdk-codex',
		family: 'gpt',
		provider: 'github-copilot-sdk',
		contextWindow: 272000,
		description: 'GPT-5.3 Codex via GitHub Copilot SDK · Best for coding',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		id: 'gemini-3-pro-preview',
		name: 'Gemini 3 Pro (Copilot SDK)',
		alias: 'copilot-sdk-gemini',
		family: 'gemini',
		provider: 'github-copilot-sdk',
		contextWindow: 128000,
		description: 'Gemini 3 Pro Preview via GitHub Copilot SDK',
		releaseDate: '2025-11-15',
		available: true,
	},
	{
		id: 'gpt-5-mini',
		name: 'GPT-5 Mini (Copilot SDK)',
		alias: 'copilot-sdk-mini',
		family: 'gpt',
		provider: 'github-copilot-sdk',
		contextWindow: 128000,
		description: 'GPT-5 Mini via GitHub Copilot SDK · Fast and efficient',
		releaseDate: '2025-12-01',
		available: true,
	},
];

export class CopilotSdkProvider implements Provider {
	readonly id = 'github-copilot-sdk';
	readonly displayName = 'GitHub Copilot (SDK)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 272000, // Max across all supported models
		// functionCalling is false: tool execution is autonomous within the SDK/CLI.
		// NeoKai cannot inject tool definitions or intercept tool callbacks.
		functionCalling: false,
		vision: false,
	};

	/** Cached path to the `copilot` binary, or null if not found */
	private copilotPathCache: string | null | undefined = undefined;
	/** Singleton CopilotClient, created lazily on first query */
	private clientCache: CopilotClient | undefined = undefined;

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	/**
	 * Returns true if the `copilot` binary is on PATH and the user is
	 * authenticated (via token env var or `gh auth login`).
	 */
	async isAvailable(): Promise<boolean> {
		const path = await this.findCopilotCli();
		if (!path) return false;

		if (this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN) {
			return true;
		}

		return this.isGhAuthenticated();
	}

	async getModels(): Promise<ModelInfo[]> {
		if (!(await this.isAvailable())) return [];
		return COPILOT_SDK_MODELS;
	}

	ownsModel(modelId: string): boolean {
		// Aliases (copilot-sdk-*) are always unique to this provider.
		// Bare model IDs shared with other providers are excluded to prevent
		// routing collisions in detectProvider() lookups.
		return COPILOT_SDK_MODELS.some(
			(m) => m.alias === modelId || (m.id === modelId && !SHARED_MODEL_IDS.has(m.id))
		);
	}

	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			opus: 'claude-opus-4.6',
			sonnet: 'claude-sonnet-4.6',
			haiku: 'gpt-5-mini',
			default: 'claude-sonnet-4.6',
		};
		return tierMap[tier];
	}

	/** Not used — this provider always uses createQuery() */
	buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		return { envVars: {}, isAnthropicCompatible: false };
	}

	/**
	 * Create a Copilot SDK query generator.
	 *
	 * Returns null if:
	 * - The `copilot` binary is not found on PATH
	 * - The user is not authenticated
	 * - The CopilotClient cannot be initialized
	 */
	async createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): Promise<AsyncGenerator<SDKMessage, void> | null> {
		const copilotPath = await this.findCopilotCli();
		if (!copilotPath) {
			logger.warn(
				'GitHub Copilot CLI not found on PATH. Install: gh extension install github/copilot'
			);
			return null;
		}

		if (!(await this.isAvailable())) {
			logger.warn(
				'GitHub Copilot CLI not authenticated. Run `gh auth login` or set COPILOT_GITHUB_TOKEN.'
			);
			return null;
		}

		const client = this.getOrCreateClient(copilotPath);
		if (!client) return null;

		// Resolve model alias → CLI model ID
		const modelEntry = COPILOT_SDK_MODELS.find(
			(m) => m.id === options.model || m.alias === options.model
		);
		const cliModelId = modelEntry?.id ?? options.model;

		return copilotSdkQueryGenerator(prompt, options, context, {
			client,
			model: cliModelId,
			cwd: options.cwd,
		});
	}

	/**
	 * Get auth status for display in the UI settings panel.
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		const path = await this.findCopilotCli();
		if (!path) {
			return {
				isAuthenticated: false,
				error: 'GitHub Copilot CLI not installed. Run: gh extension install github/copilot',
			};
		}

		if (this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN) {
			return { isAuthenticated: true, needsRefresh: false };
		}

		const isAuth = await this.isGhAuthenticated();
		if (!isAuth) {
			return {
				isAuthenticated: false,
				error: 'Not authenticated. Run `gh auth login` or set COPILOT_GITHUB_TOKEN.',
			};
		}

		return { isAuthenticated: true, needsRefresh: false };
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Locate the `copilot` binary on PATH. Result is cached after the first call.
	 */
	private async findCopilotCli(): Promise<string | null> {
		if (this.copilotPathCache !== undefined) return this.copilotPathCache;

		try {
			const cmd = process.platform === 'win32' ? 'where' : 'which';
			const { stdout } = await execFileAsync(cmd, ['copilot']);
			const found = stdout.trim().split('\n')[0];
			this.copilotPathCache = found || null;
		} catch {
			this.copilotPathCache = null;
		}

		logger.debug(`Copilot CLI path: ${this.copilotPathCache ?? 'not found'}`);
		return this.copilotPathCache;
	}

	/**
	 * Check whether `gh` CLI is authenticated.
	 */
	private async isGhAuthenticated(): Promise<boolean> {
		try {
			await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Return the highest-precedence GitHub token available, or undefined.
	 */
	private resolveGitHubToken(): string | undefined {
		return this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN || undefined;
	}

	/**
	 * Return the singleton CopilotClient, creating it on first call.
	 *
	 * The client uses `cliPath` to run the system `copilot` binary (no bundled
	 * `@github/copilot` package required). `autoStart: true` (SDK default) means
	 * the CLI subprocess starts on first `createSession()` call.
	 */
	private getOrCreateClient(cliPath: string): CopilotClient {
		if (this.clientCache === undefined) {
			this.clientCache = new CopilotClient({
				cliPath,
				useStdio: true,
				logLevel: 'error',
				githubToken: this.resolveGitHubToken(),
			});
			logger.debug(`Created CopilotClient with cliPath=${cliPath}`);
		}
		return this.clientCache;
	}
}
