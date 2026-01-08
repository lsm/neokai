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

import type { Session, WorktreeMetadata, MessageHub } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import type { Database } from '../../storage/database';
import type { DaemonHub } from '../daemon-hub';
import type { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';
import type { SessionCache, AgentSessionFactory } from './session-cache';
import type { ToolsConfigManager } from './tools-config';

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
				tools: params.config?.tools ?? this.toolsConfigManager.getDefaultForNewSession(),
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
		await this.eventBus.emit('session.updated', { sessionId, source: 'update', session: updates });
	}

	/**
	 * Delete a session
	 */
	async delete(sessionId: string): Promise<void> {
		// Transaction-like cleanup with proper error handling
		const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
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
				this.logger.info(`[SessionLifecycle] Removing worktree for session ${sessionId}`);

				try {
					await this.worktreeManager.removeWorktree(session.worktree, true);

					// Verify worktree was actually removed
					const stillExists = await this.worktreeManager.verifyWorktree(session.worktree);
					if (stillExists) {
						this.logger.error(
							`[SessionLifecycle] WARNING: Worktree still exists after removal: ${session.worktree.worktreePath}`
						);
						// Log to a failures list that global teardown can check
						// For now, just log - global teardown will catch these
					} else {
						this.logger.info(`[SessionLifecycle] Successfully removed worktree`);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.logger.error(
						`[SessionLifecycle] FAILED to remove worktree (will be cleaned by global teardown): ${errorMsg}`,
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
			this.sessionCache.remove(sessionId);

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
				this.logger.error('[SessionLifecycle] Failed to broadcast deletion:', error);
				// Don't rollback - session is already deleted
			}
		} catch (error) {
			// Rollback if DB delete failed
			if (!dbDeleted) {
				this.logger.error('[SessionLifecycle] Session deletion failed:', error);
				throw error;
			}

			// If cleanup failed but DB delete succeeded, log but don't rollback
			this.logger.error('[SessionLifecycle] Session deleted but cleanup failed:', error);
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
	 */
	async generateTitleAndRenameBranch(sessionId: string, userMessageText: string): Promise<void> {
		const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
		if (!agentSession) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const session = agentSession.getSessionData();

		// Check if title already generated
		if (session.metadata.titleGenerated) {
			this.logger.info(`[SessionLifecycle] Session ${sessionId} title already generated`);
			return;
		}

		this.logger.info(`[SessionLifecycle] Generating title for session ${sessionId}...`);

		try {
			// Step 1: Generate title from user message using Haiku model
			const title = await this.generateTitleFromMessage(userMessageText, session.workspacePath);
			this.logger.info(`[SessionLifecycle] Generated title: "${title}"`);

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

			this.logger.info(`[SessionLifecycle] Title generated for session ${sessionId}: "${title}"`);
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
		}
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

			this.logger.info('[SessionLifecycle] Generating title with Haiku...');

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
								this.logger.info(`[SessionLifecycle] Generated title: "${title}"`);
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
			this.logger.info('[SessionLifecycle] Title generation failed:', error);
			// Fallback to first 50 chars of message
			return messageText.substring(0, 50).trim() || 'New Session';
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

				// Find default model (prefer Sonnet)
				const defaultModel =
					availableModels.find((m) => m.family === 'sonnet') || availableModels[0];

				if (defaultModel) {
					this.logger.info(`[SessionLifecycle] Using default model: ${defaultModel.id}`);
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
