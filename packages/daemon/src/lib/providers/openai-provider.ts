/**
 * OpenAI Provider - OpenAI GPT models via API or ChatGPT Plus/Pro OAuth
 *
 * This provider supports two authentication methods:
 * 1. API Key: Set OPENAI_API_KEY environment variable
 * 2. OAuth: ChatGPT Plus/Pro with Codex subscription via `kai openai login`
 *
 * Uses pi-mono adapter to communicate with OpenAI's API.
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
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import { piMonoQueryGenerator } from './pimono-adapter.js';
import { Logger } from '../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as crypto from 'crypto';

const logger = new Logger('openai-provider');

/**
 * OpenAI model definitions
 */
const OPENAI_MODELS: ModelInfo[] = [
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex',
		alias: 'codex',
		family: 'gpt',
		provider: 'openai',
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
		provider: 'openai',
		contextWindow: 128000,
		description: 'GPT-5 Mini · Fast and efficient for simpler tasks',
		releaseDate: '2025-12-01',
		available: true,
	},
];

/**
 * OAuth configuration for ChatGPT Plus/Pro
 */
const OAUTH_CONFIG = {
	clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
	authorizeUrl: 'https://auth.openai.com/oauth/authorize',
	tokenUrl: 'https://auth.openai.com/oauth/token',
	redirectUri: 'http://localhost:1455/auth/callback',
	scope: 'openid profile email offline_access',
	callbackPort: 1455,
};

/**
 * OAuth token structure
 */
interface OpenAIOAuthToken {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

/**
 * Stored credentials
 */
interface StoredCredentials {
	type: 'oauth' | 'api_key';
	access?: string;
	refresh?: string;
	expires?: number; // Unix timestamp in ms
	accountId?: string;
}

/**
 * Authentication status
 */
export interface OpenAIAuthStatus {
	isAuthenticated: boolean;
	method?: 'api_key' | 'oauth';
	expiresAt?: number;
	needsRefresh?: boolean;
	error?: string;
}

/**
 * OpenAI provider implementation
 */
export class OpenAiProvider implements Provider {
	readonly id = 'openai';
	readonly displayName = 'OpenAI';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 200000,
		functionCalling: true,
		vision: true,
	};

	/**
	 * Path to stored authentication tokens
	 */
	private readonly authPath: string;

	/**
	 * Cached credentials (memory cache)
	 */
	private cachedCredentials: StoredCredentials | null = null;

	/**
	 * Active OAuth flow state (for async polling)
	 */
	private activeOAuthFlow: {
		state: string;
		verifier: string;
		server: http.Server | null;
		completed: boolean;
		success: boolean;
	} | null = null;

	constructor(
		private readonly env: Record<string, string | undefined> = process.env,
		authDir?: string
	) {
		this.authPath = path.join(authDir || path.join(os.homedir(), '.neokai'), 'auth.json');
	}

	/**
	 * Check if OpenAI is available
	 * Requires either API key or valid OAuth token
	 */
	async isAvailable(): Promise<boolean> {
		const status = await this.getAuthStatus();
		return status.isAuthenticated && !status.needsRefresh;
	}

	/**
	 * Get authentication status (implements Provider interface)
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		// Check for API key first
		if (this.env.OPENAI_API_KEY) {
			return {
				isAuthenticated: true,
				method: 'api_key',
			};
		}

		// Check for OAuth token
		const credentials = await this.loadCredentials();

		if (!credentials) {
			return {
				isAuthenticated: false,
				error: 'No API key or OAuth token. Set OPENAI_API_KEY or run OAuth login.',
			};
		}

		if (credentials.type === 'api_key' || !credentials.expires) {
			return {
				isAuthenticated: true,
				method: credentials.type,
			};
		}

		// Check if OAuth token is expired
		const now = Date.now();
		const bufferMs = 5 * 60 * 1000; // 5 minute buffer

		if (now >= credentials.expires - bufferMs) {
			return {
				isAuthenticated: true,
				method: 'oauth',
				expiresAt: credentials.expires,
				needsRefresh: true,
			};
		}

		return {
			isAuthenticated: true,
			method: 'oauth',
			expiresAt: credentials.expires,
			needsRefresh: false,
		};
	}

	/**
	 * Get API key (from env or OAuth token)
	 */
	async getApiKey(): Promise<string | undefined> {
		// Check environment variable first
		if (this.env.OPENAI_API_KEY) {
			return this.env.OPENAI_API_KEY;
		}

		// Check stored OAuth token
		const credentials = await this.loadCredentials();
		return credentials?.access;
	}

