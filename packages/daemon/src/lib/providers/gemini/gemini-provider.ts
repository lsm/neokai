/**
 * Google Gemini OAuth Provider
 *
 * Provides Anthropic-compatible bridge for Google Gemini models
 * authenticated via OAuth (Google Pro subscription credentials).
 *
 * Key features:
 * - Multiple Google account rotation with session affinity
 * - Automatic failover on rate limits (429)
 * - Account exhaustion detection and cooldown
 * - Invalid token detection and flagging
 * - Anthropic Messages API ↔ Gemini Code Assist format translation
 * - Self-contained OAuth via local callback server
 */

import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ProviderAuthStatusInfo,
	ProviderOAuthFlowData,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { createLogger } from '@neokai/shared/logger';
import {
	buildAuthUrlWithRedirect,
	exchangeAuthCode,
	fetchUserInfo,
	loadAccounts,
	type OAuthClientDeps,
	createAccount,
	addAccount as persistAddAccount,
	removeAccount as persistRemoveAccount,
} from './oauth-client.js';
import { AccountRotationManager } from './account-rotation.js';
import { createGeminiBridgeServer, type GeminiBridgeServer } from './bridge-server.js';

const log = createLogger('kai:providers:gemini');

// ---------------------------------------------------------------------------
// Gemini models
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelInfo[] = [
	{
		id: 'gemini-2.5-pro',
		name: 'Gemini 2.5 Pro',
		alias: 'gemini-2.5-pro',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Pro via Code Assist (OAuth)',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'gemini-2.5-flash',
		name: 'Gemini 2.5 Flash',
		alias: 'gemini-2.5-flash',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.5 Flash via Code Assist (OAuth)',
		releaseDate: '2025-01-01',
		available: true,
	},
	{
		id: 'gemini-2.0-flash',
		name: 'Gemini 2.0 Flash',
		alias: 'gemini-2.0-flash',
		family: 'gemini',
		provider: 'google-gemini-oauth',
		contextWindow: 1_000_000,
		description: 'Google Gemini 2.0 Flash via Code Assist (OAuth)',
		releaseDate: '2025-01-01',
		available: true,
	},
];

/** Success HTML shown in the browser after OAuth completes. */
const OAUTH_SUCCESS_HTML =
	'<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to NeoKai.</p></body></html>';

/** Error HTML shown in the browser when OAuth fails. */
const OAUTH_ERROR_HTML = (reason: string) =>
	`<html><body><h2>Authorization failed</h2><p>${reason}</p><p>You can close this tab.</p></body></html>`;

// ---------------------------------------------------------------------------
// Gemini OAuth Provider
// ---------------------------------------------------------------------------

