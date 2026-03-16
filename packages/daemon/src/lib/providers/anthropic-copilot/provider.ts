/**
 * Anthropic Copilot Provider
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
 *   1. `~/.neokai/auth.json` (explicitly stored NeoKai credentials)
 *   2. `COPILOT_GITHUB_TOKEN` env var (PAT with copilot_requests scope)
 *   3. `GH_TOKEN` env var
 *   4. `gh auth token` CLI output
 *   5. `~/.config/gh/hosts.yml` oauth_token
 *
 * IMPORTANT: `GITHUB_TOKEN` (GitHub Actions token) is NOT used — it lacks
 * Copilot access and causes "Not logged in" errors.
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
	ProviderOAuthFlowData,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { CopilotClient } from '@github/copilot-sdk';
import { startEmbeddedServer, type EmbeddedServer } from './server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Logger } from '../../logger.js';

const execFileAsync = promisify(execFile);
const logger = new Logger('anthropic-copilot-provider');

/**
 * GitHub Copilot model definitions.
 * Aliases use the `copilot-anthropic-` prefix for backwards compatibility
 * with existing configurations.
 *
 * These model IDs are the identifiers the GitHub Copilot backend recognises
 * and must be passed verbatim to `CopilotClient.createSession({ model })`.
 */
const COPILOT_ANTHROPIC_MODELS: ModelInfo[] = [
	{
		id: 'claude-opus-4.6',
		name: 'Claude Opus 4.6 (Copilot)',
		alias: 'copilot-anthropic-opus',
		family: 'opus',
		provider: 'anthropic-copilot',
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
		provider: 'anthropic-copilot',
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
		provider: 'anthropic-copilot',
		contextWindow: 272000,
		description: 'GPT-5.3 Codex via GitHub Copilot · Best for coding',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		// Intentionally "gemini-3-pro-preview" (not "gemini-3.1-pro-preview").
		// GitHubCopilotProvider used "gemini-3.1-pro-preview" because that provider
		// passed the ID directly to the Copilot CLI. This provider passes the ID
		// as a hint to the embedded HTTP server which maps it to the Copilot SDK
		// session; the version suffix matters for routing.
		id: 'gemini-3-pro-preview',
		name: 'Gemini 3 Pro (Copilot)',
		alias: 'copilot-anthropic-gemini',
		family: 'gemini',
		provider: 'anthropic-copilot',
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
		provider: 'anthropic-copilot',
		contextWindow: 128000,
		description: 'GPT-5 Mini via GitHub Copilot · Fast and efficient',
		releaseDate: '2025-12-01',
		available: true,
	},
];

/**
 * Stored credentials format for GitHub Copilot in ~/.neokai/auth.json
 */
interface StoredCopilotCredentials {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
}

/**
 * OAuth device flow response
 */
interface DeviceFlowResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

/** Resolved-token cache entry (5-minute TTL). */
interface TokenCacheEntry {
	token: string | undefined;
	expiresAt: number;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

export class AnthropicCopilotProvider implements Provider {
	readonly id = 'anthropic-copilot';
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
	/** Resolved token cache with TTL */
	private tokenCache: TokenCacheEntry | null = null;

	/** Path to stored authentication tokens */
	private readonly authPath: string;

	/** Active OAuth device flow state */
	private activeOAuthFlow: {
		deviceCode: string;
		userCode: string;
		verificationUri: string;
		expiresAt: number;
		completed: boolean;
		success: boolean;
	} | null = null;

	constructor(
		/** Working directory for Copilot sessions — defaults to `process.cwd()` at construction time. */
		private readonly cwd: string = process.cwd(),
		private readonly env: NodeJS.ProcessEnv = process.env,
		authDir?: string
	) {
		this.authPath = path.join(authDir || path.join(os.homedir(), '.neokai'), 'auth.json');
	}

	async isAvailable(): Promise<boolean> {
		const token = await this.resolveGitHubToken();
		// Classic PATs (ghp_) are rejected by the Copilot CLI — mirror the same guard
		// as getAuthStatus() so that isAvailable() and getAuthStatus() are consistent.
		// Without this, a ghp_ token causes models to appear in the picker while the
		// provider is simultaneously marked unauthenticated in the auth panel.
		if (!token || token.startsWith('ghp_')) return false;
		return true;
	}

