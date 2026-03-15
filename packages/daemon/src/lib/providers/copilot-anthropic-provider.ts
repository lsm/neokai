/**
 * GitHub Copilot Anthropic Provider
 *
 * A NeoKai provider that starts an embedded Anthropic-compatible HTTP server
 * backed by the `@github/copilot-sdk`. The Claude Agent SDK is pointed at this
 * server via `ANTHROPIC_BASE_URL`, so Copilot becomes a fully native SDK
 * backend — multi-turn, streaming, tool use — with no custom generator bridging.
 *
 * ## How it differs from CopilotSdkProvider
 *
 * | Feature              | CopilotSdkProvider              | CopilotAnthropicProvider             |
 * |----------------------|---------------------------------|--------------------------------------|
 * | Integration point    | `createQuery()` generator       | `buildSdkConfig()` + embedded server |
 * | Claude Agent SDK     | Bypassed                        | Used natively                        |
 * | Tool use             | SDK-internal only               | Full SDK tool call cycle             |
 * | Extended thinking    | No                              | Passthrough (if Copilot supports)    |
 * | Server lifecycle     | None                            | One loopback server per provider     |
 *
 * ## Authentication
 *
 * Same credential sources as CopilotCliProvider and CopilotSdkProvider:
 * - `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`
 * - Stored `gh auth login` credentials
 *
 * ## Embedded server lifecycle
 *
 * The server is created lazily on the first `buildSdkConfig()` call and reused
 * for the lifetime of the provider instance (i.e. the daemon process). It binds
 * to `127.0.0.1:0` (OS-assigned port) and is never reachable from outside the
 * host.
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
import { CopilotClient } from '@github/copilot-sdk';
import { startEmbeddedServer, type EmbeddedServer } from './copilot-anthropic-server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('copilot-anthropic-provider');

/**
 * Bare model IDs also claimed by other providers. Excluded from `ownsModel()`
 * to avoid routing collisions. Use `copilot-anthropic-*` aliases to
 * explicitly route a query to this provider.
 *
 * - Claude IDs: also claimed by GitHubCopilotProvider (registered before this)
 * - gpt-5.3-codex, gpt-5-mini: also claimed by GitHubCopilotProvider (registered before this)
 */
const SHARED_MODEL_IDS = new Set([
	'claude-opus-4.6',
	'claude-sonnet-4.6',
	'gpt-5.3-codex',
	'gpt-5-mini',
]);

/**
 * GitHub Copilot Anthropic model definitions.
 * Aliases use the `copilot-anthropic-` prefix to avoid conflicts with
 * `CopilotCliProvider` (`copilot-cli-*`) and `CopilotSdkProvider` (`copilot-sdk-*`).
 */
const COPILOT_ANTHROPIC_MODELS: ModelInfo[] = [
	{
		id: 'claude-opus-4.6',
		name: 'Claude Opus 4.6 (Copilot)',
		alias: 'copilot-anthropic-opus',
		family: 'opus',
		provider: 'github-copilot-anthropic',
		contextWindow: 200000,
		description: 'Claude Opus 4.6 via GitHub Copilot · Native Claude Agent SDK',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'claude-sonnet-4.6',
		name: 'Claude Sonnet 4.6 (Copilot)',
		alias: 'copilot-anthropic-sonnet',
		family: 'sonnet',
		provider: 'github-copilot-anthropic',
		contextWindow: 200000,
		description: 'Claude Sonnet 4.6 via GitHub Copilot · Native Claude Agent SDK',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex (Copilot)',
		alias: 'copilot-anthropic-codex',
		family: 'gpt',
		provider: 'github-copilot-anthropic',
		contextWindow: 272000,
		description: 'GPT-5.3 Codex via GitHub Copilot · Best for coding',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		id: 'gemini-3-pro-preview',
		name: 'Gemini 3 Pro (Copilot)',
		alias: 'copilot-anthropic-gemini',
		family: 'gemini',
		provider: 'github-copilot-anthropic',
		contextWindow: 128000,
		description: 'Gemini 3 Pro Preview via GitHub Copilot',
		releaseDate: '2025-11-15',
		available: true,
	},
	{
		id: 'gpt-5-mini',
		name: 'GPT-5 Mini (Copilot)',
		alias: 'copilot-anthropic-mini',
		family: 'gpt',
		provider: 'github-copilot-anthropic',
		contextWindow: 128000,
		description: 'GPT-5 Mini via GitHub Copilot · Fast and efficient',
		releaseDate: '2025-12-01',
		available: true,
	},
];

