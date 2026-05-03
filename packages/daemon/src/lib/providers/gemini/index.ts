/**
 * Google Gemini OAuth Provider
 *
 * Public API for the Gemini OAuth provider module.
 */

export { GeminiOAuthProvider } from './gemini-provider.js';
export {
	// OAuth client
	getOAuthClientId,
	getOAuthClientSecret,
	OAUTH_SCOPES,
	REDIRECT_URI,
	buildAuthUrl,
	exchangeAuthCode,
	refreshAccessToken,
	fetchUserInfo,
	validateRefreshToken,
	loadAccounts,
	saveAccounts,
	addAccount,
	removeAccount,
	updateAccount,
	createAccount,
	InvalidTokenError,
	type GoogleOAuthAccount,
	type GoogleTokenResponse,
	type GoogleUserInfo,
	type OAuthClientDeps,
} from './oauth-client.js';
export {
	// Format converter
	anthropicToGemini,
	convertModelId,
	convertMessages,
	convertSystem,
	convertTools,
	convertSchema,
	convertToolChoice,
	convertGenerationConfig,
	convertFinishReason,
	createStreamState,
	extractTextFromCandidate,
	extractFunctionCallsFromCandidate,
	type GeminiPart,
	type GeminiContent,
	type GeminiFunctionDeclaration,
	type GeminiTool,
	type GeminiToolConfig,
	type GeminiGenerationConfig,
	type GeminiRequest,
	type GeminiCandidate,
	type GeminiUsageMetadata,
	type GeminiResponseChunk,
	type GeminiStreamState,
} from './format-converter.js';
export {
	// Account rotation
	AccountRotationManager,
	DEFAULT_ROTATION_CONFIG,
	type RotationConfig,
	type AccountStorage,
	InMemoryAccountStorage,
} from './account-rotation.js';
export {
	// Bridge server
	createGeminiBridgeServer,
	type GeminiBridgeServer,
	type GeminiBridgeConfig,
} from './bridge-server.js';
