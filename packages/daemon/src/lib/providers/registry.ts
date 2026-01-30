/**
 * Provider Registry - Dynamic provider registration and lookup
 *
 * The registry is the central point for managing providers at runtime.
 * Providers can be registered, unregistered, and queried dynamically.
 *
 * This enables:
 * - Adding new providers without modifying core code
 * - Plugin-style provider architecture
 * - Provider auto-detection from model IDs
 */

import type { Provider, ProviderId, ProviderInfo } from '@neokai/shared/provider';

/**
 * Provider Registry class
 *
 * Singleton pattern - use getProviderRegistry() to get the instance.
 */
export class ProviderRegistry {
	private providers = new Map<ProviderId, Provider>();

	/**
	 * Register a provider
	 * @throws if provider ID already exists
	 */
	register(provider: Provider): void {
		if (this.providers.has(provider.id)) {
			throw new Error(`Provider ${provider.id} is already registered`);
		}
		this.providers.set(provider.id, provider);
	}

	/**
	 * Unregister a provider
	 */
	unregister(providerId: ProviderId): void {
		this.providers.delete(providerId);
	}

	/**
	 * Get a provider by ID
	 */
	get(providerId: ProviderId): Provider | undefined {
		return this.providers.get(providerId);
	}

	/**
	 * Check if a provider is registered
	 */
	has(providerId: ProviderId): boolean {
		return this.providers.has(providerId);
	}

	/**
	 * Get all registered providers
	 */
	getAll(): Provider[] {
		return Array.from(this.providers.values());
	}

	/**
	 * Get available providers (those with valid credentials)
	 */
	async getAvailable(): Promise<Provider[]> {
		const all = this.getAll();
		const results = await Promise.all(
			all.map(async (provider) => {
				const available = await provider.isAvailable();
				return available ? provider : null;
			})
		);
		return results.filter((p): p is Provider => p !== null);
	}

	/**
	 * Detect provider from model ID
	 * Asks each provider if it owns the model
	 *
	 * Returns undefined if no provider claims the model
	 */
	detectProvider(modelId: string): Provider | undefined {
		for (const provider of this.getAll()) {
			if (provider.ownsModel(modelId)) {
				return provider;
			}
		}
		return undefined;
	}

	/**
	 * Get provider information for all registered providers
	 * Useful for UI display
	 */
	async getProviderInfo(): Promise<ProviderInfo[]> {
		const providers = this.getAll();

		const results = await Promise.all(
			providers.map(async (provider) => {
				const available = await provider.isAvailable();
				const models = await provider.getModels();

				return {
					id: provider.id,
					name: provider.displayName,
					available,
					capabilities: provider.capabilities,
					models: models.map((m) => m.id),
				} satisfies ProviderInfo;
			})
		);

		return results;
	}

	/**
	 * Get the default provider
	 * Priority:
	 * 1. DEFAULT_PROVIDER env var (if matches a registered provider)
	 * 2. First available provider
	 * 3. Anthropic (if registered)
	 * 4. First registered provider
	 */
	async getDefaultProvider(): Promise<Provider> {
		const envProvider = process.env.DEFAULT_PROVIDER;
		if (envProvider && this.has(envProvider)) {
			return this.get(envProvider)!;
		}

		// Try first available provider
		const available = await this.getAvailable();
		if (available.length > 0) {
			return available[0];
		}

		// Fall back to Anthropic
		if (this.has('anthropic')) {
			return this.get('anthropic')!;
		}

		// Fall back to first registered provider
		const all = this.getAll();
		if (all.length > 0) {
			return all[0];
		}

		throw new Error('No providers registered');
	}

	/**
	 * Validate a provider switch
	 * Checks if the provider exists and is available (or can be made available with API key)
	 */
	async validateProviderSwitch(
		providerId: ProviderId,
		apiKey?: string
	): Promise<{ valid: boolean; error?: string }> {
		// Check if provider is known
		const provider = this.get(providerId);
		if (!provider) {
			return { valid: false, error: `Unknown provider: ${providerId}` };
		}

		// If API key is provided, assume it will work
		if (apiKey) {
			return { valid: true };
		}

		// Check if provider is available
		const available = await provider.isAvailable();
		if (!available) {
			return {
				valid: false,
				error: `Provider ${providerId} is not available. Configure API key.`,
			};
		}

		return { valid: true };
	}

	/**
	 * Clear all registered providers
	 * Useful for testing
	 */
	clear(): void {
		this.providers.clear();
	}

	/**
	 * Get the count of registered providers
	 */
	get size(): number {
		return this.providers.size;
	}
}

/**
 * Global registry instance
 */
let registryInstance: ProviderRegistry | null = null;

/**
 * Get the global provider registry instance
 */
export function getProviderRegistry(): ProviderRegistry {
	if (!registryInstance) {
		registryInstance = new ProviderRegistry();
	}
	return registryInstance;
}

/**
 * Reset the global registry instance
 * Useful for testing
 */
export function resetProviderRegistry(): void {
	registryInstance = null;
}
