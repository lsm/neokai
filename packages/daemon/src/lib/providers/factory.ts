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
import { MinimaxProvider } from './minimax-provider.js';
import { OpenAiProvider } from './openai-provider.js';
import { GitHubCopilotProvider } from './github-copilot-provider.js';
import { getProviderRegistry, type ProviderRegistry } from './registry.js';
export { getProviderRegistry };
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
	// If already initialized, return the existing registry
	// This handles the case where getProviderRegistry() was called but no providers were registered
	if (initialized) {
		const registry = getProviderRegistry();
		// Check if registry has any providers - if not, we need to reinitialize
		if (registry.size > 0) {
			return registry;
		}
		// Registry was reset but initialized flag wasn't - need to reinitialize
	}

	const registry = getProviderRegistry();

	// Register Anthropic provider (always available)
	registry.register(new AnthropicProvider());

	// Register GLM provider (will be available if API key is set)
	registry.register(new GlmProvider());

	// Register MiniMax provider (will be available if MINIMAX_API_KEY is set)
	registry.register(new MinimaxProvider());

	// Register OpenAI provider (will be available if OPENAI_API_KEY is set)
	registry.register(new OpenAiProvider());

	// Register GitHub Copilot provider (will be available if OAuth token is configured)
	registry.register(new GitHubCopilotProvider());

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
 * Reset the provider factory initialization state
 *
 * MUST be called alongside resetProviderRegistry() to fully reset
 * the provider system. This is typically only needed in tests.
 *
 * @public Exported for testing purposes
 */
export function resetProviderFactory(): void {
	initialized = false;
}

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
} from '@neokai/shared/provider';
