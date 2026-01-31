/**
 * RewindHandler - Handles rewind operations for AgentSession
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Preview rewind (dry run)
 * - Execute rewind (files, conversation, or both)
 * - Checkpoint retrieval (from user messages in DB)
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	Session,
	RewindPreview,
	RewindResult,
	RewindMode,
	SelectiveRewindPreview,
	SelectiveRewindResult,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import type { QueryLifecycleManager } from './query-lifecycle-manager';

/**
 * A checkpoint/rewind point derived from a user message
 */
export interface RewindPoint {
	uuid: string; // User message UUID (used as checkpoint ID by SDK)
	timestamp: number; // Message timestamp (milliseconds)
	content: string; // Message content preview
	turnNumber: number; // Derived turn number (1-indexed position)
}

/**
 * Context interface - what RewindHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface RewindHandlerContext {
	readonly session: Session;
	readonly db: Database;
	readonly daemonHub: DaemonHub;
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
	 * Get all rewind points (user messages) for this session
	 *
	 * Returns user messages from the DB, sorted newest first.
	 * Each user message is a potential rewind point since the SDK
	 * uses user message UUIDs for file checkpointing.
	 */
	getRewindPoints(): RewindPoint[] {
		const { session, db } = this.ctx;
		const userMessages = db.getUserMessages(session.id);

		// Add turn numbers (1-indexed)
		return userMessages
			.map((msg, idx) => ({
				uuid: msg.uuid,
				timestamp: msg.timestamp,
				content: msg.content,
				turnNumber: idx + 1,
			}))
			.reverse(); // Newest first
	}

	/**
	 * Get a single rewind point by UUID
	 */
	getRewindPoint(uuid: string): RewindPoint | undefined {
		const { session, db } = this.ctx;
		const userMessage = db.getUserMessageByUuid(session.id, uuid);
		if (!userMessage) return undefined;

		// Get all messages to find turn number
		const allMessages = db.getUserMessages(session.id);
		const turnNumber = allMessages.findIndex((m) => m.uuid === uuid) + 1;

		return {
			uuid: userMessage.uuid,
			timestamp: userMessage.timestamp,
			content: userMessage.content,
			turnNumber,
		};
	}

	/**
	 * Preview a rewind operation (dry run)
	 */
	async previewRewind(checkpointId: string): Promise<RewindPreview> {
		const { db, queryObject, firstMessageReceived, logger, session } = this.ctx;

		// Validate checkpoint exists (look up user message)
		const rewindPoint = this.getRewindPoint(checkpointId);
		if (!rewindPoint) {
			return { canRewind: false, error: `Rewind point ${checkpointId} not found` };
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

			// Count messages that would be deleted
			const messagesAffected = db.countMessagesAfter(session.id, rewindPoint.timestamp);

			return {
				canRewind: sdkResult.canRewind,
				error: sdkResult.error,
				filesChanged: sdkResult.filesChanged,
				insertions: sdkResult.insertions,
				deletions: sdkResult.deletions,
				messagesAffected,
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
		const { session, daemonHub, queryObject, firstMessageReceived, logger } = this.ctx;

		// Validate checkpoint exists
		const rewindPoint = this.getRewindPoint(checkpointId);
		if (!rewindPoint) {
			return { success: false, error: `Rewind point ${checkpointId} not found` };
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
				return await this.executeConversationRewind(checkpointId, rewindPoint);
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

			const conversationResult = await this.executeConversationRewind(checkpointId, rewindPoint);

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
		rewindPoint: RewindPoint
	): Promise<RewindResult> {
		const { session, db, lifecycleManager, logger } = this.ctx;

		// Step 1: Delete messages from DB after rewind point timestamp
		const messagesDeleted = db.deleteMessagesAfter(session.id, rewindPoint.timestamp);

		// Step 2: Set resumeSessionAt in session metadata
		session.metadata.resumeSessionAt = checkpointId;
		db.updateSession(session.id, { metadata: session.metadata });

		// Step 3: Restart query to apply resumeSessionAt
		await lifecycleManager.restart();

		logger.log(
			`Conversation rewound to checkpoint ${checkpointId.slice(0, 8)}..., deleted ${messagesDeleted} messages`
		);

		return { success: true, conversationRewound: true, messagesDeleted };
	}

	/**
	 * Preview a selective rewind operation
	 *
	 * Selective rewind allows choosing specific messages to rewind.
	 * All messages from the earliest selected message onward will be deleted.
	 * Files will be reverted using SDK checkpoints if available, or Edit tool diffs as fallback.
	 */
	async previewSelectiveRewind(messageIds: string[]): Promise<SelectiveRewindPreview> {
		const { session, db, queryObject, firstMessageReceived, logger } = this.ctx;

		if (!queryObject) {
			return {
				canRewind: false,
				error: 'SDK query not active. Start a conversation first.',
				messagesToDelete: 0,
				filesToRevert: [],
			};
		}

		if (!firstMessageReceived) {
			return {
				canRewind: false,
				error: 'SDK not ready. Please wait for the session to initialize.',
				messagesToDelete: 0,
				filesToRevert: [],
			};
		}

		// Get the earliest selected message (smallest timestamp)
		const allMessages = db.getSDKMessages(session.id, 10000);
		const selectedMessages = allMessages.filter((m) => m.uuid && messageIds.includes(m.uuid));

		if (selectedMessages.length === 0) {
			return {
				canRewind: false,
				error: 'No valid messages found',
				messagesToDelete: 0,
				filesToRevert: [],
			};
		}

		// Find the earliest selected message by timestamp
		const earliestMessage = selectedMessages.reduce((earliest, current) => {
			const currentTimestamp = (current as Record<string, unknown>).timestamp as number;
			const earliestTimestamp = (earliest as Record<string, unknown>).timestamp as number;
			return currentTimestamp < earliestTimestamp ? current : earliest;
		});

		const earliestTimestamp = (earliestMessage as Record<string, unknown>).timestamp as number;

		// Count messages that would be deleted
		const messagesToDelete = allMessages.filter((m) => {
			const msgTimestamp = (m as Record<string, unknown>).timestamp as number;
			return msgTimestamp > earliestTimestamp;
		}).length;

		// Analyze files that would need to be reverted
		// For now, we'll use the SDK rewind preview to get file information
		// In the future, we could also scan for Edit tool diffs as a fallback strategy
		const checkpointId = messageIds[0]; // Use the first message UUID as checkpoint

		try {
			const sdkResult = await queryObject.rewindFiles(checkpointId, { dryRun: true });

			const filesToRevert = (sdkResult.filesChanged || []).map((path) => ({
				path,
				hasCheckpoint: true, // SDK rewindFiles found this file
				hasEditDiff: false, // TODO: Scan for Edit tool diffs as fallback
			}));

			return {
				canRewind: sdkResult.canRewind,
				error: sdkResult.error,
				messagesToDelete,
				filesToRevert,
			};
		} catch (error) {
			logger.error('Selective rewind preview failed:', error);
			return {
				canRewind: false,
				error: error instanceof Error ? error.message : 'Unknown error',
				messagesToDelete,
				filesToRevert: [],
			};
		}
	}

	/**
	 * Execute a selective rewind operation
	 *
	 * Deletes all messages from the earliest selected message onward,
	 * and reverts files using SDK checkpoints.
	 */
	async executeSelectiveRewind(messageIds: string[]): Promise<SelectiveRewindResult> {
		const { session, db, lifecycleManager, queryObject, firstMessageReceived, logger } = this.ctx;

		if (!queryObject) {
			return {
				success: false,
				error: 'SDK query not active. Start a conversation first.',
				messagesDeleted: 0,
				filesReverted: [],
			};
		}

		if (!firstMessageReceived) {
			return {
				success: false,
				error: 'SDK not ready. Please wait for the session to initialize.',
				messagesDeleted: 0,
				filesReverted: [],
			};
		}

		// Get the earliest selected message (smallest timestamp)
		const allMessages = db.getSDKMessages(session.id, 10000);
		const selectedMessages = allMessages.filter((m) => m.uuid && messageIds.includes(m.uuid));

		if (selectedMessages.length === 0) {
			return {
				success: false,
				error: 'No valid messages found',
				messagesDeleted: 0,
				filesReverted: [],
			};
		}

		// Find the earliest selected message by timestamp
		const earliestMessage = selectedMessages.reduce((earliest, current) => {
			const currentTimestamp = (current as Record<string, unknown>).timestamp as number;
			const earliestTimestamp = (earliest as Record<string, unknown>).timestamp as number;
			return currentTimestamp < earliestTimestamp ? current : earliest;
		});

		const earliestTimestamp = (earliestMessage as Record<string, unknown>).timestamp as number;
		const checkpointId = messageIds[0]; // Use the first message UUID as checkpoint

		try {
			// Step 1: Rewind files using SDK checkpoint
			const sdkResult = await queryObject.rewindFiles(checkpointId);

			if (!sdkResult.canRewind) {
				return {
					success: false,
					error: sdkResult.error,
					messagesDeleted: 0,
					filesReverted: [],
				};
			}

			// Step 2: Delete messages from DB after the earliest timestamp
			const messagesDeleted = db.deleteMessagesAfter(session.id, earliestTimestamp);

			// Step 3: Set resumeSessionAt in session metadata and restart
			session.metadata.resumeSessionAt = checkpointId;
			db.updateSession(session.id, { metadata: session.metadata });

			// Step 4: Restart query to apply resumeSessionAt
			await lifecycleManager.restart();

			logger.log(
				`Selective rewind to checkpoint ${checkpointId.slice(0, 8)}..., deleted ${messagesDeleted} messages, reverted ${sdkResult.filesChanged?.length || 0} files`
			);

			return {
				success: true,
				messagesDeleted,
				filesReverted: sdkResult.filesChanged || [],
			};
		} catch (error) {
			logger.error('Selective rewind execution failed:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			return {
				success: false,
				error: errorMessage,
				messagesDeleted: 0,
				filesReverted: [],
			};
		}
	}
}