	async getModels(): Promise<ModelInfo[]> {
		// isAvailable() applies the full validity check (token present AND not a classic PAT).
		// getAuthStatus() mirrors the same logic, so if isAvailable() returns true, the
		// provider is considered authenticated and models are safe to expose.
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
		return COPILOT_ANTHROPIC_MODELS.some((m) => m.alias === modelId || m.id === modelId);
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
	 * - `ANTHROPIC_AUTH_TOKEN`      → workspace path encoded for the server
	 * - `ANTHROPIC_DEFAULT_*_MODEL` → maps SDK tiers to Copilot model IDs
	 *
	 * **Precondition:** `getModels()` (or `ensureServerStarted()`) must be
	 * awaited before calling this method.
	 */
	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		if (!this.serverCache) {
			throw new Error(
				'AnthropicCopilotProvider: embedded server not started. ' +
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
				ANTHROPIC_AUTH_TOKEN: `anthropic-copilot-proxy:${workspacePath}`,
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
	 * Get current authentication status.
	 * Uses resolveGitHubToken() — does NOT fall back to GITHUB_TOKEN (Actions token).
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		try {
			const token = await this.resolveGitHubToken();
			if (!token) {
				return {
					isAuthenticated: false,
					error:
						'No GitHub token found. Set COPILOT_GITHUB_TOKEN, run `gh auth login`, or use NeoKai OAuth.',
				};
			}
			// Classic PATs (ghp_) are explicitly rejected by the Copilot CLI internals.
			// Returning isAuthenticated: false here gives an immediate, actionable error
			// instead of a confusing "Not logged in" from the CLI subprocess.
			if (token.startsWith('ghp_')) {
				return {
					isAuthenticated: false,
					error:
						'Classic PATs (ghp_…) are not supported by the GitHub Copilot CLI. ' +
						'Use a fine-grained PAT with Copilot access, or run the OAuth login flow.',
				};
			}
			return { isAuthenticated: true, needsRefresh: false };
		} catch (error) {
			return {
				isAuthenticated: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Start OAuth device flow for authentication.
	 *
	 * Returns immediately with user code and verification URL.
	 * The background polling stores the token in ~/.neokai/auth.json on success.
	 */
	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
			return {
				type: 'device',
				userCode: this.activeOAuthFlow.userCode,
				verificationUri: this.activeOAuthFlow.verificationUri,
				message: 'OAuth flow already in progress. Enter the code at the verification URL.',
			};
		}

		try {
			const enterpriseDomain = this.getEnterpriseDomain();
			const deviceResponse = await this.startDeviceFlow(enterpriseDomain);

			this.activeOAuthFlow = {
				deviceCode: deviceResponse.device_code,
				userCode: deviceResponse.user_code,
				verificationUri: deviceResponse.verification_uri,
				expiresAt: Date.now() + deviceResponse.expires_in * 1000,
				completed: false,
				success: false,
			};

			this.startBackgroundPolling(deviceResponse, enterpriseDomain).catch((error) => {
				logger.error('Background polling failed:', error);
				if (this.activeOAuthFlow) {
					this.activeOAuthFlow.completed = true;
					this.activeOAuthFlow.success = false;
				}
			});

			return {
				type: 'device',
				userCode: deviceResponse.user_code,
				verificationUri: deviceResponse.verification_uri,
				message: 'Enter the code at the verification URL to authenticate.',
			};
		} catch (error) {
			logger.error('Failed to start OAuth flow:', error);
			throw error;
		}
	}

	/**
	 * Logout — remove stored GitHub Copilot credentials from ~/.neokai/auth.json.
	 */
	async logout(): Promise<void> {
		// Invalidate token cache
		this.tokenCache = null;

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content) as Record<string, unknown>;
			delete data['github-copilot'];

			if (Object.keys(data).length === 0) {
				await fs.unlink(this.authPath);
			} else {
				await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
			}
		} catch {
			// Ignore if file doesn't exist
		}
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
	// Credential discovery chain
	// ---------------------------------------------------------------------------

	/**
	 * Resolve a GitHub OAuth token using this priority order:
	 *   1. ~/.neokai/auth.json (explicitly stored NeoKai credentials)
	 *   2. COPILOT_GITHUB_TOKEN env var (PAT with copilot_requests scope)
	 *   3. GH_TOKEN env var
	 *   4. `gh auth token` CLI command
	 *   5. ~/.config/gh/hosts.yml oauth_token
	 *
	 * IMPORTANT: GITHUB_TOKEN (GitHub Actions token) is NOT used — it lacks
	 * Copilot access and causes "Not logged in" errors.
	 *
	 * Tokens from sources 4 and 5 are validated via a lightweight Copilot API
	 * check before being returned. The result is cached for TOKEN_CACHE_TTL_MS.
	 */
	private async resolveGitHubToken(): Promise<string | undefined> {
		if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
			return this.tokenCache.token;
		}

		const token = await this.discoverGitHubToken();
		this.tokenCache = { token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS };
		return token;
	}

	private async discoverGitHubToken(): Promise<string | undefined> {
		// 1. ~/.neokai/auth.json
		const stored = await this.loadStoredGitHubToken();
		if (stored) return stored;

		// 2. COPILOT_GITHUB_TOKEN env var (explicit, has copilot_requests scope)
		if (this.env.COPILOT_GITHUB_TOKEN) return this.env.COPILOT_GITHUB_TOKEN;

		// 3. GH_TOKEN env var (user's gh CLI token)
		if (this.env.GH_TOKEN) return this.env.GH_TOKEN;

		// 4. gh auth token CLI
		const ghCliToken = await this.tryGhCliToken();
		if (ghCliToken) {
			const valid = await this.validateCopilotToken(ghCliToken);
			if (valid) return ghCliToken;
		}

		// 5. ~/.config/gh/hosts.yml
		const hostsToken = await this.tryGhHostsToken();
		if (hostsToken && hostsToken !== ghCliToken) {
			const valid = await this.validateCopilotToken(hostsToken);
			if (valid) return hostsToken;
		}

		return undefined;
	}

	/** Read GitHub OAuth token from ~/.neokai/auth.json */
	private async loadStoredGitHubToken(): Promise<string | undefined> {
		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content) as Record<string, unknown>;
			const creds = data['github-copilot'] as StoredCopilotCredentials | undefined;
			if (creds?.refresh && typeof creds.refresh === 'string') {
				return creds.refresh;
			}
		} catch {
			// File doesn't exist or invalid JSON
		}
		return undefined;
	}

