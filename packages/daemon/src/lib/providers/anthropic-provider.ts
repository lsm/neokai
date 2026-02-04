/**
 * Anthropic Provider - Official Anthropic Claude API
 *
 * This provider uses the standard Claude Agent SDK with Anthropic's API.
 * No special configuration needed - the SDK handles everything.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	Provider,
	ProviderCapabilities,
	ProviderSdkConfig,
	ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import { resolveSDKCliPath, isBundledBinary } from '../agent/sdk-cli-resolver.js';

/**
 * Canonical SDK model IDs (short-form IDs preferred by the SDK)
 * These are the preferred IDs that should be kept when duplicates exist
 */
const CANONICAL_SDK_IDS = new Set(['default', 'opus', 'haiku', 'sonnet[1m]']);

/**
 * Detect if a model ID is a full version-specific ID (e.g., claude-sonnet-4-5-20250929)
 * vs a canonical short ID (e.g., default, opus, haiku)
 */
function isFullVersionId(modelId: string): boolean {
	// Full IDs match pattern: claude-{family}-{version}-{date}
	// e.g., claude-sonnet-4-5-20250929, claude-opus-4-5-20251101
	return /^claude-(sonnet|opus|haiku)-[\d-]+$/.test(modelId);
}

/**
 * Extract model family and version from a model ID
 * Returns null if not a recognizable Claude model
 */
function parseModelId(modelId: string): { family: string; version?: string } | null {
	// Canonical short IDs
	if (modelId === 'default') return { family: 'sonnet', version: '4.5' };
	if (modelId === 'opus') return { family: 'opus', version: '4.5' };
	if (modelId === 'haiku') return { family: 'haiku', version: '4.5' };
	if (modelId === 'sonnet[1m]') return { family: 'sonnet', version: '4.5-1m' };

	// Full version IDs: claude-{family}-{major}-{minor}-{date}
	// Example: claude-sonnet-4-5-20250929
	const match = modelId.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-\d{8})?$/);
	if (match) {
		const family = match[1];
		const major = match[2];
		const minor = match[3];
		return {
			family,
			version: `${major}.${minor}`, // Extract version as "4.5"
		};
	}

	return null;
}

/**
 * Anthropic provider implementation
 */
