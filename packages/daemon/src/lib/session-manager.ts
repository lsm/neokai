import type {
	Session,
	WorktreeMetadata,
	MessageContent,
	MessageImage,
	MessageHub,
} from '@liuboer/shared';
import type { DaemonHub } from './daemon-hub';
import { generateUUID } from '@liuboer/shared';
import type { SDKUserMessage } from '@liuboer/shared/sdk';
import type { UUID } from 'crypto';
import { Database } from '../storage/database';
import { AgentSession } from './agent';
import type { AuthManager } from './auth-manager';
import type { SettingsManager } from './settings-manager';
import { WorktreeManager } from './worktree-manager';
import { Logger } from './logger';
import { expandBuiltInCommand } from './built-in-commands';

export class SessionManager {
	private sessions: Map<string, AgentSession> = new Map();

	// FIX: Session lazy-loading race condition
	private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();
	private debug: boolean;
	private worktreeManager: WorktreeManager;
	private logger: Logger;
	private eventBusUnsubscribers: Array<() => void> = [];

	// Track pending background tasks (like title generation) for cleanup
	// These are fire-and-forget operations that must complete before DB closes
	private pendingBackgroundTasks: Set<Promise<unknown>> = new Set();

	constructor(
		private db: Database,
		private messageHub: MessageHub,
		private authManager: AuthManager,
		private settingsManager: SettingsManager,
		private eventBus: DaemonHub, // TypedHub-based event coordination
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
		this.logger = new Logger('SessionManager');
		this.worktreeManager = new WorktreeManager();
		this.logger = new Logger('SessionManager');

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
			// Session isolation: only handle events for sessions managed by this SessionManager
			// Note: In current architecture, there's one SessionManager instance managing all sessions
			// But we still check if session exists for safety
			const { sessionId, messageId, content, images } = data;

			this.logger.info(`[SessionManager] Processing message:send:request for session ${sessionId}`);

			await this.handleMessagePersistence({ sessionId, messageId, content, images });
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
				// The RPC handler fires this event as fire-and-forget, so we must track
				// the promise to ensure DB isn't closed before title generation completes
				if (needsWorkspaceInit) {
					const titleGenTask = this.generateTitleAndRenameBranch(sessionId, userMessageText).catch(
						(error) => {
							// Title generation failure is non-fatal
							this.logger.error(`[SessionManager] Title generation failed:`, error);
						}
					);

					// Track task for cleanup
					this.pendingBackgroundTasks.add(titleGenTask);
					titleGenTask.finally(() => {
						this.pendingBackgroundTasks.delete(titleGenTask);
					});

					await titleGenTask;
				}

				// STEP 2: Clear draft if it matches the sent message content
				if (hasDraftToClear) {
					await this.updateSession(sessionId, {
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
					this.logger.info(
						`[SessionManager] Created worktree at ${result.worktreePath} with branch ${result.branch}`
					);
				}
			} catch (error) {
				this.logger.error(
					'[SessionManager] Failed to create worktree during session creation:',
					error
				);
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
				permissionMode: params.config?.permissionMode,
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
		this.logger.info('[SessionManager] Emitting session:created event for session:', sessionId);
		await this.eventBus.emit('session.created', { sessionId, session });
		this.logger.info('[SessionManager] Event emitted, returning sessionId:', sessionId);

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
			this.logger.info(`[SessionManager] Session ${sessionId} title already generated`);
			return;
		}

		this.logger.info(`[SessionManager] Generating title for session ${sessionId}...`);

		try {
			// Step 1: Generate title from user message using Haiku model
			const title = await this.generateTitleFromMessage(userMessageText, session.workspacePath);
			this.logger.info(`[SessionManager] Generated title: "${title}"`);

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
						this.logger.info(`[SessionManager] Renamed branch from ${oldBranch} to ${newBranch}`);
					} else {
						this.logger.info(`[SessionManager] Failed to rename branch, keeping ${oldBranch}`);
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
			await this.eventBus.emit('session.updated', {
				sessionId,
				source: 'title-generated',
				session: updatedSession,
			});

			this.logger.info(`[SessionManager] Title generated for session ${sessionId}: "${title}"`);
		} catch (error) {
			this.logger.error('[SessionManager] Failed to generate title:', error);

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
			await this.eventBus.emit('session.updated', {
				sessionId,
				source: 'title-generated',
				session: fallbackSession,
			});

			this.logger.info(
				`[SessionManager] Used fallback title "${fallbackTitle}" for session ${sessionId}`
			);
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

			this.logger.info('[SessionManager] Generating title with Haiku...');

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
								this.logger.info(`[SessionManager] Generated title: "${title}"`);
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
			this.logger.info('[SessionManager] Title generation failed:', error);
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
						this.logger.info(`[SessionManager] Using requested model: ${found.id}`);
						return found.id;
					}
					// Model not found - log warning but continue to try default
					this.logger.info(
						`[SessionManager] Requested model "${requestedModel}" not found in available models:`,
						availableModels.map((m) => m.id)
					);
				}

				// Find default model (prefer Sonnet)
				const defaultModel =
					availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

				if (defaultModel) {
					this.logger.info(`[SessionManager] Using default model: ${defaultModel.id}`);
					return defaultModel.id;
				}
			} else {
				this.logger.info('[SessionManager] No available models loaded from cache');
			}
		} catch (error) {
			this.logger.info('[SessionManager] Error getting models:', error);
		}

		// Fallback to config default model or requested model
		// IMPORTANT: Always return full model ID, never aliases
		const fallbackModel = requestedModel || this.config.defaultModel;
		this.logger.info(`[SessionManager] Using fallback model: ${fallbackModel}`);
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
		await this.eventBus.emit('session.updated', { sessionId, source: 'update', session: updates });
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
				this.logger.info(`[SessionManager] Removing worktree for session ${sessionId}`);

				try {
					await this.worktreeManager.removeWorktree(session.worktree, true);

					// Verify worktree was actually removed
					const stillExists = await this.worktreeManager.verifyWorktree(session.worktree);
					if (stillExists) {
						this.logger.error(
							`[SessionManager] WARNING: Worktree still exists after removal: ${session.worktree.worktreePath}`
						);
						// Log to a failures list that global teardown can check
						// For now, just log - global teardown will catch these
					} else {
						this.logger.info(`[SessionManager] Successfully removed worktree`);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.logger.error(
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
				await this.eventBus.emit('session.deleted', { sessionId });
			} catch (error) {
				this.logger.error('[SessionManager] Failed to broadcast deletion:', error);
				// Don't rollback - session is already deleted
			}
		} catch (error) {
			// Rollback if DB delete failed
			if (!dbDeleted) {
				this.logger.error('[SessionManager] Session deletion failed:', error);
				throw error;
			}

			// If cleanup failed but DB delete succeeded, log but don't rollback
			this.logger.error('[SessionManager] Session deleted but cleanup failed:', error);
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

				this.logger.info(
					`[SessionManager] Server ${server.name}: allowed=${isAllowed}, defaultOn=${isDefaultOn}`
				);

				// Add to disabled list if not allowed OR not defaultOn
				if (!isAllowed || !isDefaultOn) {
					disabledMcpServers.push(server.name);
				}
			}
		}

		this.logger.info(
			'[SessionManager] getDefaultToolsConfig - disabledMcpServers:',
			disabledMcpServers
		);

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
		this.logger.info(`[SessionManager] Cleaning up ${this.sessions.size} active sessions...`);

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
		for (const [sessionId, agentSession] of this.sessions) {
			cleanupPromises.push(
				agentSession.cleanup().catch((error) => {
					this.logger.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
				})
			);
		}

		// Wait for all cleanups to complete
		await Promise.all(cleanupPromises);

		// Clear session map
		this.sessions.clear();
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
	 * Handle message persistence (moved from AgentSession.persistUserMessage)
	 * ARCHITECTURE: EventBus-centric - SessionManager owns message persistence logic
	 *
	 * Responsibilities:
	 * 1. Expand built-in commands
	 * 2. Build message content (text + images)
	 * 3. Create SDK user message
	 * 4. Save to database
	 * 5. Publish to UI via state channel
	 * 6. Emit 'message.persisted' event for downstream processing
	 */
	private async handleMessagePersistence(data: {
		sessionId: string;
		messageId: string;
		content: string;
		images?: MessageImage[];
	}): Promise<void> {
		const { sessionId, messageId, content, images } = data;

		const agentSession = await this.getSessionAsync(sessionId);
		if (!agentSession) {
			this.logger.error(`[SessionManager] Session ${sessionId} not found for message persistence`);
			return;
		}

		const session = agentSession.getSessionData();

		try {
			// 1. Expand built-in commands (e.g., /merge-session → full prompt)
			const expandedContent = expandBuiltInCommand(content);
			const finalContent = expandedContent || content;

			if (expandedContent) {
				this.logger.info(`[SessionManager] Expanding built-in command: ${content.trim()}`);
			}

			// 2. Build message content (text + images)
			const messageContent = this.buildMessageContent(finalContent, images);

			// 3. Create SDK user message
			const sdkUserMessage: SDKUserMessage = {
				type: 'user' as const,
				uuid: messageId as UUID,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: 'user' as const,
					content:
						typeof messageContent === 'string'
							? [{ type: 'text' as const, text: messageContent }]
							: messageContent,
				},
			};

			// 4. Save to database
			this.db.saveSDKMessage(sessionId, sdkUserMessage);

			// 5. Publish to UI (fire-and-forget)
			this.messageHub
				.publish(
					'state.sdkMessages.delta',
					{ added: [sdkUserMessage], timestamp: Date.now() },
					{ sessionId }
				)
				.catch((err) => {
					this.logger.error('[SessionManager] Error publishing message to UI:', err);
				});

			this.logger.info(`[SessionManager] User message ${messageId} persisted and published to UI`);

			// 6. Emit 'message.persisted' event for downstream processing
			// AgentSession will start query and enqueue message
			// SessionManager will handle title generation and draft clearing
			await this.eventBus.emit('message.persisted', {
				sessionId,
				messageId,
				messageContent,
				userMessageText: content, // Original content (before expansion)
				needsWorkspaceInit: !session.metadata.titleGenerated,
				hasDraftToClear: session.metadata?.inputDraft === content.trim(),
			});
		} catch (error) {
			this.logger.error('[SessionManager] Error persisting message:', error);
			throw error;
		}
	}

	/**
	 * Build message content from text and optional images
	 */
	private buildMessageContent(content: string, images?: MessageImage[]): string | MessageContent[] {
		if (!images || images.length === 0) {
			return content;
		}

		// Multi-modal message: array of content blocks
		// Images first, then text (SDK format)
		return [
			...images.map((img) => ({
				type: 'image' as const,
				source: {
					type: 'base64' as const,
					media_type: img.media_type,
					data: img.data,
				},
			})),
			{ type: 'text' as const, text: content },
		];
	}
}
