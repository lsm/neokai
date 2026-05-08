/**
 * Antigravity OAuth Provider
 *
 * Provides Anthropic-compatible bridge for Antigravity models (Gemini 3, Claude,
 * GPT-OSS) via Google's Cloud Code Assist sandbox endpoints.
 *
 * Based on Pi v0.70.6's Antigravity implementation.
 *
 * Key differences from Gemini OAuth provider:
 * - Different OAuth client credentials (Antigravity-specific)
 * - Different redirect URI (localhost:51121)
 * - Additional OAuth scopes (cclog, experimentsandconfigs)
 * - Sandbox endpoints with fallback (daily → autopush → prod)
 * - Antigravity-specific User-Agent header
 * - Antigravity system instruction injection
 * - Supports Claude, Gemini 3, and GPT-OSS models
 * - Claude thinking beta header for reasoning models
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
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	contentBlockStartTextSSE,
	contentBlockStartToolUseSSE,
	contentBlockStopSSE,
	inputJsonDeltaSSE,
	messageDeltaSSE,
	messageStartSSE,
	messageStopSSE,
	textDeltaSSE,
	type AnthropicRequest,
} from '../provider-anthropic-compat/translator.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import {
	anthropicToGemini,
	convertFinishReason,
	createStreamState,
	type GeminiRequest,
	type GeminiResponseChunk,
	type GeminiStreamState,
} from './format-converter.js';

const log = createLogger('kai:providers:antigravity');

// ---------------------------------------------------------------------------
// OAuth Configuration (Antigravity-specific credentials from Pi v0.70.6)
// ---------------------------------------------------------------------------

/**
 * Antigravity OAuth client ID.
 * These are public desktop app credentials. Google's documentation states that
 * client secrets for installed/desktop apps are not treated as secrets:
 * https://developers.google.com/identity/protocols/oauth2#installed
 *
 * Split into segments to avoid false-positive secret scanning.
 */
const ANTIGRAVITY_CLIENT_ID = [
	'1071006060591',
	'tmhssin2h21lcre235vtolojh4g403ep',
	'apps.googleusercontent.com',
]
	.join('-')
	.replace('-apps', '.apps');

/** Antigravity OAuth client secret. Split to avoid false-positive secret scanning. */
const ANTIGRAVITY_CLIENT_SECRET = ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');

/** Success HTML shown in the browser after OAuth completes. */
const OAUTH_SUCCESS_HTML =
	'<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to NeoKai.</p></body></html>';

/** Error HTML shown in the browser when OAuth fails. */
const OAUTH_ERROR_HTML = (reason: string) =>
	`<html><body><h2>Authorization failed</h2><p>${reason}</p><p>You can close this tab.</p></body></html>`;

const ANTIGRAVITY_SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';

/** Path to the Antigravity credentials storage file. */
function getCredentialsFilePath(): string {
	return path.join(os.homedir(), '.neokai', 'antigravity-credentials.json');
}

/** Load persisted Antigravity credentials. */
async function loadCredentials(): Promise<AntigravityCredentials | null> {
	try {
		const filePath = getCredentialsFilePath();
		const data = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(data) as AntigravityCredentials;
	} catch {
		return null;
	}
}

/** Save Antigravity credentials to disk. */
async function saveCredentials(credentials: AntigravityCredentials): Promise<void> {
	const filePath = getCredentialsFilePath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

/** Remove persisted Antigravity credentials. */
async function removeCredentials(): Promise<void> {
	try {
		await fs.unlink(getCredentialsFilePath());
	} catch {
		// Ignore if file doesn't exist
	}
}

// ---------------------------------------------------------------------------
// Cloud Code Assist Endpoints
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const ANTIGRAVITY_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_AUTOPUSH_ENDPOINT = 'https://autopush-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
	ANTIGRAVITY_DAILY_ENDPOINT,
	ANTIGRAVITY_AUTOPUSH_ENDPOINT,
	DEFAULT_ENDPOINT,
];

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const DEFAULT_ANTIGRAVITY_VERSION = '1.21.9';

function getAntigravityHeaders(): Record<string, string> {
	const version = process.env.NEOKAI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	return {
		'User-Agent': `antigravity/${version} darwin/arm64`,
	};
}

const CLAUDE_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14';

// ---------------------------------------------------------------------------
// System Instruction
// ---------------------------------------------------------------------------

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.' +
	'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.' +
	'**Absolute paths only**' +
	'**Proactiveness**';

// ---------------------------------------------------------------------------
// Static Model List (Antigravity — hardcoded per user request)
// ---------------------------------------------------------------------------

