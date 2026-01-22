/**
 * Agent module - Core agent session components
 *
 * This module contains all components related to agent session management:
 * - AgentSession: Main orchestrator for Claude SDK integration
 * - MessageQueue: Async message queue for SDK streaming input
 * - ProcessingStateManager: State machine for processing phases
 * - ContextTracker: Real-time context window usage tracking
 * - SDKMessageHandler: SDK message processing and persistence
 * - QueryOptionsBuilder: SDK query options construction
 * - QueryLifecycleManager: Query restart/reset logic
 * - ModelSwitchHandler: Model switching logic
 * - QueryRunner: Query execution and abort handling
 * - InterruptHandler: Interrupt logic
 * - SDKRuntimeConfig: Runtime SDK configuration
 * - EventSubscriptionSetup: Event subscription management
 * - QueryModeHandler: Manual/Auto-queue mode handling
 * - SlashCommandManager: Slash command caching
 * - MessageRecoveryHandler: Orphaned message recovery
 * - OutputLimiterHook: Output limiting for SDK hooks
 * - ContextFetcher: Context breakdown fetching
 * - ApiErrorCircuitBreaker: API error loop detection
 */

// Main orchestrator
export { AgentSession } from './agent-session';

// Core components
export { MessageQueue } from './message-queue';
export { ProcessingStateManager } from './processing-state-manager';
export { ContextTracker } from './context-tracker';
export { SDKMessageHandler } from './sdk-message-handler';
export { QueryOptionsBuilder } from './query-options-builder';
export { QueryLifecycleManager } from './query-lifecycle-manager';
export { ModelSwitchHandler } from './model-switch-handler';

// Extracted handlers (refactored from AgentSession)
export { QueryRunner } from './query-runner';
export { InterruptHandler } from './interrupt-handler';
export { SDKRuntimeConfig } from './sdk-runtime-config';
export { EventSubscriptionSetup } from './event-subscription-setup';
export { QueryModeHandler } from './query-mode-handler';
export { SlashCommandManager } from './slash-command-manager';
export { MessageRecoveryHandler } from './message-recovery-handler';

// Hooks and utilities
export {
	createOutputLimiterHook,
	getOutputLimiterConfigFromSettings,
} from './output-limiter-hook';
export { ContextFetcher } from './context-fetcher';
export { ApiErrorCircuitBreaker } from './api-error-circuit-breaker';
