/**
 * Multi-Provider Architecture
 *
 * This module provides the new provider system for multi-provider support.
 * It replaces the ad-hoc provider logic in provider-service.ts with a
 * proper abstraction layer.
 *
 * Usage:
 * ```typescript
 * import { initializeProviders, getProviderContextManager } from './providers';
 *
 * // Initialize at startup
 * const registry = initializeProviders();
 *
 * // Get context manager for building SDK options
 * const contextManager = getProviderContextManager();
 * const context = contextManager.createContext(session);
 * const options = await context.buildSdkOptions(baseOptions);
 * ```
 */

// Factory functions
export {
	initializeProviders,
	getProviderContextManager,
	isProviderSystemInitialized,
	registerCustomProvider,
	unregisterProvider,
	resetProviderFactory,
} from './factory.js';

// Registry
export {
	getProviderRegistry,
	resetProviderRegistry,
	ProviderRegistry,
} from './registry.js';

// Provider implementations
export { AnthropicProvider, getAnthropicModelsFromQuery } from './anthropic-provider.js';
export { GlmProvider } from './glm-provider.js';

// Context manager
export {
	ProviderContextManager,
	buildProviderAwareSdkOptions,
} from './context-manager.js';

// Types (re-exported from shared)
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
