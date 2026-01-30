/**
 * CheckpointTracker - Tracks checkpoints (restore points) from user messages
 *
 * When file checkpointing is enabled and `replay-user-messages` is set,
 * the SDK includes a UUID on each user message that can be used as a checkpoint
 * for the rewind feature.
 *
 * Checkpoints are stored in memory and associated with the session.
 * They represent restore points that can be used with query.rewindFiles().
 */

import type { Checkpoint } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { isSDKUserMessage, isSDKUserMessageReplay } from '@neokai/shared/sdk/type-guards';
import type { DaemonHub } from '../daemon-hub';
import { Logger } from '../logger';

/**
 * Message content type for extracting preview text
 */
type MessageContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: unknown }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; tool_use_id: string; content: unknown };

export class CheckpointTracker {
	private checkpoints: Map<string, Checkpoint> = new Map();
	private turnNumber = 0;
	private logger: Logger;

	constructor(
		private sessionId: string,
		private daemonHub: DaemonHub
	) {
		this.logger = new Logger(`CheckpointTracker ${sessionId}`);
	}

	/**
	 * Process an SDK message and extract checkpoint if applicable
	 *
	 * Checkpoints are created from user messages with UUIDs.
	 * This includes both regular user messages and replayed messages
	 * (when resuming a session).
	 *
	 * NOTE: This is primarily for synthetic SDK messages (compaction, subagent, etc.).
	 * Real user messages create checkpoints via createCheckpointFromUserMessage().
	 */
	processMessage(message: SDKMessage): void {
		// Check for user message with UUID (checkpoint)
		if (isSDKUserMessage(message) || isSDKUserMessageReplay(message)) {
			if (message.uuid) {
				this.addCheckpoint(message);
			}
		}
	}

	/**
	 * Create a checkpoint directly from user message data
	 *
	 * Called when a user message is persisted (before sending to SDK).
	 * This is the primary way checkpoints are created for normal conversation flow.
	 *
	 * @param messageId - UUID of the user message (becomes checkpoint ID)
	 * @param messageContent - Content of the message (for preview)
	 */
	createCheckpointFromUserMessage(
		messageId: string,
		messageContent: string | MessageContentBlock[]
	): void {
		// Don't create duplicate checkpoints
		if (this.checkpoints.has(messageId)) {
			this.logger.log(`Checkpoint ${messageId.slice(0, 8)}... already exists, skipping`);
			return;
		}

		this.turnNumber++;

		// Extract preview from content
		let messagePreview = '';
		if (typeof messageContent === 'string') {
			messagePreview = messageContent.slice(0, 100);
		} else if (Array.isArray(messageContent)) {
			// Find first text block
			const textBlock = messageContent.find(
				(block): block is { type: 'text'; text: string } => block.type === 'text'
			);
			messagePreview = textBlock?.text?.slice(0, 100) || '';
		}

		const checkpoint: Checkpoint = {
			id: messageId,
			messagePreview,
			turnNumber: this.turnNumber,
			timestamp: Date.now(),
			sessionId: this.sessionId,
		};

		this.checkpoints.set(checkpoint.id, checkpoint);
		this.logger.log(
			`Created checkpoint ${checkpoint.id.slice(0, 8)}... at turn ${checkpoint.turnNumber}`
		);

		// Emit event for state management (fire-and-forget)
		this.daemonHub
			.emit('checkpoint.created', {
				sessionId: this.sessionId,
				checkpoint,
			})
			.catch((err) => this.logger.warn('Failed to emit checkpoint.created:', err));
	}

	/**
	 * Add a checkpoint from a user message
	 */
	private addCheckpoint(message: SDKMessage): void {
		// Type assertion - we've already verified it's a user message type
		const userMessage = message as SDKMessage & {
			uuid: string;
			message?: { content: string | MessageContentBlock[] };
		};

		this.turnNumber++;

		const messagePreview = this.extractMessagePreview(userMessage);

		const checkpoint: Checkpoint = {
			id: userMessage.uuid,
			messagePreview,
			turnNumber: this.turnNumber,
			timestamp: Date.now(),
			sessionId: this.sessionId,
		};

		this.checkpoints.set(checkpoint.id, checkpoint);
		this.logger.log(
			`Created checkpoint ${checkpoint.id.slice(0, 8)}... at turn ${checkpoint.turnNumber}`
		);

		// Emit event for state management (fire-and-forget)
		this.daemonHub
			.emit('checkpoint.created', {
				sessionId: this.sessionId,
				checkpoint,
			})
			.catch((err) => this.logger.warn('Failed to emit checkpoint.created:', err));
	}

	/**
	 * Extract preview text from user message (truncated to 100 chars)
	 */
	private extractMessagePreview(message: {
		message?: { content: string | MessageContentBlock[] };
	}): string {
		const content = message.message?.content;
		if (!content) return '';

		// String content
		if (typeof content === 'string') {
			return content.slice(0, 100);
		}

		// Array of content blocks - find first text block
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					return block.text.slice(0, 100);
				}
			}
		}

		return '';
	}

	/**
	 * Get all checkpoints for this session, sorted by turn number (newest first)
	 */
	getCheckpoints(): Checkpoint[] {
		return Array.from(this.checkpoints.values()).sort((a, b) => b.turnNumber - a.turnNumber);
	}

	/**
	 * Get a specific checkpoint by ID
	 */
	getCheckpoint(id: string): Checkpoint | undefined {
		return this.checkpoints.get(id);
	}

	/**
	 * Get the most recent checkpoint
	 */
	getLatestCheckpoint(): Checkpoint | undefined {
		const all = this.getCheckpoints();
		return all[0];
	}

	/**
	 * Get the first checkpoint (initial state)
	 */
	getFirstCheckpoint(): Checkpoint | undefined {
		const all = this.getCheckpoints();
		return all[all.length - 1];
	}

	/**
	 * Rewind tracker state to a specific checkpoint
	 *
	 * Removes all checkpoints AFTER the specified checkpoint.
	 * Used when conversation is rewound to maintain consistency.
	 *
	 * @param checkpointId - The checkpoint ID to rewind to
	 * @returns Number of checkpoints removed
	 */
	rewindTo(checkpointId: string): number {
		const checkpoint = this.checkpoints.get(checkpointId);
		if (!checkpoint) {
			this.logger.warn(`Cannot rewind: checkpoint ${checkpointId} not found`);
			return 0;
		}

		// Find and remove all checkpoints after this turn
		const toRemove: string[] = [];
		for (const [id, cp] of this.checkpoints) {
			if (cp.turnNumber > checkpoint.turnNumber) {
				toRemove.push(id);
			}
		}

		for (const id of toRemove) {
			this.checkpoints.delete(id);
		}

		// Reset turn number to the checkpoint's turn
		this.turnNumber = checkpoint.turnNumber;

		this.logger.log(
			`Rewound to checkpoint ${checkpointId.slice(0, 8)}... (turn ${checkpoint.turnNumber}), removed ${toRemove.length} checkpoints`
		);

		return toRemove.length;
	}

	/**
	 * Clear all checkpoints (on session restart or reset)
	 */
	clear(): void {
		const count = this.checkpoints.size;
		this.checkpoints.clear();
		this.turnNumber = 0;
		this.logger.log(`Cleared ${count} checkpoints`);
	}

	/**
	 * Get the number of checkpoints
	 */
	get size(): number {
		return this.checkpoints.size;
	}

	/**
	 * Check if a checkpoint exists
	 */
	has(checkpointId: string): boolean {
		return this.checkpoints.has(checkpointId);
	}
}
