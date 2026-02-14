/**
 * Session RPC Handlers
 *
 * ARCHITECTURE: Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms)
 * - Heavy operations are deferred to EventBus subscribers
 * - State updates are broadcast via State Channels
 */

import type { MessageHub, MessageImage, Session } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import { generateUUID } from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@neokai/shared';
import { clearModelsCache } from '../model-service';
import {
	archiveSDKSessionFiles,
	deleteSDKSessionFiles,
	scanSDKSessionFiles,
	identifyOrphanedSDKFiles,
} from '../sdk-session-file-manager';

export function setupSessionHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager,
	daemonHub: DaemonHub
): void {
	messageHub.onRequest('session.create', async (data) => {
		const req = data as CreateSessionRequest;
		const sessionId = await sessionManager.createSession({
			workspacePath: req.workspacePath,
			initialTools: req.initialTools,
			config: req.config,
			worktreeBaseBranch: req.worktreeBaseBranch,
			title: req.title,
		});

		// Return the full session object so client can optimistically update
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession?.getSessionData();

		return { sessionId, session };
	});

	/**
	 * Set worktree mode for a session
	 * Called when user makes their choice in the worktree choice modal
	 */
	messageHub.onRequest('session.setWorktreeMode', async (data) => {
		const { sessionId, mode } = data as { sessionId: string; mode: 'worktree' | 'direct' };

		// Validate input
		if (!sessionId || !mode) {
			throw new Error('Missing required fields: sessionId and mode');
		}

		if (mode !== 'worktree' && mode !== 'direct') {
			throw new Error(`Invalid mode: ${mode}. Must be 'worktree' or 'direct'`);
		}

		// Get session lifecycle from session manager
		const sessionLifecycle = sessionManager.getSessionLifecycle();

		// Complete worktree choice
		const updatedSession = await sessionLifecycle.completeWorktreeChoice(sessionId, mode);

		// Broadcast update to all clients
		messageHub.event('session.updated', updatedSession, {
			channel: `session:${sessionId}`,
		});

		return { success: true, session: updatedSession };
	});

	messageHub.onRequest('session.list', async () => {
		const sessions = sessionManager.listSessions();
		return { sessions };
	});

	messageHub.onRequest('session.get', async (data) => {
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

	// FIX: Session health check to detect and report stuck sessions
	// Use case: Diagnose sessions that can't be loaded (zombie sessions)
	// Returns: valid (boolean), error (string if invalid)
	messageHub.onRequest('session.validate', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };
		try {
			const agentSession = await sessionManager.getSessionAsync(targetSessionId);
			return { valid: agentSession !== null, error: null };
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});

	messageHub.onRequest('session.update', async (data, _ctx) => {
		const { sessionId: targetSessionId, ...updates } = data as UpdateSessionRequest & {
			sessionId: string;
		};

		// Convert UpdateSessionRequest to Partial<Session>
		// config in UpdateSessionRequest is Partial<SessionConfig>, which is handled by
		// database.updateSession merging with existing config
		await sessionManager.updateSession(targetSessionId, updates as Partial<Session>);

		// Broadcast update event to all clients
		messageHub.event('session.updated', updates, {
			channel: `session:${targetSessionId}`,
		});

		return { success: true };
	});

	messageHub.onRequest('session.delete', async (data, _ctx) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };
		await sessionManager.deleteSession(targetSessionId);

		// Broadcast deletion event to all clients
		messageHub.event(
			'session.deleted',
			{ sessionId: targetSessionId },
			{
				channel: 'global',
			}
		);

		return { success: true };
	});

	messageHub.onRequest('session.archive', async (data, _ctx) => {
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
			// Archive SDK session files
			const archiveResult = archiveSDKSessionFiles(
				session.workspacePath,
				session.sdkSessionId ?? null,
				targetSessionId
			);

			const updatedMetadata = {
				...session.metadata,
				...(archiveResult.archivePath && {
					sdkArchivePath: archiveResult.archivePath,
					sdkArchivedAt: new Date().toISOString(),
					sdkArchivedFileCount: archiveResult.archivedFiles.length,
					sdkArchivedSize: archiveResult.totalSize,
				}),
			};

			await sessionManager.updateSession(targetSessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
				metadata: updatedMetadata,
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

			// Archive SDK session files
			const archiveResult = archiveSDKSessionFiles(
				session.workspacePath,
				session.sdkSessionId ?? null,
				targetSessionId
			);

			const updatedMetadata = {
				...session.metadata,
				...(archiveResult.archivePath && {
					sdkArchivePath: archiveResult.archivePath,
					sdkArchivedAt: new Date().toISOString(),
					sdkArchivedFileCount: archiveResult.archivedFiles.length,
					sdkArchivedSize: archiveResult.totalSize,
				}),
			};

			await sessionManager.updateSession(targetSessionId, {
				status: 'archived',
				archivedAt: new Date().toISOString(),
				worktree: undefined,
				metadata: updatedMetadata,
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
	messageHub.onRequest('message.send', async (data) => {
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
		// All heavy operations (message persistence, title gen, SDK query) handled by DaemonHub subscribers
		daemonHub
			.emit('message.sendRequest', {
				sessionId: targetSessionId,
				messageId,
				content,
				images,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		// Return immediately with messageId
		// Client gets instant feedback, heavy processing continues async
		return { messageId };
	});

	// Handle session interruption
	// ARCHITECTURE: Fire-and-forget via EventBus, AgentSession subscribes
	messageHub.onRequest('client.interrupt', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		// Verify session exists before emitting event
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Fire-and-forget: emit event, AgentSession handles it
		daemonHub.emit('agent.interruptRequest', { sessionId: targetSessionId }).catch(() => {
			// Interrupt event emission error - non-critical, continue
		});

		return { accepted: true };
	});

	// Handle getting current model information
	messageHub.onRequest('session.model.get', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Get current model ID (may be an alias like "default")
		const rawModelId = agentSession.getCurrentModel().id;

		// Resolve alias to full model ID for consistency with session.model.switch
		const { resolveModelAlias, getModelInfo } = await import('../model-service');
		const currentModelId = await resolveModelAlias(rawModelId);
		const modelInfo = await getModelInfo(currentModelId);

		return {
			currentModel: currentModelId,
			modelInfo,
		};
	});

	// Handle model switching
	// Returns synchronous result for test compatibility and immediate feedback
	messageHub.onRequest('session.model.switch', async (data) => {
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
			messageHub.event(
				'session.updated',
				{ model: result.model },
				{ channel: `session:${targetSessionId}` }
			);
		}

		return result;
	});

	// Handle coordinator mode switching
	// Updates config and auto-restarts query so the new agent/tools take effect
	messageHub.onRequest('session.coordinator.switch', async (data) => {
		const { sessionId: targetSessionId, coordinatorMode } = data as {
			sessionId: string;
			coordinatorMode: boolean;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const session = agentSession.getSessionData();
		const previousMode = session.config.coordinatorMode ?? false;

		if (previousMode === coordinatorMode) {
			return { success: true, coordinatorMode };
		}

		// Update session config
		await sessionManager.updateSession(targetSessionId, {
			config: { ...session.config, coordinatorMode },
		});

		// Restart query to apply new agent/tools configuration
		const result = await agentSession.resetQuery({ restartQuery: true });

		// Broadcast update for UI
		messageHub.event(
			'session.updated',
			{ config: { coordinatorMode } },
			{ channel: `session:${targetSessionId}` }
		);

		return { success: result.success, coordinatorMode, error: result.error };
	});

	// Handle sandbox mode switching
	// Updates config and auto-restarts query so the new sandbox settings take effect
	messageHub.onRequest('session.sandbox.switch', async (data) => {
		const { sessionId: targetSessionId, sandboxEnabled } = data as {
			sessionId: string;
			sandboxEnabled: boolean;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const session = agentSession.getSessionData();
		const previousMode = session.config.sandbox?.enabled ?? true;

		if (previousMode === sandboxEnabled) {
			return { success: true, sandboxEnabled };
		}

		// Update session config - preserve existing sandbox settings, only toggle enabled
		const updatedSandbox = {
			...session.config.sandbox,
			enabled: sandboxEnabled,
		};

		await sessionManager.updateSession(targetSessionId, {
			config: { ...session.config, sandbox: updatedSandbox },
		});

		// Restart query to apply new sandbox configuration
		const result = await agentSession.resetQuery({ restartQuery: true });

		// Broadcast update for UI
		messageHub.event(
			'session.updated',
			{ config: { sandbox: updatedSandbox } },
			{ channel: `session:${targetSessionId}` }
		);

		return { success: result.success, sandboxEnabled, error: result.error };
	});

	// Handle thinking level changes
	// Levels: auto, think8k, think16k, think32k
	// - auto: No thinking budget
	// - think8k/16k/32k: Token budget set via maxThinkingTokens
	// Note: "ultrathink" keyword is NOT auto-appended - users must type it manually
	messageHub.onRequest('session.thinking.set', async (data) => {
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
		messageHub.event(
			'session.updated',
			{ config: { thinkingLevel } },
			{ channel: `session:${targetSessionId}` }
		);

		return { success: true, thinkingLevel };
	});

	// Handle listing available models - uses hardcoded model list
	messageHub.onRequest('models.list', async (data) => {
		try {
			// Import model service for dynamic models (with static fallback)
			const { getAvailableModels } = await import('../model-service');

			// Check if forceRefresh is requested or useCache is disabled
			const params = data as {
				forceRefresh?: boolean;
				useCache?: boolean;
			};
			const forceRefresh = params?.forceRefresh ?? params?.useCache === false;

			// Get models from cache (uses 'global' cache key)
			// This will return dynamic models if they were loaded, otherwise static fallback
			// NOTE: Returns ALL available models from ALL providers for cross-provider switching
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
			// Model listing failed - throw error to caller
			throw new Error(`Failed to list models: ${errorMessage}`);
		}
	});

	// Handle clearing the model cache
	messageHub.onRequest('models.clearCache', async () => {
		clearModelsCache();
		return { success: true };
	});

	// FIX: Handle getting current agent processing state
	// Called by clients after subscribing to agent.state to get initial snapshot
	messageHub.onRequest('agent.getState', async (data) => {
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
	messageHub.onRequest('worktree.cleanup', async (data) => {
		const { workspacePath } = data as { workspacePath?: string };
		const cleanedPaths = await sessionManager.cleanupOrphanedWorktrees(workspacePath);

		return {
			success: true,
			cleanedPaths,
			message: `Cleaned up ${cleanedPaths.length} orphaned worktree(s)`,
		};
	});

	// Scan SDK session files in ~/.claude/projects/ for a workspace
	messageHub.onRequest('sdk.scan', async (data) => {
		const { workspacePath } = data as { workspacePath: string };

		// Scan SDK project directory
		const files = scanSDKSessionFiles(workspacePath);

		// Get session categories from database
		const sessions = sessionManager.listSessions();
		const activeIds = new Set(sessions.filter((s) => s.status === 'active').map((s) => s.id));
		const archivedIds = new Set(sessions.filter((s) => s.status === 'archived').map((s) => s.id));

		// Identify orphaned files
		const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

		return {
			success: true,
			workspacePath,
			summary: {
				totalFiles: files.length,
				totalSize: files.reduce((sum, f) => sum + f.size, 0),
				orphanedFiles: orphaned.length,
				orphanedSize: orphaned.reduce((sum, f) => sum + f.size, 0),
			},
			files,
			orphaned,
		};
	});

	// Cleanup SDK session files (archive or delete)
	messageHub.onRequest('sdk.cleanup', async (data) => {
		const { workspacePath, mode, sdkSessionIds } = data as {
			workspacePath: string;
			mode: 'archive' | 'delete';
			sdkSessionIds?: string[];
		};

		const errors: string[] = [];
		let processedCount = 0;
		let totalSize = 0;

		// Get files to clean
		let filesToClean = scanSDKSessionFiles(workspacePath);
		if (sdkSessionIds && sdkSessionIds.length > 0) {
			filesToClean = filesToClean.filter((f) => sdkSessionIds.includes(f.sdkSessionId));
		}

		// Process each file
		for (const file of filesToClean) {
			const kaiSessionId = file.kaiSessionIds[0] || 'orphan';

			if (mode === 'delete') {
				const result = deleteSDKSessionFiles(workspacePath, file.sdkSessionId, kaiSessionId);
				if (result.success) {
					processedCount++;
					totalSize += result.deletedSize;
				} else {
					errors.push(...result.errors);
				}
			} else {
				const result = archiveSDKSessionFiles(workspacePath, file.sdkSessionId, kaiSessionId);
				if (result.success) {
					processedCount++;
					totalSize += result.totalSize;
				} else {
					errors.push(...result.errors);
				}
			}
		}

		return {
			success: errors.length === 0,
			mode,
			processedCount,
			totalSize,
			errors,
		};
	});

	// Handle resetting the SDK agent query
	// This forcefully terminates and restarts the SDK query stream
	// Use case: Recovering from stuck "queued" state or unresponsive SDK
	messageHub.onRequest('session.resetQuery', async (data) => {
		const { sessionId: targetSessionId, restartQuery = true } = data as {
			sessionId: string;
			restartQuery?: boolean;
		};

		// Verify session exists
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Call resetQuery directly and return the result
		// This allows the client to get immediate feedback on success/failure
		const result = await agentSession.resetQuery({ restartQuery });

		// Also emit event for StateManager to update clients
		await daemonHub.emit('agent.reset', {
			sessionId: targetSessionId,
			success: result.success,
			error: result.error,
		});

		return result;
	});

	// Handle triggering saved messages to be sent (Manual query mode)
	// Use case: When user wants to manually send all saved messages in Manual mode
	// ARCHITECTURE: Fire-and-forget via EventBus, AgentSession handles the actual sending
	messageHub.onRequest('session.query.trigger', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		// Verify session exists before emitting event
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Call handleQueryTrigger directly and return result
		// This is synchronous because the UI needs immediate feedback on how many messages were sent
		const result = await agentSession.handleQueryTrigger();

		return result;
	});

	// Handle getting count of messages by status (for UI display)
	// Use case: Show "3 messages pending" in Manual mode UI
	messageHub.onRequest('session.messages.countByStatus', async (data) => {
		const { sessionId: targetSessionId, status } = data as {
			sessionId: string;
			status: 'saved' | 'queued' | 'sent';
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		// Get session to access database through sessionManager
		const session = agentSession.getSessionData();

		// Get database through sessionManager for read-only operation
		const db = sessionManager.getDatabase();
		const count = db.getMessageCountByStatus(session.id, status);

		return { count };
	});
}
