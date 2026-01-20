/**
 * Provider Factory - Initialization and registration of built-in providers
 *
 * This module handles:
 * - Creating instances of built-in providers
 * - Registering them with the global registry
 * - Providing a single initialization point for the provider system
 */

import { AnthropicProvider } from './anthropic-provider.js';
import { GlmProvider } from './glm-provider.js';
import { getProviderRegistry, type ProviderRegistry } from './registry.js';
import { ProviderContextManager } from './context-manager.js';

/**
 * Initialization state
 */
let initialized = false;

/**
 * Initialize the provider system
 *
 * Registers all built-in providers with the global registry.
 * This should be called once at application startup.
 *
 * @returns The global provider registry
 */
export function initializeProviders(): ProviderRegistry {
	if (initialized) {
		return getProviderRegistry();
	}

	const registry = getProviderRegistry();

	// Register Anthropic provider (always available)
	registry.register(new AnthropicProvider());

	// Register GLM provider (will be available if API key is set)
	registry.register(new GlmProvider());

	// Additional built-in providers can be registered here
	// Example:
	// registry.register(new DeepSeekProvider());

	initialized = true;

	return registry;
}

/**
 * Get the provider context manager
 *
 * Creates a context manager instance backed by the global provider registry.
 *
 * @returns ProviderContextManager instance
 */
export function getProviderContextManager(): ProviderContextManager {
	const registry = initializeProviders();
	return new ProviderContextManager(registry);
}

/**
 * Check if the provider system has been initialized
 */
export function isProviderSystemInitialized(): boolean {
	return initialized;
}

/**
 * Reset the provider factory initialization state
 *
 * MUST be called alongside resetProviderRegistry() to fully reset
 * the provider system. This is typically only needed in tests.
 */
export function resetProviderFactory(): void {
	initialized = false;
}

/**
 * Register a custom provider
 *
 * Allows registering additional providers beyond the built-in ones.
 * Useful for plugins or custom provider implementations.
 *
 * @param provider - The provider instance to register
 * @throws if provider ID already exists
 */
export function registerCustomProvider(
	provider: import('@liuboer/shared/provider').Provider
): void {
	const registry = initializeProviders();
	registry.register(provider);
}

/**
 * Unregister a provider by ID
 *
 * @param providerId - The ID of the provider to unregister
 */
export function unregisterProvider(providerId: string): void {
	const registry = getProviderRegistry();
	registry.unregister(providerId);
}

/**
 * Re-export commonly used types and classes for convenience
 */
export { AnthropicProvider } from './anthropic-provider.js';
export { GlmProvider, GlmProvider as GLMProvider } from './glm-provider.js';
export { getProviderRegistry, resetProviderRegistry } from './registry.js';
export { ProviderContextManager } from './context-manager.js';

// Re-export types from shared package
export type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderId,
	ProviderInfo,
	ProviderSdkConfig,
	ProviderSessionConfig,
	ModelTier,
} from '@liuboer/shared/provider';
