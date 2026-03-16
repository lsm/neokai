/**
 * Anthropic Codex Provider
 *
 * Replaces the pi-mono based OpenAI provider.  Starts a local HTTP server that
 * speaks the Anthropic Messages API (POST /v1/messages with SSE streaming)
 * backed by `codex app-server`.
 *
 * Authentication is discovered in priority order:
 *   1. OPENAI_API_KEY / CODEX_API_KEY environment variable
 *   2. ~/.neokai/auth.json  — NeoKai's own auth store (key "openai")
 *   3. ~/.codex/auth.json   — Codex CLI auth (for users who ran `codex login`)
 *
 * OAuth credentials obtained through NeoKai's login flow are written to
 * ~/.neokai/auth.json so they persist across sessions.
 *
 * Workspace isolation: each unique workspace path gets its own bridge server
 * so Codex is always rooted at the correct directory.
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
import { type BridgeServer, createBridgeServer } from './codex-anthropic-bridge/server.js';
import { Logger } from '../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';

const logger = new Logger('anthropic-codex-provider');

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

const ANTHROPIC_CODEX_MODELS: ModelInfo[] = [
	{
		id: 'codex-1',
		name: 'Codex 1',
		alias: 'codex-bridge',
		family: 'codex',
		provider: 'anthropic-codex',
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
		provider: 'anthropic-codex',
		contextWindow: 128000,
		description: 'o4-mini · Fast Codex model via Anthropic-compatible bridge',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex',
		alias: 'codex',
		family: 'gpt',
		provider: 'anthropic-codex',
		contextWindow: 200000,
		description: 'GPT-5.3 Codex · Best for coding and complex reasoning',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		id: 'gpt-5-mini',
		name: 'GPT-5 Mini',
		alias: 'mini',
		family: 'gpt',
		provider: 'anthropic-codex',
		contextWindow: 128000,
		description: 'GPT-5 Mini · Fast and efficient for simpler tasks',
		releaseDate: '2025-12-01',
		available: true,
	},
];

// ---------------------------------------------------------------------------
// OAuth configuration (ChatGPT Plus / Pro)
// ---------------------------------------------------------------------------

const OAUTH_CONFIG = {
	clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
	authorizeUrl: 'https://auth.openai.com/oauth/authorize',
	tokenUrl: 'https://auth.openai.com/oauth/token',
	redirectUri: 'http://localhost:1455/auth/callback',
	scope: 'openid profile email offline_access',
	callbackPort: 1455,
};

// ---------------------------------------------------------------------------
// Auth credential types
// ---------------------------------------------------------------------------

/** Shape stored in ~/.neokai/auth.json under the "openai" key. */
interface StoredCredentials {
	type: 'oauth' | 'api_key';
	access?: string;
	refresh?: string;
	expires?: number; // Unix timestamp in ms
	accountId?: string;
}

/** Raw OAuth token response from auth.openai.com. */
interface OpenAIOAuthToken {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

/** Shape of ~/.codex/auth.json as written by the Codex CLI. */
interface CodexAuthFile {
	OPENAI_API_KEY?: string | null;
	tokens?: {
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
	last_refresh?: string;
}

// ---------------------------------------------------------------------------
// Helper: locate the `codex` binary on PATH
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
// AnthropicCodexProvider
// ---------------------------------------------------------------------------

export class AnthropicCodexProvider implements Provider {
	readonly id = 'anthropic-codex';
	readonly displayName = 'OpenAI (Codex)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 200000,
		functionCalling: true,
		vision: false,
	};

	/** Per-workspace bridge servers — keyed by absolute workspace path. */
	private readonly bridgeServers = new Map<string, BridgeServer>();

	/** Path to NeoKai's own auth store. */
	private readonly authPath: string;

	/** Path to the Codex CLI auth file. */
	private readonly codexAuthPath: string;

	/** In-memory cache of credentials read from the NeoKai auth file. */
	private cachedCredentials: StoredCredentials | null = null;

	/** Active OAuth flow state (PKCE flow). */
	private activeOAuthFlow: {
		state: string;
		verifier: string;
		server: http.Server | null;
		completed: boolean;
		success: boolean;
	} | null = null;

	constructor(
		private readonly env: Record<string, string | undefined> = process.env,
		authDir?: string,
		codexAuthDir?: string
	) {
		this.authPath = path.join(authDir ?? path.join(os.homedir(), '.neokai'), 'auth.json');
		this.codexAuthPath = path.join(codexAuthDir ?? path.join(os.homedir(), '.codex'), 'auth.json');
	}

