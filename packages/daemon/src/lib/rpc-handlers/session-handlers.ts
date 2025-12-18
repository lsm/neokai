/**
 * Session RPC Handlers
 */

import type { MessageHub, MessageImage, Session } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@liuboer/shared';
import { clearModelsCache } from '../model-service';

export function setupSessionHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
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

		// STEP 2: Initialize workspace on first message (2-stage session creation)
		// This creates the worktree and sets session.worktree (~2s)
		// CRITICAL: Must complete BEFORE SDK query starts so cwd is correct
		if (!session.metadata.workspaceInitialized) {
			await sessionManager.initializeSessionWorkspace(targetSessionId, content);
		}

		// STEP 3: Start SDK query (if not started) and enqueue message for processing
		// Now uses correct worktree path as cwd since workspace init is complete
		await agentSession.startQueryAndEnqueue(messageId, messageContent);

		// Clear draft if it matches the sent message content
		// This prevents the draft from reappearing after send
		if (session.metadata?.inputDraft && session.metadata.inputDraft === content.trim()) {
			// Cast to bypass strict typing - database.updateSession handles partial metadata merging
			await sessionManager.updateSession(targetSessionId, {
				metadata: { inputDraft: undefined },
			} as Partial<Session>);
		}

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
}