export class GeminiOAuthProvider implements Provider {
	readonly id = 'google-gemini-oauth';
	readonly displayName = 'Google Gemini (OAuth)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: false,
		maxContextWindow: 1_000_000,
		functionCalling: true,
		vision: false,
	};

	private rotationManager: AccountRotationManager;
	private bridgeServers = new Map<string, GeminiBridgeServer>();
	private _deps?: OAuthClientDeps;
	private _pendingCodeVerifier?: string;
	private _pendingOAuthState?: string;
	private _oauthCallbackServer?: { stop(): void };
	/** Flow ID of the currently active OAuth callback server, used to prevent
	 *  stale background handlers from tearing down a newer flow's server. */
	private _activeCallbackFlowId?: string;

	constructor(deps?: OAuthClientDeps) {
		this._deps = deps;
		this.rotationManager = new AccountRotationManager({
			healthCheckOnStartup: false, // Defer to explicit initialization
		});
	}

	/**
	 * Check if this provider is available (has at least one configured account).
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const accounts = await loadAccounts();
			return accounts.some((a) => a.status !== 'invalid');
		} catch {
			return false;
		}
	}

	/**
	 * Get list of available Gemini models.
	 */
	async getModels(): Promise<ModelInfo[]> {
		return GEMINI_MODELS;
	}

	/**
	 * Check if a model ID belongs to this provider (exact match against catalog).
	 */
	ownsModel(modelId: string): boolean {
		return GEMINI_MODELS.some((m) => m.id === modelId);
	}

	/**
	 * Get model for a specific tier.
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			sonnet: 'gemini-2.5-pro',
			haiku: 'gemini-2.5-flash',
			opus: 'gemini-2.5-pro',
			default: 'gemini-2.5-pro',
		};
		return tierMap[tier];
	}

	/**
	 * Build SDK configuration for this provider.
	 *
	 * Creates a local bridge server that translates Anthropic API calls
	 * to Gemini Code Assist API calls. Returns the bridge server's URL
	 * as the ANTHROPIC_BASE_URL so the SDK routes requests through it.
	 *
	 * buildSdkConfig() is synchronous per the Provider interface.
	 * The async rotation manager initialization is deferred to the first request.
	 */
	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const sessionId = sessionConfig?.sessionId ?? 'default';

		// Create a bridge server for this session (or reuse existing)
		// Initialization of the rotation manager happens lazily on first request
		let bridge = this.bridgeServers.get(sessionId);
		if (!bridge) {
			bridge = createGeminiBridgeServer({
				rotationManager: this.rotationManager,
				fetchImpl: this._deps?.fetchImpl,
				sessionId,
			});
			this.bridgeServers.set(sessionId, bridge);
			log.info(`Bridge server started on port ${bridge.port} for session ${sessionId}`);
		}

		return {
			envVars: {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
				ANTHROPIC_API_KEY: 'gemini-oauth-placeholder',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/**
	 * Get authentication status for this provider.
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		try {
			await this.rotationManager.initialize();
			const accounts = this.rotationManager.getAccounts();

			if (accounts.length === 0) {
				return {
					isAuthenticated: false,
					method: 'oauth',
					error: 'No Google accounts configured',
				};
			}

			const activeAccounts = accounts.filter((a) => a.status === 'active');
			const invalidAccounts = accounts.filter((a) => a.status === 'invalid');

			if (activeAccounts.length === 0) {
				const exhaustedAccounts = accounts.filter((a) => a.status === 'exhausted');
				if (exhaustedAccounts.length > 0) {
					// Accounts exist but are temporarily rate-limited — still authenticated
					return {
						isAuthenticated: true,
						method: 'oauth',
						user: {
							email: exhaustedAccounts.map((a) => a.email).join(', '),
						},
					};
				}

				return {
					isAuthenticated: false,
					method: 'oauth',
					error: `All ${invalidAccounts.length} account(s) have invalid credentials`,
				};
			}

			return {
				isAuthenticated: true,
				method: 'oauth',
				user: {
					email: activeAccounts.map((a) => a.email).join(', '),
				},
			};
		} catch (error) {
			return {
				isAuthenticated: false,
				method: 'oauth',
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Start the OAuth flow for adding a new Google account.
	 *
	 * Spins up a local callback server on a random port, builds the Google
	 * OAuth URL with `http://localhost:{port}/callback` as the redirect URI,
	 * and returns the URL for the user to visit. When the user authorizes,
	 * Google redirects to the local server which automatically exchanges the
	 * code for tokens and persists the account.
	 *
	 * The caller polls `getAuthStatus()` to detect completion.
	 */
	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		// Tear down any previous callback server
		this.stopOAuthCallbackServer();

		// Start a local callback server to receive the OAuth redirect
		// State will be injected after building the auth URL
		let expectedState = '';

		// Promise that resolves when the OAuth callback delivers the auth code
		let resolveCode: ((code: string) => void) | undefined;
		const codePromise = new Promise<string>((resolve) => {
			resolveCode = resolve;
		});

		const server = Bun.serve({
			port: 0,
			idleTimeout: 255, // seconds — give the user time to authorize
			fetch(req: Request): Response {
				const url = new URL(req.url);

				if (url.pathname === '/favicon.ico') {
					return new Response('', { status: 204 });
				}

				const error = url.searchParams.get('error');
				if (error) {
					return new Response(OAUTH_ERROR_HTML(error), {
						status: 400,
						headers: { 'Content-Type': 'text/html' },
					});
				}

				// Validate state parameter to prevent CSRF
				const returnedState = url.searchParams.get('state');
				if (!returnedState || returnedState !== expectedState) {
					return new Response(OAUTH_ERROR_HTML('Invalid OAuth state parameter'), {
						status: 403,
						headers: { 'Content-Type': 'text/html' },
					});
				}

				const code = url.searchParams.get('code');
				if (!code) {
					return new Response(OAUTH_ERROR_HTML('Missing authorization code'), {
						status: 400,
						headers: { 'Content-Type': 'text/html' },
					});
				}

				// Resolve the promise so the background exchanger can proceed
				resolveCode?.(code);

				return new Response(OAUTH_SUCCESS_HTML, {
					status: 200,
					headers: { 'Content-Type': 'text/html' },
				});
			},
		});

		const callbackPort = server.port ?? 0;
		const redirectUri = `http://localhost:${callbackPort}/callback`;

		// Build the auth URL with the local callback redirect URI.
		// If URL generation fails (e.g. missing OAuth env vars), stop the
		// server before rethrowing so we don't leak an orphaned server.
		let authUrl: string;
		let codeVerifier: string;
		let state: string;
		try {
			({ authUrl, codeVerifier, state } = await buildAuthUrlWithRedirect(redirectUri));
		} catch (err) {
			server.stop();
			this._oauthCallbackServer = undefined;
			throw err;
		}

		expectedState = state;
		this._pendingCodeVerifier = codeVerifier;
		this._pendingOAuthState = state;

		// Assign a unique flow ID so the background handler only tears down
		// its own server (not a newer login flow's server).
		const flowId = crypto.randomUUID();
		this._oauthCallbackServer = server;
		this._activeCallbackFlowId = flowId;

		// Start background code exchange — runs after the user authorizes
		this.handleOAuthCallback(codePromise, codeVerifier, redirectUri, flowId);

		return {
			type: 'redirect',
			authUrl,
			message:
				'Visit the URL to authorize your Google account. The page will redirect automatically.',
		};
	}

	/**
	 * Background handler: waits for the OAuth code from the callback server,
	 * exchanges it for tokens, and saves the account.
	 *
	 * @param flowId - Unique ID for this login flow; the finally block only
	 *   tears down the callback server if it still belongs to this flow.
	 */
	private async handleOAuthCallback(
		codePromise: Promise<string>,
		codeVerifier: string,
		redirectUri: string,
		flowId: string
	): Promise<void> {
		try {
			// Wait for the code with a 240-second timeout (allows MFA and account switching)
			const code = await Promise.race([
				codePromise,
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 240_000)),
			]);

			if (!code) {
				log.warn('OAuth callback timed out — no code received within 240 seconds');
				return;
			}

			this._pendingCodeVerifier = undefined;
			this._pendingOAuthState = undefined;
			// Only shut down the server if this flow still owns it
			if (this._activeCallbackFlowId === flowId) {
				this.stopOAuthCallbackServer();
				this._activeCallbackFlowId = undefined;
			}

			const tokenResponse = await exchangeAuthCode(code, codeVerifier, this._deps, redirectUri);

			if (!tokenResponse.refresh_token) {
				log.error('No refresh token received from Google OAuth');
				return;
			}

			const userInfo = await fetchUserInfo(tokenResponse.access_token, this._deps);
			const account = createAccount(userInfo.email, tokenResponse.refresh_token, 1500);

			await persistAddAccount(account);
			await this.rotationManager.addAccount(account);

			log.info(`Added Google account via OAuth callback: ${userInfo.email}`);
		} catch (err) {
			log.error(`OAuth code exchange failed: ${err instanceof Error ? err.message : err}`);
		} finally {
			// Only tear down the server if this flow still owns it.
			// A newer startOAuthFlow() call may have replaced it.
			if (this._activeCallbackFlowId === flowId) {
				this.stopOAuthCallbackServer();
				this._activeCallbackFlowId = undefined;
			}
		}
	}

	/**
	 * Complete the OAuth flow by exchanging the authorization code.
	 *
	 * Kept for backward compatibility and manual code entry scenarios,
	 * but the primary flow uses the local callback server in startOAuthFlow().
	 */
	async completeOAuthFlow(authCode: string): Promise<{ email: string; accountId: string }> {
		if (!this._pendingCodeVerifier) {
			throw new Error('No pending OAuth flow. Call startOAuthFlow() first.');
		}

		const codeVerifier = this._pendingCodeVerifier;
		this._pendingCodeVerifier = undefined;

		// Exchange code for tokens
		const tokenResponse = await exchangeAuthCode(authCode, codeVerifier, this._deps);

		if (!tokenResponse.refresh_token) {
			throw new Error('No refresh token received from Google OAuth. Please try again.');
		}

		// Fetch user info
		const userInfo = await fetchUserInfo(tokenResponse.access_token, this._deps);

		// Create and store the account
		const account = createAccount(userInfo.email, tokenResponse.refresh_token, 1500);

		await persistAddAccount(account);
		await this.rotationManager.addAccount(account);

		log.info(`Added Google account: ${userInfo.email}`);
		return { email: userInfo.email, accountId: account.id };
	}

	/**
	 * Remove a Google account.
	 */
	async removeAccount(accountId: string): Promise<void> {
		await persistRemoveAccount(accountId);
		await this.rotationManager.removeAccount(accountId);
		log.info(`Removed Google account: ${accountId}`);
	}

	/**
	 * Logout — removes all accounts and tears down active bridge servers.
	 */
	async logout(): Promise<void> {
		const accounts = await loadAccounts();
		for (const account of accounts) {
			await persistRemoveAccount(account.id);
		}
		// Tear down active bridge servers so they stop using the old rotation manager
		await this.shutdown();
		this.stopOAuthCallbackServer();
		this.rotationManager = new AccountRotationManager();
		log.info('Logged out all Google accounts');
	}

	/**
	 * Shut down all bridge servers.
	 */
	async shutdown(): Promise<void> {
		for (const [sessionId, bridge] of this.bridgeServers.entries()) {
			log.info(`Shutting down bridge server for session ${sessionId}`);
			bridge.stop();
		}
		this.bridgeServers.clear();
	}

	/**
	 * Stop the OAuth callback server if running.
	 */
	private stopOAuthCallbackServer(): void {
		if (this._oauthCallbackServer) {
			this._oauthCallbackServer.stop();
			this._oauthCallbackServer = undefined;
		}
	}

	/**
	 * Get the rotation manager (for testing).
	 */
	getRotationManager(): AccountRotationManager {
		return this.rotationManager;
	}

	/**
	 * Set the code verifier (for testing or pre-seeded flows).
	 */
	setCodeVerifier(verifier: string): void {
		this._pendingCodeVerifier = verifier;
	}
}
