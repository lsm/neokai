/**
 * Auth RPC Handlers
 *
 * Handles authentication-related RPC calls including:
 * - NeoKai auth status (Anthropic API key / OAuth)
 * - Provider auth status (OpenAI, GitHub Copilot, etc.)
 * - Provider OAuth login/logout
 * - Gemini OAuth account management (add, list, remove, re-auth)
 */

import type { MessageHub } from '@neokai/shared';
import type {
	ProviderAuthStatus,
	ProviderAuthResponse,
	ProviderAuthRequest,
	ProviderLogoutRequest,
	ProviderRefreshRequest,
	ProviderRefreshResponse,
	ListProviderAuthStatusResponse,
	ListGeminiAccountsResponse,
	GeminiAccountInfo,
	StartGeminiOAuthRequest,
	StartGeminiOAuthResponse,
	CompleteGeminiOAuthRequest,
	CompleteGeminiOAuthResponse,
	RemoveGeminiAccountRequest,
	RemoveGeminiAccountResponse,
} from '@neokai/shared/provider';
import type { AuthManager } from '../auth-manager';
import { getProviderRegistry } from '../providers/registry';
import { Logger } from '../logger';
import {
	buildAuthUrl,
	exchangeAuthCode,
	fetchUserInfo,
	loadAccounts,
	createAccount,
	addAccount as persistAddAccount,
	removeAccount as persistRemoveAccount,
	updateAccount,
	type GoogleOAuthAccount,
} from '../providers/gemini/oauth-client.js';

const log = new Logger('auth-handlers');

/** Active OAuth code verifiers keyed by a flow ID. */
const pendingFlows = new Map<string, { codeVerifier: string; reauthAccountId?: string }>();

/**
 * Convert a GoogleOAuthAccount to a GeminiAccountInfo (strips sensitive tokens).
 */
function accountToInfo(account: GoogleOAuthAccount): GeminiAccountInfo {
	return {
		id: account.id,
		email: account.email,
		status: account.status,
		addedAt: account.added_at,
		lastUsedAt: account.last_used_at,
		dailyRequestCount: account.daily_request_count,
		dailyLimit: account.daily_limit,
		cooldownUntil: account.cooldown_until,
	};
}

/**
 * Setup authentication-related RPC handlers
 */
