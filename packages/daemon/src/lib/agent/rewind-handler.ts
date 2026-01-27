/**
 * RewindHandler - Handles rewind operations for AgentSession
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Preview rewind (dry run)
 * - Execute rewind (files, conversation, or both)
 * - Checkpoint retrieval
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session, Checkpoint, RewindPreview, RewindResult, RewindMode } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import type { CheckpointTracker } from './checkpoint-tracker';
import type { QueryLifecycleManager } from './query-lifecycle-manager';

/**
 * Context interface - what RewindHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface RewindHandlerContext {
	readonly session: Session;
	readonly db: Database;
	readonly daemonHub: DaemonHub;
	readonly checkpointTracker: CheckpointTracker;
	readonly lifecycleManager: QueryLifecycleManager;
	readonly logger: Logger;
	readonly queryObject: Query | null;
	readonly firstMessageReceived: boolean;
}

/**
 * Handles rewind operations for AgentSession
 */
export class RewindHandler {
	constructor(private ctx: RewindHandlerContext) {}

	/**
	 * Get all checkpoints for this session
	 */
	getCheckpoints(): Checkpoint[] {
		return this.ctx.checkpointTracker.getCheckpoints();
	}

	/**
	 * Preview a rewind operation (dry run)
	 */
	async previewRewind(checkpointId: string): Promise<RewindPreview> {
		const { checkpointTracker, queryObject, firstMessageReceived, logger } = this.ctx;

		// Validate checkpoint exists
		const checkpoint = checkpointTracker.getCheckpoint(checkpointId);
		if (!checkpoint) {
			return { canRewind: false, error: `Checkpoint ${checkpointId} not found` };
		}

		// Check SDK query is active and ready
		if (!queryObject) {
			return { canRewind: false, error: 'SDK query not active. Start a conversation first.' };
		}

		if (!firstMessageReceived) {
			return {
				canRewind: false,
				error: 'SDK not ready. Please wait for the session to initialize.',
			};
		}

		try {
			const sdkResult = await queryObject.rewindFiles(checkpointId, { dryRun: true });
			return {
				canRewind: sdkResult.canRewind,
				error: sdkResult.error,
				filesChanged: sdkResult.filesChanged,
				insertions: sdkResult.insertions,
				deletions: sdkResult.deletions,
			};
		} catch (error) {
			logger.error('Rewind preview failed:', error);
			return { canRewind: false, error: error instanceof Error ? error.message : 'Unknown error' };
		}
	}

	/**
	 * Execute a rewind operation
	 */
	async executeRewind(checkpointId: string, mode: RewindMode): Promise<RewindResult> {
		const { session, daemonHub, checkpointTracker, queryObject, firstMessageReceived, logger } =
			this.ctx;

		// Validate checkpoint exists
		const checkpoint = checkpointTracker.getCheckpoint(checkpointId);
		if (!checkpoint) {
			return { success: false, error: `Checkpoint ${checkpointId} not found` };
		}

		// Check SDK query is active and ready
		if (!queryObject) {
			return { success: false, error: 'SDK query not active. Start a conversation first.' };
		}

		if (!firstMessageReceived) {
			return { success: false, error: 'SDK not ready. Please wait for the session to initialize.' };
		}

		// Emit rewind.started event
		await daemonHub.emit('rewind.started', { sessionId: session.id, checkpointId, mode });

		try {
			// Mode 1: files only
			if (mode === 'files') {
				const sdkResult = await queryObject.rewindFiles(checkpointId);

				if (!sdkResult.canRewind) {
					await daemonHub.emit('rewind.failed', {
						sessionId: session.id,
						checkpointId,
						mode,
						error: sdkResult.error || 'Rewind failed',
					});
					return { success: false, error: sdkResult.error };
				}

				await daemonHub.emit('rewind.completed', {
					sessionId: session.id,
					checkpointId,
					mode,
					result: {
						success: true,
						filesChanged: sdkResult.filesChanged,
						insertions: sdkResult.insertions,
						deletions: sdkResult.deletions,
					},
				});

				return {
					success: true,
					filesChanged: sdkResult.filesChanged,
					insertions: sdkResult.insertions,
					deletions: sdkResult.deletions,
				};
			}

			// Mode 2: conversation only
			if (mode === 'conversation') {
				return await this.executeConversationRewind(checkpointId, checkpoint);
			}

			// Mode 3: both - files then conversation
			const sdkResult = await queryObject.rewindFiles(checkpointId);

			if (!sdkResult.canRewind) {
				await daemonHub.emit('rewind.failed', {
					sessionId: session.id,
					checkpointId,
					mode,
					error: sdkResult.error || 'File rewind failed',
				});
				return { success: false, error: sdkResult.error };
			}

			const conversationResult = await this.executeConversationRewind(checkpointId, checkpoint);

			return {
				success: conversationResult.success,
				error: conversationResult.error,
				filesChanged: sdkResult.filesChanged,
				insertions: sdkResult.insertions,
				deletions: sdkResult.deletions,
				conversationRewound: conversationResult.conversationRewound,
				messagesDeleted: conversationResult.messagesDeleted,
			};
		} catch (error) {
			logger.error('Rewind execution failed:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			await daemonHub.emit('rewind.failed', {
				sessionId: session.id,
				checkpointId,
				mode,
				error: errorMessage,
			});

			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Execute conversation rewind (delete messages after checkpoint and restart)
	 */
	private async executeConversationRewind(
		checkpointId: string,
		checkpoint: Checkpoint
	): Promise<RewindResult> {
		const { session, db, checkpointTracker, lifecycleManager, logger } = this.ctx;

		// Step 1: Delete messages from DB after checkpoint timestamp
		const messagesDeleted = db.deleteMessagesAfter(session.id, checkpoint.timestamp);

		// Step 2: Set resumeSessionAt in session metadata
		session.metadata.resumeSessionAt = checkpointId;
		db.updateSession(session.id, { metadata: session.metadata });

		// Step 3: Rewind checkpoint tracker to remove later checkpoints
		checkpointTracker.rewindTo(checkpointId);

		// Step 4: Restart query to apply resumeSessionAt
		await lifecycleManager.restart();

		logger.log(
			`Conversation rewound to checkpoint ${checkpointId.slice(0, 8)}..., deleted ${messagesDeleted} messages`
		);

		return { success: true, conversationRewound: true, messagesDeleted };
	}
}
