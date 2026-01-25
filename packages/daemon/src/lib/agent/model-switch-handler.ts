/**
 * ModelSwitchHandler - Handles model switching logic for AgentSession
 *
 * Extracted from AgentSession to reduce complexity and improve testability.
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
import type { Session, CurrentModelInfo } from '@liuboer/shared';
import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service';
import { getProviderRegistry } from '../providers/factory.js';
import type { ContextTracker } from './context-tracker';
import type { ProcessingStateManager } from './processing-state-manager';

/**
 * Dependencies required for model switching
 */
export interface ModelSwitchDependencies {
	session: Session;
	db: Database;
	messageHub: MessageHub;
	daemonHub: DaemonHub;
	contextTracker: ContextTracker;
	stateManager: ProcessingStateManager;
	errorManager: ErrorManager;
	logger: Logger;
	getQueryObject: () => Query | null;
	isTransportReady: () => boolean;
	/**
	 * Callback to restart the query with new environment variables
	 * Required when switching between providers (e.g., Anthropic ↔ GLM)
	 * since the SDK subprocess needs different env vars (ANTHROPIC_BASE_URL, etc.)
	 */
	restartQuery?: () => Promise<void>;
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
	private deps: ModelSwitchDependencies;

	constructor(deps: ModelSwitchDependencies) {
		this.deps = deps;
	}

	/**
	 * Get current model ID for this session
	 */
	getCurrentModel(): CurrentModelInfo {
		return {
			id: this.deps.session.config.model,
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
			restartQuery,
		} = this.deps;

		logger.log(`Handling model switch to: ${newModel}`);

		try {
			// Validate the model
			const isValid = await isValidModel(newModel);
			if (!isValid) {
				const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
				logger.error(`${error}`);
				return { success: false, model: session.config.model, error };
			}

			// Resolve alias to full model ID
			const resolvedModel = await resolveModelAlias(newModel);
			const modelInfo = await getModelInfo(resolvedModel);

			// Resolve the current model in case it's also an alias
			const currentResolvedModel = await resolveModelAlias(session.config.model);

			// Check if already using this model (compare resolved IDs)
			if (currentResolvedModel === resolvedModel) {
				logger.log(`Already using model: ${resolvedModel}`);
				return {
					success: true,
					model: resolvedModel,
					error: `Already using ${modelInfo?.name || resolvedModel}`,
				};
			}

			const previousModel = session.config.model;

			// Emit model switching event
			await messageHub.publish(
				'session.model-switching',
				{
					from: previousModel,
					to: resolvedModel,
				},
				{ sessionId: session.id }
			);

			// Check if query is running AND ProcessTransport is ready
			const queryObject = this.deps.getQueryObject();
			const transportReady = this.deps.isTransportReady();

			// Detect if this is a cross-provider switch (e.g., Anthropic → GLM)
			// This is mainly for logging and updating the provider config field
			const providerRegistry = getProviderRegistry();
			const currentProviderInstance = providerRegistry.detectProvider(currentResolvedModel);
			const newProviderInstance = providerRegistry.detectProvider(resolvedModel);
			const isCrossProviderSwitch = currentProviderInstance?.id !== newProviderInstance?.id;

			if (isCrossProviderSwitch) {
				const currentProviderId = currentProviderInstance?.id || 'unknown';
				const newProviderId = newProviderInstance?.id || 'unknown';
				logger.log(`Cross-provider switch detected: ${currentProviderId} → ${newProviderId}`);
			}

			if (!queryObject || !transportReady) {
				// Query not started yet OR transport not ready - just update config
				logger.log(
					`${!queryObject ? 'Query not started yet' : 'ProcessTransport not ready yet'}, updating config only`
				);
				session.config.model = resolvedModel;
				db.updateSession(session.id, {
					config: session.config,
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
				if (!restartQuery) {
					const error = `Model switch requires query restart, but restartQuery callback not provided`;
					logger.error(error);
					return { success: false, model: session.config.model, error };
				}

				logger.log(`Restarting query for model switch to ${resolvedModel}`);

				// Update session config first (will be used when query restarts)
				session.config.model = resolvedModel;
				// Update provider in session config for cross-provider switches
				if (isCrossProviderSwitch && newProviderInstance?.id) {
					session.config.provider = newProviderInstance.id as 'anthropic' | 'glm';
				}
				db.updateSession(session.id, {
					config: session.config,
				});

				// Update context tracker model
				contextTracker.setModel(resolvedModel);

				// Restart the query
				// This spawns a new SDK subprocess with the new model configuration
				await restartQuery();

				logger.log(`Query restarted for model switch to ${resolvedModel}`);
			}

			// Emit success event
			await messageHub.publish(
				'session.model-switched',
				{
					from: previousModel,
					to: resolvedModel,
					modelInfo: modelInfo || null,
				},
				{ sessionId: session.id }
			);

			logger.log(`Model switched successfully to: ${resolvedModel}`);

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
