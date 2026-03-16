/**
 * GitHub Copilot Anthropic Provider
 *
 * A NeoKai provider that starts an embedded Anthropic-compatible HTTP server
 * backed by the `@github/copilot-sdk`.  The Claude Agent SDK is pointed at
 * this server via `ANTHROPIC_BASE_URL`, so Copilot becomes a fully native SDK
 * backend — multi-turn, streaming, and tool use — with no custom generator
 * bridging.
 *
 * ## How it works
 *
 * The embedded server implements the Anthropic messages API (`POST /v1/messages`).
 * Incoming tool definitions are registered as Copilot SDK external tools.
 * When the Copilot model decides to call one of them the server emits an
 * Anthropic `tool_use` SSE block, ends the response, and suspends the session.
 * The next request (with `tool_result`) resumes the session via the
 * `ConversationManager`.
 *
 * ## Authentication
 *
 * Credential sources (in priority order):
 *   - `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`
 *   - Stored `gh auth login` credentials
 *
 * ## Embedded server lifecycle
 *
 * The server is created lazily on the first `buildSdkConfig()` call and reused
 * for the lifetime of the provider instance (i.e. the daemon process).  It
 * binds to `127.0.0.1:0` (OS-assigned port) and is never reachable from
 * outside the host.
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
import { startEmbeddedServer, type EmbeddedServer } from './server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../../logger.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('copilot-anthropic-provider');

/**
 * Bare model IDs also claimed by other providers.  Excluded from `ownsModel()`
 * to avoid routing collisions.  Use `copilot-anthropic-*` aliases to
 * explicitly route a query to this provider.
 */
const SHARED_MODEL_IDS = new Set([
	'claude-opus-4.6',
	'claude-sonnet-4.6',
	'gpt-5.3-codex',
	'gpt-5-mini',
]);

/**
 * GitHub Copilot Anthropic model definitions.
 * Aliases use the `copilot-anthropic-` prefix to avoid collisions with other
 * Copilot-backed providers.
 *
 * These model IDs are the identifiers the GitHub Copilot backend recognises
 * and must be passed verbatim to `CopilotClient.createSession({ model })`.
 * They mirror the IDs in `github-copilot-provider.ts` (`GITHUB_COPILOT_MODELS`)
 * which is the authoritative reference for what the Copilot CLI accepts.
 * The one intentional divergence is `gemini-3-pro-preview` vs the CLI provider's
 * `gemini-3.1-pro-preview` — see the inline comment for the rationale.
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
		// Intentionally "gemini-3-pro-preview" (not "gemini-3.1-pro-preview").
		// GitHubCopilotProvider uses "gemini-3.1-pro-preview" as its model ID
		// because that provider passes the ID directly to the Copilot CLI.
		// This provider passes the ID as a hint to the embedded HTTP server
		// which maps it to the Copilot SDK session; the version suffix matters
		// for routing but the underlying model may be the same backend.
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
		/**
		 * Full tool-use support: the embedded server registers incoming `tools`
		 * as Copilot SDK external tools and bridges tool_use / tool_result across
		 * consecutive HTTP requests via ConversationManager.
		 */
		functionCalling: true,
		vision: false,
	};

	/** Singleton CopilotClient, created lazily */
	private clientCache: CopilotClient | undefined = undefined;
	/** Singleton embedded server, started lazily */
	private serverCache: EmbeddedServer | undefined = undefined;
	/** In-flight server start promise (prevents race on concurrent first calls) */
	private serverStarting: Promise<EmbeddedServer> | undefined = undefined;

	constructor(
		/** Working directory for Copilot sessions — defaults to `process.cwd()` at construction time. */
		private readonly cwd: string = process.cwd(),
		private readonly env: NodeJS.ProcessEnv = process.env
	) {}

	async isAvailable(): Promise<boolean> {
		// The @github/copilot CLI ships as an npm dependency of @github/copilot-sdk
		// and is always present after `bun install` — no system-wide install needed.
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
	 * - `ANTHROPIC_BASE_URL`        → `http://127.0.0.1:<port>`
	 * - `ANTHROPIC_AUTH_TOKEN`      → dummy token (server ignores auth)
	 * - `ANTHROPIC_DEFAULT_*_MODEL` → maps SDK tiers to Copilot model IDs
	 *
	 * **Precondition:** `getModels()` (or `ensureServerStarted()`) must be
	 * awaited before calling this method.
	 */
	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		if (!this.serverCache) {
			throw new Error(
				'CopilotAnthropicProvider: embedded server not started. ' +
					'Await getModels() or ensureServerStarted() before calling buildSdkConfig().'
			);
		}

		const entry = COPILOT_ANTHROPIC_MODELS.find((m) => m.alias === modelId || m.id === modelId);
		const resolvedId = entry?.id ?? modelId;
		// Per-session workspace path is encoded in the auth token so the embedded
		// server (shared singleton) can apply the correct cwd per HTTP request.
		const workspacePath = (sessionConfig?.workspacePath as string | undefined) ?? this.cwd;

		return {
			envVars: {
				ANTHROPIC_BASE_URL: this.serverCache.url,
				ANTHROPIC_AUTH_TOKEN: `copilot-anthropic-proxy:${workspacePath}`,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				API_TIMEOUT_MS: '300000',
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
	 * Shut down the embedded HTTP server and the underlying CopilotClient subprocess.
	 *
	 * **Call after `sessionManager.cleanup()`** — active NeoKai sessions hold
	 * open SSE connections to this server; they must be closed first.
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
			this.serverStarting = undefined;
		} catch (err) {
			this.serverStarting = undefined;
			throw err;
		}
		return this.serverCache.url;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private async createServer(): Promise<EmbeddedServer> {
		const client = this.getOrCreateClient();
		const server = await startEmbeddedServer(client, this.cwd);
		logger.debug(`Embedded Anthropic server started at ${server.url}`);
		return server;
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

	private getOrCreateClient(): CopilotClient {
		if (this.clientCache === undefined) {
			// No cliPath — CopilotClient defaults to getBundledCliPath() which
			// resolves the @github/copilot CLI from node_modules automatically.
			// @github/copilot ships as a runtime dependency of @github/copilot-sdk
			// so it is always present after `bun install`.
			this.clientCache = new CopilotClient({
				useStdio: true,
				logLevel: 'error',
				githubToken: this.resolveGitHubToken(),
			});
			logger.debug('Created CopilotClient (bundled CLI path)');
		}
		return this.clientCache;
	}
}