	isAvailable(): boolean {
		return !!(this.env.OPENAI_API_KEY || this.env.CODEX_API_KEY) && !!findCodexCli();
	}

	// -------------------------------------------------------------------------
	// Auth status & credential discovery
	// -------------------------------------------------------------------------

	/**
	 * Return the best available API key, following the discovery chain:
	 *   1. OPENAI_API_KEY env var
	 *   2. CODEX_API_KEY env var
	 *   3. ~/.neokai/auth.json → data["openai"].access
	 *   4. ~/.codex/auth.json  → OPENAI_API_KEY field (if non-null string)
	 *   5. ~/.codex/auth.json  → tokens.access_token
	 */
	async getApiKey(): Promise<string | undefined> {
		if (this.env.OPENAI_API_KEY) return this.env.OPENAI_API_KEY;
		if (this.env.CODEX_API_KEY) return this.env.CODEX_API_KEY;

		// Try NeoKai auth file
		const neokaiCreds = await this.loadCredentials();
		if (neokaiCreds?.access) return neokaiCreds.access;

		// Try Codex CLI auth file
		return this.loadCodexApiKey();
	}

	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		const apiKey = await this.getApiKey();

		if (!apiKey) {
			return {
				isAuthenticated: false,
				error:
					'No credentials found. Set OPENAI_API_KEY, run `kai openai login`, or log in via `codex login`.',
			};
		}

		const codexPath = findCodexCli();
		if (!codexPath) {
			return {
				isAuthenticated: false,
				error: 'codex binary not found on PATH. Install Codex CLI to use this provider.',
			};
		}

		// Determine auth method
		if (this.env.OPENAI_API_KEY || this.env.CODEX_API_KEY) {
			return { isAuthenticated: true, method: 'api_key' };
		}

		const neokaiCreds = await this.loadCredentials();
		if (neokaiCreds?.access) {
			if (neokaiCreds.expires) {
				const bufferMs = 5 * 60 * 1000;
				if (Date.now() >= neokaiCreds.expires - bufferMs) {
					return {
						isAuthenticated: true,
						method: 'oauth',
						expiresAt: neokaiCreds.expires,
						needsRefresh: true,
					};
				}
				return { isAuthenticated: true, method: 'oauth', expiresAt: neokaiCreds.expires };
			}
			return { isAuthenticated: true, method: neokaiCreds.type };
		}

		// Must have come from Codex auth file
		return { isAuthenticated: true, method: 'api_key' };
	}

	async getModels(): Promise<ModelInfo[]> {
		const status = await this.getAuthStatus();
		return status.isAuthenticated ? ANTHROPIC_CODEX_MODELS : [];
	}

	ownsModel(modelId: string): boolean {
		const lower = modelId.toLowerCase();
		// Own all GPT / OpenAI reasoning model prefixes
		if (
			lower.startsWith('gpt-') ||
			lower.startsWith('o1-') ||
			lower.startsWith('o3-') ||
			lower.startsWith('o4-') ||
			lower.startsWith('codex')
		) {
			return true;
		}
		return ANTHROPIC_CODEX_MODELS.some((m) => m.id === modelId || m.alias === modelId);
	}

	getModelForTier(tier: ModelTier): string | undefined {
		const map: Record<ModelTier, string> = {
			opus: 'gpt-5.3-codex',
			sonnet: 'codex-1',
			haiku: 'o4-mini',
			default: 'codex-1',
		};
		return map[tier];
	}

	// -------------------------------------------------------------------------
	// Bridge server management
	// -------------------------------------------------------------------------

