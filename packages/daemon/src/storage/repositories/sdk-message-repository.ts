/**
 * SDK Message Repository
 *
 * Responsibilities:
 * - Save and retrieve SDK messages
 * - Pagination support (before/since cursors)
 * - Message query mode tracking (saved/queued/sent status)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { Logger } from '../../lib/logger';
import type { SQLiteValue } from '../types';

export type SendStatus = 'saved' | 'queued' | 'sent';

export class SDKMessageRepository {
	private logger = new Logger('Database');

	constructor(private db: BunDatabase) {}

	/**
	 * Save a full SDK message to the database
	 *
	 * FIX: Enhanced with proper error handling and logging
	 * Returns true on success, false on failure
	 */
	saveSDKMessage(sessionId: string, message: SDKMessage): boolean {
		try {
			const id = generateUUID();
			const messageType = message.type;
			const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
			const timestamp = new Date().toISOString();

			const stmt = this.db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
			);

			stmt.run(id, sessionId, messageType, messageSubtype, JSON.stringify(message), timestamp);
			return true;
		} catch (error) {
			// Log error but don't throw - prevents stream from dying
			this.logger.error('[Database] Failed to save SDK message:', error);
			this.logger.error('[Database] Message type:', message.type, 'Session:', sessionId);
			return false;
		}
	}

	/**
	 * Get SDK messages for a session
	 *
	 * Returns messages in chronological order (oldest to newest).
	 *
	 * Pagination modes:
	 * 1. Initial load (no before): Returns the NEWEST `limit` top-level messages + their subagent messages
	 * 2. Load older (with before): Returns messages BEFORE the given timestamp
	 * 3. Load newer (with since): Returns messages AFTER the given timestamp
	 *
	 * Note: The limit applies only to top-level messages. Subagent messages (with parent_tool_use_id)
	 * are automatically included for the returned top-level messages to support SubagentBlock rendering.
	 *
	 * @param sessionId - The session ID to get messages for
	 * @param limit - Maximum number of top-level messages to return (default: 100)
	 * @param before - Cursor: get messages older than this timestamp (milliseconds)
	 * @param since - Get messages newer than this timestamp (milliseconds)
	 */
	getSDKMessages(sessionId: string, limit = 100, before?: number, since?: number): SDKMessage[] {
		// Step 1: Get top-level messages (excluding subagent messages)
		let query = `SELECT sdk_message, timestamp FROM sdk_messages WHERE session_id = ? AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL`;
		const params: SQLiteValue[] = [sessionId];

		// Cursor-based pagination: get messages BEFORE a timestamp (for loading older)
		if (before !== undefined && before > 0) {
			query += ` AND timestamp < ?`;
			params.push(new Date(before).toISOString());
		}

		// Get messages AFTER a timestamp (for loading newer / real-time updates)
		if (since !== undefined && since > 0) {
			query += ` AND timestamp > ?`;
			params.push(new Date(since).toISOString());
		}

		// Order DESC to get newest messages first, then reverse for chronological display
		query += ` ORDER BY timestamp DESC LIMIT ?`;
		params.push(limit);

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		// Parse SDK message and inject the timestamp from the database row
		const messages = rows.map((r) => {
			const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
			const timestamp = new Date(r.timestamp as string).getTime();
			// Inject timestamp into SDK message object for client-side filtering
			return { ...sdkMessage, timestamp } as SDKMessage & { timestamp: number };
		});

		// Reverse to get chronological order (oldest to newest) for display
		const topLevelMessages = messages.reverse();

		// Step 2: Get all subagent messages for the returned top-level messages
		// Extract tool use IDs from Task blocks in the top-level messages
		const toolUseIds = new Set<string>();
		topLevelMessages.forEach((msg) => {
			if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
				msg.message.content.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_use' && blockObj.id) {
						toolUseIds.add(blockObj.id as string);
					}
				});
			}
		});

		// Fetch subagent messages that have parent_tool_use_id matching any of the tool use IDs
		let subagentMessages: SDKMessage[] = [];
		if (toolUseIds.size > 0) {
			const placeholders = Array.from(toolUseIds)
				.map(() => '?')
				.join(',');
			const subagentQuery = `SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND json_extract(sdk_message, '$.parent_tool_use_id') IN (${placeholders})
       ORDER BY timestamp ASC`;
			const subagentParams: SQLiteValue[] = [sessionId, ...Array.from(toolUseIds)];

			const subagentStmt = this.db.prepare(subagentQuery);
			const subagentRows = subagentStmt.all(...subagentParams) as Record<string, unknown>[];

			subagentMessages = subagentRows.map((r) => {
				const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
				const timestamp = new Date(r.timestamp as string).getTime();
				return { ...sdkMessage, timestamp } as SDKMessage & { timestamp: number };
			});
		}

		// Combine and return: top-level messages + their associated subagent messages
		return [...topLevelMessages, ...subagentMessages];
	}

	/**
	 * Get SDK messages by type
	 */
	getSDKMessagesByType(
		sessionId: string,
		messageType: string,
		messageSubtype?: string,
		limit = 100
	): SDKMessage[] {
		let query = `SELECT sdk_message FROM sdk_messages WHERE session_id = ? AND message_type = ?`;
		const params: SQLiteValue[] = [sessionId, messageType];

		if (messageSubtype) {
			query += ` AND message_subtype = ?`;
			params.push(messageSubtype);
		}

		query += ` ORDER BY timestamp ASC LIMIT ?`;
		params.push(limit);

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		return rows.map((r) => JSON.parse(r.sdk_message as string) as SDKMessage);
	}

	/**
	 * Get the count of SDK messages for a session
	 *
	 * Only counts top-level messages (excludes nested subagent messages with parent_tool_use_id)
	 * to ensure accurate pagination.
	 */
	getSDKMessageCount(sessionId: string): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM sdk_messages
       WHERE session_id = ? AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL`
		);
		const result = stmt.get(sessionId) as { count: number };
		return result.count;
	}

	// ============================================================================
	// Message Query Mode operations
	// ============================================================================
	// Message send status types for query mode feature:
	// - 'saved': Message persisted but not yet sent to SDK (Manual mode)
	// - 'queued': Message in queue waiting to be sent (during processing)
	// - 'sent': Message has been yielded to SDK

	/**
	 * Save a user message with explicit send status
	 *
	 * Used by query modes to track message lifecycle:
	 * - Immediate mode: saves with status 'sent' (after yielding to SDK)
	 * - Auto-queue mode: saves with status 'queued' (pending SDK consumption)
	 * - Manual mode: saves with status 'saved' (until user triggers send)
	 *
	 * @returns The generated message ID
	 */
	saveUserMessage(sessionId: string, message: SDKMessage, sendStatus: SendStatus = 'sent'): string {
		const id = generateUUID();
		const messageType = message.type;
		const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
		const timestamp = new Date().toISOString();

		const stmt = this.db.prepare(
			`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			sessionId,
			messageType,
			messageSubtype,
			JSON.stringify(message),
			timestamp,
			sendStatus
		);
		return id;
	}

	/**
	 * Get messages by send status for a session
	 *
	 * Used to retrieve:
	 * - 'saved' messages for manual trigger
	 * - 'queued' messages for auto-send on turn_end
	 *
	 * Returns messages in chronological order (oldest first).
	 */
	getMessagesByStatus(
		sessionId: string,
		status: SendStatus
	): Array<SDKMessage & { dbId: string; timestamp: number }> {
		const stmt = this.db.prepare(
			`SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND send_status = ?
       ORDER BY timestamp ASC`
		);
		const rows = stmt.all(sessionId, status) as Array<{
			id: string;
			sdk_message: string;
			timestamp: string;
		}>;

		return rows.map((row) => ({
			...(JSON.parse(row.sdk_message) as SDKMessage),
			dbId: row.id,
			timestamp: new Date(row.timestamp).getTime(),
		}));
	}

	/**
	 * Update send status for messages
	 *
	 * Used to transition messages through the lifecycle:
	 * - 'saved' -> 'queued' (when user triggers manual send)
	 * - 'queued' -> 'sent' (when message is yielded to SDK)
	 */
	updateMessageStatus(messageIds: string[], newStatus: SendStatus): void {
		if (messageIds.length === 0) return;

		// Use parameterized query to prevent SQL injection
		const placeholders = messageIds.map(() => '?').join(',');
		const stmt = this.db.prepare(
			`UPDATE sdk_messages SET send_status = ? WHERE id IN (${placeholders})`
		);
		stmt.run(newStatus, ...messageIds);
	}

	/**
	 * Get count of messages by status for a session
	 * Useful for UI display (e.g., "3 messages pending")
	 */
	getMessageCountByStatus(sessionId: string, status: SendStatus): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND send_status = ?`
		);
		const result = stmt.get(sessionId, status) as { count: number };
		return result.count;
	}

	/**
	 * Delete messages after a specific timestamp
	 *
	 * Used by the rewind feature to remove messages from the conversation
	 * when rewinding to a previous checkpoint.
	 *
	 * @param sessionId - The session ID to delete messages from
	 * @param afterTimestamp - Delete messages with timestamp greater than this value (milliseconds)
	 * @returns The number of messages deleted
	 */
	deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
		const isoTimestamp = new Date(afterTimestamp).toISOString();
		const stmt = this.db.prepare(`DELETE FROM sdk_messages WHERE session_id = ? AND timestamp > ?`);
		const result = stmt.run(sessionId, isoTimestamp);
		return result.changes;
	}

	/**
	 * Delete messages at and after a specific timestamp (inclusive)
	 *
	 * Used by the rewind feature to remove the rewind point message itself
	 * and all subsequent messages.
	 *
	 * @param sessionId - The session ID to delete messages from
	 * @param atTimestamp - Delete messages with timestamp greater than or equal to this value (milliseconds)
	 * @returns The number of messages deleted
	 */
	deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
		const isoTimestamp = new Date(atTimestamp).toISOString();
		const stmt = this.db.prepare(
			`DELETE FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`
		);
		const result = stmt.run(sessionId, isoTimestamp);
		return result.changes;
	}

	/**
	 * Get user messages for a session (used as rewind points)
	 *
	 * Returns user messages with their UUIDs, timestamps, and content.
	 * These serve as potential rewind checkpoints since each user message
	 * has a UUID that the SDK uses for file checkpointing.
	 *
	 * @param sessionId - The session ID to get user messages for
	 * @returns Array of user message data for rewind
	 */
	getUserMessages(sessionId: string): Array<{ uuid: string; timestamp: number; content: string }> {
		const stmt = this.db.prepare(
			`SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND message_type = 'user'
       ORDER BY timestamp ASC`
		);
		const rows = stmt.all(sessionId) as Array<{ sdk_message: string; timestamp: string }>;

		return rows.map((row) => {
			const message = JSON.parse(row.sdk_message) as SDKMessage;
			const timestamp = new Date(row.timestamp).getTime();

			// Extract text content from message
			// User messages have a specific structure with nested message.content
			let content = '';
			const userMessage = message as {
				message?: { content?: string | Array<{ type: string; text?: string }> };
				uuid?: string;
			};
			if (userMessage.message?.content) {
				if (typeof userMessage.message.content === 'string') {
					content = userMessage.message.content;
				} else if (Array.isArray(userMessage.message.content)) {
					// Find first text block
					const textBlock = userMessage.message.content.find(
						(block): block is { type: 'text'; text: string } => block.type === 'text'
					);
					content = textBlock?.text || '';
				}
			}

			return {
				uuid: userMessage.uuid || '',
				timestamp,
				content,
			};
		});
	}

	/**
	 * Get a single user message by UUID
	 *
	 * Used by rewind to look up a specific checkpoint/message.
	 *
	 * @param sessionId - The session ID
	 * @param uuid - The message UUID
	 * @returns The message data or undefined
	 */
	getUserMessageByUuid(
		sessionId: string,
		uuid: string
	): { uuid: string; timestamp: number; content: string } | undefined {
		const stmt = this.db.prepare(
			`SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND message_type = 'user'
       ORDER BY timestamp ASC`
		);
		const rows = stmt.all(sessionId) as Array<{ sdk_message: string; timestamp: string }>;

		for (const row of rows) {
			const message = JSON.parse(row.sdk_message) as SDKMessage;
			if (message.uuid === uuid) {
				const timestamp = new Date(row.timestamp).getTime();

				// Extract text content from message
				// User messages have a specific structure with nested message.content
				let content = '';
				const userMessage = message as {
					message?: { content?: string | Array<{ type: string; text?: string }> };
					uuid?: string;
				};
				if (userMessage.message?.content) {
					if (typeof userMessage.message.content === 'string') {
						content = userMessage.message.content;
					} else if (Array.isArray(userMessage.message.content)) {
						// Find first text block
						const textBlock = userMessage.message.content.find(
							(block): block is { type: 'text'; text: string } => block.type === 'text'
						);
						content = textBlock?.text || '';
					}
				}

				return { uuid, timestamp, content };
			}
		}

		return undefined;
	}

	/**
	 * Count messages after a specific timestamp
	 *
	 * Used by rewind to show how many messages will be deleted.
	 *
	 * @param sessionId - The session ID
	 * @param afterTimestamp - Count messages with timestamp greater than this value (milliseconds)
	 * @returns The number of messages after the timestamp
	 */
	countMessagesAfter(sessionId: string, afterTimestamp: number): number {
		const isoTimestamp = new Date(afterTimestamp).toISOString();
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND timestamp > ?`
		);
		const result = stmt.get(sessionId, isoTimestamp) as { count: number };
		return result.count;
	}
}
