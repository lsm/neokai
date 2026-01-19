/**
 * Provider Context Manager
 *
 * Manages provider-specific contexts without global state mutation.
 * Creates isolated scopes for provider configuration per session.
 *
 * This replaces the environment variable mutation pattern with a
 * cleaner approach where provider configuration is built into
 * SDK options directly.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Provider, ProviderContext } from '@liuboer/shared/provider';
import type { Session, ProviderId } from '@liuboer/shared';
import type { ProviderRegistry } from './registry.js';

/**
 * Context implementation class
 */
class ContextImpl implements ProviderContext {
	readonly sessionConfig;

	constructor(
		readonly provider: Provider,
		readonly sdkConfig: ProviderContext['sdkConfig'],
		readonly modelId: string,
		sessionConfig?: Record<string, unknown>
	) {
		this.sessionConfig = sessionConfig;
	}

	/**
	 * Get the SDK-compatible model ID
	 * Applies translation if provider needs it
	 */
	getSdkModelId(): string {
		if (this.provider.translateModelIdForSdk) {
			return this.provider.translateModelIdForSdk(this.modelId);
		}
		return this.modelId;
	}

	/**
	 * Build SDK options with provider configuration applied
	 * Merges base options with provider-specific env vars and settings
	 */
	async buildSdkOptions<T extends Record<string, unknown>>(baseOptions: T): Promise<T> {
		const sdkModelId = this.getSdkModelId();

		// Merge provider env vars with base options
		const mergedEnv: Record<string, string> = {
			...(baseOptions.env as Record<string, string> | undefined),
			...this.sdkConfig.envVars,
		};

		// Build merged options
		const mergedOptions: T = {
			...baseOptions,
			model: sdkModelId,
			env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
		};

		// Merge any additional SDK options from provider
		if (this.sdkConfig.sdkOptions) {
			Object.assign(mergedOptions, this.sdkConfig.sdkOptions);
		}

		return mergedOptions;
	}
}

/**
 * Provider Context Manager
 *
 * Creates and manages provider contexts for sessions.
 */
export class ProviderContextManager {
	constructor(private readonly registry: ProviderRegistry) {}

	/**
	 * Create a provider context for a session
	 *
	 * Resolves the provider from:
	 * 1. Explicit session.config.provider
	 * 2. Model-based detection via registry
	 * 3. Default to Anthropic
	 */
	createContext(session: Session): ProviderContext {
		// Resolve provider for this session
		const provider = this.resolveProvider(session);
		const modelId = session.config.model || 'default';

		// Build SDK configuration for this provider
		const sessionConfig = session.config.providerConfig;
		const sdkConfig = provider.buildSdkConfig(modelId, sessionConfig);

		return new ContextImpl(provider, sdkConfig, modelId, sessionConfig);
	}

	/**
	 * Resolve the provider for a session
	 */
	private resolveProvider(session: Session): Provider {
		// 1. Try explicit provider first
		if (session.config.provider) {
			const provider = this.registry.get(session.config.provider);
			if (provider) {
				return provider;
			}
			console.warn(
				`[ProviderContextManager] Explicit provider "${session.config.provider}" not registered, falling back to detection`
			);
		}

		// 2. Detect provider from model ID
		const modelId = session.config.model || 'default';
		const detected = this.registry.detectProvider(modelId);
		if (detected) {
			return detected;
		}

		// 3. Default to Anthropic
		const anthropic = this.registry.get('anthropic');
		if (anthropic) {
			return anthropic;
		}

		throw new Error('No provider available for session');
	}

	/**
	 * Check if a model switch requires a query restart
	 *
	 * Cross-provider switches require restart because the SDK subprocess
	 * needs different environment variables.
	 */
	requiresQueryRestart(session: Session, newModelId: string): boolean {
		const currentProvider = this.resolveProvider(session);
		const newProvider = this.registry.detectProvider(newModelId);

		// If we can't detect the new provider, assume it's different
		if (!newProvider) {
			return true;
		}

		// Restart if providers are different
		return currentProvider.id !== newProvider.id;
	}

	/**
	 * Get provider by ID
	 */
	getProvider(providerId: ProviderId): Provider | undefined {
		return this.registry.get(providerId);
	}

	/**
	 * Detect provider from model ID
	 */
	detectProvider(modelId: string): Provider | undefined {
		return this.registry.detectProvider(modelId);
	}

	/**
	 * Validate a provider switch
	 */
	async validateProviderSwitch(
		providerId: ProviderId,
		apiKey?: string
	): Promise<{ valid: boolean; error?: string }> {
		return this.registry.validateProviderSwitch(providerId, apiKey);
	}

	/**
	 * Get available providers
	 */
	async getAvailableProviders(): Promise<Provider[]> {
		return this.registry.getAvailable();
	}
}

/**
 * Helper to build SDK options with provider context
 *
 * This is a convenience function for the common pattern:
 * ```typescript
 * const context = contextManager.createContext(session);
 * const options = await context.buildSdkOptions(baseOptions);
 * ```
 */
export async function buildProviderAwareSdkOptions<T extends Options>(
	session: Session,
	baseOptions: T,
	contextManager: ProviderContextManager
): Promise<T> {
	const context = contextManager.createContext(session);
	return context.buildSdkOptions(baseOptions);
}
