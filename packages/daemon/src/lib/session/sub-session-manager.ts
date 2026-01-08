/**
 * Sub-Session Manager Module
 *
 * Handles sub-session operations:
 * - Sub-session creation with parent validation
 * - Sub-session deletion with cascade
 * - Sub-session listing and filtering
 * - Sub-session reordering
 * - Worktree inheritance logic
 */

import type { Session, WorktreeMetadata, SubSessionConfig } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import type { Database } from '../../storage/database';
import type { DaemonHub } from '../daemon-hub';
import type { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';
import type { SessionCache, AgentSessionFactory } from './session-cache';
import type { SessionLifecycle, SessionLifecycleConfig } from './session-lifecycle';
import type { ToolsConfigManager } from './tools-config';

export interface CreateSubSessionParams {
	parentId: string;
	title?: string;
	config?: Partial<Session['config']>;
	subSessionConfig?: SubSessionConfig;
}

export class SubSessionManager {
	private logger: Logger;

	constructor(
		private db: Database,
		private sessionCache: SessionCache,
		private worktreeManager: WorktreeManager,
		private eventBus: DaemonHub,
		private sessionLifecycle: SessionLifecycle,
		private config: SessionLifecycleConfig,
		private toolsConfigManager: ToolsConfigManager,
		private createAgentSession: AgentSessionFactory
	) {
		this.logger = new Logger('SubSessionManager');
	}

	/**
	 * Create a sub-session under a parent session
	 *
	 * Sub-sessions:
	 * - Are child sessions that belong to a parent
	 * - Each has its own SDK instance (independent conversation)
	 * - Can only be one level deep (no nested sub-sessions)
	 * - Can inherit config from parent based on SubSessionConfig
	 * - Are automatically deleted when parent is deleted (cascade)
	 */
	async create(params: CreateSubSessionParams): Promise<string> {
		const { parentId, title, config: configOverrides, subSessionConfig } = params;

		// Get parent session
		const parent = this.db.getSession(parentId);
		if (!parent) {
			throw new Error(`Parent session ${parentId} not found`);
		}

		// Validate parent is not a sub-session (one level deep only)
		if (parent.parentId) {
			throw new Error('Cannot create sub-session under another sub-session (one level deep only)');
		}

		const sessionId = generateUUID();

		// Determine inheritance options (default to true for model and permissionMode)
		const inheritModel = subSessionConfig?.inheritModel ?? true;
		const inheritPermissionMode = subSessionConfig?.inheritPermissionMode ?? true;
		const inheritWorktree = subSessionConfig?.inheritWorktree ?? false;

		// Build session config
		// Start with defaults, apply parent inheritance, then apply overrides
		const sessionConfig: Session['config'] = {
			model: inheritModel ? parent.config.model : this.config.defaultModel,
			maxTokens: configOverrides?.maxTokens ?? parent.config.maxTokens ?? this.config.maxTokens,
			temperature:
				configOverrides?.temperature ?? parent.config.temperature ?? this.config.temperature,
			permissionMode: inheritPermissionMode
				? parent.config.permissionMode
				: configOverrides?.permissionMode,
			tools: configOverrides?.tools ?? this.toolsConfigManager.getDefaultForNewSession(),
			...configOverrides,
		};

		// Handle worktree
		let worktreeMetadata: WorktreeMetadata | undefined;
		let sessionWorkspacePath = parent.workspacePath;

		if (!this.config.disableWorktrees && !inheritWorktree) {
			// Create a new worktree for the sub-session
			try {
				const result = await this.worktreeManager.createWorktree({
					sessionId,
					repoPath: parent.worktree?.mainRepoPath ?? parent.workspacePath,
					branchName: `session/${sessionId}`,
					baseBranch: parent.worktree?.branch ?? 'HEAD',
				});

				if (result) {
					worktreeMetadata = result;
					sessionWorkspacePath = result.worktreePath;
					this.logger.info(
						`[SubSessionManager] Created worktree for sub-session at ${result.worktreePath}`
					);
				}
			} catch (error) {
				this.logger.error('[SubSessionManager] Failed to create worktree for sub-session:', error);
				// Continue without worktree - fallback to parent workspace
			}
		} else if (inheritWorktree && parent.worktree) {
			// Share parent's worktree
			worktreeMetadata = parent.worktree;
			sessionWorkspacePath = parent.worktree.worktreePath;
		}

		const session: Session = {
			id: sessionId,
			title: title || `Sub-session of ${parent.title}`,
			workspacePath: sessionWorkspacePath,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: sessionConfig,
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
				titleGenerated: !!title, // If title provided, skip auto-generation
				workspaceInitialized: true,
			},
			worktree: worktreeMetadata,
			gitBranch: worktreeMetadata?.branch,
			// Sub-session specific fields
			parentId,
			labels: subSessionConfig?.labels,
		};

		// Save to database using createSubSession (validates and sets order)
		this.db.createSubSession(session);

		// Create agent session
		const agentSession = this.createAgentSession(session);
		this.sessionCache.set(sessionId, agentSession);

		// Emit sub-session created event
		await this.eventBus.emit('subSession.created', {
			sessionId,
			parentId,
			session,
		});

		// Also emit regular session created event for state management
		await this.eventBus.emit('session.created', { sessionId, session });

		return sessionId;
	}

	/**
	 * Delete a sub-session
	 * Same as deleteSession, but also emits subSession.deleted event
	 */
	async delete(sessionId: string): Promise<void> {
		const session = this.db.getSession(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		if (!session.parentId) {
			throw new Error(`Session ${sessionId} is not a sub-session`);
		}

		const parentId = session.parentId;

		// Delete using standard delete logic from SessionLifecycle
		await this.sessionLifecycle.delete(sessionId);

		// Emit sub-session specific event
		await this.eventBus.emit('subSession.deleted', { sessionId, parentId });
	}

	/**
	 * Get sub-sessions for a parent
	 */
	list(parentId: string, labels?: string[]): Session[] {
		return this.db.getSubSessions(parentId, labels);
	}

	/**
	 * Reorder sub-sessions
	 */
	async reorder(parentId: string, orderedIds: string[]): Promise<void> {
		this.db.updateSubSessionOrder(parentId, orderedIds);

		await this.eventBus.emit('subSession.reordered', {
			sessionId: 'global', // Global event, not scoped to a session
			parentId,
			orderedIds,
		});
	}
}
