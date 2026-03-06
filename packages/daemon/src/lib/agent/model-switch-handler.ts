/**
 * ModelSwitchHandler - Handles model switching logic for AgentSession
 *
 * Extracted from AgentSession to reduce complexity and improve testability.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Model validation and alias resolution
 * - Query restart to regenerate system:init with new model
 * - Session config persistence
 * - Event emission for UI updates
 *
 * FIX: Always restarts query when switching models mid-conversation.
 * SDK's setModel() doesn't update the cached system:init message, which
 * causes MessageInfoDropdown to show stale model info. Restarting ensures
 * fresh system:init is emitted with the correct model.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session, SessionConfig, CurrentModelInfo, MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { ErrorManager } from '../error-manager';
import { ErrorCategory } from '../error-manager';
import type { Logger } from '../logger';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service';
import { getProviderRegistry } from '../providers/factory.js';
import type { ContextTracker } from './context-tracker';
import type { ProcessingStateManager } from './processing-state-manager';
import type { QueryLifecycleManager } from './query-lifecycle-manager';

/**
 * Context interface - what ModelSwitchHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface ModelSwitchHandlerContext {
	readonly session: Session;
	readonly db: Database;
	readonly messageHub: MessageHub;
	readonly daemonHub: DaemonHub;
	readonly contextTracker: ContextTracker;
	readonly stateManager: ProcessingStateManager;
	readonly errorManager: ErrorManager;
	readonly logger: Logger;
	readonly lifecycleManager: QueryLifecycleManager;

	// SDK state
	readonly queryObject: Query | null;
	readonly firstMessageReceived: boolean;
}

/**
 * Result of a model switch operation
 */
export interface ModelSwitchResult {
	success: boolean;
	model: string;
	error?: string;
}

/**
 * Handles model switching for AgentSession
 */
export class ModelSwitchHandler {
	constructor(private ctx: ModelSwitchHandlerContext) {}

	/**
	 * Get current model ID for this session
	 */
	getCurrentModel(): CurrentModelInfo {
		return {
			id: this.ctx.session.config.model,
			info: null, // Model info is fetched asynchronously by RPC handler
		};
	}