export function setupAuthHandlers(messageHub: MessageHub, authManager: AuthManager): void {
	// NeoKai auth status (Anthropic)
	messageHub.onRequest('auth.status', async () => {
		const authStatus = await authManager.getAuthStatus();
		return { authStatus };
	});

	// List all providers with their auth status
	messageHub.onRequest('auth.providers', async (): Promise<ListProviderAuthStatusResponse> => {
		const registry = getProviderRegistry();
		const providers = registry.getAll();

		const providerStatuses: ProviderAuthStatus[] = await Promise.all(
			providers.map(async (provider) => {
				// Get auth status if provider supports it
				let authStatus: ProviderAuthStatus = {
					id: provider.id,
					displayName: provider.displayName,
					isAuthenticated: false,
				};

				try {
					if (provider.getAuthStatus) {
						const status = await provider.getAuthStatus();
						authStatus = {
							id: provider.id,
							displayName: provider.displayName,
							isAuthenticated: status.isAuthenticated,
							method: status.method,
							expiresAt: status.expiresAt,
							needsRefresh: status.needsRefresh,
							user: status.user,
							error: status.error,
						};
					} else {
						// Fallback: use isAvailable()
						const available = await provider.isAvailable();
						authStatus = {
							id: provider.id,
							displayName: provider.displayName,
							isAuthenticated: available,
						};
					}
				} catch (error) {
					log.error(`Failed to get auth status for ${provider.id}:`, error);
					authStatus = {
						id: provider.id,
						displayName: provider.displayName,
						isAuthenticated: false,
						error: error instanceof Error ? error.message : 'Unknown error',
					};
				}

				return authStatus;
			})
		);

		return { providers: providerStatuses };
	});

	// Initiate OAuth login for a provider
	messageHub.onRequest(
		'auth.login',
		async (req: ProviderAuthRequest): Promise<ProviderAuthResponse> => {
			const { providerId } = req;
			const registry = getProviderRegistry();

			const provider = registry.get(providerId);
			if (!provider) {
				return {
					success: false,
					error: `Provider not found: ${providerId}`,
				};
			}

			if (!provider.startOAuthFlow) {
				return {
					success: false,
					error: `Provider ${providerId} does not support OAuth login`,
				};
			}

			try {
				const flowData = await provider.startOAuthFlow();

				return {
					success: true,
					authUrl: flowData.authUrl,
					userCode: flowData.userCode,
					verificationUri: flowData.verificationUri,
					message: flowData.message,
				};
			} catch (error) {
				log.error(`OAuth login failed for ${providerId}:`, error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'OAuth login failed',
				};
			}
		}
	);

	// Logout from a provider
	messageHub.onRequest(
		'auth.logout',
		async (req: ProviderLogoutRequest): Promise<{ success: boolean; error?: string }> => {
			const { providerId } = req;
			const registry = getProviderRegistry();

			const provider = registry.get(providerId);
			if (!provider) {
				return {
					success: false,
					error: `Provider not found: ${providerId}`,
				};
			}

			if (!provider.logout) {
				return {
					success: false,
					error: `Provider ${providerId} does not support logout`,
				};
			}

			try {
				await provider.logout();
				return { success: true };
			} catch (error) {
				log.error(`Logout failed for ${providerId}:`, error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Logout failed',
				};
			}
		}
	);

	// Refresh token for a provider
	messageHub.onRequest(
		'auth.refresh',
		async (req: ProviderRefreshRequest): Promise<ProviderRefreshResponse> => {
			const { providerId } = req;
			const registry = getProviderRegistry();

			const provider = registry.get(providerId);
			if (!provider) {
				return {
					success: false,
					error: `Provider not found: ${providerId}`,
				};
			}

			if (!provider.refreshToken) {
				return {
					success: false,
					error: `Provider ${providerId} does not support token refresh`,
				};
			}

			try {
				const refreshed = await provider.refreshToken();
				if (!refreshed) {
					return {
						success: false,
						error: 'Token refresh failed. Please try logging out and logging in again.',
					};
				}
				return { success: true };
			} catch (error) {
				log.error(`Token refresh failed for ${providerId}:`, error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Token refresh failed',
				};
			}
		}
	);

	// =========================================================================
	// Gemini OAuth Account Management
	// =========================================================================

	/**
	 * List all configured Gemini OAuth accounts (without sensitive tokens).
	 */
	messageHub.onRequest('auth.gemini.accounts', async (): Promise<ListGeminiAccountsResponse> => {
		try {
			const accounts = await loadAccounts();
			return { accounts: accounts.map(accountToInfo) };
		} catch {
			return { accounts: [] };
		}
	});

	/**
	 * Start a headless Gemini OAuth flow.
	 *
	 * Generates an auth URL with the headless redirect URI and stores the
	 * PKCE code verifier for later exchange. Returns the URL for the UI
	 * to display to the user.
	 */
	messageHub.onRequest(
		'auth.gemini.startOAuth',
		async (req: StartGeminiOAuthRequest): Promise<StartGeminiOAuthResponse> => {
			try {
				const { authUrl, codeVerifier } = await buildAuthUrl();
				const flowId = crypto.randomUUID();
				pendingFlows.set(flowId, {
					codeVerifier,
					reauthAccountId: req.accountId,
				});

				return {
					success: true,
					authUrl,
					message: flowId,
				};
			} catch (error) {
				log.error('Failed to start Gemini OAuth flow:', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to start OAuth flow',
				};
			}
		}
	);

	/**
	 * Complete a Gemini OAuth flow by exchanging the auth code for tokens.
	 *
	 * The flow ID maps to the stored PKCE verifier. After successful exchange,
	 * the account is persisted and the flow is cleaned up.
	 */
	messageHub.onRequest(
		'auth.gemini.completeOAuth',
		async (
			req: CompleteGeminiOAuthRequest & { flowId?: string }
		): Promise<CompleteGeminiOAuthResponse> => {
			const { authCode, flowId } = req;
			if (!authCode) {
				return { success: false, error: 'Authorization code is required' };
			}
			if (!flowId) {
				return { success: false, error: 'Flow ID is required' };
			}

			const flow = pendingFlows.get(flowId);
			if (!flow) {
				return {
					success: false,
					error: 'No pending OAuth flow found. Please start a new one.',
				};
			}

			try {
				const tokenResponse = await exchangeAuthCode(authCode, flow.codeVerifier);

				if (!tokenResponse.refresh_token) {
					pendingFlows.delete(flowId);
					return {
						success: false,
						error: 'No refresh token received. Please ensure you grant all permissions.',
					};
				}

				const userInfo = await fetchUserInfo(tokenResponse.access_token);

				// If this is a re-auth flow, update the existing account
				if (flow.reauthAccountId) {
					const accounts = await loadAccounts();
					const existing = accounts.find((a) => a.id === flow.reauthAccountId);
					if (existing) {
						await updateAccount(flow.reauthAccountId, {
							refresh_token: tokenResponse.refresh_token,
							status: 'active',
							cooldown_until: 0,
						});
						const updated = (await loadAccounts()).find((a) => a.id === flow.reauthAccountId);
						pendingFlows.delete(flowId);
						log.info(`Re-authenticated Google account: ${userInfo.email}`);
						return {
							success: true,
							account: updated ? accountToInfo(updated) : undefined,
						};
					}
				}

				// New account
				const account = createAccount(userInfo.email, tokenResponse.refresh_token);
				await persistAddAccount(account);
				pendingFlows.delete(flowId);

				log.info(`Added Google account via headless OAuth: ${userInfo.email}`);
				return {
					success: true,
					account: accountToInfo(account),
				};
			} catch (error) {
				pendingFlows.delete(flowId);
				log.error('Gemini OAuth code exchange failed:', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to exchange auth code',
				};
			}
		}
	);

	/**
	 * Remove a Gemini OAuth account by ID.
	 */
	messageHub.onRequest(
		'auth.gemini.removeAccount',
		async (req: RemoveGeminiAccountRequest): Promise<RemoveGeminiAccountResponse> => {
			try {
				await persistRemoveAccount(req.accountId);
				log.info(`Removed Gemini OAuth account: ${req.accountId}`);
				return { success: true };
			} catch (error) {
				log.error('Failed to remove Gemini OAuth account:', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to remove account',
				};
			}
		}
	);
}
