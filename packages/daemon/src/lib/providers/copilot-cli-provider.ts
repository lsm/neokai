/**
 * GitHub Copilot CLI Provider
 *
 * A NeoKai provider that uses the `copilot` CLI binary as a transparent backend,
 * enabling access to GitHub Copilot models (Claude, GPT, Gemini) without managing
 * API keys directly.
 *
 * ## Key Difference from GitHubCopilotProvider
 *
 * - `GitHubCopilotProvider` (id: 'github-copilot'): Uses pi-agent-core to make
 *   direct API calls to the Copilot API with OAuth token exchange.
 * - `CopilotCliProvider` (id: 'github-copilot-cli'): Spawns the `copilot` CLI
 *   binary as a subprocess and communicates via NDJSON.
 *
 * ## Models
 *
 * Exposes the same models as GitHubCopilotProvider but routes them through
 * the CLI instead of direct API calls. Model IDs match CLI's `--model` flag values.
 *
 * ## Authentication
 *
 * Uses existing `gh` CLI credentials or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` /
 * `GITHUB_TOKEN` environment variables. No separate OAuth flow needed if
 * `gh auth login` has been completed.
 *
 * @see docs/reports/copilot-cli-capabilities.md
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
import { copilotCliQueryGenerator } from './copilot-cli-adapter.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('copilot-cli-provider');

/**
 * GitHub Copilot CLI model definitions.
 *
 * Model IDs match the `--model` flag values accepted by the `copilot` binary.
 */
/**
 * Model IDs shared with GitHubCopilotProvider.
 *
 * Both providers expose these Anthropic models, but GitHubCopilotProvider (id:
 * 'github-copilot') is registered first in the registry and wins in detectProvider()
 * lookups. To prevent the CLI provider from shadowing the API-based provider when a
 * user selects 'claude-sonnet-4.6' without specifying a provider, ownsModel() does
 * NOT claim these IDs. Users select them via alias (e.g., 'copilot-cli-sonnet') to
 * explicitly route through the CLI.
 */
const SHARED_WITH_GITHUB_COPILOT = new Set(['claude-opus-4.6', 'claude-sonnet-4.6']);

const COPILOT_CLI_MODELS: ModelInfo[] = [
	{
		id: 'claude-opus-4.6',
		name: 'Claude Opus 4.6 (Copilot CLI)',
		alias: 'copilot-cli-opus',
		family: 'opus',
		provider: 'github-copilot-cli',
		contextWindow: 200000,
		description: 'Claude Opus 4.6 via GitHub Copilot CLI · Most capable',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'claude-sonnet-4.6',
		name: 'Claude Sonnet 4.6 (Copilot CLI)',
		alias: 'copilot-cli-sonnet',
		family: 'sonnet',
		provider: 'github-copilot-cli',
		contextWindow: 200000,
		description: 'Claude Sonnet 4.6 via GitHub Copilot CLI · Balanced',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex (Copilot CLI)',
		alias: 'copilot-cli-codex',
		family: 'gpt',
		provider: 'github-copilot-cli',
		contextWindow: 272000,
		description: 'GPT-5.3 Codex via GitHub Copilot CLI · Best for coding',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		id: 'gemini-3-pro-preview',
		name: 'Gemini 3 Pro (Copilot CLI)',
		alias: 'copilot-cli-gemini',
		family: 'gemini',
		provider: 'github-copilot-cli',
		contextWindow: 128000,
		description: 'Gemini 3 Pro Preview via GitHub Copilot CLI',
		releaseDate: '2025-11-15',
		available: true,
	},
	{
		id: 'gpt-5-mini',
		name: 'GPT-5 Mini (Copilot CLI)',
		alias: 'copilot-cli-mini',
		family: 'gpt',
		provider: 'github-copilot-cli',
		contextWindow: 128000,
		description: 'GPT-5 Mini via GitHub Copilot CLI · Fast and efficient',
		releaseDate: '2025-12-01',
		available: true,
	},
];