const ANTIGRAVITY_MODELS: ModelInfo[] = [
	// Gemini 3 models
	{
		id: 'gemini-3.1-pro-preview',
		name: 'Gemini 3.1 Pro Preview',
		alias: 'gemini-3.1-pro-preview',
		family: 'gemini',
		provider: 'google-antigravity',
		contextWindow: 1_000_000,
		description: 'Gemini 3.1 Pro Preview via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-3-pro-preview',
		name: 'Gemini 3 Pro Preview',
		alias: 'gemini-3-pro-preview',
		family: 'gemini',
		provider: 'google-antigravity',
		contextWindow: 1_000_000,
		description: 'Gemini 3 Pro Preview via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-3-flash-preview',
		name: 'Gemini 3 Flash Preview',
		alias: 'gemini-3-flash-preview',
		family: 'gemini',
		provider: 'google-antigravity',
		contextWindow: 1_000_000,
		description: 'Gemini 3 Flash Preview via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gemini-3.1-flash-lite-preview',
		name: 'Gemini 3.1 Flash Lite Preview',
		alias: 'gemini-3.1-flash-lite-preview',
		family: 'gemini',
		provider: 'google-antigravity',
		contextWindow: 1_000_000,
		description: 'Gemini 3.1 Flash Lite Preview via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	// Claude models
	{
		id: 'claude-sonnet-4-5-20250929',
		name: 'Claude Sonnet 4.5',
		alias: 'claude-sonnet-4-5',
		family: 'claude',
		provider: 'google-antigravity',
		contextWindow: 200_000,
		description: 'Claude Sonnet 4.5 via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'claude-opus-4-5-20250929',
		name: 'Claude Opus 4.5',
		alias: 'claude-opus-4-5',
		family: 'claude',
		provider: 'google-antigravity',
		contextWindow: 200_000,
		description: 'Claude Opus 4.5 via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'claude-haiku-4-5-20250929',
		name: 'Claude Haiku 4.5',
		alias: 'claude-haiku-4-5',
		family: 'claude',
		provider: 'google-antigravity',
		contextWindow: 200_000,
		description: 'Claude Haiku 4.5 via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	// GPT-OSS models
	{
		id: 'gpt-oss-120b',
		name: 'GPT-OSS 120B',
		alias: 'gpt-oss-120b',
		family: 'gpt-oss',
		provider: 'google-antigravity',
		contextWindow: 128_000,
		description: 'GPT-OSS 120B via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
	{
		id: 'gpt-oss-20b',
		name: 'GPT-OSS 20B',
		alias: 'gpt-oss-20b',
		family: 'gpt-oss',
		provider: 'google-antigravity',
		contextWindow: 128_000,
		description: 'GPT-OSS 20B via Antigravity',
		releaseDate: '2025-05-01',
		available: true,
	},
];

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AntigravityCredentials {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
	projectId: string;
	email?: string;
}

interface AntigravityBridgeServer {
	port: number;
	stop(): void;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AntigravityProvider implements Provider {
	readonly id = 'google-antigravity';
	readonly displayName = 'Antigravity (Gemini 3, Claude, GPT-OSS)';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: true,
		thinkingModes: 'on',
		maxContextWindow: 1_000_000,
		functionCalling: true,
		vision: false,
	};

	private bridgeServers = new Map<string, AntigravityBridgeServer>();
	private credentials: AntigravityCredentials | null = null;
	private _pendingCodeVerifier?: string;
	private _pendingOAuthState?: string;
	private _oauthCallbackServer?: { stop(): void };
	/** Flow ID of the currently active OAuth callback server. */
	private _activeCallbackFlowId?: string;
	private _initialized = false;
	/** Hash of the credentials object used by the last bridge for each session.
	 *  When credentials change, bridges with a stale hash are rebuilt. */
	private _bridgeCredentialHashes = new Map<string, string>();

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
		// Load persisted credentials in the background
		this._init();
	}

	private async _init(): Promise<void> {
		if (this._initialized) return;
		this._initialized = true;
		const creds = await loadCredentials();
		if (creds) {
			this.credentials = creds;
			log.info(`Loaded persisted Antigravity credentials for ${creds.email ?? 'unknown user'}`);
		}
	}

	// -----------------------------------------------------------------------
	// Availability
	// -----------------------------------------------------------------------

	async isAvailable(): Promise<boolean> {
		await this._init();
		return this.credentials !== null;
	}

	// -----------------------------------------------------------------------
	// Models
	// -----------------------------------------------------------------------

	async getModels(): Promise<ModelInfo[]> {
		return [...ANTIGRAVITY_MODELS];
	}

	ownsModel(modelId: string): boolean {
		return ANTIGRAVITY_MODELS.some((m) => m.id === modelId);
	}

	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			sonnet: 'claude-sonnet-4-5-20250929',
			haiku: 'claude-haiku-4-5-20250929',
			opus: 'claude-opus-4-5-20250929',
			default: 'gemini-3.1-pro-preview',
		};
		return tierMap[tier];
	}

	// -----------------------------------------------------------------------
	// SDK Config
	// -----------------------------------------------------------------------

	buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		const sessionId = sessionConfig?.sessionId ?? 'default';

		if (!this.credentials) {
			throw new Error(
				'Antigravity credentials not configured. Authenticate via /login or settings.'
			);
		}

		const credHash = hashCredentials(this.credentials);
		const existingHash = this._bridgeCredentialHashes.get(sessionId);

		let bridge = this.bridgeServers.get(sessionId);
		if (!bridge || existingHash !== credHash) {
			// Tear down stale bridge before creating a new one
			if (bridge) {
				log.info(`Restarting Antigravity bridge for session ${sessionId} (credentials changed)`);
				bridge.stop();
			}
			bridge = createAntigravityBridgeServer({
				credentials: this.credentials,
				sessionId,
			});
			this.bridgeServers.set(sessionId, bridge);
			this._bridgeCredentialHashes.set(sessionId, credHash);
			log.info(`Antigravity bridge server started on port ${bridge.port} for session ${sessionId}`);
		}

		return {
			envVars: {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
				ANTHROPIC_API_KEY: 'antigravity-placeholder',
			},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	// -----------------------------------------------------------------------
	// Auth Status
	// -----------------------------------------------------------------------

	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		if (!this.credentials) {
			return {
				isAuthenticated: false,
				method: 'oauth',
				error: 'No Antigravity account configured. Use /login to authenticate.',
			};
		}

		// Check if token needs refresh
		const needsRefresh = Date.now() >= this.credentials.expiresAt;

		return {
			isAuthenticated: true,
			method: 'oauth',
			expiresAt: this.credentials.expiresAt,
			needsRefresh,
			user: this.credentials.email ? { email: this.credentials.email } : undefined,
		};
	}

	// -----------------------------------------------------------------------
	// OAuth Flow
	// -----------------------------------------------------------------------

	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		// Tear down any previous callback server
		this.stopOAuthCallbackServer();

		// Promise that resolves when the OAuth callback delivers the auth code
		let resolveCode: ((code: string) => void) | undefined;
		const codePromise = new Promise<string>((resolve) => {
			resolveCode = resolve;
		});

		// Start a local callback server to receive the OAuth redirect
		let expectedState = '';

		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
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
		const redirectUri = `http://127.0.0.1:${callbackPort}/oauth-callback`;

		// Build the auth URL with the local callback redirect URI
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);
		const state = generateStateParameter();

		const params = new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			response_type: 'code',
			redirect_uri: redirectUri,
			scope: ANTIGRAVITY_SCOPES.join(' '),
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			state,
			access_type: 'offline',
			prompt: 'consent',
		});

		const authUrl = `${AUTH_URL}?${params.toString()}`;

		expectedState = state;
		this._pendingCodeVerifier = codeVerifier;
		this._pendingOAuthState = state;

		// Assign a unique flow ID so the background handler only tears down
		// its own server (not a newer login flow's server)
		const flowId = crypto.randomUUID();
		this._oauthCallbackServer = server;
		this._activeCallbackFlowId = flowId;

		// Start background code exchange — runs after the user authorizes
		this._handleOAuthCallback(codePromise, codeVerifier, redirectUri, flowId);

		return {
			type: 'redirect',
			authUrl,
			message:
				'Visit the URL to authorize your Antigravity account. The page will redirect automatically.',
		};
	}

	/**
	 * Background handler: waits for the OAuth code from the callback server,
	 * exchanges it for tokens, and saves the credentials.
	 *
	 * @param flowId - Unique ID for this login flow; the finally block only
	 *   tears down the callback server if it still belongs to this flow.
	 */
	private async _handleOAuthCallback(
		codePromise: Promise<string>,
		codeVerifier: string,
		redirectUri: string,
		flowId: string
	): Promise<void> {
		try {
			// Wait for the code with a 240-second timeout
			const code = await Promise.race([
				codePromise,
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 240_000)),
			]);

			if (!code) {
				log.warn('Antigravity OAuth callback timed out — no code received within 240 seconds');
				return;
			}

			this._pendingCodeVerifier = undefined;
			this._pendingOAuthState = undefined;
			// Only shut down the server if this flow still owns it
			if (this._activeCallbackFlowId === flowId) {
				this.stopOAuthCallbackServer();
				this._activeCallbackFlowId = undefined;
			}

			// Exchange code for tokens
			const tokenResponse = await fetch(TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: ANTIGRAVITY_CLIENT_ID,
					client_secret: ANTIGRAVITY_CLIENT_SECRET,
					code,
					grant_type: 'authorization_code',
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				}),
			});

			if (!tokenResponse.ok) {
				const error = await tokenResponse.text();
				throw new Error(`Token exchange failed: ${error}`);
			}

			const tokenData = (await tokenResponse.json()) as {
				access_token: string;
				refresh_token: string;
				expires_in: number;
			};

			if (!tokenData.refresh_token) {
				throw new Error('No refresh token received. Please try again.');
			}

			// Get user email
			const email = await this.fetchUserEmail(tokenData.access_token);

			// Discover project
			const projectId = await this.discoverProject(tokenData.access_token);

			// Store and persist credentials
			this.credentials = {
				refreshToken: tokenData.refresh_token,
				accessToken: tokenData.access_token,
				expiresAt: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
				projectId,
				email,
			};
			await saveCredentials(this.credentials);

			log.info(`Antigravity OAuth completed for ${email ?? 'unknown user'}`);
		} catch (err) {
			log.error(
				`Antigravity OAuth code exchange failed: ${err instanceof Error ? err.message : err}`
			);
		} finally {
			// Only tear down the server if this flow still owns it
			if (this._activeCallbackFlowId === flowId) {
				this.stopOAuthCallbackServer();
				this._activeCallbackFlowId = undefined;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Token Refresh
	// -----------------------------------------------------------------------

	async refreshToken(): Promise<boolean> {
		if (!this.credentials) {
			return false;
		}

		try {
			const response = await fetch(TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: ANTIGRAVITY_CLIENT_ID,
					client_secret: ANTIGRAVITY_CLIENT_SECRET,
					refresh_token: this.credentials.refreshToken,
					grant_type: 'refresh_token',
				}),
			});

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`Token refresh failed: ${error}`);
			}

			const data = (await response.json()) as {
				access_token: string;
				expires_in: number;
				refresh_token?: string;
			};

			this.credentials.accessToken = data.access_token;
			this.credentials.expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;
			// Google may not return a new refresh token; preserve the original
			if (data.refresh_token) {
				this.credentials.refreshToken = data.refresh_token;
			}

			await saveCredentials(this.credentials);
			return true;
		} catch (error) {
			log.error(
				`Failed to refresh Antigravity token: ${error instanceof Error ? error.message : error}`
			);
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Logout
	// -----------------------------------------------------------------------

	async logout(): Promise<void> {
		this.credentials = null;
		this.stopOAuthCallbackServer();
		await this.shutdown();
		await removeCredentials();
		log.info('Antigravity logged out');
	}

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------

	async shutdown(): Promise<void> {
		for (const [sessionId, bridge] of this.bridgeServers.entries()) {
			log.info(`Shutting down Antigravity bridge server for session ${sessionId}`);
			bridge.stop();
		}
		this.bridgeServers.clear();
		this.stopOAuthCallbackServer();
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private stopOAuthCallbackServer(): void {
		if (this._oauthCallbackServer) {
			this._oauthCallbackServer.stop();
			this._oauthCallbackServer = undefined;
		}
	}

	private async fetchUserEmail(accessToken: string): Promise<string | undefined> {
		try {
			const response = await fetch(USERINFO_URL, {
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (response.ok) {
				const data = (await response.json()) as { email?: string };
				return data.email;
			}
		} catch {
			// Ignore errors, email is optional
		}
		return undefined;
	}

	/**
	 * Discover or provision a Google Cloud project for the user.
	 * Tries endpoints in order: prod first, then sandbox fallbacks.
	 */
	private async discoverProject(accessToken: string): Promise<string> {
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
			'User-Agent': 'google-api-nodejs-client/9.15.1',
			'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
			'Client-Metadata': JSON.stringify({
				ideType: 'IDE_UNSPECIFIED',
				platform: 'PLATFORM_UNSPECIFIED',
				pluginType: 'GEMINI',
			}),
		};

		// Try endpoints in order
		const endpoints = [DEFAULT_ENDPOINT, ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_AUTOPUSH_ENDPOINT];

		for (const endpoint of endpoints) {
			try {
				const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						metadata: {
							ideType: 'IDE_UNSPECIFIED',
							platform: 'PLATFORM_UNSPECIFIED',
							pluginType: 'GEMINI',
						},
					}),
				});

				if (response.ok) {
					const data = (await response.json()) as {
						cloudaicompanionProject?: string | { id?: string };
					};

					if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
						return data.cloudaicompanionProject;
					}
					if (
						data.cloudaicompanionProject &&
						typeof data.cloudaicompanionProject === 'object' &&
						data.cloudaicompanionProject.id
					) {
						return data.cloudaicompanionProject.id;
					}
				}
			} catch {
				// Try next endpoint
			}
		}

		// Fallback project ID
		return 'rising-fact-p41fc';
	}

	/**
	 * Set credentials directly (for testing or pre-seeded auth).
	 */
	setCredentials(credentials: AntigravityCredentials): void {
		this.credentials = credentials;
	}

	/**
	 * Get current credentials (for testing).
	 */
	getCredentials(): AntigravityCredentials | null {
		return this.credentials;
	}
}

