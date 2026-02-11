/**
 * Session Manager - Orchestrator
 *
 * Main entry point for session operations. Orchestrates:
 * - SessionCache: In-memory session storage
 * - SessionLifecycle: CRUD operations and title generation
 * - ToolsConfigManager: Global tools configuration
 * - MessagePersistence: User message handling
 *
 * Also manages:
 * - EventBus subscriptions for async message processing
 * - Background task tracking for cleanup
 */

import type { Session, MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import { AgentSession } from '../agent/agent-session';
import type { AuthManager } from '../auth-manager';
import type { SettingsManager } from '../settings-manager';
import { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';

// Import extracted modules
import { SessionCache } from './session-cache';
import {
	SessionLifecycle,
	type SessionLifecycleConfig,
	type CreateSessionParams,
} from './session-lifecycle';
import { ToolsConfigManager } from './tools-config';
import { MessagePersistence } from './message-persistence';

/**
 * Cleanup state machine for SessionManager
 *
 * Prevents race conditions during cleanup by tracking state and
 * preventing new background tasks from starting during cleanup.
 *
 * States:
 * - IDLE: Normal operation, cleanup not started
 * - CLEANING: Cleanup in progress, barrier active for new background tasks
 * - CLEANED: Cleanup complete, no further operations allowed
 */
export enum CleanupState {
	IDLE = 'idle',
	CLEANING = 'cleaning',
	CLEANED = 'cleaned',
}

export class SessionManager {
	private logger: Logger;
	private worktreeManager: WorktreeManager;
	private eventBusUnsubscribers: Array<() => void> = [];

	// Track pending background tasks (like title generation) for cleanup
	// These are fire-and-forget operations that must complete before DB closes
	private pendingBackgroundTasks: Set<Promise<unknown>> = new Set();

	// Cleanup state machine - prevents race conditions during shutdown
	private cleanupState: CleanupState = CleanupState.IDLE;

	// Extracted modules
	private sessionCache: SessionCache;
	private sessionLifecycle: SessionLifecycle;
	private toolsConfigManager: ToolsConfigManager;
	private messagePersistence: MessagePersistence;

	constructor(
		private db: Database,
		private messageHub: MessageHub,
		private authManager: AuthManager,
		private settingsManager: SettingsManager,
		private eventBus: DaemonHub,
		private config: SessionLifecycleConfig
	) {
		this.logger = new Logger('SessionManager');
		this.worktreeManager = new WorktreeManager();

		// Initialize tools config manager
		this.toolsConfigManager = new ToolsConfigManager(db, settingsManager);

		// Factory function for creating AgentSession instances
		const createAgentSession = (session: Session): AgentSession => {
			return new AgentSession(session, db, messageHub, eventBus, () =>
				this.authManager.getCurrentApiKey()
			);
		};

		// Initialize session cache with factory and loader
		this.sessionCache = new SessionCache(createAgentSession, (sessionId: string) =>
			this.db.getSession(sessionId)
		);

		// Initialize session lifecycle
		this.sessionLifecycle = new SessionLifecycle(
			db,
			this.worktreeManager,
			this.sessionCache,
			eventBus,
			messageHub,
			config,
			this.toolsConfigManager,
			createAgentSession
		);

		// Initialize message persistence
		this.messagePersistence = new MessagePersistence(this.sessionCache, db, messageHub, eventBus);

		// Setup EventBus subscribers for async message processing
		this.setupEventSubscriptions();
	}

	/**
	 * Setup EventBus subscriptions for async message processing
	 * ARCHITECTURE: EventBus-centric pattern - SessionManager handles message persistence
	 */
	private setupEventSubscriptions(): void {
		// Subscribe to message send requests (from RPC handler)
		// Handles message persistence: expand commands → build content → save DB → publish UI
		const unsubMessageSendRequest = this.eventBus.on('message.sendRequest', async (data) => {
			const { sessionId, messageId, content, images } = data;

			await this.messagePersistence.persist({
				sessionId,
				messageId,
				content,
				images,
			});
		});
		this.eventBusUnsubscribers.push(unsubMessageSendRequest);

		// Subscribe to message persisted events (for title generation + draft clearing)
		// AgentSession also subscribes to this event for query feeding
		const unsubMessagePersisted = this.eventBus.on('message.persisted', async (data) => {
			const { sessionId, userMessageText, needsWorkspaceInit, hasDraftToClear } = data;

			try {
				// STEP 1: Generate title and rename branch (if needed)
				// Only run if workspace initialization is needed (first message)
				// CRITICAL: Check cleanup barrier to prevent race conditions
				if (needsWorkspaceInit) {
					// BARRIER: Skip new background tasks during cleanup
					// This prevents race conditions where tasks complete during shutdown
					/* v8 ignore next */
					if (this.cleanupState !== CleanupState.IDLE) return;

					const titleGenTask = this.sessionLifecycle
						.generateTitleAndRenameBranch(sessionId, userMessageText)
						.catch((error) => {
							// Title generation failure is non-fatal
							this.logger.error(`[SessionManager] Title generation failed:`, error);
						});

					// Track task for cleanup barrier
					this.pendingBackgroundTasks.add(titleGenTask);
					titleGenTask.finally(() => {
						this.pendingBackgroundTasks.delete(titleGenTask);
					});

					await titleGenTask;
				}

				// STEP 2: Clear draft if it matches the sent message content
				if (hasDraftToClear) {
					await this.sessionLifecycle.update(sessionId, {
						metadata: { inputDraft: undefined },
					} as Partial<Session>);
				}
			} catch (error) {
				this.logger.error(
					`[SessionManager] Error in post-persistence processing for session ${sessionId}:`,
					error
				);
				// Errors are non-fatal - the user message is already persisted and visible
			}
		});
		this.eventBusUnsubscribers.push(unsubMessagePersisted);
	}

	// ==================== Session CRUD Operations ====================

	async createSession(params: CreateSessionParams): Promise<string> {
		return this.sessionLifecycle.create(params);
	}

	/**
	 * Generate title and rename branch for a session
	 * @deprecated Use sessionLifecycle.generateTitleAndRenameBranch directly
	 */
	async generateTitleAndRenameBranch(
		sessionId: string,
		userMessageText: string
	): Promise<{ title: string; isFallback: boolean }> {
		return this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, userMessageText);
	}

	/**
	 * @deprecated Use generateTitleAndRenameBranch instead
	 * Kept for backward compatibility - now just calls generateTitleAndRenameBranch
	 */
	async initializeSessionWorkspace(
		sessionId: string,
		userMessageText: string
	): Promise<{ title: string; isFallback: boolean }> {
		return this.generateTitleAndRenameBranch(sessionId, userMessageText);
	}

	/**
	 * Get session (with lazy-loading race condition fix)
	 *
	 * FIX: Prevents multiple simultaneous loads of the same session
	 * which would create duplicate Claude API connections
	 */
	getSession(sessionId: string): AgentSession | null {
		return this.sessionCache.get(sessionId);
	}

	/**
	 * Get the session lifecycle manager (exposed for testing)
	 * @internal
	 */
	getSessionLifecycle(): SessionLifecycle {
		return this.sessionLifecycle;
	}

	/**
	 * Get session asynchronously (preferred for concurrent access)
	 *
	 * FIX: Handles concurrent requests properly with locking
	 */
	async getSessionAsync(sessionId: string): Promise<AgentSession | null> {
		return this.sessionCache.getAsync(sessionId);
	}

	listSessions(): Session[] {
		return this.db.listSessions();
	}

	async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
		return this.sessionLifecycle.update(sessionId, updates);
	}

	/**
	 * Get session metadata directly from database without loading SDK
	 * Used for operations that don't require SDK initialization (e.g., removing tool outputs)
	 */
	getSessionFromDB(sessionId: string): Session | null {
		return this.sessionLifecycle.getFromDB(sessionId);
	}

	/**
	 * Mark a message's tool output as removed from SDK session file
	 * This updates the session metadata to track which outputs were deleted
	 */
	async markOutputRemoved(sessionId: string, messageUuid: string): Promise<void> {
		return this.sessionLifecycle.markOutputRemoved(sessionId, messageUuid);
	}

	async deleteSession(sessionId: string): Promise<void> {
		return this.sessionLifecycle.delete(sessionId);
	}

	getActiveSessions(): number {
		return this.sessionCache.getActiveCount();
	}

	getTotalSessions(): number {
		return this.db.listSessions().length;
	}

	// ==================== Tools Configuration ====================

	/**
	 * Get the global tools configuration
	 */
	getGlobalToolsConfig() {
		return this.toolsConfigManager.getGlobal();
	}

	/**
	 * Save the global tools configuration
	 */
	saveGlobalToolsConfig(config: ReturnType<typeof this.toolsConfigManager.getGlobal>) {
		this.toolsConfigManager.saveGlobal(config);
	}

	// ==================== Cleanup ====================

	/**
	 * Cleanup all sessions (called during shutdown)
	 *
	 * Uses a state machine to prevent race conditions:
	 * - IDLE → CLEANING: Sets barrier, prevents new background tasks
	 * - CLEANING: Executes cleanup in phases
	 * - CLEANING → CLEANED: Final state, no more operations allowed
	 *
	 * If cleanup fails, state returns to IDLE to allow retry.
	 */
	async cleanup(): Promise<void> {
		// State check: prevent concurrent cleanup
		if (this.cleanupState !== CleanupState.IDLE) {
			return;
		}

		// Transition to CLEANING state - sets the barrier for new background tasks
		this.cleanupState = CleanupState.CLEANING;

		try {
			// PHASE 1: Unsubscribe from EventBus FIRST
			// This prevents new events from being processed during cleanup
			for (const unsubscribe of this.eventBusUnsubscribers) {
				try {
					unsubscribe();
				} catch (error) {
					this.logger.error(`[SessionManager] Error during EventBus unsubscribe:`, error);
				}
			}
			this.eventBusUnsubscribers = [];

			// PHASE 2: Wait for pending background tasks (like title generation) with timeout
			// These are fire-and-forget operations from EventBus handlers
			// The cleanup barrier prevents new tasks from starting
			// Use a timeout to prevent hanging in CI when title generation takes too long
			const BACKGROUND_TASK_TIMEOUT_MS = 5000; // 5 seconds max wait

			if (this.pendingBackgroundTasks.size > 0) {
				const timeoutPromise = new Promise<'timeout'>((resolve) =>
					setTimeout(() => resolve('timeout'), BACKGROUND_TASK_TIMEOUT_MS)
				);

				await Promise.race([
					Promise.all(Array.from(this.pendingBackgroundTasks))
						.then(() => 'completed' as const)
						.catch((error) => {
							this.logger.error(`[SessionManager] Error waiting for background tasks:`, error);
							return 'error' as const;
						}),
					timeoutPromise,
				]);

				this.pendingBackgroundTasks.clear();
			}

			// PHASE 3: Cleanup all in-memory sessions in parallel
			// CRITICAL: Each AgentSession.cleanup() now properly stops SDK queries
			// with lifecycle manager, ensuring subprocesses exit before we continue
			const cleanupPromises: Promise<void>[] = [];
			for (const [sessionId, agentSession] of this.sessionCache.entries()) {
				cleanupPromises.push(
					agentSession.cleanup().catch((error) => {
						this.logger.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
					})
				);
			}

			// Wait for all cleanups to complete
			await Promise.all(cleanupPromises);

			// Clear session cache
			this.sessionCache.clear();

			// Transition to CLEANED state
			this.cleanupState = CleanupState.CLEANED;
		} catch (error) {
			// On failure, rollback to IDLE to allow retry
			this.cleanupState = CleanupState.IDLE;
			this.logger.error(`[SessionManager] Cleanup failed, state rolled back to IDLE:`, error);
			throw error;
		}
	}

	/**
	 * Get the current cleanup state (useful for testing/diagnostics)
	 */
	getCleanupState(): CleanupState {
		return this.cleanupState;
	}

	/**
	 * Manually cleanup orphaned worktrees in a workspace
	 * Returns array of cleaned up worktree paths
	 */
	async cleanupOrphanedWorktrees(workspacePath?: string): Promise<string[]> {
		const path = workspacePath || this.config.workspaceRoot;
		return await this.worktreeManager.cleanupOrphanedWorktrees(path);
	}

	/**
	 * Get the database instance
	 * Used by RPC handlers that need direct DB access for query mode operations
	 */
	getDatabase(): Database {
		return this.db;
	}
}
