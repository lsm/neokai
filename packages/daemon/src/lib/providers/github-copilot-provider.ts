/**
 * GitHub Copilot Provider - GitHub Copilot Chat models
 *
 * This provider uses GitHub's Copilot API through the pi-mono adapter,
 * enabling access to multiple LLM providers (OpenAI, Google, Anthropic)
 * through GitHub's OAuth authentication.
 *
 * Authentication:
 * - Uses GitHub OAuth device flow
 * - Tokens stored in ~/.neokai/auth.json
 * - Supports automatic token refresh
 * - Supports GitHub Enterprise via GITHUB_API_URL
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
import { refreshGitHubCopilotToken } from '@mariozechner/pi-ai/oauth';
import { Logger } from '../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const logger = new Logger('github-copilot-provider');

/**
 * GitHub Copilot model definitions
 *
 * IMPORTANT: Model IDs must match exactly what pi-ai registers in its model registry.
 * pi-ai uses dots (e.g., 'claude-opus-4.6') not hyphens (e.g., 'claude-opus-4-6').
 */
const GITHUB_COPILOT_MODELS: ModelInfo[] = [
	{
		id: 'claude-opus-4.6',
		name: 'Claude Opus 4.6 (Copilot)',
		alias: 'copilot-opus',
		family: 'opus',
		provider: 'github-copilot',
		contextWindow: 128000,
		description: 'Claude Opus 4.6 via GitHub Copilot · Most capable',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'claude-sonnet-4.6',
		name: 'Claude Sonnet 4.6 (Copilot)',
		alias: 'copilot-sonnet',
		family: 'sonnet',
		provider: 'github-copilot',
		contextWindow: 128000,
		description: 'Claude Sonnet 4.6 via GitHub Copilot · Balanced',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex (Copilot)',
		alias: 'copilot-codex',
		family: 'gpt',
		provider: 'github-copilot',
		contextWindow: 272000,
		description: 'GPT-5.3 Codex via GitHub Copilot · Best for coding',
		releaseDate: '2025-12-01',
		available: true,
	},
	{
		id: 'gemini-3.1-pro-preview',
		name: 'Gemini 3.1 Pro (Copilot)',
		alias: 'copilot-gemini',
		family: 'gemini',
		provider: 'github-copilot',
		contextWindow: 128000,
		description: 'Gemini 3.1 Pro Preview via GitHub Copilot',
		releaseDate: '2025-11-15',
		available: true,
	},
	{
		id: 'gpt-5-mini',
		name: 'GPT-5 Mini (Copilot)',
		alias: 'copilot-mini',
		family: 'gpt',
		provider: 'github-copilot',
		contextWindow: 128000,
		description: 'GPT-5 Mini via GitHub Copilot · Fast and efficient',
		releaseDate: '2025-12-01',
		available: true,
	},
];

/**
 * Stored credentials format for GitHub Copilot
 *
 * Uses pi-ai's OAuthCredentials format:
 * - refresh: GitHub OAuth access token (long-lived)
 * - access: Copilot session token (short-lived, ~30 min)
 * - expires: Expiry timestamp in ms (with 5 min buffer)
 * - enterpriseUrl: Optional GitHub Enterprise domain
 */
interface StoredCopilotCredentials {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
}

/**
 * OAuth device flow response
 */
interface DeviceFlowResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

/**
 * GitHub Copilot provider implementation
 */
export class GitHubCopilotProvider implements Provider {
	readonly id = 'github-copilot';
	readonly displayName = 'GitHub Copilot';

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
	private cachedCredentials: StoredCopilotCredentials | null = null;