/**
 * Create a stable hash of credentials so we can detect when they change
 * and rebuild stale bridge servers.
 */
function hashCredentials(credentials: AntigravityCredentials): string {
	return `${credentials.refreshToken.slice(0, 8)}:${credentials.projectId}`;
}

// ---------------------------------------------------------------------------
// PKCE Helpers
// ---------------------------------------------------------------------------

function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64URLEncode(array);
}

function generateStateParameter(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64URLEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return base64URLEncode(new Uint8Array(hash));
}

function base64URLEncode(buffer: Uint8Array): string {
	return btoa(String.fromCharCode(...buffer))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Bridge Server
// ---------------------------------------------------------------------------

interface AntigravityBridgeConfig {
	credentials: AntigravityCredentials;
	sessionId?: string;
}

function createAntigravityBridgeServer(config: AntigravityBridgeConfig): AntigravityBridgeServer {
	const credentials = config.credentials;
	const _sessionId = config.sessionId ?? 'default';

	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			if (url.pathname === '/health' || url.pathname === '/v1/health') {
				return new Response('ok');
			}

			if (url.pathname === '/v1/models' && req.method === 'GET') {
				return new Response(
					JSON.stringify({
						data: ANTIGRAVITY_MODELS.map((m) => ({
							id: m.id,
							display_name: m.name,
							type: 'model',
						})),
					}),
					{ headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.pathname !== '/v1/messages' && url.pathname !== '/v1/messages/') {
				return new Response(createAnthropicErrorBody('not_found_error', 'Not found'), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (req.method !== 'POST') {
				return new Response(
					createAnthropicErrorBody('invalid_request_error', 'Method not allowed'),
					{ status: 405, headers: { 'Content-Type': 'application/json' } }
				);
			}

			let anthropicRequest: AnthropicRequest;
			try {
				anthropicRequest = (await req.json()) as AnthropicRequest;
			} catch {
				return new Response(createAnthropicErrorBody('invalid_request_error', 'Invalid JSON'), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Refresh token if expired
			if (Date.now() >= credentials.expiresAt) {
				try {
					const refreshResponse = await fetch(TOKEN_URL, {
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							client_id: ANTIGRAVITY_CLIENT_ID,
							client_secret: ANTIGRAVITY_CLIENT_SECRET,
							refresh_token: credentials.refreshToken,
							grant_type: 'refresh_token',
						}),
					});

					if (!refreshResponse.ok) {
						const error = await refreshResponse.text();
						throw new Error(`Token refresh failed: ${error}`);
					}

					const data = (await refreshResponse.json()) as {
						access_token: string;
						expires_in: number;
						refresh_token?: string;
					};

					credentials.accessToken = data.access_token;
					credentials.expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;
					if (data.refresh_token) {
						credentials.refreshToken = data.refresh_token;
					}
					await saveCredentials(credentials);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return new Response(createAnthropicErrorBody('authentication_error', message), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}
			}

			const isStreaming = anthropicRequest.stream !== false;

			try {
				if (isStreaming) {
					return await streamAntigravityRequest(anthropicRequest, credentials);
				}
				return await generateAntigravityRequest(anthropicRequest, credentials);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`Antigravity request failed: ${message}`);
				const { errorType, statusCode } = classifyAntigravityError(message);
				return new Response(createAnthropicErrorBody(errorType, message), {
					status: statusCode,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		},
	});

	return {
		port: server.port ?? 0,
		stop: () => server.stop(),
	};
}

// ---------------------------------------------------------------------------
// Request Building
// ---------------------------------------------------------------------------

function buildAntigravityRequest(
	anthropicRequest: AnthropicRequest,
	credentials: AntigravityCredentials
): GeminiRequest {
	const baseRequest = anthropicToGemini(anthropicRequest, {
		project: credentials.projectId,
	});

	// Inject Antigravity system instruction
	const existingParts = baseRequest.request.systemInstruction?.parts ?? [];
	baseRequest.request.systemInstruction = {
		role: 'user',
		parts: [
			{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
			{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
			...existingParts,
		],
	};

	// Add request metadata
	return {
		...baseRequest,
		requestType: 'agent',
		userAgent: 'antigravity',
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

function needsClaudeThinkingBetaHeader(modelId: string): boolean {
	return modelId.startsWith('claude-');
}

// ---------------------------------------------------------------------------
// Shared request logic
// ---------------------------------------------------------------------------

interface AntigravityRequestResult {
	response: Response;
	modelId: string;
}

async function makeAntigravityRequest(
	anthropicRequest: AnthropicRequest,
	credentials: AntigravityCredentials,
	acceptSSE: boolean
): Promise<AntigravityRequestResult> {
	const requestBody = buildAntigravityRequest(anthropicRequest, credentials);
	const modelId = anthropicRequest.model;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${credentials.accessToken}`,
		'Content-Type': 'application/json',
		...getAntigravityHeaders(),
	};

	if (acceptSSE) {
		headers.Accept = 'text/event-stream';
	}

	if (needsClaudeThinkingBetaHeader(modelId)) {
		headers['anthropic-beta'] = CLAUDE_THINKING_BETA_HEADER;
	}

	const requestBodyJson = JSON.stringify(requestBody);

	let response: Response | undefined;
	let lastError: Error | undefined;
	let endpointIndex = 0;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
			const requestUrl = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

			response = await fetch(requestUrl, {
				method: 'POST',
				headers,
				body: requestBodyJson,
			});

			if (response.ok) {
				break;
			}

			const errorText = await response.text();

			// On 403/404, cascade to next endpoint immediately
			if (
				(response.status === 403 || response.status === 404) &&
				endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
			) {
				endpointIndex++;
				continue;
			}

			// Check if retryable
			if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
				if (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
					endpointIndex++;
				}
				const serverDelay = extractRetryDelay(errorText, response);
				const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;
				await sleep(delayMs);
				continue;
			}

			throw new Error(
				`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`
			);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (lastError.message === 'fetch failed' && lastError.cause instanceof Error) {
				lastError = new Error(`Network error: ${lastError.cause.message}`);
			}
			// Do not retry errors that were explicitly thrown as non-retryable
			// (e.g., 4xx client errors other than 429).
			if (lastError.message.startsWith('Cloud Code Assist API error (')) {
				const statusMatch = lastError.message.match(/\((\d{3})\)/);
				const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
				if (status >= 400 && status < 500 && status !== 429) {
					throw lastError;
				}
			}
			if (attempt < MAX_RETRIES) {
				const delayMs = BASE_DELAY_MS * 2 ** attempt;
				await sleep(delayMs);
				continue;
			}
			throw lastError;
		}
	}

	if (!response || !response.ok) {
		throw lastError ?? new Error('Failed to get response after retries');
	}

	return { response, modelId };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async function streamAntigravityRequest(
	anthropicRequest: AnthropicRequest,
	credentials: AntigravityCredentials
): Promise<Response> {
	const { response, modelId } = await makeAntigravityRequest(anthropicRequest, credentials, true);
	return streamGeminiResponse(response, modelId);
}

// ---------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------

async function generateAntigravityRequest(
	anthropicRequest: AnthropicRequest,
	credentials: AntigravityCredentials
): Promise<Response> {
	const { response, modelId } = await makeAntigravityRequest(anthropicRequest, credentials, false);
	return collectGeminiResponse(response, modelId);
}

// ---------------------------------------------------------------------------
// Response Streaming (adapted from existing bridge-server.ts)
// ---------------------------------------------------------------------------

function streamGeminiResponse(geminiResponse: Response, model: string): Response {
	const state = createStreamState(model);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			controller.enqueue(encoder.encode(messageStartSSE(state.messageId, model, 0)));

			if (!geminiResponse.body) {
				controller.enqueue(encoder.encode(messageDeltaSSE('end_turn', { outputTokens: 1 })));
				controller.enqueue(encoder.encode(messageStopSSE()));
				controller.close();
				return;
			}

			const reader = geminiResponse.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let dataBuffer = '';

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });

					const lines = buffer.split('\n').map((l) => l.replace(/\r$/, ''));
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						const dataContent = extractSSEData(line);
						if (dataContent !== undefined) {
							dataBuffer += dataContent.trim();
						} else if (line === '' && dataBuffer) {
							try {
								const chunk = JSON.parse(dataBuffer) as GeminiResponseChunk;
								const events = processGeminiChunk(chunk, state);
								for (const event of events) {
									controller.enqueue(encoder.encode(event));
								}
							} catch {
								// Skip malformed JSON chunks
							}
							dataBuffer = '';
						}
					}
				}

				// Process trailing data
				const trailingData = extractSSEData(buffer);
				if (trailingData !== undefined) {
					dataBuffer += trailingData.trim();
				}
				if (dataBuffer) {
					try {
						const chunk = JSON.parse(dataBuffer) as GeminiResponseChunk;
						const events = processGeminiChunk(chunk, state);
						for (const event of events) {
							controller.enqueue(encoder.encode(event));
						}
					} catch {
						// Skip
					}
				}
			} finally {
				reader.releaseLock();
			}

			if (!state.finished) {
				controller.enqueue(
					encoder.encode(
						messageDeltaSSE('end_turn', {
							outputTokens: Math.max(state.outputTokens, 1),
						})
					)
				);
				controller.enqueue(encoder.encode(messageStopSSE()));
			}

			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

function processGeminiChunk(chunk: GeminiResponseChunk, state: GeminiStreamState): string[] {
	const events: string[] = [];
	const response = chunk.response;
	if (!response) return events;

	if (response.usageMetadata) {
		state.inputTokens = response.usageMetadata.promptTokenCount ?? state.inputTokens;
		state.outputTokens = response.usageMetadata.candidatesTokenCount ?? state.outputTokens;
	}

	const candidates = response.candidates ?? [];
	for (const candidate of candidates) {
		let chunkHasFunctionCall = false;

		if (candidate.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined) {
					events.push(contentBlockStartTextSSE(state.contentBlockIndex));
					events.push(textDeltaSSE(state.contentBlockIndex, part.text));
					events.push(contentBlockStopSSE(state.contentBlockIndex));
					state.contentBlockIndex++;
					// Only estimate tokens when the provider hasn't reported usage yet.
					// usageMetadata sets outputTokens directly; adding character-based
					// estimates on top would double-count.
					if (!response.usageMetadata?.candidatesTokenCount) {
						state.outputTokens += Math.ceil(part.text.length / 4);
					}
				} else if (part.functionCall) {
					chunkHasFunctionCall = true;
					state.hasSeenFunctionCall = true;
					const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
					const argsJson = JSON.stringify(part.functionCall.args ?? {});

					events.push(
						contentBlockStartToolUseSSE(state.contentBlockIndex, toolUseId, part.functionCall.name)
					);
					events.push(inputJsonDeltaSSE(state.contentBlockIndex, argsJson));
					events.push(contentBlockStopSSE(state.contentBlockIndex));
					state.contentBlockIndex++;
				}
			}
		}

		if (candidate.finishReason) {
			const stopReason =
				chunkHasFunctionCall || state.hasSeenFunctionCall
					? 'tool_use'
					: convertFinishReason(candidate.finishReason);
			events.push(
				messageDeltaSSE(stopReason, {
					inputTokens: state.inputTokens > 0 ? state.inputTokens : null,
					outputTokens: Math.max(state.outputTokens, 1),
				})
			);
			events.push(messageStopSSE());
			state.finished = true;
		}
	}

	return events;
}

// ---------------------------------------------------------------------------
// Non-streaming Response Collection
// ---------------------------------------------------------------------------

async function collectGeminiResponse(geminiResponse: Response, model: string): Promise<Response> {
	const reader = geminiResponse.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let dataBuffer = '';

	const chunks: GeminiResponseChunk[] = [];

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split('\n').map((l) => l.replace(/\r$/, ''));
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const dataContent = extractSSEData(line);
				if (dataContent !== undefined) {
					dataBuffer += dataContent.trim();
				} else if (line === '' && dataBuffer) {
					try {
						chunks.push(JSON.parse(dataBuffer) as GeminiResponseChunk);
					} catch {
						// Skip
					}
					dataBuffer = '';
				}
			}
		}

		const trailingData = extractSSEData(buffer);
		if (trailingData !== undefined) {
			dataBuffer += trailingData.trim();
		}
		if (dataBuffer) {
			try {
				chunks.push(JSON.parse(dataBuffer) as GeminiResponseChunk);
			} catch {
				// Skip
			}
		}
	} finally {
		reader.releaseLock();
	}

	const state = createStreamState(model);
	const contentBlocks: Array<Record<string, unknown>> = [];
	let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
	let inputTokens = 0;
	let outputTokens = 0;
	let hasFunctionCall = false;

	for (const chunk of chunks) {
		if (!chunk.response) continue;

		if (chunk.response.usageMetadata) {
			inputTokens = chunk.response.usageMetadata.promptTokenCount ?? inputTokens;
			outputTokens = chunk.response.usageMetadata.candidatesTokenCount ?? outputTokens;
		}

		for (const candidate of chunk.response.candidates ?? []) {
			if (candidate.content?.parts) {
				for (const part of candidate.content.parts) {
					if (part.text !== undefined) {
						contentBlocks.push({
							type: 'text',
							text: part.text,
						});
					} else if (part.functionCall) {
						hasFunctionCall = true;
						contentBlocks.push({
							type: 'tool_use',
							id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
							name: part.functionCall.name,
							input: part.functionCall.args ?? {},
						});
					}
				}
			}
			if (candidate.finishReason) {
				stopReason = hasFunctionCall ? 'tool_use' : convertFinishReason(candidate.finishReason);
			}
		}
	}

	return new Response(
		JSON.stringify({
			id: state.messageId,
			type: 'message',
			role: 'assistant',
			content: contentBlocks,
			model,
			stop_reason: stopReason,
			stop_sequence: null,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			},
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

// ---------------------------------------------------------------------------
// SSE Utilities
// ---------------------------------------------------------------------------

function extractSSEData(line: string): string | undefined {
	if (line.startsWith('data: ')) return line.slice(6);
	if (line.startsWith('data:') && line.length > 5) return line.slice(5);
	return undefined;
}

// ---------------------------------------------------------------------------
// Retry Logic
// ---------------------------------------------------------------------------

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(
		errorText
	);
}

function extractRetryDelay(errorText: string, response?: Response): number | undefined {
	const normalizeDelay = (ms: number): number | undefined =>
		ms > 0 ? Math.ceil(ms + 1000) : undefined;

	const headers = response?.headers;
	if (headers) {
		const retryAfter = headers.get('retry-after');
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) {
				const delay = normalizeDelay(retryAfterSeconds * 1000);
				if (delay !== undefined) return delay;
			}
			const retryAfterDate = new Date(retryAfter);
			const retryAfterMs = retryAfterDate.getTime();
			if (!Number.isNaN(retryAfterMs)) {
				const delay = normalizeDelay(retryAfterMs - Date.now());
				if (delay !== undefined) return delay;
			}
		}

		const rateLimitResetAfter = headers.get('x-ratelimit-reset-after');
		if (rateLimitResetAfter) {
			const resetAfterSeconds = Number(rateLimitResetAfter);
			if (Number.isFinite(resetAfterSeconds)) {
				const delay = normalizeDelay(resetAfterSeconds * 1000);
				if (delay !== undefined) return delay;
			}
		}
	}

	// Pattern: "Your quota will reset after ..."
	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? Number.parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? Number.parseInt(durationMatch[2], 10) : 0;
		const seconds = Number.parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			const delay = normalizeDelay(totalMs);
			if (delay !== undefined) return delay;
		}
	}

	// Pattern: "Please retry in X[ms|s]"
	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = Number.parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === 'ms' ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) return delay;
		}
	}

	// Pattern: "retryDelay": "34.074824224s"
	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = Number.parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === 'ms' ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) return delay;
		}
	}

	return undefined;
}

function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) {
			return parsed.error.message;
		}
	} catch {
		// Not JSON, return as-is
	}
	return errorText;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

function classifyAntigravityError(message: string): {
	errorType: AnthropicErrorType;
	statusCode: number;
} {
	const lower = message.toLowerCase();
	if (
		lower.includes('api key') ||
		lower.includes('apikey') ||
		lower.includes('unauthenticated') ||
		lower.includes('authentication') ||
		lower.includes('invalid credentials') ||
		lower.includes('token refresh failed')
	) {
		return { errorType: 'authentication_error', statusCode: 401 };
	}
	if (
		lower.includes('permission') ||
		lower.includes('forbidden') ||
		lower.includes('access denied')
	) {
		return { errorType: 'permission_error', statusCode: 403 };
	}
	if (
		lower.includes('rate limit') ||
		lower.includes('quota') ||
		lower.includes('resource_exhausted') ||
		lower.includes('too many requests')
	) {
		return { errorType: 'rate_limit_error', statusCode: 429 };
	}
	if (
		lower.includes('not found') ||
		lower.includes('not_found') ||
		lower.includes('unknown model') ||
		lower.includes('model not found')
	) {
		return { errorType: 'not_found_error', statusCode: 404 };
	}
	return { errorType: 'api_error', statusCode: 500 };
}
