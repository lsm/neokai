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
	buildAuthUrl,
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
	 * Check if a model ID belongs to this provider.
	 */
	ownsModel(modelId: string): boolean {
		return modelId.startsWith('gemini-');
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
	 * Returns a redirect-type flow with the auth URL the user should visit.
	 */
	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		const { authUrl, codeVerifier } = await buildAuthUrl();

		// Store the code verifier temporarily for the callback
		// In a real implementation, this would be stored in session state
		this._pendingCodeVerifier = codeVerifier;

		return {
			type: 'redirect',
			authUrl,
			message:
				'Visit the URL to authorize your Google account, then provide the authorization code.',
		};
	}

	/**
	 * Complete the OAuth flow by exchanging the authorization code.
	 *
	 * This is called separately after startOAuthFlow() once the user
	 * provides the authorization code from the Google consent page.
	 */
	async completeOAuthFlow(authCode: string): Promise<{ email: string; accountId: string }> {
		if (!this._pendingCodeVerifier) {
			throw new Error('No pending OAuth flow. Call startOAuthFlow() first.');
		}

		const codeVerifier = this._pendingCodeVerifier;
		this._pendingCodeVerifier = undefined;

		// Exchange code for tokens
		const tokenResponse = await exchangeAuthCode(authCode, codeVerifier, this._deps);

		// Fetch user info
		const userInfo = await fetchUserInfo(tokenResponse.access_token, this._deps);

		// Create and store the account
		const account = createAccount(
			userInfo.email,
			tokenResponse.refresh_token ?? '', // Should always be present with offline access
			1500
		);

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
	 * Logout — removes all accounts.
	 */
	async logout(): Promise<void> {
		const accounts = await loadAccounts();
		for (const account of accounts) {
			await persistRemoveAccount(account.id);
		}
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
	 * Get the rotation manager (for testing).
	 */
	getRotationManager(): AccountRotationManager {
		return this.rotationManager;
	}

	/** Pending PKCE code verifier for the in-progress OAuth flow. */
	private _pendingCodeVerifier?: string;

	/**
	 * Set the code verifier (for testing or pre-seeded flows).
	 */
	setCodeVerifier(verifier: string): void {
		this._pendingCodeVerifier = verifier;
	}
}