export class CopilotAnthropicProvider implements Provider {
	readonly id = 'github-copilot-anthropic';
	readonly displayName = 'GitHub Copilot (Anthropic API)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 272000,
		// The embedded server ignores the `tools` array — the Copilot CLI runs its
		// own internal agentic loop and returns plain text. The Claude Agent SDK's
		// native tool loop is bypassed, so this must be false.
		functionCalling: false,
		vision: false,
	};

	/** Cached path to the `copilot` binary, or null if not found */
	private copilotPathCache: string | null | undefined = undefined;
	/** Singleton CopilotClient, created lazily */
	private clientCache: CopilotClient | undefined = undefined;
	/** Singleton embedded server, started lazily */
	private serverCache: EmbeddedServer | undefined = undefined;
	/** In-flight server start promise (prevents race on concurrent first calls) */
	private serverStarting: Promise<EmbeddedServer> | undefined = undefined;

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

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
		// Pre-warm the embedded server so buildSdkConfig() has a valid URL by
		// the time the user picks a model and starts a session.
		try {
			await this.ensureServerStarted();
		} catch (err) {
			logger.error('Failed to start embedded Anthropic server:', err);
			return [];
		}
		return COPILOT_ANTHROPIC_MODELS;
	}

	ownsModel(modelId: string): boolean {
		return COPILOT_ANTHROPIC_MODELS.some(
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

	/**
	 * Build SDK configuration for this provider.
	 *
	 * Returns env vars that point the Claude Agent SDK at the embedded server:
	 * - `ANTHROPIC_BASE_URL` → `http://127.0.0.1:<port>` (loopback server URL)
	 * - `ANTHROPIC_AUTH_TOKEN` → dummy token (server ignores auth on loopback)
	 * - `ANTHROPIC_DEFAULT_*_MODEL` → maps SDK tiers to Copilot model IDs
	 *
	 * **Precondition:** `getModels()` (or `ensureServerStarted()`) must be
	 * awaited before calling this method. The embedded server is started
	 * asynchronously in `getModels()`, which runs during provider initialisation
	 * before any session can be created. If the server has not been started yet
	 * this method throws rather than returning a silently-broken port-0 URL.
	 */
	buildSdkConfig(modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		if (!this.serverCache) {
			throw new Error(
				'CopilotAnthropicProvider: embedded server not started. ' +
					'Await getModels() or ensureServerStarted() before calling buildSdkConfig().'
			);
		}

		// Resolve alias → bare model ID
		const entry = COPILOT_ANTHROPIC_MODELS.find((m) => m.alias === modelId || m.id === modelId);
		const resolvedId = entry?.id ?? modelId;

		return {
			envVars: {
				ANTHROPIC_BASE_URL: this.serverCache.url,
				// Dummy key — the embedded server does not validate auth
				ANTHROPIC_AUTH_TOKEN: 'copilot-anthropic-proxy',
				// Disable SDK telemetry to the real Anthropic API
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				// Extended timeout (copilot can be slow on first response)
				API_TIMEOUT_MS: '300000',
				// Map SDK model tiers to the resolved Copilot model ID
				ANTHROPIC_DEFAULT_OPUS_MODEL:
					resolvedId === 'claude-opus-4.6' ? 'claude-opus-4.6' : 'claude-sonnet-4.6',
				ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedId,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5-mini',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/**
	 * Shut down the embedded HTTP server and the underlying CopilotClient
	 * subprocess. Called during daemon cleanup so the event loop can exit
	 * cleanly. Safe to call when the server/client was never started.
	 *
	 * **IMPORTANT — call after `sessionManager.cleanup()`.**
	 * The embedded HTTP server only closes once all existing connections are
	 * done. Active NeoKai sessions hold open SSE connections to this server;
	 * they must be terminated first (by sessionManager.cleanup()) before
	 * shutdown() is called, otherwise `serverCache.stop()` will block until
	 * those connections close on their own.
	 */
	async shutdown(): Promise<void> {
		if (this.serverCache) {
			await this.serverCache.stop().catch((err: unknown) => {
				logger.warn('Error stopping embedded Anthropic server:', err);
			});
			this.serverCache = undefined;
		}
		if (this.clientCache) {
			await this.clientCache.stop().catch((err: unknown) => {
				logger.warn('Error stopping CopilotClient:', err);
			});
			this.clientCache = undefined;
		}
	}

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

	/**
	 * Pre-warm: start the embedded server and return its URL.
	 * Safe to call concurrently — only one server is ever created.
	 */
	async ensureServerStarted(): Promise<string> {
		if (this.serverCache) return this.serverCache.url;

		if (!this.serverStarting) {
			this.serverStarting = this.createServer();
		}

		try {
			this.serverCache = await this.serverStarting;
		} catch (err) {
			// Clear the cached promise so the next call can retry.
			this.serverStarting = undefined;
			throw err;
		}
		return this.serverCache.url;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private async createServer(): Promise<EmbeddedServer> {
		const cliPath = await this.findCopilotCli();
		if (!cliPath) {
			throw new Error('GitHub Copilot CLI not found — cannot start embedded server');
		}
		const client = this.getOrCreateClient(cliPath);
		const server = await startEmbeddedServer(client);
		logger.debug(`Embedded Anthropic server started at ${server.url}`);
		return server;
	}

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

	private async isGhAuthenticated(): Promise<boolean> {
		try {
			await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	private resolveGitHubToken(): string | undefined {
		return this.env.COPILOT_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN || undefined;
	}

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
