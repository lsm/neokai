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

import type { Session, WorktreeMetadata, MessageHub, Provider } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import type { Database } from '../../storage/database';
import type { DaemonHub } from '../daemon-hub';
import type { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';
import type { SessionCache, AgentSessionFactory } from './session-cache';
import type { ToolsConfigManager } from './tools-config';
import { getProviderService } from '../provider-service';

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
	useWorktree?: boolean;
	worktreeBaseBranch?: string;
	title?: string; // Optional title - if provided, skips auto-title generation
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
		const sessionId = generateUUID();

		const baseWorkspacePath = params.workspacePath || this.config.workspaceRoot;

		// Validate and resolve model ID using cached models
		const modelId = await this.getValidatedModelId(params.config?.model);

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

		if (!this.config.disableWorktrees) {
			try {
				const result = await this.worktreeManager.createWorktree({
					sessionId,
					repoPath: baseWorkspacePath,
					branchName: initialBranchName,
					baseBranch: params.worktreeBaseBranch || 'HEAD',
				});

				if (result) {
					worktreeMetadata = result;
					sessionWorkspacePath = result.worktreePath;
					this.logger.info(
						`[SessionLifecycle] Created worktree at ${result.worktreePath} with branch ${result.branch}`
					);
				}
			} catch (error) {
				this.logger.error(
					'[SessionLifecycle] Failed to create worktree during session creation:',
					error
				);
				// Continue without worktree - fallback to base workspace
			}
		}

		const session: Session = {
			id: sessionId,
			title: providedTitle || 'New Session',
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
				tools: params.config?.tools ?? this.toolsConfigManager.getDefaultForNewSession(),
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
			},
			// Worktree set during creation (if enabled)
			worktree: worktreeMetadata,
			gitBranch: worktreeMetadata?.branch,
		};

		// Save to database
		this.db.createSession(session);

		// Create agent session and add to cache
		const agentSession = this.createAgentSession(session);
		this.sessionCache.set(sessionId, agentSession);

		// Emit event via EventBus (StateManager will handle publishing to MessageHub)
		this.logger.info('[SessionLifecycle] Emitting session:created event for session:', sessionId);
		await this.eventBus.emit('session.created', { sessionId, session });
		this.logger.info('[SessionLifecycle] Event emitted, returning sessionId:', sessionId);

		return sessionId;
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
		this.logger.info(`[SessionLifecycle] Starting deletion for session ${sessionId}`);

		// Get references before deletion
		const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
		const session = this.db.getSession(sessionId);

		// Track completed phases for potential rollback
		const completedPhases: string[] = [];

		try {
			// PHASE 1: Cleanup AgentSession (stops SDK subprocess)
			// This is critical - must complete before other cleanup
			if (agentSession) {
				this.logger.info(`[SessionLifecycle] PHASE 1: Cleaning up AgentSession`);
				try {
					await agentSession.cleanup();
					completedPhases.push('agent-cleanup');
				} catch (error) {
					this.logger.error(`[SessionLifecycle] AgentSession cleanup failed:`, error);
					// Continue with deletion - SDK subprocess will be terminated when process exits
				}
			}

			// PHASE 2: Delete worktree and branch
			// Must happen before DB deletion (we need the worktree metadata)
			if (session?.worktree) {
				this.logger.info(`[SessionLifecycle] PHASE 2: Removing worktree for session ${sessionId}`);
				try {
					await this.worktreeManager.removeWorktree(session.worktree, true);

					// Verify worktree was actually removed
					const stillExists = await this.worktreeManager.verifyWorktree(session.worktree);
					if (stillExists) {
						this.logger.warn(
							`[SessionLifecycle] Worktree still exists after removal: ${session.worktree.worktreePath}`
						);
						// Track for global teardown
						completedPhases.push('worktree-cleanup-partial');
					} else {
						this.logger.info(`[SessionLifecycle] Worktree successfully removed`);
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
			this.logger.info(`[SessionLifecycle] PHASE 3: Deleting session from database`);
			try {
				this.db.deleteSession(sessionId);
				completedPhases.push('db-delete');
			} catch (error) {
				this.logger.error(`[SessionLifecycle] Database deletion failed:`, error);
				throw error; // Re-throw - if we can't delete from DB, deletion failed
			}

			// PHASE 4: Remove from cache
			this.logger.info(`[SessionLifecycle] PHASE 4: Removing session from cache`);
			try {
				this.sessionCache.remove(sessionId);
				completedPhases.push('cache-remove');
			} catch (error) {
				this.logger.error(`[SessionLifecycle] Cache removal failed:`, error);
				// Non-critical - session will be garbage collected
			}

			// PHASE 5: Broadcast deletion event
			// Best-effort notification - failure doesn't affect deletion
			this.logger.info(`[SessionLifecycle] PHASE 5: Broadcasting deletion event`);
			try {
				await Promise.all([
					this.messageHub.publish(
						'session.deleted',
						{ sessionId, reason: 'deleted' },
						{ sessionId: 'global' }
					),
					this.eventBus.emit('session.deleted', { sessionId }),
				]);
				completedPhases.push('broadcast');
			} catch (error) {
				this.logger.error(`[SessionLifecycle] Failed to broadcast deletion:`, error);
				// Non-critical - session is already deleted
			}

			this.logger.info(
				`[SessionLifecycle] Session ${sessionId} deleted successfully (completed phases: ${completedPhases.join(', ')})`
			);
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
			this.logger.info(`[SessionLifecycle] Session ${sessionId} title already generated`);
			return { title: session.title, isFallback: false };
		}

		this.logger.info(`[SessionLifecycle] Generating title for session ${sessionId}...`);

		try {
			// Step 1: Generate title from user message using Haiku model
			const { title, isFallback } = await this.generateTitleFromMessage(
				userMessageText,
				session.workspacePath
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
						this.logger.info(`[SessionLifecycle] Renamed branch from ${oldBranch} to ${newBranch}`);
					} else {
						this.logger.info(`[SessionLifecycle] Failed to rename branch, keeping ${oldBranch}`);
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

			if (isFallback) {
				this.logger.warn(
					`[SessionLifecycle] Used fallback title for session ${sessionId}: "${title}"`
				);
			} else {
				this.logger.info(`[SessionLifecycle] Title generated for session ${sessionId}: "${title}"`);
			}

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

			this.logger.info(
				`[SessionLifecycle] Used fallback title "${fallbackTitle}" for session ${sessionId}`
			);

			// Return result so caller can check if it was a fallback
			return { title: fallbackTitle, isFallback: true };
		}
	}

	/**
	 * Generate title from first user message using direct API call
	 * This bypasses the SDK subprocess and calls the Anthropic-like API directly
	 *
	 * @returns Object with title and isFallback flag
	 */
	private async generateTitleFromMessage(
		messageText: string,
		_sessionWorkspacePath: string
	): Promise<{ title: string; isFallback: boolean }> {
		// Get provider service to detect provider and get API configuration
		const providerService = getProviderService();
		const provider = providerService.getDefaultProvider();
		const apiKey = providerService.getProviderApiKey(provider);

		if (!apiKey) {
			this.logger.warn(
				`[SessionLifecycle] No API key for provider ${provider}, using fallback title`
			);
			return {
				title: messageText.substring(0, 50).trim() || 'New Session',
				isFallback: true,
			};
		}

		// Get title generation configuration from provider service
		const { modelId } = providerService.getTitleGenerationConfig(provider);

		this.logger.info(
			`[SessionLifecycle] Generating title with ${provider} provider using model ${modelId}...`
		);

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
		provider: Provider,
		modelId: string,
		messageText: string
	): Promise<string> {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const providerService = getProviderService();

		// Apply provider-specific environment variables to process.env
		// Use explicit provider to avoid model ID detection issues with shorthands like 'haiku'
		const originalEnv = providerService.applyEnvVarsToProcessForProvider(provider, modelId);

		this.logger.debug(
			`[SessionLifecycle] Env vars applied for provider ${provider}, model ${modelId}`
		);

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
				},
			});

			// Extract title from the response
			const { isSDKAssistantMessage } = await import('@liuboer/shared/sdk/type-guards');
			let title = '';

			for await (const message of agentQuery) {
				if (isSDKAssistantMessage(message)) {
					const textBlocks = message.message.content.filter(
						(b: { type: string }) => b.type === 'text'
					);
					title = textBlocks
						.map((b: { text?: string }) => b.text)
						.join(' ')
						.trim();

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

			this.logger.info(`[SessionLifecycle] Generated title: "${title}"`);
			return title;
		} finally {
			// Always restore original environment variables
			providerService.restoreEnvVars(originalEnv);
			this.logger.debug(`[SessionLifecycle] Env vars restored`);
		}
	}

	/**
	 * Get a validated model ID by using cached dynamic models
	 * Falls back to static model if dynamic loading failed or is unavailable
	 */
	private async getValidatedModelId(requestedModel?: string): Promise<string> {
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
						this.logger.info(`[SessionLifecycle] Using requested model: ${found.id}`);
						return found.id;
					}
					// Model not found - log warning but continue to try default
					this.logger.info(
						`[SessionLifecycle] Requested model "${requestedModel}" not found in available models:`,
						availableModels.map((m) => m.id)
					);
				}

				// Use configured default model (from DEFAULT_MODEL env var or 'default')
				// Try to find it by alias or ID in available models
				const configuredDefault = this.config.defaultModel;
				const defaultByConfig = availableModels.find(
					(m) => m.id === configuredDefault || m.alias === configuredDefault
				);

				if (defaultByConfig) {
					this.logger.info(
						`[SessionLifecycle] Using configured default model: ${defaultByConfig.id} (from ${configuredDefault})`
					);
					return defaultByConfig.id;
				}

				// Fallback: prefer Sonnet family if no configured default found
				const defaultModel =
					availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

				if (defaultModel) {
					this.logger.info(`[SessionLifecycle] Using fallback default model: ${defaultModel.id}`);
					return defaultModel.id;
				}
			} else {
				this.logger.info('[SessionLifecycle] No available models loaded from cache');
			}
		} catch (error) {
			this.logger.info('[SessionLifecycle] Error getting models:', error);
		}

		// Fallback to config default model or requested model
		// IMPORTANT: Always return full model ID, never aliases
		const fallbackModel = requestedModel || this.config.defaultModel;
		this.logger.info(`[SessionLifecycle] Using fallback model: ${fallbackModel}`);
		return fallbackModel;
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
 * Slugify text for branch names
 */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.substring(0, 50);
}
