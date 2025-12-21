import type { Session, WorktreeMetadata, MessageContent } from '@liuboer/shared';
import type { MessageHub, EventBus } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { Database } from '../storage/database';
import { AgentSession } from './agent-session';
import type { AuthManager } from './auth-manager';
import type { SettingsManager } from './settings-manager';
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
		private settingsManager: SettingsManager,
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

		// Setup EventBus subscribers for async message processing
		this.setupEventSubscriptions();
	}

	/**
	 * Setup EventBus subscriptions for async message processing
	 * ARCHITECTURE: Heavy operations are handled here instead of RPC handlers
	 */
	private setupEventSubscriptions(): void {
		// Handle user message persisted event - process heavy operations async
		this.eventBus.on(
			'user-message:persisted',
			async (data: {
				sessionId: string;
				messageId: string;
				messageContent: string | MessageContent[];
				userMessageText: string;
				needsWorkspaceInit: boolean;
				hasDraftToClear: boolean;
				skipQueryStart?: boolean;
			}) => {
				const {
					sessionId,
					messageId,
					messageContent,
					userMessageText,
					needsWorkspaceInit,
					hasDraftToClear,
					skipQueryStart,
				} = data;

				this.log(`[SessionManager] Processing user-message:persisted for session ${sessionId}`);

				try {
					const agentSession = await this.getSessionAsync(sessionId);
					if (!agentSession) {
						this.error(`[SessionManager] Session ${sessionId} not found for message processing`);
						return;
					}

					// SDK query and title generation can now run in PARALLEL
					// because worktree is created during session creation with correct cwd

					// STEP 1: Start SDK query (if not started) and enqueue message for processing
					// Skip if caller will handle query start (e.g., handleMessageSend direct calls)
					const sdkQueryPromise = skipQueryStart
						? Promise.resolve()
						: agentSession.startQueryAndEnqueue(messageId, messageContent);

					// STEP 2: Generate title and rename branch (runs in parallel with SDK query)
					// Only run if workspace initialization is needed (first message)
					const titlePromise = needsWorkspaceInit
						? this.generateTitleAndRenameBranch(sessionId, userMessageText).catch((error) => {
								// Title generation failure is non-fatal
								this.error(`[SessionManager] Title generation failed:`, error);
							})
						: Promise.resolve();

					// STEP 3: Clear draft if it matches the sent message content
					if (hasDraftToClear) {
						await this.updateSession(sessionId, {
							metadata: { inputDraft: undefined },
						} as Partial<Session>);
					}

					// Wait for SDK query to start (title gen can continue in background)
					await sdkQueryPromise;

					// Wait for title generation to complete (non-blocking for user)
					await titlePromise;

					this.log(
						`[SessionManager] Message ${messageId} processing initiated for session ${sessionId}`
					);
				} catch (error) {
					this.error(`[SessionManager] Error processing message for session ${sessionId}:`, error);
					// Errors are non-fatal - the user message is already persisted and visible
					// The SDK query may retry or the user can send another message
				}
			}
		);

		this.log('[SessionManager] EventBus subscriptions setup complete');
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

		// Create worktree immediately with session/{uuid} branch
		// This allows SDK query to start without waiting for title generation
		let worktreeMetadata: WorktreeMetadata | undefined;
		let sessionWorkspacePath = baseWorkspacePath;

		if (!this.config.disableWorktrees) {
			try {
				const result = await this.worktreeManager.createWorktree({
					sessionId,
					repoPath: baseWorkspacePath,
					// Use session/{uuid} as initial branch name (will be renamed after title gen)
					branchName: `session/${sessionId}`,
					baseBranch: params.worktreeBaseBranch || 'HEAD',
				});

				if (result) {
					worktreeMetadata = result;
					sessionWorkspacePath = result.worktreePath;
					this.log(
						`[SessionManager] Created worktree at ${result.worktreePath} with branch ${result.branch}`
					);
				}
			} catch (error) {
				this.error('[SessionManager] Failed to create worktree during session creation:', error);
				// Continue without worktree - fallback to base workspace
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
				// Workspace is already initialized (worktree created or using base path)
				workspaceInitialized: true,
			},
			// Worktree set during creation (if enabled)
			worktree: worktreeMetadata,
			gitBranch: worktreeMetadata?.branch,
		};

		// Save to database
		this.db.createSession(session);

		// Create agent session with MessageHub, EventBus, and auth function
		// Note: AgentSession creates its own SettingsManager with session.workspacePath for isolation
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
	 * Generate title and rename branch for a session
	 * Called on first message to:
	 * - Generate meaningful title from user message
	 * - Rename branch from session/{uuid} to session/{slug}-{shortId}
	 * - Update session record
	 *
	 * NOTE: Worktree is already created during session creation with session/{uuid} branch.
	 * This method only generates title and renames the branch.
	 */
	async generateTitleAndRenameBranch(sessionId: string, userMessageText: string): Promise<void> {
		const agentSession = this.sessions.get(sessionId);
		if (!agentSession) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const session = agentSession.getSessionData();

		// Check if title already generated
		if (session.metadata.titleGenerated) {
			this.log(`[SessionManager] Session ${sessionId} title already generated`);
			return;
		}

		this.log(`[SessionManager] Generating title for session ${sessionId}...`);

		try {
			// Step 1: Generate title from user message using Haiku model
			const title = await this.generateTitleFromMessage(userMessageText, session.workspacePath);
			this.log(`[SessionManager] Generated title: "${title}"`);

			// Step 2: Rename branch if we have a worktree
			let newBranchName = session.worktree?.branch;
			if (session.worktree) {
				const newBranch = this.generateBranchName(title, sessionId);
				const oldBranch = session.worktree.branch;

				// Only rename if branch name is different (i.e., it's still session/{uuid})
				if (oldBranch !== newBranch) {
					const renamed = await this.worktreeManager.renameBranch(
						session.worktree.mainRepoPath,
						oldBranch,
						newBranch
					);

					if (renamed) {
						newBranchName = newBranch;
						this.log(`[SessionManager] Renamed branch from ${oldBranch} to ${newBranch}`);
					} else {
						this.log(`[SessionManager] Failed to rename branch, keeping ${oldBranch}`);
					}
				}
			}

			// Step 3: Update session record
			const updatedSession: Session = {
				...session,
				title,
				worktree: session.worktree
					? {
							...session.worktree,
							branch: newBranchName || session.worktree.branch,
						}
					: undefined,
				gitBranch: newBranchName || session.gitBranch,
				metadata: {
					...session.metadata,
					titleGenerated: true,
				},
			};

			// Save to DB
			this.db.updateSession(sessionId, updatedSession);

			// Update in-memory session
			agentSession.updateMetadata(updatedSession);

			// Broadcast updates - include session data for decoupled state management
			await this.eventBus.emit('session:updated', {
				sessionId,
				source: 'title-generated',
				session: updatedSession,
			});

			this.log(`[SessionManager] Title generated for session ${sessionId}: "${title}"`);
		} catch (error) {
			this.error('[SessionManager] Failed to generate title:', error);

			// Fallback: Use first 50 chars of message as title
			const fallbackTitle = userMessageText.substring(0, 50).trim() || 'New Session';
			const fallbackSession: Session = {
				...session,
				title: fallbackTitle,
				metadata: {
					...session.metadata,
					titleGenerated: false, // Mark as not generated (user can retry)
				},
			};

			this.db.updateSession(sessionId, fallbackSession);
			agentSession.updateMetadata(fallbackSession);

			// Include session data for decoupled state management
			await this.eventBus.emit('session:updated', {
				sessionId,
				source: 'title-generated',
				session: fallbackSession,
			});

			this.log(`[SessionManager] Used fallback title "${fallbackTitle}" for session ${sessionId}`);
		}
	}

	/**
	 * @deprecated Use generateTitleAndRenameBranch instead
	 * Kept for backward compatibility - now just calls generateTitleAndRenameBranch
	 */
	async initializeSessionWorkspace(sessionId: string, userMessageText: string): Promise<void> {
		return this.generateTitleAndRenameBranch(sessionId, userMessageText);
	}

	/**
	 * Generate title from first user message
	 */
	private async generateTitleFromMessage(
		messageText: string,
		workspacePath: string
	): Promise<string> {
		// Timeout for title generation (15 seconds) - prevents blocking if SDK hangs
		const TITLE_GENERATION_TIMEOUT = 15000;

		try {
			// Use the same approach as title-generator.ts but simplified
			const { query } = await import('@anthropic-ai/claude-agent-sdk');

			this.log('[SessionManager] Generating title with Haiku...');

			// Create a promise that rejects after timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('Title generation timed out')), TITLE_GENERATION_TIMEOUT);
			});

			// Race between title generation and timeout
			const generateTitle = async (): Promise<string> => {
				// Use Agent SDK with maxTurns: 1 for simple title generation
				// Disable MCP servers and other features that might cause hanging
				const result = await query({
					prompt: `Based on the user's request below, generate a concise 3-7 word title that captures the main intent or topic.

IMPORTANT: Return ONLY the title text itself, with NO formatting whatsoever:
- NO quotes around the title
- NO asterisks or markdown
- NO backticks
- NO punctuation at the end
- Just plain text words

User's request:
${messageText.slice(0, 2000)}`,
					options: {
						model: 'haiku',
						maxTurns: 1,
						permissionMode: 'bypassPermissions',
						allowDangerouslySkipPermissions: true,
						cwd: workspacePath,
						// Disable features that might cause hanging in test/CI environments
						mcpServers: {},
						settingSources: [],
					},
				});

				// Extract and clean title from SDK response
				const { isSDKAssistantMessage } = await import('@liuboer/shared/sdk/type-guards');

				for await (const message of result) {
					if (isSDKAssistantMessage(message)) {
						const textBlocks = message.message.content.filter(
							(b: { type: string }) => b.type === 'text'
						);
						let title = textBlocks
							.map((b: { text?: string }) => b.text)
							.join(' ')
							.trim();

						if (title) {
							// Strip any markdown formatting
							title = title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');

							// Remove wrapping quotes
							while (
								(title.startsWith('"') && title.endsWith('"')) ||
								(title.startsWith("'") && title.endsWith("'"))
							) {
								title = title.slice(1, -1).trim();
							}

							// Remove backticks
							title = title.replace(/`/g, '');

							if (title) {
								this.log(`[SessionManager] Generated title: "${title}"`);
								return title;
							}
						}
					}
				}

				// Fallback if no title extracted
				return messageText.substring(0, 50).trim() || 'New Session';
			};

			// Race between generation and timeout
			return await Promise.race([generateTitle(), timeoutPromise]);
		} catch (error) {
			this.log('[SessionManager] Title generation failed:', error);
			// Fallback to first 50 chars of message
			return messageText.substring(0, 50).trim() || 'New Session';
		}
	}

	/**
	 * Generate branch name from title
	 * Creates a slugified branch name like "session/fix-login-bug-abc123"
	 */
	private generateBranchName(title: string, sessionId: string): string {
		// Slugify title: "Fix login bug" -> "fix-login-bug"
		const slug = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
			.replace(/^-|-$/g, '') // Remove leading/trailing hyphens
			.substring(0, 50); // Max 50 chars

		// Add short UUID to prevent conflicts
		const shortId = sessionId.substring(0, 8);

		return `session/${slug}-${shortId}`;
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
		// Note: AgentSession creates its own SettingsManager with session.workspacePath for isolation
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
		// Note: AgentSession creates its own SettingsManager with session.workspacePath for isolation
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

		// FIX: Emit event via EventBus - include data for decoupled state management
		await this.eventBus.emit('session:updated', { sessionId, source: 'update', session: updates });
	}

	/**
	 * Get session metadata directly from database without loading SDK
	 * Used for operations that don't require SDK initialization (e.g., removing tool outputs)
	 */
	getSessionFromDB(sessionId: string): Session | null {
		return this.db.getSession(sessionId);
	}

	/**
	 * Mark a message's tool output as removed from SDK session file
	 * This updates the session metadata to track which outputs were deleted
	 */
	async markOutputRemoved(sessionId: string, messageUuid: string): Promise<void> {
		const session = this.db.getSession(sessionId);
		if (!session) {
			throw new Error('Session not found');
		}

		// Add messageUuid to removedOutputs array (if not already present)
		const removedOutputs = session.metadata.removedOutputs || [];
		if (!removedOutputs.includes(messageUuid)) {
			removedOutputs.push(messageUuid);
		}

		// Update session metadata
		await this.updateSession(sessionId, {
			metadata: {
				...session.metadata,
				removedOutputs,
			},
		});
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
	 *
	 * ARCHITECTURE (Direct 1:1 UI→SDK Mapping):
	 * - disabledMcpServers: List of server names to disable (empty = all enabled)
	 * - This is written to .claude/settings.local.json and SDK applies filtering
	 * - No intermediate loadProjectMcp/enabledMcpPatterns values needed
	 */
	private getDefaultToolsConfig(): Session['config']['tools'] {
		const globalToolsConfig = this.db.getGlobalToolsConfig();
		const globalSettings = this.settingsManager.getGlobalSettings();

		// Build disabledMcpServers from global mcpServerSettings
		// Servers with allowed=false or defaultOn=false are disabled by default
		const mcpServerSettings = globalSettings.mcpServerSettings || {};
		const mcpServers = this.settingsManager.listMcpServersFromSources();

		const disabledMcpServers: string[] = [];
		for (const source of Object.keys(mcpServers) as Array<'user' | 'project' | 'local'>) {
			for (const server of mcpServers[source]) {
				const settings = mcpServerSettings[server.name];
				const isAllowed = settings?.allowed !== false; // Default to true
				const isDefaultOn = settings?.defaultOn === true; // Default to false (matches UI)

				this.log(
					`[SessionManager] Server ${server.name}: allowed=${isAllowed}, defaultOn=${isDefaultOn}`
				);

				// Add to disabled list if not allowed OR not defaultOn
				if (!isAllowed || !isDefaultOn) {
					disabledMcpServers.push(server.name);
				}
			}
		}

		this.log('[SessionManager] getDefaultToolsConfig - disabledMcpServers:', disabledMcpServers);

		return {
			// System Prompt: Claude Code preset - Only enable if allowed AND default is on
			useClaudeCodePreset:
				globalToolsConfig.systemPrompt.claudeCodePreset.allowed &&
				globalToolsConfig.systemPrompt.claudeCodePreset.defaultEnabled,
			// Setting Sources: Use global setting sources
			settingSources: globalSettings.settingSources || ['user', 'project', 'local'],
			// MCP: Direct mapping - list of disabled servers (empty = all enabled)
			// SDK will auto-load from .mcp.json and apply this filter via settings.local.json
			disabledMcpServers,
			// Liuboer tools: Only enable if allowed AND default is on
			liuboerTools: {
				memory:
					globalToolsConfig.liuboerTools.memory.allowed &&
					globalToolsConfig.liuboerTools.memory.defaultEnabled,
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
