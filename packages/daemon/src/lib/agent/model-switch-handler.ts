/**
 * ModelSwitchHandler - Handles model switching logic for AgentSession
 *
 * Extracted from AgentSession to reduce complexity and improve testability.
 * Handles:
 * - Model validation and alias resolution
 * - SDK setModel() integration
 * - Session config persistence
 * - Event emission for UI updates
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session, CurrentModelInfo } from '@liuboer/shared';
import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service';
import { getProviderRegistry } from '../providers/index.js';
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
	 * Handles same-provider switches using SDK's setModel() and cross-provider
	 * switches by restarting the query with new environment variables.
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
			// Cross-provider switches require query restart because the SDK subprocess
			// needs different environment variables (ANTHROPIC_BASE_URL, API keys, etc.)
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
			} else if (isCrossProviderSwitch) {
				// Cross-provider switch: need to restart the query to get new env vars
				// The SDK subprocess was created with provider-specific env vars
				// (ANTHROPIC_BASE_URL, API keys, etc.) that cannot be changed dynamically
				if (!restartQuery) {
					const error = `Cross-provider switch requires query restart, but restartQuery callback not provided`;
					logger.error(error);
					return { success: false, model: session.config.model, error };
				}

				const newProviderId = newProviderInstance?.id || 'unknown';
				logger.log(
					`Restarting query for cross-provider switch to ${resolvedModel} (${newProviderId})`
				);

				// Update session config first (will be used when query restarts)
				session.config.model = resolvedModel;
				db.updateSession(session.id, {
					config: session.config,
				});

				// Update context tracker model
				contextTracker.setModel(resolvedModel);

				// Restart the query with new environment variables
				// This will spawn a new SDK subprocess with the correct provider env vars
				await restartQuery();

				logger.log(`Query restarted for cross-provider switch to ${resolvedModel}`);
			} else {
				// Same-provider switch: Use SDK's native setModel() method
				// This is fast (<500ms) and doesn't require restarting the subprocess
				logger.log(`Using SDK setModel() to switch to: ${resolvedModel}`);
				await queryObject.setModel(resolvedModel);

				// Update session config
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

				logger.log(`Model switched via SDK to: ${resolvedModel}`);
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
