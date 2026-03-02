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
import { Logger } from '../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const logger = new Logger('github-copilot-provider');

/**
 * GitHub Copilot model definitions
 */
const GITHUB_COPILOT_MODELS: ModelInfo[] = [
	{
		id: 'gpt-5.3-codex',
		name: 'GPT-5.3 Codex (Copilot)',
		alias: 'copilot-codex',
		family: 'gpt',
		provider: 'github-copilot',
		contextWindow: 200000,
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
		contextWindow: 200000,
		description: 'Gemini 3.1 Pro Preview via GitHub Copilot',
		releaseDate: '2025-11-15',
		available: true,
	},
	{
		id: 'claude-opus-4-6',
		name: 'Claude Opus 4.6 (Copilot)',
		alias: 'copilot-opus',
		family: 'opus',
		provider: 'github-copilot',
		contextWindow: 200000,
		description: 'Claude Opus 4.6 via GitHub Copilot · Most capable',
		releaseDate: '2025-11-01',
		available: true,
	},
	{
		id: 'claude-sonnet-4-6',
		name: 'Claude Sonnet 4.6 (Copilot)',
		alias: 'copilot-sonnet',
		family: 'sonnet',
		provider: 'github-copilot',
		contextWindow: 200000,
		description: 'Claude Sonnet 4.6 via GitHub Copilot · Balanced',
		releaseDate: '2025-11-01',
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
 * OAuth token structure
 */
interface CopilotOAuthToken {
	access_token: string;
	refresh_token?: string;
	expires_at?: number; // Unix timestamp
	token_type: string;
	scope?: string;
}

/**
 * Authentication status
 */
export interface CopilotAuthStatus {
	isAuthenticated: boolean;
	expiresAt?: number;
	needsRefresh?: boolean;
	error?: string;
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
	 * Cached token (memory cache)
	 */
	private cachedToken: CopilotOAuthToken | null = null;

	/**
	 * GitHub API URL (supports GitHub Enterprise) - used for API calls
	 */
	private readonly githubApiUrl: string;

	/**
	 * GitHub OAuth URL - always github.com for OAuth endpoints
	 */
	private readonly githubOAuthUrl = 'https://github.com';

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
		// Support GitHub Enterprise via environment variable
		this.githubApiUrl = env.GITHUB_API_URL || 'https://api.github.com';
		this.authPath = path.join(authDir || path.join(os.homedir(), '.neokai'), 'auth.json');
	}

	/**
	 * Check if GitHub Copilot is available
	 * Requires valid OAuth token
	 */
	async isAvailable(): Promise<boolean> {
		const status = await this.getAuthStatus();
		return status.isAuthenticated && !status.needsRefresh;
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
			opus: 'claude-opus-4-6',
			sonnet: 'claude-sonnet-4-6',
			haiku: 'gpt-5-mini',
			default: 'claude-sonnet-4-6',
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
	 */
	async createQuery(
		prompt: AsyncGenerator<SDKUserMessage>,
		options: ProviderQueryOptions,
		context: ProviderQueryContext
	): Promise<AsyncGenerator<SDKMessage, void> | null> {
		// Check availability and refresh token if needed
		const status = await this.getAuthStatus();

		if (!status.isAuthenticated) {
			logger.warn('GitHub Copilot not authenticated. Run `kai copilot login` to authenticate.');
			return null;
		}

		if (status.needsRefresh) {
			const refreshed = await this.refreshToken();
			if (!refreshed) {
				logger.error('Failed to refresh GitHub Copilot token.');
				return null;
			}
		}

		const token = await this.loadToken();
		if (!token) {
			return null;
		}

		// Create query generator with GitHub Copilot configuration
		return piMonoQueryGenerator(
			prompt,
			{
				...options,
				apiKey: token.access_token,
			},
			context,
			'github-copilot',
			options.model,
			// Tool execution callback would be injected by QueryRunner
			undefined
		);
	}

	// =========================================================================
	// OAuth Implementation
	// =========================================================================

	/**
	 * Get current authentication status (implements Provider interface)
	 */
	async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
		try {
			const token = await this.loadToken();

			if (!token) {
				return {
					isAuthenticated: false,
					error: 'No token found. Run OAuth login to authenticate.',
				};
			}

			// Check if token is expired
			if (token.expires_at) {
				const now = Math.floor(Date.now() / 1000);
				const bufferSeconds = 300; // 5 minute buffer

				if (now >= token.expires_at - bufferSeconds) {
					return {
						isAuthenticated: true,
						expiresAt: token.expires_at * 1000, // Convert to ms
						needsRefresh: true,
					};
				}

				return {
					isAuthenticated: true,
					expiresAt: token.expires_at * 1000, // Convert to ms
					needsRefresh: false,
				};
			}

			// Token without expiry - assume valid
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
			// Start device flow
			const deviceResponse = await this.startDeviceFlow();

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
			this.startBackgroundPolling(deviceResponse).catch((error) => {
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
	 * Poll for token in background
	 */
	private async startBackgroundPolling(device: DeviceFlowResponse): Promise<void> {
		const clientId = this.env.GITHUB_COPILOT_CLIENT_ID || '01ab8ac9400c4e429b23';
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
				const response = await fetch(`${this.githubOAuthUrl}/login/oauth/access_token`, {
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
					access_token: string;
					refresh_token: string;
					expires_in?: number;
					token_type?: string;
					scope?: string;
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

				// Success!
				const token: CopilotOAuthToken = {
					access_token: data.access_token,
					refresh_token: data.refresh_token,
					expires_at: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
					token_type: data.token_type || 'bearer',
					scope: data.scope,
				};

				await this.saveToken(token);
				this.cachedToken = token;

				if (this.activeOAuthFlow) {
					this.activeOAuthFlow.completed = true;
					this.activeOAuthFlow.success = true;
				}
				return;
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
	 * Start GitHub device flow
	 */
	private async startDeviceFlow(): Promise<DeviceFlowResponse> {
		// GitHub Copilot OAuth app client ID (VS Code's client_id)
		const clientId = this.env.GITHUB_COPILOT_CLIENT_ID || '01ab8ac9400c4e429b23';

		const response = await fetch(`${this.githubOAuthUrl}/login/device/code`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				client_id: clientId,
				scope: 'user',
			}),
		});

		if (!response.ok) {
			throw new Error(`Device flow start failed: ${response.statusText}`);
		}

		return response.json() as Promise<DeviceFlowResponse>;
	}

	/**
	 * Refresh OAuth token
	 */
	async refreshToken(): Promise<boolean> {
		const token = await this.loadToken();

		if (!token?.refresh_token) {
			return false;
		}

		try {
			const clientId = this.env.GITHUB_COPILOT_CLIENT_ID || '01ab8ac9400c4e429b23';

			const response = await fetch(`${this.githubOAuthUrl}/login/oauth/access_token`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify({
					client_id: clientId,
					refresh_token: token.refresh_token,
					grant_type: 'refresh_token',
				}),
			});

			if (!response.ok) {
				logger.error('Token refresh failed:', response.statusText);
				return false;
			}

			const data = (await response.json()) as {
				access_token: string;
				refresh_token?: string;
				expires_in?: number;
				token_type?: string;
				scope?: string;
				error?: string;
			};

			if (data.error) {
				logger.error('Token refresh error:', data.error);
				return false;
			}

			const newToken: CopilotOAuthToken = {
				access_token: data.access_token,
				refresh_token: data.refresh_token || token.refresh_token,
				expires_at: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
				token_type: data.token_type || 'bearer',
				scope: data.scope,
			};

			await this.saveToken(newToken);
			this.cachedToken = newToken;

			return true;
		} catch (error) {
			logger.error('Token refresh failed:', error);
			return false;
		}
	}

	/**
	 * Logout - delete stored token
	 */
	async logout(): Promise<void> {
		this.cachedToken = null;

		try {
			await fs.unlink(this.authPath);
		} catch {
			// Ignore if file doesn't exist
		}
	}

	/**
	 * Load token from storage
	 */
	private async loadToken(): Promise<CopilotOAuthToken | null> {
		// Return cached token if available
		if (this.cachedToken) {
			return this.cachedToken;
		}

		try {
			const content = await fs.readFile(this.authPath, 'utf-8');
			const data = JSON.parse(content);

			// Look for GitHub Copilot token
			if (data['github-copilot']) {
				this.cachedToken = data['github-copilot'];
				return this.cachedToken;
			}

			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Save token to storage
	 */
	private async saveToken(token: CopilotOAuthToken): Promise<void> {
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

		// Update with new token
		data['github-copilot'] = token;

		// Write with restrictive permissions
		await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), {
			mode: 0o600, // Only owner can read/write
		});
	}
}