export class AnthropicProvider implements Provider {
	readonly id = 'anthropic';
	readonly displayName = 'Anthropic';

	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		extendedThinking: true,
		maxContextWindow: 200000,
		functionCalling: true,
		vision: true,
	};

	/**
	 * Cache for dynamically loaded models
	 */
	private modelCache: ModelInfo[] | null = null;

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly modelCacheKey: string = 'anthropic-global'
	) {}

	/**
	 * Check if Anthropic is available
	 * Requires ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN
	 */
	isAvailable(): boolean {
		return !!(
			this.env.ANTHROPIC_API_KEY ||
			this.env.CLAUDE_CODE_OAUTH_TOKEN ||
			this.env.ANTHROPIC_AUTH_TOKEN
		);
	}

	/**
	 * Get API key from environment
	 */
	getApiKey(): string | undefined {
		return (
			this.env.ANTHROPIC_API_KEY ||
			this.env.CLAUDE_CODE_OAUTH_TOKEN ||
			this.env.ANTHROPIC_AUTH_TOKEN
		);
	}

	/**
	 * Get available models from Anthropic
	 * Dynamically loads from SDK - no static fallback
	 */
	async getModels(): Promise<ModelInfo[]> {
		// Return cached models if available
		if (this.modelCache) {
			return this.modelCache;
		}

		// Only try to load from SDK if credentials are available
		// Without credentials, the SDK call may hang indefinitely
		if (!this.isAvailable()) {
			return [];
		}

		try {
			// Load from SDK
			const models = await this.loadModelsFromSdk();
			this.modelCache = models;
			return models;
		} catch (error) {
			console.warn('[AnthropicProvider] Failed to load models from SDK:', error);
			// No static fallback - return empty array
			return [];
		}
	}

	/**
	 * Load models from SDK
	 * @param timeout - Timeout in milliseconds (default: 3000ms)
	 */
	private async loadModelsFromSdk(timeout: number = 10000): Promise<ModelInfo[]> {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');

		// Create a temporary query to fetch models
		const tmpQuery = query({
			prompt: '',
			options: {
				model: 'default',
				cwd: process.cwd(),
				maxTurns: 0,
				pathToClaudeCodeExecutable: resolveSDKCliPath(),
				executable: isBundledBinary() ? 'bun' : undefined,
			},
		});

		try {
			// Add timeout to prevent hanging in CI/slow environments
			const sdkModels = await Promise.race([
				tmpQuery.supportedModels(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('SDK model load timeout')), timeout)
				),
			]);
			return this.convertSdkModels(sdkModels);
		} finally {
			// Fire-and-forget interrupt
			tmpQuery.interrupt().catch(() => {});
		}
	}

	/**
	 * Convert SDK models to ModelInfo format
	 * Public for use by external helpers like getAnthropicModelsFromQuery
	 *
	 * Intelligently filters out duplicate models:
	 * - Prefers canonical short IDs (default, opus, haiku) over full version IDs
	 * - Detects when multiple IDs represent the same model
	 */
	convertSdkModels(
		sdkModels: Array<{ value: string; displayName: string; description: string }>
	): ModelInfo[] {
		// Track which model families we've seen with canonical IDs
		const canonicalIdsByFamily = new Map<string, string>();

		// First pass: identify all canonical IDs
		for (const sdkModel of sdkModels) {
			if (CANONICAL_SDK_IDS.has(sdkModel.value)) {
				const parsed = parseModelId(sdkModel.value);
				if (parsed) {
					const key = `${parsed.family}-${parsed.version}`;
					canonicalIdsByFamily.set(key, sdkModel.value);
				}
			}
		}

		return sdkModels
			.filter((sdkModel) => {
				// Always keep canonical short IDs
				if (CANONICAL_SDK_IDS.has(sdkModel.value)) {
					return true;
				}

				// For full version IDs, check if there's a canonical ID for the same model
				if (isFullVersionId(sdkModel.value)) {
					const parsed = parseModelId(sdkModel.value);
					if (parsed) {
						const key = `${parsed.family}-${parsed.version}`;
						const canonicalId = canonicalIdsByFamily.get(key);

						if (canonicalId) {
							// There's a canonical ID for this model - filter out the full ID
							console.log(
								`[AnthropicProvider] Filtering out ${sdkModel.value} (duplicate of canonical ${canonicalId})`
							);
							return false;
						}
					}
				}

				// Keep all other models
				return true;
			})
			.map((sdkModel) => {
				// Extract display name from description (format: "Model X.Y · description")
				const description = sdkModel.description || '';
				const separatorIndex = description.indexOf(' · ');
				let displayName = description;
				if (separatorIndex > 0) {
					displayName = description.substring(0, separatorIndex);
				} else {
					displayName = sdkModel.displayName || sdkModel.value;
				}

				// Handle SDK's verbose default model display name
				const currentlyMatch = displayName.match(/currently\s+([^)]+)/);
				if (currentlyMatch) {
					displayName = currentlyMatch[1].trim();
				}

				// Determine family from model ID or display name
				let family: 'opus' | 'sonnet' | 'haiku' = 'sonnet';
				const nameLower = displayName.toLowerCase();
				if (nameLower.includes('opus')) {
					family = 'opus';
				} else if (nameLower.includes('haiku')) {
					family = 'haiku';
				}

				return {
					id: sdkModel.value,
					name: displayName,
					alias: sdkModel.value, // SDK uses short IDs like 'opus', 'default'
					family,
					provider: 'anthropic',
					contextWindow: 200000,
					description: sdkModel.description || '',
					releaseDate: '',
					available: true,
				};
			});
	}

	/**
	 * Check if a model ID belongs to Anthropic
	 *
	 * Anthropic owns:
	 * - 'default', 'opus', 'haiku' (SDK short IDs)
	 * - 'claude-*' model IDs
	 *
	 * Does NOT own models from other providers (glm-*, deepseek-*, etc.)
	 */
	ownsModel(modelId: string): boolean {
		const lower = modelId.toLowerCase();

		// SDK short IDs
		if (['default', 'opus', 'haiku', 'sonnet'].includes(lower)) {
			return true;
		}

		// Anthropic model IDs
		if (lower.startsWith('claude-')) {
			return true;
		}

		// Known other provider prefixes (exclude these)
		const otherProviderPrefixes = ['glm-', 'deepseek-', 'openai-', 'gpt-', 'qwen-'];
		if (otherProviderPrefixes.some((prefix) => lower.startsWith(prefix))) {
			return false;
		}

		// Default: assume Anthropic for unknown models
		// (this allows legacy model IDs to work)
		return true;
	}

	/**
	 * Get model for a specific tier
	 */
	getModelForTier(tier: ModelTier): string | undefined {
		const tierMap: Record<ModelTier, string> = {
			sonnet: 'default',
			haiku: 'haiku',
			opus: 'opus',
			default: 'default',
		};
		return tierMap[tier];
	}

	/**
	 * Build SDK configuration for Anthropic
	 *
	 * Anthropic uses default SDK behavior - no special config needed.
	 * Returns empty env vars (SDK handles auth from environment).
	 */
	buildSdkConfig(): ProviderSdkConfig {
		return {
			envVars: {},
			isAnthropicCompatible: true,
			apiVersion: 'v1',
		};
	}

	/**
	 * Set model cache
	 * Useful for pre-warming the cache from external model loading
	 */
	setModelCache(models: ModelInfo[]): void {
		this.modelCache = models;
	}

	/**
	 * Clear model cache
	 */
	clearModelCache(): void {
		this.modelCache = null;
	}
}

/**
 * Helper function to get models from an existing query
 * This is useful for getting models from an active session's query
 */
export async function getAnthropicModelsFromQuery(queryObject: Query | null): Promise<ModelInfo[]> {
	if (!queryObject || typeof queryObject.supportedModels !== 'function') {
		return [];
	}

	const provider = new AnthropicProvider();
	try {
		const sdkModels = await queryObject.supportedModels();
		return provider.convertSdkModels(sdkModels);
	} catch (error) {
		console.warn('[AnthropicProvider] Failed to load models from query:', error);
		return [];
	}
}