	/** Run `gh auth token` and return the token, or undefined on failure. */
	private async tryGhCliToken(): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
			const token = stdout.trim();
			return token || undefined;
		} catch {
			return undefined;
		}
	}

	/** Read oauth_token from ~/.config/gh/hosts.yml */
	private async tryGhHostsToken(): Promise<string | undefined> {
		try {
			const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
			const content = await fs.readFile(hostsPath, 'utf-8');
			const match = content.match(/oauth_token:\s*(\S+)/);
			return match?.[1] || undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Validate that a GitHub OAuth token has Copilot API access.
	 *
	 * Uses the SDK to attempt a real Copilot session. The CLI subprocess handles
	 * the OAuth→session-token exchange internally when COPILOT_GITHUB_TOKEN is set
	 * in its env. This gives a definitive answer: if the CLI can create a session,
	 * the token has the required Copilot access.
	 *
	 * The GitHub Actions GITHUB_TOKEN has no Copilot access, so its session attempt
	 * fails, preventing false-positive authentication in CI.
	 *
	 * Only called for tokens from `gh auth token` (source 4) and hosts.yml (source 5).
	 * COPILOT_GITHUB_TOKEN and GH_TOKEN env-var tokens are trusted without validation.
	 *
	 * Cold-path only: called once per daemon restart per credential source, then cached
	 * for 5 minutes by `resolveGitHubToken`. Expected latency: 3–15 s (subprocess spawn
	 * + OAuth exchange). A 20 s hard timeout prevents indefinite hangs on slow networks.
	 *
	 * Note: uses `gpt-4o-mini` as the validation model. If Copilot ever removes that
	 * model, validation will spuriously return false (prompting the user to re-authenticate
	 * via OAuth rather than silently succeeding).
	 */
	private async validateCopilotToken(token: string): Promise<boolean> {
		const TIMEOUT_MS = 20_000;
		const client = new CopilotClient({
			useStdio: true,
			logLevel: 'error',
			env: { ...this.env, COPILOT_GITHUB_TOKEN: token },
		});
		try {
			const session = await Promise.race([
				client.createSession({
					model: 'gpt-4o-mini',
					onPermissionRequest: () => Promise.resolve({ kind: 'approved' as const }),
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('validateCopilotToken timed out')), TIMEOUT_MS)
				),
			]);
			await session.disconnect();
			return true;
		} catch {
			return false;
		} finally {
			await client.stop().catch(() => {});
		}
	}

	// ---------------------------------------------------------------------------
	// OAuth device flow
	// ---------------------------------------------------------------------------

	private getEnterpriseDomain(): string | undefined {
		const apiUrl = this.env.GITHUB_API_URL;
		if (!apiUrl) return undefined;
		try {
			const url = new URL(apiUrl);
			if (url.hostname === 'api.github.com') return undefined;
			return url.hostname;
		} catch {
			return undefined;
		}
	}

	private getGitHubOAuthUrl(enterpriseDomain?: string): string {
		return enterpriseDomain ? `https://${enterpriseDomain}` : 'https://github.com';
	}

	private getClientId(): string {
		return this.env.GITHUB_COPILOT_CLIENT_ID || atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=');
	}

	private async startDeviceFlow(enterpriseDomain?: string): Promise<DeviceFlowResponse> {
		const clientId = this.getClientId();
		const githubOAuthUrl = this.getGitHubOAuthUrl(enterpriseDomain);

		const response = await fetch(`${githubOAuthUrl}/login/device/code`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'GitHubCopilotChat/0.35.0',
			},
			body: JSON.stringify({ client_id: clientId, scope: 'read:user copilot' }),
		});

		if (!response.ok) {
			throw new Error(`Device flow start failed: ${response.statusText}`);
		}

		return response.json() as Promise<DeviceFlowResponse>;
	}

	private async startBackgroundPolling(
		device: DeviceFlowResponse,
		enterpriseDomain?: string
	): Promise<void> {
		const clientId = this.getClientId();
		const githubOAuthUrl = this.getGitHubOAuthUrl(enterpriseDomain);
		const startTime = Date.now();
		const expiresMs = device.expires_in * 1000;

		while (Date.now() - startTime < expiresMs) {
			if (!this.activeOAuthFlow || this.activeOAuthFlow.completed) return;

			await new Promise((resolve) => setTimeout(resolve, device.interval * 1000));

			try {
				const response = await fetch(`${githubOAuthUrl}/login/oauth/access_token`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: JSON.stringify({
						client_id: clientId,
						device_code: device.device_code,
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					}),
				});

				if (!response.ok) continue;

				const data = (await response.json()) as {
					access_token?: string;
					error?: string;
				};

				if (data.error === 'authorization_pending') continue;

				if (data.error) {
					logger.error('OAuth polling error:', data.error);
					if (this.activeOAuthFlow) {
						this.activeOAuthFlow.completed = true;
						this.activeOAuthFlow.success = false;
					}
					return;
				}

				if (!data.access_token) continue;

				// Store the GitHub OAuth token directly — @github/copilot-sdk
				// handles the Copilot session token exchange internally.
				const credentials: StoredCopilotCredentials = {
					refresh: data.access_token,
					access: '',
					expires: 0,
					enterpriseUrl: enterpriseDomain,
				};

				await this.saveCredentials(credentials);
				// Invalidate token cache so next call picks up the new token
				this.tokenCache = null;

				logger.debug('GitHub Copilot OAuth login successful');

				if (this.activeOAuthFlow) {
					this.activeOAuthFlow.completed = true;
					this.activeOAuthFlow.success = true;
				}
				return;
			} catch (error) {
				logger.debug('OAuth polling attempt failed:', error);
				continue;
			}
		}

		logger.error('OAuth device flow timed out');
		if (this.activeOAuthFlow) {
			this.activeOAuthFlow.completed = true;
			this.activeOAuthFlow.success = false;
		}
	}

	private async saveCredentials(credentials: StoredCopilotCredentials): Promise<void> {
		const dir = path.dirname(this.authPath);
		await fs.mkdir(dir, { recursive: true });

		let data: Record<string, unknown> = {};
		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			data = JSON.parse(content) as Record<string, unknown>;
		} catch {
			// File doesn't exist, start fresh
		}

		data['github-copilot'] = credentials;

		await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private async createServer(): Promise<EmbeddedServer> {
		const token = await this.resolveGitHubToken();
		const client = this.getOrCreateClient(token);
		const server = await startEmbeddedServer(client, this.cwd);
		logger.debug(`Embedded Anthropic server started at ${server.url}`);
		return server;
	}

	private getOrCreateClient(token?: string): CopilotClient {
		if (this.clientCache === undefined) {
			// Pass the GitHub OAuth token as COPILOT_GITHUB_TOKEN in the subprocess env.
			// The CLI will exchange it for a Copilot session token internally.
			//
			// Do NOT use the `githubToken` option — that sets COPILOT_SDK_AUTH_TOKEN,
			// which expects a pre-exchanged session token (tid=... format), not a GitHub
			// OAuth token (ghp_/gho_). Passing an OAuth token there causes the CLI to
			// reject it with "OAuth token has expired".
			const env: NodeJS.ProcessEnv = { ...this.env };
			if (token) {
				env.COPILOT_GITHUB_TOKEN = token;
			}
			this.clientCache = new CopilotClient({
				useStdio: true,
				logLevel: 'error',
				env,
			});
			logger.debug('Created CopilotClient (bundled CLI path)');
		}
		return this.clientCache;
	}
}
