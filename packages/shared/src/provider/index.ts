/**
 * Multi-Provider Architecture
 */

export type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderId,
	ProviderInfo,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
	ProviderAuthStatusInfo,
	ProviderOAuthFlowData,
} from './types.js';

export type {
	ProviderAuthStatus,
	ProviderAuthRequest,
	ProviderAuthResponse,
	ProviderLogoutRequest,
	ProviderRefreshRequest,
	ProviderRefreshResponse,
	ListProviderAuthStatusResponse,
	OAuthFlowData,
	GeminiAccountStatus,
	GeminiAccountInfo,
	ListGeminiAccountsResponse,
	StartGeminiOAuthRequest,
	StartGeminiOAuthResponse,
	CompleteGeminiOAuthRequest,
	CompleteGeminiOAuthResponse,
	RemoveGeminiAccountRequest,
	RemoveGeminiAccountResponse,
} from './auth-types.js';
