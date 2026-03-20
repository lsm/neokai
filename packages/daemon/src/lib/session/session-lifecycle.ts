/**
 * Session Lifecycle Module
 *
 * Handles session CRUD operations:
 * - Session creation with worktree support
 * - Session update
 * - Session deletion with cleanup cascade
 * - Model validation
 * - Title generation and branch renaming
 */

import type { Provider, Session, WorktreeMetadata, MessageHub } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { Database } from '../../storage/database';
import type { DaemonHub } from '../daemon-hub';
import type { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';
import type { SessionCache, AgentSessionFactory } from './session-cache';
import type { ToolsConfigManager } from './tools-config';
import { getProviderService, mergeProviderEnvVars } from '../provider-service';
import { deleteSDKSessionFiles } from '../sdk-session-file-manager';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.js';

export interface SessionLifecycleConfig {
	defaultModel: string;
	maxTokens: number;
	temperature: number;
	workspaceRoot: string;
	disableWorktrees?: boolean;
}

export interface CreateSessionParams {
	workspacePath?: string;
	initialTools?: string[];
	config?: Partial<Session['config']>;
	worktreeBaseBranch?: string;
	title?: string; // Optional title - if provided, skips auto-title generation
	sessionId?: string; // Optional custom session ID (for room chat/self sessions)
	roomId?: string; // Optional room ID to assign session to
	lobbyId?: string; // Optional lobby ID to assign session to
	createdBy?: 'human' | 'neo'; // Creator type (defaults to 'human')
	// Session types:
	// - 'worker': Standard coding session with Claude Code system prompt
	// - 'room_chat': User-facing room chat interface (room:chat:${roomId})
	// - 'planner': Planner agent session (Room Runtime)
	// - 'coder': Coder agent session (Room Runtime)
	// - 'leader': Leader agent session (Room Runtime)
	// - 'general': General agent session (Room Runtime)
	// - 'lobby': Instance-level agent session
	sessionType?: 'room_chat' | 'planner' | 'coder' | 'leader' | 'general' | 'worker' | 'lobby';
	pairedSessionId?: string;
	parentSessionId?: string;
	currentTaskId?: string;
}

export class SessionLifecycle {
	private logger: Logger;

	constructor(
		private db: Database,
		private worktreeManager: WorktreeManager,
		private sessionCache: SessionCache,
		private eventBus: DaemonHub,
		private messageHub: MessageHub,
		private config: SessionLifecycleConfig,
		private toolsConfigManager: ToolsConfigManager,
		private createAgentSession: AgentSessionFactory
	) {
		this.logger = new Logger('SessionLifecycle');
	}

	/**
	 * Create a new session
	 */
	async create(params: CreateSessionParams): Promise<string> {
		// Use provided sessionId or generate a new one (for room chat sessions)
		const sessionId = params.sessionId || generateUUID();
		const sessionType = params.sessionType ?? 'worker';

		const baseWorkspacePath = params.workspacePath || this.config.workspaceRoot;

		// Detect git support before creating worktree
		const gitSupport = await this.worktreeManager.detectGitSupport(baseWorkspacePath);
		const isGitRepo = gitSupport.isGitRepo;

		// Worktree choice is only for worker sessions.
		const supportsWorktreeChoice = sessionType === 'worker';

		// Determine if worktree choice should be shown
		const shouldShowChoice = supportsWorktreeChoice && isGitRepo && !this.config.disableWorktrees;

		// Determine if worktree should be created immediately
		// Only for non-git repos (git repos go through choice flow)
		const shouldCreateWorktree =
			supportsWorktreeChoice && !this.config.disableWorktrees && !isGitRepo;

		// Read global settings for defaults (model, thinkingLevel, autoScroll)
		const globalSettings = this.db.getGlobalSettings();

		// Validate and resolve model ID using cached models
		// Priority: params.config.model > globalSettings.model > server default
		const requestedModel = params.config?.model || globalSettings.model;
		const { id: modelId, provider: resolvedProvider } =
			await this.getValidatedModelId(requestedModel);

		// Determine if title should be auto-generated
		// If title is provided, mark as generated to skip auto-title generation
		const providedTitle = params.title?.trim();
		const shouldSkipAutoTitle = Boolean(providedTitle);

		// Create worktree with appropriate branch name
		// If title provided, use meaningful branch name; otherwise use session/{uuid}
		let worktreeMetadata: WorktreeMetadata | undefined;
		let sessionWorkspacePath = baseWorkspacePath;
		const initialBranchName = shouldSkipAutoTitle
			? generateBranchName(providedTitle!, sessionId) // Title is defined when shouldSkipAutoTitle is true
			: `session/${sessionId}`;

		// Create worktree for non-git repos
		// Git repos will go through choice flow
		if (shouldCreateWorktree) {
			try {
				const result = await this.createWorktreeInternal(
					sessionId,
					baseWorkspacePath,
					initialBranchName,
					params.worktreeBaseBranch || 'HEAD'
				);

				if (result) {
					worktreeMetadata = result;
					sessionWorkspacePath = result.worktreePath;
				}
			} catch (error) {
				this.logger.error(
					'[SessionLifecycle] Failed to create worktree during session creation:',
					error
				);
				// Continue without worktree - fallback to base workspace
			}
		}

		// Determine session status based on worktree choice needed
		const sessionStatus: Session['status'] = shouldShowChoice
			? 'pending_worktree_choice'
			: 'active';

		// Detect current branch for non-worktree git repos
		let currentBranch: string | undefined = worktreeMetadata?.branch;
		if (!currentBranch && isGitRepo && gitSupport.gitRoot) {
			try {
				const branch = await this.worktreeManager.getCurrentBranch(gitSupport.gitRoot);
				currentBranch = branch ?? undefined;
			} catch (error) {
				this.logger.debug('[SessionLifecycle] Failed to get current branch:', error);
				// Continue without branch info
			}
		}

		const session: Session = {
			id: sessionId,
			title: providedTitle || 'New Session',
			workspacePath: sessionWorkspacePath,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: sessionStatus,
			// Session type: defaults to 'worker', can be set to 'room_chat', 'planner', 'coder', 'leader', 'general', or 'lobby'
			type: sessionType,
			config: {
				model: modelId, // Use validated model ID
				maxTokens: params.config?.maxTokens || this.config.maxTokens,
				temperature: params.config?.temperature || this.config.temperature,
				// Apply global settings defaults for autoScroll and thinkingLevel
				autoScroll: params.config?.autoScroll ?? globalSettings.autoScroll,
				thinkingLevel: params.config?.thinkingLevel ?? globalSettings.thinkingLevel,
				coordinatorMode: params.config?.coordinatorMode ?? globalSettings.coordinatorMode,
				permissionMode: params.config?.permissionMode,
				// Provider: Allow explicit override; fall back to resolved provider from model alias.
				// Critical when providers share canonical IDs (e.g., Anthropic and
				// anthropic-copilot both owning claude-sonnet-4.6).
				provider: (params.config?.provider ?? resolvedProvider) as Provider,
				// Tools config: Use global defaults for new sessions
				// SDK built-in tools are always enabled (not configurable)
				// MCP and NeoKai tools are configurable based on global settings
				tools: params.config?.tools ?? this.toolsConfigManager.getDefaultForNewSession(),
				// Sandbox: Use global settings default (enabled with network access)
				// Global settings provide balanced security: filesystem isolation + dev domains allowed
				// If user provides partial sandbox config (e.g., just enabled: false), respect that
				sandbox: params.config?.sandbox ?? globalSettings.sandbox,
				// MCP servers: Allow room chat sessions to include room-agent-tools
				mcpServers: params.config?.mcpServers,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
				// Mark as generated if title was provided to skip auto-title generation
				titleGenerated: shouldSkipAutoTitle,
				// Workspace is already initialized (worktree created or using base path)
				workspaceInitialized: true,
				// Only set worktreeChoice if we're showing the choice UI
				worktreeChoice: shouldShowChoice
					? {
							status: 'pending',
							createdAt: new Date().toISOString(),
						}
					: undefined,
				// Dual-session architecture fields
				...(params.sessionType && { sessionType: params.sessionType }),
				...(params.pairedSessionId && { pairedSessionId: params.pairedSessionId }),
				...(params.parentSessionId && { parentSessionId: params.parentSessionId }),
				...(params.currentTaskId && { currentTaskId: params.currentTaskId }),
			},
			// Worktree set during creation (if enabled)
			worktree: worktreeMetadata,
			gitBranch: currentBranch ?? undefined,
			// Context for room/lobby sessions (includes links between chat and self sessions)
			context:
				params.roomId || params.lobbyId
					? {
							...(params.roomId && { roomId: params.roomId }),
							...(params.lobbyId && { lobbyId: params.lobbyId }),
						}
					: undefined,
		};

		// Save to database
		this.db.createSession(session);

		// Create agent session and add to cache
		const agentSession = this.createAgentSession(session);
		this.sessionCache.set(sessionId, agentSession);

		// Emit event via EventBus (StateManager will handle publishing to MessageHub)
		await this.eventBus.emit('session.created', { sessionId, session });

		return sessionId;
	}

	/**
	 * Create worktree internal helper
	 *
	 * Private method to handle worktree creation with proper error handling.
	 * Used during session creation and when completing worktree choice.
	 *
	 * @param sessionId - Session ID for logging
	 * @param baseWorkspacePath - Base workspace path
	 * @param branchName - Branch name for the worktree
	 * @param baseBranch - Base branch to create worktree from (default: 'HEAD')
	 * @returns WorktreeMetadata if successful, undefined if creation fails
	 */
	private async createWorktreeInternal(
		sessionId: string,
		baseWorkspacePath: string,
		branchName: string,
		baseBranch?: string
	): Promise<WorktreeMetadata | undefined> {
		try {
			const result = await this.worktreeManager.createWorktree({
				sessionId,
				repoPath: baseWorkspacePath,
				branchName,
				baseBranch,
			});

			if (result) {
				this.logger.info(
					`[SessionLifecycle] Created worktree at ${result.worktreePath} with branch ${result.branch}`
				);
			}

			return result || undefined;
		} catch (error) {
			this.logger.error(
				`[SessionLifecycle] Failed to create worktree for session ${sessionId}:`,
				error
			);
			return undefined;
		}
	}

	/**
	 * Complete worktree setup after user makes choice
	 *
	 * @param sessionId - Session ID
	 * @param choice - User's worktree choice ('worktree' or 'direct')
	 * @returns Updated session data
	 */
	async completeWorktreeChoice(sessionId: string, choice: 'worktree' | 'direct'): Promise<Session> {
		const agentSession = this.sessionCache.get(sessionId);
		if (!agentSession) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const session = agentSession.getSessionData();
		const sessionType = session.type ?? 'worker';

		// Verify session is in pending state
		if (session.status !== 'pending_worktree_choice') {
			throw new Error(
				`Session ${sessionId} is not pending worktree choice (current status: ${session.status})`
			);
		}

		let worktreeMetadata: WorktreeMetadata | undefined;
		const baseWorkspacePath = session.workspacePath;
		const effectiveChoice: 'worktree' | 'direct' = sessionType === 'worker' ? choice : 'direct';

		if (effectiveChoice === 'worktree') {
			// Create worktree now
			// Generate branch name (use session ID based name since title should be generated by now)
			const branchName = `session/${sessionId}`;

			worktreeMetadata = await this.createWorktreeInternal(
				sessionId,
				baseWorkspacePath,
				branchName,
				'HEAD'
			);

			this.logger.info(
				`[SessionLifecycle] Worktree choice completed: created worktree for session ${sessionId}`
			);
		} else {
			// Direct mode - use workspace as-is
			this.logger.info(
				`[SessionLifecycle] Worktree choice completed: direct mode for session ${sessionId}`
			);
		}

		// Detect current branch for direct mode (non-worktree)
		let currentBranch: string | undefined = worktreeMetadata?.branch;
		if (!currentBranch && effectiveChoice === 'direct') {
			try {
				const branch = await this.worktreeManager.getCurrentBranch(baseWorkspacePath);
				currentBranch = branch ?? undefined;
			} catch (error) {
				this.logger.debug('[SessionLifecycle] Failed to get current branch:', error);
				// Continue without branch info
			}
		}

		// Update session
		const updatedSession: Session = {
			...session,
			status: 'active',
			worktree: worktreeMetadata,
			gitBranch: currentBranch ?? undefined,
			metadata: {
				...session.metadata,
				worktreeChoice: {
					status: 'completed',
					choice: effectiveChoice,
					createdAt: session.metadata.worktreeChoice?.createdAt,
					completedAt: new Date().toISOString(),
				},
			},
		};

		// Save to database
		this.db.updateSession(sessionId, updatedSession);

		// Update in-memory agent session metadata
		agentSession.updateMetadata(updatedSession);

		// Emit event for state synchronization
		await this.eventBus.emit('session.updated', {
			sessionId,
			session: updatedSession,
		});

		return updatedSession;
	}

	/**
	 * Update a session
	 */
	async update(sessionId: string, updates: Partial<Session>): Promise<void> {
		this.db.updateSession(sessionId, updates);

		// Update in-memory session if exists
		const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
		if (agentSession) {
			agentSession.updateMetadata(updates);
		}

		// FIX: Emit event via EventBus - include data for decoupled state management
		await this.eventBus.emit('session.updated', {
			sessionId,
			source: 'update',
			session: updates,
		});
	}

	/**
	 * Delete a session with atomic cleanup
	 *
	 * Uses a phased approach with state tracking to ensure cleanup succeeds
	 * or fails gracefully without leaving orphaned resources.
	 *
	 * Phases:
	 * 1. Cleanup AgentSession (stops SDK subprocess)
	 * 2. Delete worktree and branch
	 * 3. Delete from database
	 * 4. Remove from cache
	 * 5. Broadcast deletion event
	 *
	 * If any phase fails, the error is logged but cleanup continues.
	 * Orphaned resources (worktrees, branches) can be cleaned up via global teardown.
	 */
	async delete(sessionId: string): Promise<void> {
		// Get references before deletion
		const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
		const session = this.db.getSession(sessionId);

		// Track completed phases for potential rollback
		const completedPhases: string[] = [];

		try {
			// PHASE 1: Cleanup AgentSession (stops SDK subprocess)
			// This is critical - must complete before other cleanup
			if (agentSession) {
				try {
					await agentSession.cleanup();
					completedPhases.push('agent-cleanup');
				} catch (error) {
					this.logger.error(`[SessionLifecycle] AgentSession cleanup failed:`, error);
					// Continue with deletion - SDK subprocess will be terminated when process exits
				}
			}

			// PHASE 1.5: Delete SDK session files from ~/.claude/projects/
			// This removes the .jsonl files created by Claude Agent SDK
			if (session) {
				try {
					const deleteResult = deleteSDKSessionFiles(
						session.workspacePath,
						session.sdkSessionId ?? null,
						sessionId
					);
					completedPhases.push(
						deleteResult.success ? 'sdk-files-delete' : 'sdk-files-delete-partial'
					);
				} catch (error) {
					this.logger.error(`[SessionLifecycle] SDK file deletion failed:`, error);
					// Non-critical - continue with other cleanup
				}
			}

			// PHASE 2: Delete worktree and branch
			// Must happen before DB deletion (we need the worktree metadata)
			if (session?.worktree) {
				try {
					await this.worktreeManager.removeWorktree(session.worktree, true);

					// Verify worktree was actually removed
					const stillExists = await this.worktreeManager.verifyWorktree(session.worktree);
					if (stillExists) {
						// Track for global teardown
						completedPhases.push('worktree-cleanup-partial');
					} else {
						completedPhases.push('worktree-cleanup');
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.logger.error(
						`[SessionLifecycle] Worktree removal failed (global teardown will handle): ${errorMsg}`
					);
					// Don't add to completedPhases - worktree cleanup failed
				}
			}

			// PHASE 3: Delete from database
			// This is the point of no return - session is considered deleted
			try {
				this.db.deleteSession(sessionId);
				completedPhases.push('db-delete');
			} catch (error) {
				this.logger.error(`[SessionLifecycle] Database deletion failed:`, error);
				throw error; // Re-throw - if we can't delete from DB, deletion failed
			}

			// PHASE 4: Remove from cache
			try {
				this.sessionCache.remove(sessionId);
				completedPhases.push('cache-remove');
			} catch (error) {
				this.logger.error(`[SessionLifecycle] Cache removal failed:`, error);
				// Non-critical - session will be garbage collected
			}

			// PHASE 5: Broadcast deletion event
			// Best-effort notification - failure doesn't affect deletion
			try {
				this.messageHub.event(
					'session.deleted',
					{ sessionId, reason: 'deleted' },
					{ channel: 'global' }
				);
				await this.eventBus.emit('session.deleted', { sessionId });
				completedPhases.push('broadcast');
			} catch (error) {
				this.logger.error(`[SessionLifecycle] Failed to broadcast deletion:`, error);
				// Non-critical - session is already deleted
			}
		} catch (error) {
			// Critical failure - log what was completed
			this.logger.error(
				`[SessionLifecycle] Session deletion FAILED (completed phases: ${completedPhases.join(', ')}):`,
				error
			);

			// Note: True rollback isn't feasible because:
			// - We can't restore a deleted DB record without original data
			// - We can't recreate a deleted worktree/branch
			// - AgentSession can't be "uncleaned"
			//
			// The strategy instead is:
			// - Track completed phases for diagnostics
			// - Allow global teardown to clean up orphaned resources
			// - Log clearly what succeeded and what failed

			throw error;
		}
	}

	/**
	 * Get session metadata directly from database without loading SDK
	 * Used for operations that don't require SDK initialization (e.g., removing tool outputs)
	 */
	getFromDB(sessionId: string): Session | null {
		return this.db.getSession(sessionId);
	}

	/**
	 * Get the in-memory AgentSession for a session ID.
	 * Returns null if the session is not cached (e.g., not yet created or already deleted).
	 */
	getAgentSession(sessionId: string): import('../agent/agent-session').AgentSession | null {
		return this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
	}

	/**
	 * Get AgentSession for a session ID, loading it from DB-backed cache if needed.
	 */
	async getAgentSessionAsync(
		sessionId: string
	): Promise<import('../agent/agent-session').AgentSession | null> {
		return this.sessionCache.getAsync(sessionId);
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
		await this.update(sessionId, {
			metadata: {
				...session.metadata,
				removedOutputs,
			},
		});
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
	 *
	 * @returns Object with title and isFallback flag indicating if title was actually generated
	 */
	async generateTitleAndRenameBranch(
		sessionId: string,
		userMessageText: string
	): Promise<{ title: string; isFallback: boolean }> {
		const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
		if (!agentSession) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const session = agentSession.getSessionData();

		// Check if title already generated
		if (session.metadata.titleGenerated) {
			return { title: session.title, isFallback: false };
		}

		try {
			// Step 1: Generate title from user message using session's model
			// Cast to string: 'anthropic-copilot' is valid at runtime but not in the legacy Provider union.
			const { title, isFallback } = await this.generateTitleFromMessage(
				userMessageText,
				session.config.model,
				session.config.provider as string | undefined
			);

			// Step 2: Rename branch if we have a worktree
			let newBranchName = session.worktree?.branch;
			if (session.worktree) {
				const newBranch = generateBranchName(title, sessionId);
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
					// Only mark as generated if not a fallback
					titleGenerated: !isFallback,
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

			// Return result so caller can check if it was a fallback
			return { title, isFallback };
		} catch (error) {
			this.logger.error('[SessionLifecycle] Failed to generate title:', error);

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

			// Return result so caller can check if it was a fallback
			return { title: fallbackTitle, isFallback: true };
		}
	}

	/**
	 * Generate title from first user message using direct API call
	 * This bypasses the SDK subprocess and calls the Anthropic-like API directly
	 *
	 * @param sessionModel - The model to use for title generation (from session config)
	 * @returns Object with title and isFallback flag
	 */
	private async generateTitleFromMessage(
		messageText: string,
		sessionModel?: string,
		sessionProviderId?: string
	): Promise<{ title: string; isFallback: boolean }> {
		const providerService = getProviderService();

		// Determine which provider to use for title generation.
		// When the session has an explicit provider ID (e.g. 'anthropic-copilot'), use that
		// directly.  Otherwise fall back to the default configured provider.
		let provider: string;
		if (sessionProviderId) {
			provider = sessionProviderId;
		} else {
			provider = await providerService.getDefaultProvider();
		}

		// Providers whose credentials are managed by getProviderApiKey() (ANTHROPIC_API_KEY,
		// GLM_API_KEY, MINIMAX_API_KEY). For these we can do a fast, synchronous key check.
		//
		// All other providers (e.g. 'anthropic-copilot' with GitHub auth) are NOT listed
		// here because getProviderApiKey() does not handle their credentials. They use
		// the isProviderAvailable() path below instead, which delegates to each
		// provider's own isAvailable() implementation.
		const legacyKeyProviders: string[] = ['anthropic', 'glm', 'minimax'];
		if (legacyKeyProviders.includes(provider)) {
			const apiKey = providerService.getProviderApiKey(provider as Provider);
			if (!apiKey) {
				this.logger.warn(
					`[SessionLifecycle] No API key for provider ${provider}, using fallback title`
				);
				return {
					title: messageText.substring(0, 50).trim() || 'New Session',
					isFallback: true,
				};
			}
		} else {
			// For non-legacy providers (e.g. 'anthropic-copilot'), fall back if unavailable.
			const available = await providerService.isProviderAvailable(provider);
			if (!available) {
				this.logger.warn(
					`[SessionLifecycle] Provider ${provider} not available, using fallback title`
				);
				return {
					title: messageText.substring(0, 50).trim() || 'New Session',
					isFallback: true,
				};
			}
		}

		// Use session model if provided, otherwise fall back to title generation config
		let modelId: string;
		if (sessionModel) {
			modelId = sessionModel;
		} else {
			const config = await providerService.getTitleGenerationConfig(provider);
			modelId = config.modelId;
		}

		try {
			const title = await this.generateTitleWithSdk(provider, modelId, messageText);
			return { title, isFallback: false };
		} catch (error) {
			this.logger.error('[SessionLifecycle] SDK title generation failed:', error);
			// Fallback to first 50 chars of message
			return {
				title: messageText.substring(0, 50).trim() || 'New Session',
				isFallback: true,
			};
		}
	}

	/**
	 * Generate title using SDK query with proper environment setup
	 *
	 * Uses ProviderService to configure environment variables for the provider,
	 * then calls the SDK's query function to generate the title.
	 */
	private async generateTitleWithSdk(
		provider: string,
		modelId: string,
		messageText: string
	): Promise<string> {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const providerService = getProviderService();

		// Apply provider-specific environment variables to process.env
		// Use explicit provider to avoid model ID detection issues with shorthands like 'haiku'
		const originalEnv = providerService.applyEnvVarsToProcessForProvider(provider, modelId);

		try {
			const prompt = `Based on the user's request below, generate a concise 3-7 word title that captures the main intent or topic.

IMPORTANT: Return ONLY the title text itself, with NO formatting whatsoever:
- NO quotes around the title
- NO asterisks or markdown
- NO backticks
- NO punctuation at the end
- Just plain text words

User's request:
${messageText.slice(0, 2000)}`;

			// Get the environment variables to pass explicitly to SDK subprocess.
			// Pass the provider ID so that providers whose model IDs overlap with
			// Anthropic (e.g. anthropic-copilot using claude-opus-4.6) are looked up
			// by ID rather than auto-detected, which would return the wrong provider.
			const providerEnvVars = providerService.getEnvVarsForModel(modelId, provider);

			const cliPath = resolveSDKCliPath();

			// Merge provider env vars with parent process env vars
			// This ensures inherited vars (like ANTHROPIC_API_KEY) are preserved
			// while provider-specific vars (like ANTHROPIC_BASE_URL for GLM) override
			const mergedEnv = buildSdkQueryEnv(providerEnvVars);

			const agentQuery = query({
				prompt,
				options: {
					model: provider === 'glm' ? 'haiku' : modelId,
					maxTurns: 1,
					permissionMode: 'acceptEdits',
					allowDangerouslySkipPermissions: false,
					mcpServers: {},
					settingSources: [],
					tools: [],
					pathToClaudeCodeExecutable: cliPath,
					executable: isRunningUnderBun() ? 'bun' : undefined,
					env: mergedEnv,
				},
			});

			// Extract title from the response
			const { isSDKAssistantMessage } = await import('@neokai/shared/sdk/type-guards');
			let title = '';

			for await (const message of agentQuery) {
				if (isSDKAssistantMessage(message)) {
					const content = message.message.content as Array<{
						type: string;
						text?: string;
						thinking?: string;
					}>;

					// First, try to extract from text blocks
					const textBlocks = content.filter((b) => b.type === 'text') as Array<{
						type: 'text';
						text: string;
					}>;
					title = textBlocks
						.map((b) => b.text)
						.join(' ')
						.trim();

					// If no text blocks, try thinking blocks as fallback
					if (!title) {
						const thinkingBlocks = content.filter(
							(b): b is { type: 'thinking'; thinking: string } =>
								b.type === 'thinking' && 'thinking' in b
						);
						title = thinkingBlocks
							.map((b) => b.thinking)
							.join(' ')
							.trim();
					}

					if (title) {
						break; // Got the title, exit early
					}
				}
			}

			if (!title) {
				throw new Error('No text content in SDK response');
			}

			// Clean up the title
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

			return title;
		} finally {
			// Always restore original environment variables
			providerService.restoreEnvVars(originalEnv);
		}
	}

	/**
	 * Get a validated model ID by using cached dynamic models
	 * Falls back to static model if dynamic loading failed or is unavailable
	 *
	 * Returns both the canonical model ID and the provider that owns it.
	 * The provider is needed to correctly route providers whose models may share
	 * canonical IDs with Anthropic (e.g., claude-sonnet-4.6).
	 */
	private async getValidatedModelId(
		requestedModel?: string
	): Promise<{ id: string; provider?: string }> {
		// Get available models from cache (already loaded on app startup)
		try {
			const { getAvailableModels } = await import('../model-service');
			const availableModels = getAvailableModels('global');

			if (availableModels.length > 0) {
				// If a specific model was requested, validate it
				if (requestedModel) {
					const found = availableModels.find(
						(m) => m.id === requestedModel || m.alias === requestedModel
					);
					if (found) {
						return { id: found.id, provider: found.provider };
					}
				}

				// Use configured default model (from DEFAULT_MODEL env var or 'sonnet')
				// Try to find it by alias or ID in available models
				const configuredDefault = this.config.defaultModel;
				const defaultByConfig = availableModels.find(
					(m) => m.id === configuredDefault || m.alias === configuredDefault
				);

				if (defaultByConfig) {
					return { id: defaultByConfig.id, provider: defaultByConfig.provider };
				}

				// Fallback: prefer Sonnet family if no configured default found
				const defaultModel =
					availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

				if (defaultModel) {
					return { id: defaultModel.id, provider: defaultModel.provider };
				}
			}
		} catch (error) {
			this.logger.error('[SessionLifecycle] Error getting models:', error);
		}

		// Fallback to config default model or requested model
		// IMPORTANT: Always return full model ID, never aliases
		const fallbackModel = requestedModel || this.config.defaultModel;
		return { id: fallbackModel };
	}
}

/**
 * Generate branch name from title
 * Creates a slugified branch name like "session/fix-login-bug-abc123"
 */
export function generateBranchName(title: string, sessionId: string): string {
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
 * Build environment variables for SDK query
 *
 * Merges provider-specific environment variables with parent process env vars.
 * This ensures inherited vars (like ANTHROPIC_API_KEY) are preserved while
 * provider-specific vars (like ANTHROPIC_BASE_URL for GLM) can override.
 *
 * @param providerEnvVars - Provider-specific environment variables
 * @returns Merged environment variables object
 */
function buildSdkQueryEnv(providerEnvVars: Record<string, string | undefined>): NodeJS.ProcessEnv {
	return mergeProviderEnvVars(providerEnvVars as Record<string, string>);
}