	/**
	 * Switch to a different model mid-session
	 *
	 * Always restarts the query to ensure SDK emits a fresh system:init message
	 * with the correct model. This is necessary because SDK's setModel() doesn't
	 * update the cached system:init, causing stale model info in the UI.
	 */
	async switchModel(newModel: string): Promise<ModelSwitchResult> {
		const {
			session,
			db,
			messageHub,
			daemonHub,
			contextTracker,
			stateManager,
			errorManager,
			logger,
			lifecycleManager,
			queryObject,
			firstMessageReceived,
		} = this.ctx;

		try {
			// Validate the model
			const isValid = await isValidModel(newModel);
			if (!isValid) {
				const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
				logger.error(`${error}`);
				return { success: false, model: session.config.model, error };
			}

			// Get model info from the ORIGINAL alias to preserve provider context.
			// Resolving alias first (e.g., 'copilot-sonnet' → 'claude-sonnet-4.6') and then
			// calling getModelInfo loses the provider — two providers can share the same
			// canonical ID (e.g., Anthropic and GitHub Copilot both have 'claude-sonnet-4.6').
			const modelInfo = await getModelInfo(newModel);
			const resolvedModel = modelInfo?.id ?? (await resolveModelAlias(newModel));

			// Resolve the current model in case it's also an alias
			const currentResolvedModel = await resolveModelAlias(session.config.model);

			// Check if already using this model (compare resolved IDs)
			if (currentResolvedModel === resolvedModel) {
				return {
					success: true,
					model: resolvedModel,
					error: `Already using ${modelInfo?.name || resolvedModel}`,
				};
			}

			const previousModel = session.config.model;

			// Emit model switching event
			messageHub.event(
				'session.model-switching',
				{
					from: previousModel,
					to: resolvedModel,
				},
				{ channel: `session:${session.id}` }
			);

			// Check if query is running AND ProcessTransport is ready
			const transportReady = firstMessageReceived;

			// Detect if this is a cross-provider switch (e.g., Anthropic → GLM)
			// This is mainly for logging and updating the provider config field
			const providerRegistry = getProviderRegistry();
			const currentProviderInstance = providerRegistry.detectProvider(currentResolvedModel);
			// Use provider from model info to correctly handle shared canonical IDs
			// (e.g., 'claude-sonnet-4.6' is owned by both Anthropic and GitHub Copilot).
			// detectProvider() would always return Anthropic for 'claude-sonnet-4.6'.
			const newProviderInstance = modelInfo?.provider
				? (providerRegistry.get(modelInfo.provider) ??
					providerRegistry.detectProvider(resolvedModel))
				: providerRegistry.detectProvider(resolvedModel);
			const isCrossProviderSwitch = currentProviderInstance?.id !== newProviderInstance?.id;

			if (isCrossProviderSwitch) {
				const _currentProviderId = currentProviderInstance?.id || 'unknown';
				const _newProviderId = newProviderInstance?.id || 'unknown';
			}

			if (!queryObject || !transportReady) {
				// Query not started yet OR transport not ready - just update config
				session.config.model = resolvedModel;
				// Keep provider aligned with model for pre-query switches too.
				// Without this, a stale explicit provider can force wrong model routing.
				if (newProviderInstance?.id) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					session.config.provider = newProviderInstance.id as any;
				}
				// Only pass serializable fields — session.config may contain runtime-only
				// objects (mcpServers with closures, agents, spawnClaudeCodeProcess) that
				// cannot be JSON-stringified and would cause a cyclic structure error.
				db.updateSession(session.id, {
					config: {
						model: resolvedModel,
						...(newProviderInstance?.id && {
							provider: newProviderInstance.id as 'anthropic' | 'glm',
						}),
					} as SessionConfig,
				});

				// Update context tracker model
				contextTracker.setModel(resolvedModel);

				// Emit session.updated event - include data for decoupled state management
				await daemonHub.emit('session.updated', {
					sessionId: session.id,
					source: 'model-switch',
					session: { config: session.config },
				});
			} else {
				// Query is running - restart it to ensure system:init is regenerated with new model
				// FIX: SDK's setModel() doesn't update the cached system:init message,
				// causing MessageInfoDropdown to show stale model info.
				// Restarting forces SDK to emit fresh system:init with correct model.

				// Update session config first (will be used when query restarts)
				session.config.model = resolvedModel;
				// Keep provider aligned with model (same as the pre-query branch —
				// unconditionally update so same-provider switches don’t leave stale state).
				if (newProviderInstance?.id) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					session.config.provider = newProviderInstance.id as any;
				}
				// Only pass serializable fields — session.config may contain runtime-only
				// objects (mcpServers with closures, agents, spawnClaudeCodeProcess) that
				// cannot be JSON-stringified and would cause a cyclic structure error.
				db.updateSession(session.id, {
					config: {
						model: resolvedModel,
						...(newProviderInstance?.id && {
							provider: newProviderInstance.id as 'anthropic' | 'glm',
						}),
					} as SessionConfig,
				});

				// Update context tracker model
				contextTracker.setModel(resolvedModel);

				// Restart the query via lifecycle manager
				// This spawns a new SDK subprocess with the new model configuration
				await lifecycleManager.restart();
			}

			// Emit success event
			messageHub.event(
				'session.model-switched',
				{
					from: previousModel,
					to: resolvedModel,
					modelInfo: modelInfo || null,
				},
				{ channel: `session:${session.id}` }
			);

			return {
				success: true,
				model: resolvedModel,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Model switch failed:`, error);

			await errorManager.handleError(
				session.id,
				error as Error,
				ErrorCategory.MODEL,
				`Failed to switch model: ${errorMessage}`,
				stateManager.getState(),
				{
					requestedModel: newModel,
					currentModel: session.config.model,
				}
			);

			return {
				success: false,
				model: session.config.model,
				error: errorMessage,
			};
		}
	}
}
