/**
 * Provider Authentication Types
 *
 * Types for provider OAuth/API key authentication flows.
 * Used by both daemon (backend) and web (frontend) packages.
 */

/**
 * Authentication status for a single provider
 */
export interface ProviderAuthStatus {
	/** Provider identifier */
	id: string;
	/** Human-readable display name */
	displayName: string;
	/** Whether the provider is authenticated */
	isAuthenticated: boolean;
	/** Authentication method used */
	method?: 'api_key' | 'oauth';
	/** Token expiration timestamp (Unix ms) */
	expiresAt?: number;
	/** Whether token needs refresh */
	needsRefresh?: boolean;
	/** User information (if available) */
	user?: {
		email?: string;
		name?: string;
	};
	/** Error message if authentication failed */
	error?: string;
}

/**
 * Request to initiate authentication for a provider
 */
export interface ProviderAuthRequest {
	/** Provider identifier */
	providerId: string;
}

/**
 * Response from initiating authentication
 */
export interface ProviderAuthResponse {
	/** Whether the auth initiation was successful */
	success: boolean;
	/** URL to open in browser (for OAuth redirect flow like OpenAI) */
	authUrl?: string;
	/** User code to display (for device flow like GitHub Copilot) */
	userCode?: string;
	/** Verification URL for device flow */
	verificationUri?: string;
	/** Human-readable message */
	message?: string;
	/** Error message if failed */
	error?: string;
}

/**
 * Request to logout from a provider
 */
export interface ProviderLogoutRequest {
	/** Provider identifier */
	providerId: string;
}

/**
 * Request to refresh token for a provider
 */
export interface ProviderRefreshRequest {
	/** Provider identifier */
	providerId: string;
}

/**
 * Response from refreshing provider token
 */
export interface ProviderRefreshResponse {
	/** Whether the refresh was successful */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Response from listing provider auth statuses
 */
export interface ListProviderAuthStatusResponse {
	/** List of provider authentication statuses */
	providers: ProviderAuthStatus[];
}

/**
 * Internal type for OAuth flow data
 * Used by providers to return flow-specific data
 */
export interface OAuthFlowData {
	/** Flow type */
	type: 'redirect' | 'device';
	/** For redirect flow: URL to open in browser */
	authUrl?: string;
	/** For device flow: user code to display */
	userCode?: string;
	/** For device flow: verification URL */
	verificationUri?: string;
	/** Human-readable message */
	message: string;
}

// ---------------------------------------------------------------------------
// Gemini OAuth Account Management Types
// ---------------------------------------------------------------------------

/**
 * Account status indicator for Gemini OAuth accounts
 */
export type GeminiAccountStatus = 'active' | 'exhausted' | 'invalid';

/**
 * Gemini OAuth account info for UI display (excludes sensitive tokens)
 */
export interface GeminiAccountInfo {
	/** Unique account identifier */
	id: string;
	/** Google account email */
	email: string;
	/** Account status */
	status: GeminiAccountStatus;
	/** ISO timestamp when account was added */
	addedAt: number;
	/** ISO timestamp when account was last used (0 = never) */
	lastUsedAt: number;
	/** Number of requests made today */
	dailyRequestCount: number;
	/** Daily request limit for this account */
	dailyLimit: number;
	/** Cooldown until timestamp (Unix ms). 0 = no cooldown */
	cooldownUntil: number;
}

/**
 * Response from listing Gemini OAuth accounts
 */
export interface ListGeminiAccountsResponse {
	accounts: GeminiAccountInfo[];
}

/**
 * Request to start a headless Gemini OAuth flow
 */
export interface StartGeminiOAuthRequest {
	/** Optional account ID to re-authenticate (for re-auth flows) */
	accountId?: string;
}

/**
 * Response from starting a Gemini OAuth flow
 */
export interface StartGeminiOAuthResponse {
	/** Whether the flow was initiated successfully */
	success: boolean;
	/** Auth URL for the user to visit */
	authUrl?: string;
	/** Flow ID used to correlate start → complete (passed back in completeOAuth) */
	flowId?: string;
	/** Human-readable message / instructions */
	message?: string;
	/** Error message if failed */
	error?: string;
}

/**
 * Request to complete a Gemini OAuth flow with auth code
 */
export interface CompleteGeminiOAuthRequest {
	/** The authorization code from Google */
	authCode: string;
	/** Flow ID returned by startOAuth, used to look up the stored PKCE verifier */
	flowId: string;
}

/**
 * Response from completing a Gemini OAuth flow
 */
export interface CompleteGeminiOAuthResponse {
	/** Whether the account was added successfully */
	success: boolean;
	/** Added account info */
	account?: GeminiAccountInfo;
	/** Error message if failed */
	error?: string;
}

/**
 * Request to remove a Gemini OAuth account
 */
export interface RemoveGeminiAccountRequest {
	/** Account ID to remove */
	accountId: string;
}

/**
 * Response from removing a Gemini OAuth account
 */
export interface RemoveGeminiAccountResponse {
	/** Whether the account was removed successfully */
	success: boolean;
	/** Error message if failed */
	error?: string;
}