	/**
	 * Build SDK configuration.
	 *
	 * Lazily starts a per-workspace bridge server and returns env vars that
	 * route the Anthropic SDK to that bridge's local HTTP endpoint.
	 */
	buildSdkConfig(_modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const workspace = sessionConfig?.workspacePath ?? process.cwd();
		let bridgeServer = this.bridgeServers.get(workspace);

		if (!bridgeServer) {
			const codexBinaryPath = findCodexCli() ?? 'codex';
			// getApiKey() is async; fall back to env sync for buildSdkConfig
			const apiKey = this.env.OPENAI_API_KEY ?? this.env.CODEX_API_KEY ?? '';
			bridgeServer = createBridgeServer({ codexBinaryPath, apiKey, cwd: workspace });
			this.bridgeServers.set(workspace, bridgeServer);
			logger.info(
				`AnthropicCodexProvider: bridge server started on port ${bridgeServer.port} for workspace=${workspace}`
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

	/** @deprecated Use stopAllBridgeServers(). */
	stopBridgeServer(): void {
		this.stopAllBridgeServers();
	}

	// -------------------------------------------------------------------------
	// OAuth flow (ChatGPT Plus / Pro)
	// -------------------------------------------------------------------------

	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
			return {
				type: 'redirect',
				authUrl: this.activeOAuthFlow.state
					? this.buildAuthUrl(
							this.activeOAuthFlow.state,
							await this.generatePKCEChallenge(this.activeOAuthFlow.verifier)
						).toString()
					: undefined,
				message: 'OAuth flow already in progress. Complete authentication in your browser.',
			};
		}

		const verifier = this.generateRandomString(128);
		const challenge = await this.generatePKCEChallenge(verifier);
		const state = this.generateRandomString(32);
		const authUrl = this.buildAuthUrl(state, challenge);

		this.activeOAuthFlow = { state, verifier, server: null, completed: false, success: false };

		this.startBackgroundOAuthFlow(state, verifier).catch((error) => {
			logger.error('Background OAuth flow failed:', error);
			if (this.activeOAuthFlow) {
				this.activeOAuthFlow.completed = true;
				this.activeOAuthFlow.success = false;
			}
		});

		return {
			type: 'redirect',
			authUrl: authUrl.toString(),
			message: 'Opening browser for OpenAI authentication...',
		};
	}

	private buildAuthUrl(state: string, challenge: string): URL {
		const authUrl = new URL(OAUTH_CONFIG.authorizeUrl);
		authUrl.searchParams.set('response_type', 'code');
		authUrl.searchParams.set('client_id', OAUTH_CONFIG.clientId);
		authUrl.searchParams.set('redirect_uri', OAUTH_CONFIG.redirectUri);
		authUrl.searchParams.set('scope', OAUTH_CONFIG.scope);
		authUrl.searchParams.set('code_challenge', challenge);
		authUrl.searchParams.set('code_challenge_method', 'S256');
		authUrl.searchParams.set('state', state);
		authUrl.searchParams.set('id_token_add_organizations', 'true');
		authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
		authUrl.searchParams.set('originator', 'neokai');
		return authUrl;
	}

	private async startBackgroundOAuthFlow(expectedState: string, verifier: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				const url = new URL(req.url ?? '/', 'http://localhost');

				if (url.pathname !== '/auth/callback') {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not found');
					return;
				}

				const code = url.searchParams.get('code');
				const state = url.searchParams.get('state');

				if (state !== expectedState) {
					res.writeHead(400, { 'Content-Type': 'text/plain' });
					res.end('Invalid state parameter');
					reject(new Error('Invalid state parameter'));
					return;
				}

				if (!code) {
					res.writeHead(400, { 'Content-Type': 'text/plain' });
					res.end('No authorization code received');
					reject(new Error('No authorization code received'));
					return;
				}

				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(
					'<html><body><h1>Authentication successful!</h1><p>You can close this window and return to NeoKai.</p><script>window.close();</script></body></html>'
				);
				server.close();

				this.exchangeCodeForTokens(code, verifier)
					.then((tokens) => {
						const credentials: StoredCredentials = {
							type: 'oauth',
							access: tokens.access_token,
							refresh: tokens.refresh_token,
							expires: Date.now() + tokens.expires_in * 1000,
							accountId: this.extractAccountId(tokens.access_token),
						};
						return this.saveCredentials(credentials).then(() => {
							this.cachedCredentials = credentials;
							if (this.activeOAuthFlow) {
								this.activeOAuthFlow.completed = true;
								this.activeOAuthFlow.success = true;
							}
							resolve();
						});
					})
					.catch((error) => {
						logger.error('Token exchange failed:', error);
						if (this.activeOAuthFlow) {
							this.activeOAuthFlow.completed = true;
							this.activeOAuthFlow.success = false;
						}
						reject(error as Error);
					});
			});

			if (this.activeOAuthFlow) this.activeOAuthFlow.server = server;

			server.listen(OAUTH_CONFIG.callbackPort, () => {
				logger.debug(`OAuth callback server listening on port ${OAUTH_CONFIG.callbackPort}`);
			});

