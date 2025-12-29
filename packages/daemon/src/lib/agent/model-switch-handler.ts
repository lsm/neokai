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
import type { EventBus, MessageHub } from '@liuboer/shared';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service';
import type { ContextTracker } from './context-tracker';
import type { ProcessingStateManager } from './processing-state-manager';

/**
 * Dependencies required for model switching
 */
export interface ModelSwitchDependencies {
	session: Session;
	db: Database;
	messageHub: MessageHub;
	eventBus: EventBus;
	contextTracker: ContextTracker;
	stateManager: ProcessingStateManager;
	errorManager: ErrorManager;
	logger: Logger;
	getQueryObject: () => Query | null;
	isTransportReady: () => boolean;
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
	 * Switch to a different Claude model mid-session
	 */
	async switchModel(newModel: string): Promise<ModelSwitchResult> {
		const {
			session,
			db,
			messageHub,
			eventBus,
			contextTracker,
			stateManager,
			errorManager,
			logger,
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

				// Emit session:updated event - include data for decoupled state management
				await eventBus.emit('session:updated', {
					sessionId: session.id,
					source: 'model-switch',
					session: { config: session.config },
				});
			} else {
				// Use SDK's native setModel() method (transport is ready)
				logger.log(`Using SDK setModel() to switch to: ${resolvedModel}`);
				await queryObject.setModel(resolvedModel);

				// Update session config
				session.config.model = resolvedModel;
				db.updateSession(session.id, {
					config: session.config,
				});

				// Update context tracker model
				contextTracker.setModel(resolvedModel);

				// Emit session:updated event - include data for decoupled state management
				await eventBus.emit('session:updated', {
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
