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

/** TTL for pending OAuth flows — 10 minutes. */
const FLOW_TTL_MS = 10 * 60 * 1000;

interface PendingFlow {
	codeVerifier: string;
	reauthAccountId?: string;
	createdAt: number;
}

/** Active OAuth code verifiers keyed by a flow ID. */
const pendingFlows = new Map<string, PendingFlow>();

/** Evict expired flows (called lazily on start/complete). */
function evictExpiredFlows(): void {
	const now = Date.now();
	for (const [id, flow] of pendingFlows) {
		if (now - flow.createdAt > FLOW_TTL_MS) {
			pendingFlows.delete(id);
		}
	}
}

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
	 *
	 * Note: Flows are held in-process only; a daemon restart mid-flow
	 * will lose the pending verifier and the user must start a new flow.
	 */
	messageHub.onRequest(
		'auth.gemini.startOAuth',
		async (req: StartGeminiOAuthRequest): Promise<StartGeminiOAuthResponse> => {
			evictExpiredFlows();
			try {
				const { authUrl, codeVerifier } = await buildAuthUrl();
				const flowId = crypto.randomUUID();
				pendingFlows.set(flowId, {
					codeVerifier,
					reauthAccountId: req.accountId,
					createdAt: Date.now(),
				});

				return {
					success: true,
					authUrl,
					flowId,
					message: 'Visit the URL to authorize your Google account, then paste the auth code.',
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
	 * the account is persisted and the flow is cleaned up. The in-memory
	 * rotation manager is kept in sync so sessions pick up changes immediately.
	 */
	messageHub.onRequest(
		'auth.gemini.completeOAuth',
		async (req: CompleteGeminiOAuthRequest): Promise<CompleteGeminiOAuthResponse> => {
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

			// Check TTL
			if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
				pendingFlows.delete(flowId);
				return {
					success: false,
					error: 'OAuth flow expired. Please start a new one.',
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

				// Helper to sync the rotation manager with the updated account list.
				// Uses reload() (not initialize()) to bypass the one-time initialized guard
				// so the in-memory pool picks up changes immediately.
				const syncRotationManager = async () => {
					const registry = getProviderRegistry();
					const provider = registry.get('google-gemini-oauth');
					if (provider && 'getRotationManager' in provider) {
						const rm = (
							provider as { getRotationManager: () => { reload: () => Promise<void> } }
						).getRotationManager();
						await rm.reload();
					}
				};

				// If this is a re-auth flow, update the existing account
				if (flow.reauthAccountId) {
					// Verify the authenticated email matches the target account
					const existingAccounts = await loadAccounts();
					const targetAccount = existingAccounts.find((a) => a.id === flow.reauthAccountId);
					if (targetAccount && targetAccount.email !== userInfo.email) {
						pendingFlows.delete(flowId);
						return {
							success: false,
							error: `Authenticated email (${userInfo.email}) does not match account email (${targetAccount.email}). Please use the correct Google account.`,
						};
					}

					await updateAccount(flow.reauthAccountId, {
						refresh_token: tokenResponse.refresh_token,
						status: 'active',
						cooldown_until: 0,
					});
					pendingFlows.delete(flowId);
					await syncRotationManager();
					log.info(`Re-authenticated Google account: ${userInfo.email}`);
					const accounts = await loadAccounts();
					const updated = accounts.find((a) => a.id === flow.reauthAccountId);
					return {
						success: true,
						account: updated ? accountToInfo(updated) : undefined,
					};
				}

				// New account — check for duplicate email
				const existingAccounts = await loadAccounts();
				if (existingAccounts.some((a) => a.email === userInfo.email)) {
					pendingFlows.delete(flowId);
					return {
						success: false,
						error: `Account ${userInfo.email} already exists. Remove it first or use re-authenticate.`,
					};
				}

				const account = createAccount(userInfo.email, tokenResponse.refresh_token);
				await persistAddAccount(account);
				pendingFlows.delete(flowId);
				await syncRotationManager();

				log.info(`Added Google account via headless OAuth: ${userInfo.email}`);
				return {
					success: true,
					account: accountToInfo(account),
				};
			} catch (error) {
				// Do NOT delete the flow here — the PKCE code verifier is still valid.
				// The exchange may have failed due to a bad/expired auth code or a
				// transient network error. Keeping the flow alive lets the user visit
				// the auth URL again (getting a fresh single-use code) and retry with
				// the same flowId rather than having to restart the whole OAuth flow.
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
				// Sync the in-memory rotation manager so active sessions stop using this account
				const registry = getProviderRegistry();
				const provider = registry.get('google-gemini-oauth');
				if (provider && 'getRotationManager' in provider) {
					const rm = (
						provider as {
							getRotationManager: () => { removeAccount: (id: string) => Promise<void> };
						}
					).getRotationManager();
					await rm.removeAccount(req.accountId);
				}
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