			setTimeout(
				() => {
					server.close();
					if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
						this.activeOAuthFlow.completed = true;
						this.activeOAuthFlow.success = false;
					}
					reject(new Error('OAuth flow timed out'));
				},
				5 * 60 * 1000
			);
		});
	}

	private async exchangeCodeForTokens(code: string, verifier: string): Promise<OpenAIOAuthToken> {
		const response = await fetch(OAUTH_CONFIG.tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				grant_type: 'authorization_code',
				code,
				redirect_uri: OAUTH_CONFIG.redirectUri,
				client_id: OAUTH_CONFIG.clientId,
				code_verifier: verifier,
			}),
		});

		if (!response.ok) {
			throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
		}
		return response.json() as Promise<OpenAIOAuthToken>;
	}

	async refreshToken(): Promise<boolean> {
		const credentials = await this.loadCredentials();
		if (!credentials?.refresh) return false;

		try {
			const response = await fetch(OAUTH_CONFIG.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: credentials.refresh,
					client_id: OAUTH_CONFIG.clientId,
				}),
			});

			if (!response.ok) {
				logger.error('Token refresh failed:', response.statusText);
				return false;
			}

			const tokens = (await response.json()) as OpenAIOAuthToken;
			const newCreds: StoredCredentials = {
				type: 'oauth',
				access: tokens.access_token,
				refresh: tokens.refresh_token || credentials.refresh,
				expires: Date.now() + tokens.expires_in * 1000,
				accountId: credentials.accountId ?? this.extractAccountId(tokens.access_token),
			};

			await this.saveCredentials(newCreds);
			this.cachedCredentials = newCreds;
			return true;
		} catch (error) {
			logger.error('Token refresh failed:', error);
			return false;
		}
	}

	async logout(): Promise<void> {
		this.cachedCredentials = null;
		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content) as Record<string, unknown>;
			delete data['openai'];

			if (Object.keys(data).length === 0) {
				await fs.unlink(this.authPath);
			} else {
				await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
			}
		} catch {
			// file does not exist — nothing to do
		}
	}

	// -------------------------------------------------------------------------
	// Private: credential persistence
	// -------------------------------------------------------------------------

	private async loadCredentials(): Promise<StoredCredentials | null> {
		if (this.cachedCredentials) return this.cachedCredentials;

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content) as Record<string, unknown>;
			const creds = data['openai'] as StoredCredentials | undefined;
			if (creds?.access) {
				this.cachedCredentials = creds;
				return creds;
			}
		} catch {
			// file missing or malformed — continue to next source
		}
		return null;
	}

	private async loadCodexApiKey(): Promise<string | undefined> {
		try {
			const content = await fs.readFile(this.codexAuthPath, 'utf-8');
			const data = JSON.parse(content) as CodexAuthFile;

			// Prefer an explicit API key stored by the CLI
			if (data.OPENAI_API_KEY && typeof data.OPENAI_API_KEY === 'string') {
				return data.OPENAI_API_KEY;
			}
			// Fall back to OAuth bearer token
			if (data.tokens?.access_token) {
				return data.tokens.access_token;
			}
		} catch {
			// file missing or malformed — not an error
		}
		return undefined;
	}

	private async saveCredentials(credentials: StoredCredentials): Promise<void> {
		const dir = path.dirname(this.authPath);
		await fs.mkdir(dir, { recursive: true });

		let data: Record<string, unknown> = {};
		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			data = JSON.parse(content) as Record<string, unknown>;
		} catch {
			// file does not exist yet
		}

		data['openai'] = credentials;
		await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
	}

	// -------------------------------------------------------------------------
	// Private: PKCE helpers
	// -------------------------------------------------------------------------

	private generateRandomString(length: number): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
		const randomValues = crypto.randomBytes(length);
		let result = '';
		for (let i = 0; i < length; i++) {
			result += chars[randomValues[i] % chars.length];
		}
		return result;
	}

	private async generatePKCEChallenge(verifier: string): Promise<string> {
		return crypto.createHash('sha256').update(verifier).digest().toString('base64url');
	}

	private extractAccountId(accessToken: string): string | undefined {
		try {
			const parts = accessToken.split('.');
			if (parts.length !== 3) return undefined;
			const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8')) as Record<
				string,
				unknown
			>;
			const auth = payload['https://api.openai.com/auth'] as Record<string, string> | undefined;
			return auth?.chatgpt_account_id ?? (payload.sub as string | undefined);
		} catch {
			return undefined;
		}
	}
}
