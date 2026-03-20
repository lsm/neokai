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

import type { Provider, ProviderContext } from '@neokai/shared/provider';
import type { Session, ProviderId } from '@neokai/shared';
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
	 * Resolves the provider from the explicit `session.config.provider` ID.
	 * Throws if the session has no stored provider or the stored ID is not registered —
	 * silent rerouting to a default provider is intentionally not allowed here.
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
	 * Resolve the provider for a session.
	 *
	 * Throws — never silently falls back — so misconfigured sessions surface as
	 * clear errors rather than being silently rerouted to the wrong provider.
	 */
	private resolveProvider(session: Session): Provider {
		const providerId = session.config.provider;

		if (!providerId) {
			throw new Error(
				`Session '${session.id}' has no provider stored in config. ` +
					`All sessions created after PR #466 store an explicit provider ID.`
			);
		}

		const provider = this.registry.get(providerId);
		if (!provider) {
			throw new Error(
				`Provider '${providerId}' (requested by session '${session.id}') is not registered.`
			);
		}

		return provider;
	}

	/**
	 * Check if a model switch requires a query restart.
	 *
	 * Cross-provider switches require restart because the SDK subprocess
	 * needs different environment variables.
	 *
	 * @param session - Current session (used to resolve the current provider)
	 * @param newModelId - Target model ID (informational)
	 * @param newProviderId - Target provider ID (explicit — must be known by the caller)
	 */
	requiresQueryRestart(session: Session, newModelId: string, newProviderId: string): boolean {
		const currentProvider = this.resolveProvider(session);
		const newProvider = this.registry.get(newProviderId);

		// If the new provider is unknown, assume a different one — safer to restart
		if (!newProvider) {
			return true;
		}

		return currentProvider.id !== newProvider.id;
	}

	/**
	 * Get provider by ID
	 */
	getProvider(providerId: ProviderId): Provider | undefined {
		return this.registry.get(providerId);
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
