/**
 * Session RPC Handlers
 *
 * ARCHITECTURE: Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms)
 * - Heavy operations are deferred to EventBus subscribers
 * - State updates are broadcast via State Channels
 */

import type { MessageHub, MessageImage, Session, EventBus } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@liuboer/shared';
import { clearModelsCache } from '../model-service';

export function setupSessionHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager,
	eventBus: EventBus
): void {
	messageHub.handle('session.create', async (data) => {
		const req = data as CreateSessionRequest;
		const sessionId = await sessionManager.createSession({
			workspacePath: req.workspacePath,
			initialTools: req.initialTools,
			config: req.config,
			useWorktree: req.useWorktree,
			worktreeBaseBranch: req.worktreeBaseBranch,
		});

		// Return the full session object so client can optimistically update
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession?.getSessionData();

		return { sessionId, session };
	});

	messageHub.handle('session.list', async () => {
		const sessions = sessionManager.listSessions();
		return { sessions };
	});

	messageHub.handle('session.get', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		const session = agentSession.getSessionData();
		const contextInfo = agentSession.getContextInfo();

		return {
			session,
			activeTools: [],
			// File/workspace context (for display purposes)
			context: {
				files: [],
				workingDirectory: session.workspacePath,
			},
			// Token usage context info (for StatusIndicator)
			contextInfo,
		};
	});

	messageHub.handle('session.update', async (data, _ctx) => {
		const { sessionId: targetSessionId, ...updates } = data as UpdateSessionRequest & {
			sessionId: string;
		};

		// Convert UpdateSessionRequest to Partial<Session>
		// config in UpdateSessionRequest is Partial<SessionConfig>, which is handled by
		// database.updateSession merging with existing config
		await sessionManager.updateSession(targetSessionId, updates as Partial<Session>);

		// Broadcast update event to all clients
		await messageHub.publish('session.updated', updates, {
			sessionId: targetSessionId,
		});

		return { success: true };
	});

	messageHub.handle('session.delete', async (data, _ctx) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };
		await sessionManager.deleteSession(targetSessionId);

		// Broadcast deletion event to all clients
		await messageHub.publish(
			'session.deleted',
			{},
			{
				sessionId: targetSessionId,
			}
		);

		return { success: true };
	});

	messageHub.handle('session.archive', async (data, _ctx) => {
		const { sessionId: targetSessionId, confirmed = false } = data as {
			sessionId: string;
			confirmed?: boolean;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const session = agentSession.getSessionData();

		// No worktree - direct archive
		if (!session.worktree) {
			await sessionManager.updateSession(targetSessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
			} as Partial<Session>);

			return { success: true, requiresConfirmation: false };
		}

		// Check commits ahead
		const { WorktreeManager } = await import('../worktree-manager');
		const worktreeManager = new WorktreeManager();
		const commitStatus = await worktreeManager.getCommitsAhead(session.worktree);

		// If has commits and not confirmed, return commit info
		if (!confirmed && commitStatus.hasCommitsAhead) {
			return {
				success: false,
				requiresConfirmation: true,
				commitStatus,
			};
		}

		// Archive: remove worktree and update session
		try {
			await worktreeManager.removeWorktree(session.worktree, true);

			await sessionManager.updateSession(targetSessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
				worktree: undefined,
			} as Partial<Session>);

			return {
				success: true,
				requiresConfirmation: false,
				commitsRemoved: commitStatus.commits.length,
			};
		} catch (error) {
			throw new Error(
				`Failed to archive: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	});

	// Handle message sending to a session
	// ARCHITECTURE: Fast RPC handler - defers heavy work to EventBus
	messageHub.handle('message.send', async (data) => {
		const {
			sessionId: targetSessionId,
			content,
			images,
		} = data as {
			sessionId: string;
			content: string;
			images?: MessageImage[];
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const session = agentSession.getSessionData();

		// STEP 1: Persist user message and publish to UI IMMEDIATELY (instant UX)
		// User sees their message instantly (<10ms) before any blocking operations
		const { messageId, messageContent } = await agentSession.persistUserMessage({
			content,
			images,
		});

		// STEP 2: Emit event for async processing (truly non-blocking fire-and-forget)
		// Heavy operations (title gen, branch rename, SDK query, draft clearing) handled by EventBus subscriber
		// DO NOT await - this ensures RPC returns quickly (<100ms) and avoids timeout issues
		// Title generation alone can take 15+ seconds if SDK is slow
		// NOTE: Workspace (worktree) is already created during session creation
		eventBus
			.emit('user-message:persisted', {
				sessionId: targetSessionId,
				messageId,
				messageContent,
				userMessageText: content,
				needsWorkspaceInit: !session.metadata.titleGenerated, // Triggers title gen on first message
				hasDraftToClear: session.metadata?.inputDraft === content.trim(),
			})
			.catch((err) => {
				console.error('[message.send] Error in async message processing:', err);
			});

		// STEP 3: Return immediately with messageId
		// Client gets instant feedback, heavy processing continues async
		return { messageId };
	});

	// Handle session interruption
	messageHub.handle('client.interrupt', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		await agentSession.handleInterrupt();
		return { success: true };
	});

	// Handle getting current model information
	messageHub.handle('session.model.get', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Get current model ID
		const currentModelId = agentSession.getCurrentModel().id;

		// Fetch full model info from SDK asynchronously
		const { getModelInfo } = await import('../model-service');
		const modelInfo = await getModelInfo(currentModelId);

		return {
			currentModel: currentModelId,
			modelInfo,
		};
	});

	// Handle model switching
	messageHub.handle('session.model.switch', async (data) => {
		const { sessionId: targetSessionId, model } = data as {
			sessionId: string;
			model: string;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const result = await agentSession.handleModelSwitch(model);

		// If successful, broadcast the model switch event
		if (result.success) {
			await messageHub.publish(
				'session.updated',
				{ model: result.model },
				{ sessionId: targetSessionId }
			);
		}

		return result;
	});

	// Handle listing available models - uses hardcoded model list
	messageHub.handle('models.list', async (data) => {
		try {
			// Import model service for dynamic models (with static fallback)
			const { getAvailableModels } = await import('../model-service');

			// Check if forceRefresh is requested or useCache is disabled
			const params = data as { forceRefresh?: boolean; useCache?: boolean };
			const forceRefresh = params?.forceRefresh ?? params?.useCache === false;

			// Get models from cache (uses 'global' cache key)
			// This will return dynamic models if they were loaded, otherwise static fallback
			const availableModels = getAvailableModels('global');

			// Return models in the expected format
			return {
				models: availableModels.map((m) => ({
					id: m.id,
					display_name: m.name,
					description: m.description,
					type: 'model' as const,
				})),
				// If forceRefresh is true, indicate that this is a fresh fetch
				cached: !forceRefresh,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[RPC] Failed to list models:', errorMessage);
			throw new Error(`Failed to list models: ${errorMessage}`);
		}
	});

	// Handle clearing the model cache
	messageHub.handle('models.clearCache', async () => {
		clearModelsCache();
		return { success: true };
	});

	// FIX: Handle getting current agent processing state
	// Called by clients after subscribing to agent.state to get initial snapshot
	messageHub.handle('agent.getState', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const state = agentSession.getProcessingState();

		// Return current state (don't publish - this is just a query, not a state change)
		return { state };
	});

	// Handle manual cleanup of orphaned worktrees
	messageHub.handle('worktree.cleanup', async (data) => {
		const { workspacePath } = data as { workspacePath?: string };
		const cleanedPaths = await sessionManager.cleanupOrphanedWorktrees(workspacePath);

		return {
			success: true,
			cleanedPaths,
			message: `Cleaned up ${cleanedPaths.length} orphaned worktree(s)`,
		};
	});

	// Handle resetting the SDK agent query
	// This forcefully terminates and restarts the SDK query stream
	// Use case: Recovering from stuck "queued" state or unresponsive SDK
	messageHub.handle('session.resetQuery', async (data) => {
		const { sessionId: targetSessionId, restartQuery = true } = data as {
			sessionId: string;
			restartQuery?: boolean;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const result = await agentSession.resetQuery({ restartQuery });

		if (result.success) {
			// Notify all clients about the reset
			await messageHub.publish(
				'session.reset',
				{ message: 'Agent has been reset successfully' },
				{ sessionId: targetSessionId }
			);
		}

		return result;
	});
}