export class CopilotCliProvider implements Provider {
	readonly id = 'github-copilot-cli';
	readonly displayName = 'GitHub Copilot (CLI)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 272000, // Max across all supported models
		// functionCalling is false: the CLI executes tools autonomously; NeoKai cannot
		// define tools, receive tool callbacks, or intercept tool executions. Setting
		// this to true would mislead any code that gates behavior on this capability.
		functionCalling: false,
		vision: false, // Not supported in NDJSON mode (v1.0.2)
	};

	/** Cached result of binary availability check */
	private copilotPathCache: string | null | undefined = undefined;

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	/**
	 * Returns true if the `copilot` binary is available on PATH and the user
	 * is authenticated (has COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or
	 * stored credentials from `gh auth`).
	 */
	async isAvailable(): Promise<boolean> {
		const path = await this.findCopilotCli();
		if (!path) return false;

		// If an explicit token is configured, we're good
		if (this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN) {
			return true;
		}

		// Otherwise check gh auth status
		return this.isGhAuthenticated();
	}

	async getModels(): Promise<ModelInfo[]> {
		if (!(await this.isAvailable())) return [];
		return COPILOT_CLI_MODELS;
	}

	ownsModel(modelId: string): boolean {
		// Aliases are always unique to this provider (e.g., 'copilot-cli-opus').
		// Shared model IDs (claude-opus-4.6, claude-sonnet-4.6) are excluded here to
		// prevent collision with GitHubCopilotProvider in detectProvider() routing.
		return COPILOT_CLI_MODELS.some(
			(m) => m.alias === modelId || (m.id === modelId && !SHARED_WITH_GITHUB_COPILOT.has(m.id))
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
	 * Create a Copilot CLI query generator.
	 *
	 * Returns null if:
	 * - The `copilot` binary is not found on PATH
	 * - The user is not authenticated
	 */
	async createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): Promise<AsyncGenerator<SDKMessage, void> | null> {
		// Single availability check covers both binary detection and auth verification.
		// findCopilotCli() result is cached after the first call.
		if (!(await this.isAvailable())) {
			const copilotPath = await this.findCopilotCli();
			if (!copilotPath) {
				logger.warn(
					'GitHub Copilot CLI not found on PATH. Install from: https://github.com/github/copilot-cli'
				);
			} else {
				logger.warn(
					'GitHub Copilot CLI not authenticated. Run `gh auth login` or set COPILOT_GITHUB_TOKEN.'
				);
			}
			return null;
		}

		const copilotPath = (await this.findCopilotCli())!;

		// Resolve model alias to CLI model ID
		const modelEntry = COPILOT_CLI_MODELS.find(
			(m) => m.id === options.model || m.alias === options.model
		);
		const cliModelId = modelEntry?.id ?? options.model;

		return copilotCliQueryGenerator(prompt, options, context, {
			copilotPath,
			model: cliModelId,
			githubToken: this.resolveGitHubToken(),
			cwd: options.cwd,
		});
	}

	/**
	 * Get auth status for display in the UI.
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
	 * Find the `copilot` binary on PATH.
	 *
	 * Result is cached after the first call to avoid repeated disk checks.
	 */
	private async findCopilotCli(): Promise<string | null> {
		if (this.copilotPathCache !== undefined) {
			return this.copilotPathCache;
		}

		try {
			// Use `which` on Unix or `where` on Windows to locate the binary
			const cmd = process.platform === 'win32' ? 'where' : 'which';
			const { stdout } = await execFileAsync(cmd, ['copilot']);
			const path = stdout.trim().split('\n')[0];
			this.copilotPathCache = path || null;
		} catch {
			this.copilotPathCache = null;
		}

		logger.debug(`Copilot CLI path: ${this.copilotPathCache ?? 'not found'}`);
		return this.copilotPathCache;
	}

	/**
	 * Check if `gh` CLI is authenticated.
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
	 * Resolve the GitHub token to pass to the CLI subprocess.
	 *
	 * Returns the highest-precedence available token, or undefined if none.
	 */
	private resolveGitHubToken(): string | undefined {
		return this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN || undefined;
	}
}
