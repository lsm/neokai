import type { Session } from '@liuboer/shared';
import type { MessageHub, EventBus } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { Database } from '../storage/database';
import { AgentSession } from './agent-session';
import type { AuthManager } from './auth-manager';
import { WorktreeManager } from './worktree-manager';

export class SessionManager {
	private sessions: Map<string, AgentSession> = new Map();

	// FIX: Session lazy-loading race condition
	private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();
	private debug: boolean;
	private worktreeManager: WorktreeManager;

	constructor(
		private db: Database,
		private messageHub: MessageHub,
		private authManager: AuthManager,
		private eventBus: EventBus, // FIX: Use EventBus instead of StateManager
		private config: {
			defaultModel: string;
			maxTokens: number;
			temperature: number;
			workspaceRoot: string;
			disableWorktrees?: boolean;
		}
	) {
		// Only enable debug logs in development mode, not in test mode
		this.debug = process.env.NODE_ENV === 'development';
		this.worktreeManager = new WorktreeManager();
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log(...args);
		}
	}

	private error(...args: unknown[]): void {
		if (this.debug) {
			console.error(...args);
		}
	}

	async createSession(params: {
		workspacePath?: string;
		initialTools?: string[];
		config?: Partial<Session['config']>;
		useWorktree?: boolean;
		worktreeBaseBranch?: string;
	}): Promise<string> {
		const sessionId = generateUUID();

		const baseWorkspacePath = params.workspacePath || this.config.workspaceRoot;

		// Validate and resolve model ID using cached models
		const modelId = await this.getValidatedModelId(params.config?.model);

		// Try to create worktree if useWorktree is true (default) and we're in a git repo
		// Also respect config.disableWorktrees flag (for testing)
		let sessionWorkspacePath = baseWorkspacePath;
		let worktreeMetadata;
		let gitBranch: string | undefined;

		if (params.useWorktree !== false && !this.config.disableWorktrees) {
			try {
				worktreeMetadata = await this.worktreeManager.createWorktree({
					sessionId,
					repoPath: baseWorkspacePath,
					baseBranch: params.worktreeBaseBranch || 'HEAD',
				});

				if (worktreeMetadata) {
					sessionWorkspacePath = worktreeMetadata.worktreePath;
					this.log(
						`[SessionManager] Created worktree for session ${sessionId} at ${worktreeMetadata.worktreePath}`
					);
				} else {
					this.log(
						`[SessionManager] Not a git repository, using shared workspace: ${baseWorkspacePath}`
					);
				}
			} catch (error) {
				console.error(
					'[SessionManager] Failed to create worktree, falling back to shared workspace:',
					error
				);
				// Fall back to shared workspace on error
			}
		}

		// For non-worktree sessions, try to get the current git branch
		if (!worktreeMetadata) {
			try {
				const gitRoot = await this.worktreeManager.findGitRoot(baseWorkspacePath);
				if (gitRoot) {
					const branch = await this.worktreeManager.getCurrentBranch(gitRoot);
					gitBranch = branch ?? undefined;
					if (gitBranch) {
						this.log(`[SessionManager] Detected git branch: ${gitBranch}`);
					}
				}
			} catch (error) {
				// Not a git repo or can't detect branch - that's fine
				this.log('[SessionManager] Could not detect git branch:', error);
			}
		}

		const session: Session = {
			id: sessionId,
			title: 'New Session',
			workspacePath: sessionWorkspacePath,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: modelId, // Use validated model ID
				maxTokens: params.config?.maxTokens || this.config.maxTokens,
				temperature: params.config?.temperature || this.config.temperature,
				autoScroll: params.config?.autoScroll,
				// Tools config: Use global defaults for new sessions
				// SDK built-in tools are always enabled (not configurable)
				// MCP and Liuboer tools are configurable based on global settings
				tools: params.config?.tools ?? this.getDefaultToolsConfig(),
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
				titleGenerated: false,
			},
			worktree: worktreeMetadata ?? undefined,
			gitBranch: gitBranch ?? undefined,
		};

		// Save to database
		this.db.createSession(session);

		// Create agent session with MessageHub, EventBus, and auth function
		const agentSession = new AgentSession(session, this.db, this.messageHub, this.eventBus, () =>
			this.authManager.getCurrentApiKey()
		);

		this.sessions.set(sessionId, agentSession);

		// Emit event via EventBus (StateManager will handle publishing to MessageHub)
		this.log('[SessionManager] Emitting session:created event for session:', sessionId);
		await this.eventBus.emit('session:created', { session });
		this.log('[SessionManager] Event emitted, returning sessionId:', sessionId);

		return sessionId;
	}

	/**
	 * Get a validated model ID by using cached dynamic models
	 * Falls back to static model if dynamic loading failed or is unavailable
	 */
	private async getValidatedModelId(requestedModel?: string): Promise<string> {
		// Get available models from cache (already loaded on app startup)
		try {
			const { getAvailableModels } = await import('./model-service');
			const availableModels = getAvailableModels('global');

			if (availableModels.length > 0) {
				// If a specific model was requested, validate it
				if (requestedModel) {
					const found = availableModels.find(
						(m) => m.id === requestedModel || m.alias === requestedModel
					);
					if (found) {
						console.log(`[SessionManager] Using requested model: ${found.id}`);
						return found.id;
					}
					// Model not found - log warning but continue to try default
					console.log(
						`[SessionManager] Requested model "${requestedModel}" not found in available models:`,
						availableModels.map((m) => m.id)
					);
				}

				// Find default model (prefer Sonnet)
				const defaultModel =
					availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

				if (defaultModel) {
					console.log(`[SessionManager] Using default model: ${defaultModel.id}`);
					return defaultModel.id;
				}
			} else {
				console.log('[SessionManager] No available models loaded from cache');
			}
		} catch (error) {
			console.log('[SessionManager] Error getting models:', error);
		}

		// Fallback to config default model or requested model
		// IMPORTANT: Always return full model ID, never aliases
		const fallbackModel = requestedModel || this.config.defaultModel;
		console.log(`[SessionManager] Using fallback model: ${fallbackModel}`);
		return fallbackModel;
	}

	/**
	 * Get session (with lazy-loading race condition fix)
	 *
	 * FIX: Prevents multiple simultaneous loads of the same session
	 * which would create duplicate Claude API connections
	 */
	getSession(sessionId: string): AgentSession | null {
		// Check in-memory first
		if (this.sessions.has(sessionId)) {
			return this.sessions.get(sessionId)!;
		}

		// Check if load already in progress
		const loadInProgress = this.sessionLoadLocks.get(sessionId);
		if (loadInProgress) {
			// Wait for the load to complete (this is sync, so we throw an error)
			// Callers should use getSessionAsync() for concurrent access
			throw new Error(
				`Session ${sessionId} is being loaded. Use getSessionAsync() for concurrent access.`
			);
		}

		// Load synchronously (for backward compatibility)
		const session = this.db.getSession(sessionId);
		if (!session) return null;

		// Create agent session with MessageHub, EventBus, and auth function
		const agentSession = new AgentSession(session, this.db, this.messageHub, this.eventBus, () =>
			this.authManager.getCurrentApiKey()
		);
		this.sessions.set(sessionId, agentSession);

		return agentSession;
	}

	/**
	 * Get session asynchronously (preferred for concurrent access)
	 *
	 * FIX: Handles concurrent requests properly with locking
	 */
	async getSessionAsync(sessionId: string): Promise<AgentSession | null> {
		// Check in-memory first
		if (this.sessions.has(sessionId)) {
			return this.sessions.get(sessionId)!;
		}

		// Check if load already in progress
		const loadInProgress = this.sessionLoadLocks.get(sessionId);
		if (loadInProgress) {
			return await loadInProgress; // Wait for existing load
		}

		// Start new load with lock
		const loadPromise = this.loadSessionFromDB(sessionId);
		this.sessionLoadLocks.set(sessionId, loadPromise);

		try {
			const agentSession = await loadPromise;
			if (agentSession) {
				this.sessions.set(sessionId, agentSession);
			}
			return agentSession;
		} finally {
			this.sessionLoadLocks.delete(sessionId);
		}
	}

	/**
	 * Load session from database (private helper)
	 */
	private async loadSessionFromDB(sessionId: string): Promise<AgentSession | null> {
		const session = this.db.getSession(sessionId);
		if (!session) return null;

		// Create agent session with MessageHub, EventBus, and auth function
		return new AgentSession(session, this.db, this.messageHub, this.eventBus, () =>
			this.authManager.getCurrentApiKey()
		);
	}

	listSessions(): Session[] {
		return this.db.listSessions();
	}

	async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
		this.db.updateSession(sessionId, updates);

		// Update in-memory session if exists
		const agentSession = this.sessions.get(sessionId);
		if (agentSession) {
			agentSession.updateMetadata(updates);
		}

		// FIX: Emit event via EventBus
		await this.eventBus.emit('session:updated', { sessionId, updates });
	}

	async deleteSession(sessionId: string): Promise<void> {
		// Transaction-like cleanup with proper error handling
		const agentSession = this.sessions.get(sessionId);
		let dbDeleted = false;

		// Get session data for worktree cleanup
		const session = this.db.getSession(sessionId);

		try {
			// 1. Cleanup resources (can fail)
			if (agentSession) {
				await agentSession.cleanup();
			}

			// 2. Delete worktree if session uses one (before DB deletion)
			if (session?.worktree) {
				this.log(`[SessionManager] Removing worktree for session ${sessionId}`);

				try {
					await this.worktreeManager.removeWorktree(session.worktree, true);

					// Verify worktree was actually removed
					const stillExists = await this.worktreeManager.verifyWorktree(session.worktree);
					if (stillExists) {
						console.error(
							`[SessionManager] WARNING: Worktree still exists after removal: ${session.worktree.worktreePath}`
						);
						// Log to a failures list that global teardown can check
						// For now, just log - global teardown will catch these
					} else {
						this.log(`[SessionManager] Successfully removed worktree`);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					console.error(
						`[SessionManager] FAILED to remove worktree (will be cleaned by global teardown): ${errorMsg}`,
						{ sessionId, worktreePath: session.worktree.worktreePath }
					);

					// Continue with session deletion - global teardown will handle orphaned worktrees
					// This prevents a stuck session that can't be deleted due to git issues
				}
			}

			// 3. Delete from DB (can fail)
			this.db.deleteSession(sessionId);
			dbDeleted = true;

			// 4. Remove from memory (shouldn't fail)
			this.sessions.delete(sessionId);

			// 5. Notify clients (can fail, but don't rollback)
			try {
				await this.messageHub.publish(
					`session.deleted`,
					{ sessionId, reason: 'deleted' },
					{ sessionId: 'global' }
				);

				// Emit event via EventBus
				await this.eventBus.emit('session:deleted', { sessionId });
			} catch (error) {
				this.error('[SessionManager] Failed to broadcast deletion:', error);
				// Don't rollback - session is already deleted
			}
		} catch (error) {
			// Rollback if DB delete failed
			if (!dbDeleted) {
				this.error('[SessionManager] Session deletion failed:', error);
				throw error;
			}

			// If cleanup failed but DB delete succeeded, log but don't rollback
			this.error('[SessionManager] Session deleted but cleanup failed:', error);
		}
	}

	getActiveSessions(): number {
		return this.sessions.size;
	}

	getTotalSessions(): number {
		return this.db.listSessions().length;
	}

	/**
	 * Get the global tools configuration
	 */
	getGlobalToolsConfig() {
		return this.db.getGlobalToolsConfig();
	}

	/**
	 * Save the global tools configuration
	 */
	saveGlobalToolsConfig(config: ReturnType<typeof this.db.getGlobalToolsConfig>) {
		this.db.saveGlobalToolsConfig(config);
	}

	/**
	 * Get default tools configuration for new sessions based on global settings
	 */
	private getDefaultToolsConfig(): Session['config']['tools'] {
		const global = this.db.getGlobalToolsConfig();

		return {
			// System Prompt: Claude Code preset - Only enable if allowed AND default is on
			useClaudeCodePreset:
				global.systemPrompt.claudeCodePreset.allowed &&
				global.systemPrompt.claudeCodePreset.defaultEnabled,
			// Setting Sources: Load project settings - Only enable if allowed AND default is on
			loadSettingSources:
				global.settingSources.project.allowed && global.settingSources.project.defaultEnabled,
			// MCP: Only enable if allowed AND default is on
			loadProjectMcp: global.mcp.allowProjectMcp && global.mcp.defaultProjectMcp,
			enabledMcpPatterns: [],
			// Liuboer tools: Only enable if allowed AND default is on
			liuboerTools: {
				memory: global.liuboerTools.memory.allowed && global.liuboerTools.memory.defaultEnabled,
			},
		};
	}

	/**
	 * Cleanup all sessions (called during shutdown)
	 */
	async cleanup(): Promise<void> {
		this.log(`[SessionManager] Cleaning up ${this.sessions.size} active sessions...`);

		// Cleanup all in-memory sessions
		for (const [sessionId, agentSession] of this.sessions) {
			try {
				agentSession.cleanup();
			} catch (error) {
				this.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
			}
		}

		// Clear session map
		this.sessions.clear();
		this.log(`[SessionManager] All sessions cleaned up`);
	}

	/**
	 * Manually cleanup orphaned worktrees in a workspace
	 * Returns array of cleaned up worktree paths
	 */
	async cleanupOrphanedWorktrees(workspacePath?: string): Promise<string[]> {
		const path = workspacePath || this.config.workspaceRoot;
		this.log(`[SessionManager] Cleaning up orphaned worktrees in ${path}`);
		return await this.worktreeManager.cleanupOrphanedWorktrees(path);
	}
}
