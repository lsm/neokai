/**
 * Rewind Feature Types
 *
 * Types for the rewind feature, which allows restoring workspace files
 * and/or conversation to a previous checkpoint.
 */

/**
 * Checkpoint information for a restore point in the conversation.
 * Each user message with a UUID creates a checkpoint.
 */
export interface Checkpoint {
	/** UUID from the user message */
	id: string;
	/** Preview of the message content (first 100 chars) */
	messagePreview: string;
	/** Turn number in the conversation (1-indexed) */
	turnNumber: number;
	/** Timestamp when the message was created (milliseconds since epoch) */
	timestamp: number;
	/** Session ID this checkpoint belongs to */
	sessionId: string;
}

/**
 * Result of a rewind preview operation (dry run).
 * Shows what would change without actually modifying anything.
 */
export interface RewindPreview {
	/** Whether rewind is possible */
	canRewind: boolean;
	/** Error message if rewind is not possible */
	error?: string;
	/** List of files that would be changed */
	filesChanged?: string[];
	/** Number of line insertions */
	insertions?: number;
	/** Number of line deletions */
	deletions?: number;
}

/**
 * Result of a rewind execution operation.
 * Contains the actual changes made.
 */
export interface RewindResult {
	/** Whether the rewind operation succeeded */
	success: boolean;
	/** Error message if the operation failed */
	error?: string;
	/** List of files that were changed */
	filesChanged?: string[];
	/** Number of line insertions */
	insertions?: number;
	/** Number of line deletions */
	deletions?: number;
	/** Whether the conversation was rewound (messages deleted) */
	conversationRewound?: boolean;
	/** Number of messages deleted from the conversation */
	messagesDeleted?: number;
}

/**
 * Rewind mode - what to restore when rewinding.
 */
export type RewindMode = 'files' | 'conversation' | 'both';
