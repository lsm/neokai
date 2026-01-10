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

import type { Session, MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import { AgentSession } from '../agent';
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

export class SessionManager {
	private logger: Logger;
	private worktreeManager: WorktreeManager;
	private eventBusUnsubscribers: Array<() => void> = [];

	// Track pending background tasks (like title generation) for cleanup
	// These are fire-and-forget operations that must complete before DB closes
	private pendingBackgroundTasks: Set<Promise<unknown>> = new Set();

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

			this.logger.info(`[SessionManager] Processing message:send:request for session ${sessionId}`);

			await this.messagePersistence.persist({ sessionId, messageId, content, images });
		});
		this.eventBusUnsubscribers.push(unsubMessageSendRequest);

		// Subscribe to message persisted events (for title generation + draft clearing)
		// AgentSession also subscribes to this event for query feeding
		const unsubMessagePersisted = this.eventBus.on('message.persisted', async (data) => {
			const { sessionId, userMessageText, needsWorkspaceInit, hasDraftToClear } = data;

			this.logger.info(`[SessionManager] Processing message:persisted for session ${sessionId}`);

			try {
				// STEP 1: Generate title and rename branch (if needed)
				// Only run if workspace initialization is needed (first message)
				// CRITICAL: Track this as a background task for cleanup
				if (needsWorkspaceInit) {
					const titleGenTask = this.sessionLifecycle
						.generateTitleAndRenameBranch(sessionId, userMessageText)
						.catch((error) => {
							// Title generation failure is non-fatal
							this.logger.error(`[SessionManager] Title generation failed:`, error);
						});

					// Track task for cleanup
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

				this.logger.info(
					`[SessionManager] Post-persistence processing complete for session ${sessionId}`
				);
			} catch (error) {
				this.logger.error(
					`[SessionManager] Error in post-persistence processing for session ${sessionId}:`,
					error
				);
				// Errors are non-fatal - the user message is already persisted and visible
			}
		});
		this.eventBusUnsubscribers.push(unsubMessagePersisted);

		this.logger.info('[SessionManager] EventBus subscriptions setup complete');
	}

	// ==================== Session CRUD Operations ====================

	async createSession(params: CreateSessionParams): Promise<string> {
		return this.sessionLifecycle.create(params);
	}

	/**
	 * Generate title and rename branch for a session
	 * @deprecated Use sessionLifecycle.generateTitleAndRenameBranch directly
	 */
	async generateTitleAndRenameBranch(sessionId: string, userMessageText: string): Promise<void> {
		return this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, userMessageText);
	}

	/**
	 * @deprecated Use generateTitleAndRenameBranch instead
	 * Kept for backward compatibility - now just calls generateTitleAndRenameBranch
	 */
	async initializeSessionWorkspace(sessionId: string, userMessageText: string): Promise<void> {
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
	 */
	async cleanup(): Promise<void> {
		this.logger.info(
			`[SessionManager] Cleaning up ${this.sessionCache.getActiveCount()} active sessions...`
		);

		// STEP 1: Unsubscribe from EventBus FIRST
		// This prevents new events from being processed during cleanup
		for (const unsubscribe of this.eventBusUnsubscribers) {
			try {
				unsubscribe();
			} catch (error) {
				this.logger.error(`[SessionManager] Error during EventBus unsubscribe:`, error);
			}
		}
		this.eventBusUnsubscribers = [];
		this.logger.info(`[SessionManager] EventBus subscriptions removed`);

		// STEP 2: Wait for pending background tasks (like title generation)
		// These are fire-and-forget operations from EventBus handlers that may still be running
		// We must wait for them to complete before closing the database
		if (this.pendingBackgroundTasks.size > 0) {
			this.logger.info(
				`[SessionManager] Waiting for ${this.pendingBackgroundTasks.size} pending background tasks...`
			);
			await Promise.all(Array.from(this.pendingBackgroundTasks)).catch((error) => {
				this.logger.error(`[SessionManager] Error waiting for background tasks:`, error);
			});
			this.pendingBackgroundTasks.clear();
			this.logger.info(`[SessionManager] Background tasks completed`);
		}

		// STEP 3: Cleanup all in-memory sessions in parallel
		// CRITICAL: Must await cleanup() to ensure SDK queries are fully stopped
		// before database is closed. Each cleanup() has a 5s timeout for the SDK query.
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

		// Clear session map
		this.sessionCache.clear();
		this.logger.info(`[SessionManager] All sessions cleaned up`);
	}

	/**
	 * Manually cleanup orphaned worktrees in a workspace
	 * Returns array of cleaned up worktree paths
	 */
	async cleanupOrphanedWorktrees(workspacePath?: string): Promise<string[]> {
		const path = workspacePath || this.config.workspaceRoot;
		this.logger.info(`[SessionManager] Cleaning up orphaned worktrees in ${path}`);
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