	/**
	 * Get available models from OpenAI
	 */
	async getModels(): Promise<ModelInfo[]> {
		const status = await this.getAuthStatus();
		return status.isAuthenticated ? OPENAI_MODELS : [];
	}

	/**
	 * Check if a model ID belongs to OpenAI
	 */
	ownsModel(modelId: string): boolean {
		const lower = modelId.toLowerCase();

		// OpenAI model IDs
		if (lower.startsWith('gpt-')) {
			return true;
		}

		// Check against known models
		return OPENAI_MODELS.some((m) => m.id === modelId || m.alias === modelId);
	}

	/**
	 * Get model for a specific tier
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			opus: 'gpt-5.3-codex',
			sonnet: 'gpt-5.3-codex',
			haiku: 'gpt-5-mini',
			default: 'gpt-5.3-codex',
		};
		return tierMap[tier];
	}

	/**
	 * Build SDK configuration for OpenAI
	 */
	buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		return {
			envVars: {},
			isAnthropicCompatible: false,
		};
	}

	/**
	 * Create custom query generator for OpenAI
	 */
	async createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): Promise<AsyncGenerator<SDKMessage, void> | null> {
		// Check availability and refresh if needed
		const status = await this.getAuthStatus();

		if (!status.isAuthenticated) {
			logger.warn('OpenAI not authenticated. Set OPENAI_API_KEY or run `kai openai login`.');
			return null;
		}

		if (status.needsRefresh) {
			const refreshed = await this.refreshToken();
			if (!refreshed) {
				logger.error('Failed to refresh OpenAI token.');
				return null;
			}
		}

		const apiKey = await this.getApiKey();
		if (!apiKey) {
			return null;
		}

		// Use pi-mono query generator with OpenAI configuration
		return piMonoQueryGenerator(
			prompt,
			{
				...options,
				apiKey,
			},
			context,
			'openai',
			options.model,
			undefined
		);
	}

	// =========================================================================
	// OAuth Implementation
	// =========================================================================

	/**
	 * Start OAuth flow for ChatGPT Plus/Pro (implements Provider interface)
	 *
	 * Uses Authorization Code + PKCE flow with local callback server.
	 * Returns immediately with auth URL - flow completes in background.
	 * Call getAuthStatus() to poll for completion.
	 *
	 * @returns OAuth flow data with URL to open in browser
	 */
	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		// If there's already an active flow, return its URL
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

		try {
			// Generate PKCE verifier and challenge
			const verifier = this.generateRandomString(128);
			const challenge = await this.generatePKCEChallenge(verifier);
			const state = this.generateRandomString(32);

			// Build authorization URL
			const authUrl = this.buildAuthUrl(state, challenge);

			// Initialize active flow state
			this.activeOAuthFlow = {
				state,
				verifier,
				server: null,
				completed: false,
				success: false,
			};

			// Start callback server and flow in background
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
		} catch (error) {
			logger.error('Failed to start OAuth flow:', error);
			throw error;
		}
	}

	/**
	 * Build the OAuth authorization URL
	 */
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

	/**
	 * Run OAuth flow in background (callback server + token exchange)
	 */
	private async startBackgroundOAuthFlow(expectedState: string, verifier: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				const url = new URL(req.url || '/', 'http://localhost');

				if (url.pathname === '/auth/callback') {
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
					res.end(`
						<html>
							<body>
								<h1>Authentication successful!</h1>
								<p>You can close this window and return to NeoKai.</p>
								<script>window.close();</script>
							</body>
						</html>
					`);

					server.close();

					// Exchange code for tokens
					this.exchangeCodeForTokens(code, verifier)
						.then((tokens) => {
							// Extract account ID from JWT
							const accountId = this.extractAccountId(tokens.access_token);

							// Save credentials
							const credentials: StoredCredentials = {
								type: 'oauth',
								access: tokens.access_token,
								refresh: tokens.refresh_token,
								expires: Date.now() + tokens.expires_in * 1000,
								accountId,
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
							reject(error);
						});
				} else {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not found');
				}
			});

			// Store server reference
			if (this.activeOAuthFlow) {
				this.activeOAuthFlow.server = server;
			}

			server.listen(OAUTH_CONFIG.callbackPort, () => {
				logger.debug(`OAuth callback server listening on port ${OAUTH_CONFIG.callbackPort}`);
			});

			// Timeout after 5 minutes
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

	/**
	 * Exchange authorization code for tokens
	 */
	private async exchangeCodeForTokens(code: string, verifier: string): Promise<OpenAIOAuthToken> {
		const response = await fetch(OAUTH_CONFIG.tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				grant_type: 'authorization_code',
				code,
				redirect_uri: OAUTH_CONFIG.redirectUri,
				client_id: OAUTH_CONFIG.clientId,
				code_verifier: verifier,
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${text}`);
		}

		return response.json() as Promise<OpenAIOAuthToken>;
	}

	/**
	 * Refresh OAuth token
	 */
	async refreshToken(): Promise<boolean> {
		const credentials = await this.loadCredentials();

		if (!credentials?.refresh) {
			return false;
		}

		try {
			const response = await fetch(OAUTH_CONFIG.tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
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

			const newCredentials: StoredCredentials = {
				type: 'oauth',
				access: tokens.access_token,
				refresh: tokens.refresh_token || credentials.refresh,
				expires: Date.now() + tokens.expires_in * 1000,
				accountId: credentials.accountId || this.extractAccountId(tokens.access_token),
			};

			await this.saveCredentials(newCredentials);
			this.cachedCredentials = newCredentials;

			return true;
		} catch (error) {
			logger.error('Token refresh failed:', error);
			return false;
		}
	}

	/**
	 * Logout - delete stored credentials
	 */
	async logout(): Promise<void> {
		this.cachedCredentials = null;

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content);
			delete data['openai'];

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
	 * Generate random string for PKCE and state
	 */
	private generateRandomString(length: number): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
		let result = '';
		const randomValues = crypto.randomBytes(length);
		for (let i = 0; i < length; i++) {
			result += chars[randomValues[i] % chars.length];
		}
		return result;
	}

	/**
	 * Generate PKCE code challenge from verifier
	 */
	private async generatePKCEChallenge(verifier: string): Promise<string> {
		const hash = crypto.createHash('sha256').update(verifier).digest();
		return hash.toString('base64url');
	}

	/**
	 * Extract ChatGPT account ID from JWT access token
	 */
	private extractAccountId(accessToken: string): string | undefined {
		try {
			const parts = accessToken.split('.');
			if (parts.length !== 3) return undefined;

			const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
			return payload['https://api.openai.com/chatgpt_account_id'] || payload.sub;
		} catch {
			return undefined;
		}
	}

	/**
	 * Load credentials from storage
	 */
	private async loadCredentials(): Promise<StoredCredentials | null> {
		if (this.cachedCredentials) {
			return this.cachedCredentials;
		}

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content);

			if (data['openai']) {
				this.cachedCredentials = data['openai'];
				return this.cachedCredentials;
			}

			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Save credentials to storage
	 */
	private async saveCredentials(credentials: StoredCredentials): Promise<void> {
		const dir = path.dirname(this.authPath);
		await fs.mkdir(dir, { recursive: true });

		let data: Record<string, unknown> = {};
		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			data = JSON.parse(content);
		} catch {
			// File doesn't exist
		}

		data['openai'] = credentials;

		await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
	}
}