	/**
	 * Active OAuth flow state (for async polling)
	 */
	private activeOAuthFlow: {
		deviceCode: string;
		userCode: string;
		verificationUri: string;
		expiresAt: number;
		completed: boolean;
		success: boolean;
	} | null = null;

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		authDir?: string
	) {
		this.authPath = path.join(authDir || path.join(os.homedir(), '.neokai'), 'auth.json');
	}

	/**
	 * Check if GitHub Copilot is available
	 * Requires valid OAuth credentials (GitHub token stored)
	 */
	async isAvailable(): Promise<boolean> {
		const status = await this.getAuthStatus();
		return status.isAuthenticated;
	}

	/**
	 * Get available models
	 */
	async getModels(): Promise<ModelInfo[]> {
		const status = await this.getAuthStatus();
		return status.isAuthenticated ? GITHUB_COPILOT_MODELS : [];
	}

	/**
	 * Check if a model ID belongs to GitHub Copilot
	 */
	ownsModel(modelId: string): boolean {
		// Check against known models
		return GITHUB_COPILOT_MODELS.some((m) => m.id === modelId || m.alias === modelId);
	}

	/**
	 * Get model for a specific tier
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			opus: 'claude-opus-4.6',
			sonnet: 'claude-sonnet-4.6',
			haiku: 'gpt-5-mini',
			default: 'claude-sonnet-4.6',
		};
		return tierMap[tier];
	}

	/**
	 * Build SDK configuration
	 * Not used - we use createQuery instead
	 */
	buildSdkConfig(_modelId: string, _sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
		return {
			envVars: {},
			isAnthropicCompatible: false,
		};
	}

	/**
	 * Create custom query generator for GitHub Copilot
	 *
	 * GitHub Copilot requires a two-step authentication:
	 * 1. GitHub OAuth token (long-lived, stored as 'refresh')
	 * 2. Copilot session token (short-lived ~30min, obtained via token exchange)
	 *
	 * The Copilot session token is obtained by calling:
	 *   GET https://api.github.com/copilot_internal/v2/token
	 * with the GitHub OAuth token as Bearer auth.
	 */
	async createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): Promise<AsyncGenerator<SDKMessage, void> | null> {
		// Ensure we have valid credentials with a fresh Copilot session token
		const copilotApiKey = await this.getCopilotApiKey();
		if (!copilotApiKey) {
			logger.warn('GitHub Copilot not authenticated. Run `kai copilot login` to authenticate.');
			return null;
		}

		// Resolve model alias to canonical ID (pi-ai only knows canonical IDs like
		// 'claude-sonnet-4.6', not NeoKai internal aliases like 'copilot-sonnet')
		const modelEntry = GITHUB_COPILOT_MODELS.find(
			(m) => m.id === options.model || m.alias === options.model
		);
		const canonicalModelId = modelEntry?.id ?? options.model;

		// Create query generator with GitHub Copilot configuration
		return piMonoQueryGenerator(
			prompt,
			{
				...options,
				apiKey: copilotApiKey,
				model: canonicalModelId,
			},
			context,
			'github-copilot',
			canonicalModelId,
			// Tool execution callback would be injected by QueryRunner
			undefined
		);
	}

	/**
	 * Get a valid Copilot API key (session token), refreshing if needed.
	 *
	 * This handles the critical token exchange step:
	 * GitHub OAuth token → Copilot session token via /copilot_internal/v2/token
	 */
	private async getCopilotApiKey(): Promise<string | null> {
		const credentials = await this.loadCredentials();
		if (!credentials) {
			return null;
		}

		// Check if the Copilot session token is still valid
		if (Date.now() < credentials.expires) {
			return credentials.access;
		}

		// Token expired — refresh it using the GitHub OAuth token
		try {
			const refreshed = await refreshGitHubCopilotToken(
				credentials.refresh,
				credentials.enterpriseUrl
			);

			const newCredentials: StoredCopilotCredentials = {
				refresh: refreshed.refresh,
				access: refreshed.access,
				expires: refreshed.expires,
				enterpriseUrl: credentials.enterpriseUrl,
			};

			await this.saveCredentials(newCredentials);
			this.cachedCredentials = newCredentials;

			logger.debug('Refreshed Copilot session token');
			return newCredentials.access;
		} catch (error) {
			logger.error('Failed to refresh Copilot session token:', error);
			return null;
		}
	}

	// =========================================================================
	// OAuth Implementation
	// =========================================================================

	/**
	 * Get current authentication status (implements Provider interface)
	 *
	 * Checks if we have a stored GitHub OAuth token (refresh token).
	 * The Copilot session token is refreshed lazily in getCopilotApiKey().
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		try {
			const credentials = await this.loadCredentials();

			if (!credentials) {
				return {
					isAuthenticated: false,
					error: 'No token found. Run OAuth login to authenticate.',
				};
			}

			// We have credentials — the Copilot session token will be
			// refreshed lazily when needed in getCopilotApiKey()
			return {
				isAuthenticated: true,
				needsRefresh: false,
			};
		} catch (error) {
			return {
				isAuthenticated: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Start OAuth device flow for authentication (implements Provider interface)
	 *
	 * Returns immediately with user code and verification URL - flow completes in background.
	 * Call getAuthStatus() to poll for completion.
	 *
	 * @returns OAuth flow data with user code and verification URL
	 */
	async startOAuthFlow(): Promise<ProviderOAuthFlowData> {
		// If there's already an active flow, return its info
		if (this.activeOAuthFlow && !this.activeOAuthFlow.completed) {
			return {
				type: 'device',
				userCode: this.activeOAuthFlow.userCode,
				verificationUri: this.activeOAuthFlow.verificationUri,
				message: 'OAuth flow already in progress. Enter the code at the verification URL.',
			};
		}

		try {
			const enterpriseDomain = this.getEnterpriseDomain();
			// Start device flow
			const deviceResponse = await this.startDeviceFlow(enterpriseDomain);

			// Store active flow state
			this.activeOAuthFlow = {
				deviceCode: deviceResponse.device_code,
				userCode: deviceResponse.user_code,
				verificationUri: deviceResponse.verification_uri,
				expiresAt: Date.now() + deviceResponse.expires_in * 1000,
				completed: false,
				success: false,
			};

			// Start polling in background
			this.startBackgroundPolling(deviceResponse, enterpriseDomain).catch((error) => {
				logger.error('Background polling failed:', error);
				if (this.activeOAuthFlow) {
					this.activeOAuthFlow.completed = true;
					this.activeOAuthFlow.success = false;
				}
			});

			return {
				type: 'device',
				userCode: deviceResponse.user_code,
				verificationUri: deviceResponse.verification_uri,
				message: 'Enter the code at the verification URL to authenticate.',
			};
		} catch (error) {
			logger.error('Failed to start OAuth flow:', error);
			throw error;
		}
	}

	/**
	 * Get the GitHub Enterprise domain, if configured
	 */
	private getEnterpriseDomain(): string | undefined {
		const apiUrl = this.env.GITHUB_API_URL;
		if (!apiUrl) return undefined;

		try {
			const url = new URL(apiUrl);
			// If it's github.com, no enterprise domain
			if (url.hostname === 'api.github.com') return undefined;
			return url.hostname;
		} catch {
			return undefined;
		}
	}

	/**
	 * Get the GitHub OAuth base URL (supports enterprise)
	 */
	private getGitHubOAuthUrl(enterpriseDomain?: string): string {
		if (enterpriseDomain) {
			return `https://${enterpriseDomain}`;
		}
		return 'https://github.com';
	}

	/**
	 * Poll for token in background
	 *
	 * After obtaining the GitHub OAuth token, performs the critical token exchange
	 * to get a Copilot session token via /copilot_internal/v2/token
	 */
	private async startBackgroundPolling(
		device: DeviceFlowResponse,
		enterpriseDomain?: string
	): Promise<void> {
		const clientId = this.getClientId();
		const githubOAuthUrl = this.getGitHubOAuthUrl(enterpriseDomain);
		const startTime = Date.now();
		const expiresMs = device.expires_in * 1000;

		while (Date.now() - startTime < expiresMs) {
			// Check if flow was cancelled
			if (!this.activeOAuthFlow || this.activeOAuthFlow.completed) {
				return;
			}

			// Wait for polling interval
			await new Promise((resolve) => setTimeout(resolve, device.interval * 1000));

			try {
				const response = await fetch(`${githubOAuthUrl}/login/oauth/access_token`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: JSON.stringify({
						client_id: clientId,
						device_code: device.device_code,
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					}),
				});

				if (!response.ok) {
					continue;
				}

				const data = (await response.json()) as {
					access_token?: string;
					error?: string;
				};

				// Check for pending status
				if (data.error === 'authorization_pending') {
					continue;
				}

				// Check for other errors
				if (data.error) {
					logger.error('OAuth polling error:', data.error);
					if (this.activeOAuthFlow) {
						this.activeOAuthFlow.completed = true;
						this.activeOAuthFlow.success = false;
					}
					return;
				}

				if (!data.access_token) {
					continue;
				}

				// Got GitHub OAuth token — now exchange it for a Copilot session token
				// This is the critical step that was missing before
				const githubAccessToken = data.access_token;

				try {
					const copilotCredentials = await refreshGitHubCopilotToken(
						githubAccessToken,
						enterpriseDomain
					);

					const credentials: StoredCopilotCredentials = {
						refresh: copilotCredentials.refresh,
						access: copilotCredentials.access,
						expires: copilotCredentials.expires,
						enterpriseUrl: enterpriseDomain,
					};

					await this.saveCredentials(credentials);
					this.cachedCredentials = credentials;

					logger.debug('GitHub Copilot login successful, token exchange completed');

					if (this.activeOAuthFlow) {
						this.activeOAuthFlow.completed = true;
						this.activeOAuthFlow.success = true;
					}
					return;
				} catch (exchangeError) {
					logger.error('Copilot token exchange failed:', exchangeError);
					if (this.activeOAuthFlow) {
						this.activeOAuthFlow.completed = true;
						this.activeOAuthFlow.success = false;
					}
					return;
				}
			} catch (error) {
				logger.debug('OAuth polling attempt failed:', error);
				continue;
			}
		}

		logger.error('OAuth device flow timed out');
		if (this.activeOAuthFlow) {
			this.activeOAuthFlow.completed = true;
			this.activeOAuthFlow.success = false;
		}
	}

	/**
	 * Get the GitHub Copilot OAuth client ID
	 * Uses VS Code's Copilot Chat extension client ID (same as pi-ai)
	 */
	private getClientId(): string {
		return this.env.GITHUB_COPILOT_CLIENT_ID || atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=');
	}

	/**
	 * Start GitHub device flow
	 */
	private async startDeviceFlow(enterpriseDomain?: string): Promise<DeviceFlowResponse> {
		const clientId = this.getClientId();
		const githubOAuthUrl = this.getGitHubOAuthUrl(enterpriseDomain);

		const response = await fetch(`${githubOAuthUrl}/login/device/code`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'GitHubCopilotChat/0.35.0',
			},
			body: JSON.stringify({
				client_id: clientId,
				scope: 'read:user',
			}),
		});

		if (!response.ok) {
			throw new Error(`Device flow start failed: ${response.statusText}`);
		}

		return response.json() as Promise<DeviceFlowResponse>;
	}

	/**
	 * Logout - delete stored credentials
	 */
	async logout(): Promise<void> {
		this.cachedCredentials = null;

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content);
			delete data['github-copilot'];

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
	 * Load credentials from storage
	 */
	private async loadCredentials(): Promise<StoredCopilotCredentials | null> {
		// Return cached credentials if available
		if (this.cachedCredentials) {
			return this.cachedCredentials;
		}

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content);

			// Look for GitHub Copilot credentials
			if (data['github-copilot']) {
				const stored = data['github-copilot'];

				// Handle legacy format (access_token/refresh_token)
				if (stored.access_token && !stored.refresh) {
					// Migrate: old format stored the GitHub OAuth token as access_token
					// The GitHub OAuth token becomes the refresh token in the new format
					const migrated: StoredCopilotCredentials = {
						refresh: stored.access_token,
						access: '', // Will be refreshed on first use
						expires: 0, // Force immediate refresh
					};
					this.cachedCredentials = migrated;
					return this.cachedCredentials;
				}

				this.cachedCredentials = stored;
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
	private async saveCredentials(credentials: StoredCopilotCredentials): Promise<void> {
		// Ensure directory exists
		const dir = path.dirname(this.authPath);
		await fs.mkdir(dir, { recursive: true });

		// Read existing data
		let data: Record<string, unknown> = {};
		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			data = JSON.parse(content);
		} catch {
			// File doesn't exist, start fresh
		}

		// Update with new credentials
		data['github-copilot'] = credentials;

		// Write with restrictive permissions
		await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), {
			mode: 0o600, // Only owner can read/write
		});
	}
}
