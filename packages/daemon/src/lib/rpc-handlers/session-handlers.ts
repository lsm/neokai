/**
 * Session RPC Handlers
 *
 * ARCHITECTURE: Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms)
 * - Heavy operations are deferred to EventBus subscribers
 * - State updates are broadcast via State Channels
 */

import type { MessageHub, MessageImage, Session, EventBus } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
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
	// ARCHITECTURE: Fast RPC handler - emits event, returns immediately
	// EventBus-centric pattern: RPC → emit event → SessionManager handles persistence
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

		// Verify session exists before emitting event
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Generate messageId immediately for return
		const messageId = generateUUID();

		// Fire-and-forget: emit event, SessionManager handles persistence
		// All heavy operations (message persistence, title gen, SDK query) handled by EventBus subscribers
		eventBus
			.emit('message:send:request', {
				sessionId: targetSessionId,
				messageId,
				content,
				images,
			})
			.catch((err) => {
				console.error('[message.send] Error emitting message send event:', err);
			});

		// Return immediately with messageId
		// Client gets instant feedback, heavy processing continues async
		return { messageId };
	});

	// Handle session interruption
	// ARCHITECTURE: Fire-and-forget via EventBus, AgentSession subscribes
	messageHub.handle('client.interrupt', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		// Verify session exists before emitting event
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Fire-and-forget: emit event, AgentSession handles it
		eventBus.emit('agent:interrupt:request', { sessionId: targetSessionId }).catch((err) => {
			console.error('[client.interrupt] Error emitting interrupt event:', err);
		});

		return { accepted: true };
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
	// Returns synchronous result for test compatibility and immediate feedback
	messageHub.handle('session.model.switch', async (data) => {
		const { sessionId: targetSessionId, model } = data as {
			sessionId: string;
			model: string;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Call handleModelSwitch directly - returns {success, model, error}
		const result = await agentSession.handleModelSwitch(model);

		// Broadcast model switch result via state channels for UI updates
		if (result.success) {
			await messageHub.publish(
				'session.updated',
				{ model: result.model },
				{ sessionId: targetSessionId }
			);
		}

		return result;
	});

	// Handle thinking level changes
	// Levels: auto, think8k, think16k, think32k
	// - auto: No thinking budget
	// - think8k/16k/32k: Token budget set via maxThinkingTokens
	// Note: "ultrathink" keyword is NOT auto-appended - users must type it manually
	messageHub.handle('session.thinking.set', async (data) => {
		const { sessionId: targetSessionId, level } = data as {
			sessionId: string;
			level: 'auto' | 'think8k' | 'think16k' | 'think32k';
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Validate level
		const validLevels = ['auto', 'think8k', 'think16k', 'think32k'];
		const thinkingLevel = validLevels.includes(level) ? level : 'auto';

		// Update session config with new thinkingLevel
		await sessionManager.updateSession(targetSessionId, {
			config: {
				...agentSession.getSessionData().config,
				thinkingLevel: thinkingLevel as 'auto' | 'think8k' | 'think16k' | 'think32k',
			},
		});

		// Broadcast the thinking level change
		await messageHub.publish(
			'session.updated',
			{ config: { thinkingLevel } },
			{ sessionId: targetSessionId }
		);

		return { success: true, thinkingLevel };
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
	// ARCHITECTURE: Fire-and-forget via EventBus, AgentSession subscribes
	messageHub.handle('session.resetQuery', async (data) => {
		const { sessionId: targetSessionId, restartQuery = true } = data as {
			sessionId: string;
			restartQuery?: boolean;
		};

		// Verify session exists before emitting event
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Fire-and-forget: emit event, AgentSession handles it
		// Reset result is broadcast via 'agent:reset' event → StateManager → clients
		eventBus
			.emit('agent:reset:request', { sessionId: targetSessionId, restartQuery })
			.catch((err) => {
				console.error('[session.resetQuery] Error emitting reset event:', err);
			});

		return { accepted: true };
	});
}
