/**
 * SDK Message Repository
 *
 * Responsibilities:
 * - Save and retrieve SDK messages
 * - Pagination support (before/since cursors)
 * - Message query mode tracking (deferred/enqueued/consumed status)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { MessageOrigin, NeokaiActionMessage, ChatMessage } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { Logger } from '../../lib/logger';
import type { SQLiteValue } from '../types';

export type SendStatus = 'deferred' | 'enqueued' | 'consumed' | 'failed';

export class SDKMessageRepository {
	private logger = new Logger('Database');

	constructor(private db: BunDatabase) {}

	/**
	 * Save a full SDK message to the database
	 *
	 * FIX: Enhanced with proper error handling and logging
	 * Returns true on success, false on failure
	 */
	saveSDKMessage(sessionId: string, message: SDKMessage, origin?: MessageOrigin): boolean {
		try {
			const id = generateUUID();
			const messageType = message.type;
			const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
			const timestamp = new Date().toISOString();

			const stmt = this.db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
			);

			stmt.run(
				id,
				sessionId,
				messageType,
				messageSubtype,
				JSON.stringify(message),
				timestamp,
				origin ?? null
			);
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
	 * @returns Object with messages array and hasMore boolean
	 */
	getSDKMessages(
		sessionId: string,
		limit?: number,
		before?: number,
		since?: number
	): {
		messages: Array<
			ChatMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
		>;
		hasMore: boolean;
	} {
		return this._getSDKMessagesImpl(sessionId, limit ?? 100, before, since);
	}

	/**
	 * Internal implementation for getSDKMessages
	 * @private
	 */
	private _getSDKMessagesImpl(
		sessionId: string,
		limit: number,
		before?: number,
		since?: number
	): {
		messages: Array<
			ChatMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
		>;
		hasMore: boolean;
	} {
		// Step 1: Get top-level messages (excluding subagent messages)
		// Show user messages that were consumed to SDK, plus any that failed to deliver.
		let query = `SELECT sdk_message, timestamp, send_status, origin FROM sdk_messages
      WHERE session_id = ?
        AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
        AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))`;
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

		// Parse SDK message and inject the timestamp, sendStatus, and origin from the database row.
		// Always explicitly set `origin` (even to undefined) so the SDK's own
		// `origin?: SDKMessageOrigin` object field — added in SDK 0.2.110 — is stripped from the
		// spread result. Without this, messages whose DB origin column is null would carry an
		// SDKMessageOrigin object instead of a NeoKai MessageOrigin string, making the field's
		// type inconsistent across messages.
		const messages = rows.map((r) => {
			const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
			const timestamp = new Date(r.timestamp as string).getTime();
			const extra: Record<string, unknown> = {
				timestamp,
				// DB origin wins; undefined explicitly clears any SDK-level origin object.
				origin: r.origin != null ? (r.origin as MessageOrigin) : undefined,
			};
			if (r.send_status === 'failed') {
				extra.sendStatus = 'failed';
			}
			return { ...sdkMessage, ...extra } as SDKMessage & { timestamp: number };
		});

		// Reverse to get chronological order (oldest to newest) for display
		const topLevelMessages = messages.reverse();

		// Determine hasMore: if we got exactly `limit` top-level messages, there might be more
		const hasMore = topLevelMessages.length === limit;

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
		let subagentMessages: Array<SDKMessage & { timestamp: number }> = [];
		if (toolUseIds.size > 0) {
			const placeholders = Array.from(toolUseIds)
				.map(() => '?')
				.join(',');
			const subagentQuery = `SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND json_extract(sdk_message, '$.parent_tool_use_id') IN (${placeholders})
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        ORDER BY timestamp ASC`;
			const subagentParams: SQLiteValue[] = [sessionId, ...Array.from(toolUseIds)];

			const subagentStmt = this.db.prepare(subagentQuery);
			const subagentRows = subagentStmt.all(...subagentParams) as Record<string, unknown>[];

			subagentMessages = subagentRows.map((r) => {
				const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
				const timestamp = new Date(r.timestamp as string).getTime();
				// Subagent messages have no DB origin column; explicitly set undefined to strip
				// any SDK-level origin object from the JSON blob (same reasoning as top-level).
				return { ...sdkMessage, timestamp, origin: undefined } as SDKMessage & {
					timestamp: number;
				};
			});
		}

		// Combine and return: top-level messages + their associated subagent messages
		// hasMore is based on top-level message count only (not including subagent messages)
		// Note: cast required because the new SDK added `origin?: SDKMessageOrigin` to SDKUserMessage,
		// which conflicts with our augmented `origin?: MessageOrigin` field (a different type used for
		// tracking message provenance in NeoKai). The runtime values are always correct.
		return {
			messages: [...topLevelMessages, ...subagentMessages] as Array<
				SDKMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
			>,
			hasMore,
		};
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
	 * Get the most recently persisted top-level SDK message for a session.
	 *
	 * Excludes:
	 * - Subagent/tool-linked rows (those with a `parent_tool_use_id`).
	 * - User messages still in `deferred`/`enqueued` send_status (not yet consumed
	 *   by the SDK), so an unsent injectMessage doesn't shadow the real last message.
	 *
	 * Used by workflow runtime safety checks that need to know whether a node
	 * agent went idle after a terminal SDK result / clear end-turn, or stopped
	 * mid-turn (for example after a tool_use without a matching tool_result).
	 */
	getLastSDKMessage(sessionId: string): (SDKMessage & { dbId: string; timestamp: number }) | null {
		const stmt = this.db.prepare(
			`SELECT id, sdk_message, timestamp FROM sdk_messages
	       WHERE session_id = ?
		       AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
		       AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
	       ORDER BY timestamp DESC, rowid DESC
	       LIMIT 1`
		);
		const row = stmt.get(sessionId) as {
			id: string;
			sdk_message: string;
			timestamp: string;
		} | null;
		return row ? this.inflatePersistedMessage(row) : null;
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
       WHERE session_id = ?
         AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') = 'consumed')`
		);
		const result = stmt.get(sessionId) as { count: number };
		return result.count;
	}

	// ============================================================================
	// Message Query Mode operations
	// ============================================================================
	// Message send status types for query mode feature:
	// - 'deferred': Message persisted but not yet consumed to SDK (Manual mode)
	// - 'enqueued': Message in queue waiting to be consumed (during processing)
	// - 'consumed': Message has been yielded to SDK

	/**
	 * Save a user message with explicit send status
	 *
	 * Used by query modes to track message lifecycle:
	 * - Immediate mode: saves with status 'enqueued', then flips to 'consumed'
	 *   when the SDK input generator yields the message
	 * - Auto-queue mode: saves with status 'enqueued' (pending SDK consumption)
	 * - Manual mode: saves with status 'deferred' (until user triggers send)
	 *
	 * @returns The generated message ID
	 */
	saveUserMessage(
		sessionId: string,
		message: SDKMessage,
		sendStatus: SendStatus = 'consumed',
		origin?: MessageOrigin
	): string {
		const id = generateUUID();
		const messageType = message.type;
		const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
		const timestamp = new Date().toISOString();

		const stmt = this.db.prepare(
			`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			sessionId,
			messageType,
			messageSubtype,
			JSON.stringify(message),
			timestamp,
			sendStatus,
			origin ?? null
		);
		return id;
	}

	/**
	 * Get messages by send status for a session
	 *
	 * Used to retrieve:
	 * - 'deferred' messages for manual trigger
	 * - 'enqueued' messages for auto-send on turn_end
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

		return rows.map((row) => this.inflatePersistedMessage(row));
	}

	/**
	 * Look up a single persisted user message by UUID and status.
	 *
	 * This avoids repeatedly loading and parsing every queued/deferred/consumed
	 * message during SDK replay acknowledgment, which is on the hot streaming path.
	 */
	getMessageByStatusAndUuid(
		sessionId: string,
		status: SendStatus,
		uuid: string
	): (SDKMessage & { dbId: string; timestamp: number }) | null {
		const stmt = this.db.prepare(
			`SELECT id, sdk_message, timestamp FROM sdk_messages
	       WHERE session_id = ?
	         AND send_status = ?
	         AND json_extract(sdk_message, '$.uuid') = ?
	       ORDER BY timestamp ASC
	       LIMIT 1`
		);
		const row = stmt.get(sessionId, status, uuid) as {
			id: string;
			sdk_message: string;
			timestamp: string;
		} | null;
		return row ? this.inflatePersistedMessage(row) : null;
	}

	private inflatePersistedMessage(row: {
		id: string;
		sdk_message: string;
		timestamp: string;
	}): SDKMessage & { dbId: string; timestamp: number } {
		return {
			...(JSON.parse(row.sdk_message) as SDKMessage),
			dbId: row.id,
			// DB timestamp (epoch ms) overrides the SDK's ISO string timestamp for persisted messages
			timestamp: new Date(row.timestamp).getTime(),
		} as SDKMessage & { dbId: string; timestamp: number };
	}

	/**
	 * Update send status for messages
	 *
	 * Used to transition messages through the lifecycle:
	 * - 'deferred' -> 'enqueued' (when user triggers manual send)
	 * - 'enqueued' -> 'consumed' (when message is yielded to SDK)
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
	 * Update the timestamp of a message.
	 *
	 * When timestampMs is provided, sets the timestamp to that value (used to
	 * record the moment the SDK generator yielded the message — T_consumed).
	 * Otherwise falls back to the current time.
	 */
	updateMessageTimestamp(messageId: string, timestampMs?: number): void {
		const stmt = this.db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE id = ?`);
		const ts = timestampMs !== undefined ? new Date(timestampMs) : new Date();
		stmt.run(ts.toISOString(), messageId);
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
	 * Get assistant messages from a session since a specific message (by DB row ID).
	 *
	 * Used by Room Runtime to collect Craft output for forwarding to Lead.
	 * - If afterMessageId is null: returns all assistant messages for the session.
	 * - Otherwise: returns messages whose timestamp is after the row with afterMessageId.
	 *
	 * Returns structured objects ready for envelope formatting.
	 */
	getAssistantMessagesSince(
		sessionId: string,
		afterMessageId: string | null
	): Array<{ id: string; text: string; toolCallNames: string[] }> {
		let query: string;
		let params: Array<string>;

		if (afterMessageId) {
			// Get timestamp of the reference message, then fetch messages after it
			query = `
				SELECT id, sdk_message FROM sdk_messages
				WHERE session_id = ?
				  AND message_type = 'assistant'
				  AND timestamp > (
				      SELECT timestamp FROM sdk_messages WHERE id = ?
				  )
				ORDER BY timestamp ASC
			`;
			params = [sessionId, afterMessageId];
		} else {
			query = `
				SELECT id, sdk_message FROM sdk_messages
				WHERE session_id = ? AND message_type = 'assistant'
				ORDER BY timestamp ASC
			`;
			params = [sessionId];
		}

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Array<{ id: string; sdk_message: string }>;

		return rows.map((row) => {
			const msg = JSON.parse(row.sdk_message) as Record<string, unknown>;
			const text = this.extractAssistantText(msg);
			const toolCallNames = this.extractToolCallNames(msg);
			return { id: row.id, text, toolCallNames };
		});
	}

	private extractAssistantText(msg: Record<string, unknown>): string {
		const parts: string[] = [];
		const message = msg.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'text' && typeof block.text === 'string') {
					parts.push(block.text);
				}
			}
		} else if (typeof content === 'string') {
			parts.push(content);
		}
		// Also capture result text from SDK result messages
		if (msg.type === 'result' && typeof msg.result === 'string') {
			parts.push(msg.result);
		}
		return parts.join('\n\n').trim();
	}

	private extractToolCallNames(msg: Record<string, unknown>): string[] {
		const names: string[] = [];
		const message = msg.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'tool_use' && typeof block.name === 'string') {
					names.push(block.name);
				}
			}
		}
		return names;
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

	// ============================================================================
	// NeoKai action messages (interactive prompts stored in the chat timeline)
	// ============================================================================

	/**
	 * Save a NeoKai-native action message to the sdk_messages table.
	 *
	 * The message is stored in the same `sdk_message` JSON column as SDK messages,
	 * but with `message_type = 'neokai_action'` so it can be distinguished during
	 * fetch.  No `send_status` is needed because action messages are never queued.
	 *
	 * @returns The generated row ID (used later to update the resolved state).
	 */
	saveNeokaiActionMessage(sessionId: string, message: NeokaiActionMessage): string {
		const id = generateUUID();
		const timestamp = new Date(message.timestamp).toISOString();

		const stmt = this.db.prepare(
			`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
		);

		stmt.run(id, sessionId, 'neokai_action', message.action, JSON.stringify(message), timestamp);
		return id;
	}

	/**
	 * Update a NeoKai action message in-place (e.g. mark it resolved after the
	 * user has made a choice).
	 *
	 * @param rowId   The ID returned by saveNeokaiActionMessage.
	 * @param updated The full updated message object (replaces the stored JSON).
	 */
	updateNeokaiActionMessage(rowId: string, updated: NeokaiActionMessage): void {
		const stmt = this.db.prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`);
		stmt.run(JSON.stringify(updated), rowId);
	}

	/**
	 * Update a NeoKai action message by its uuid field (stored inside the JSON blob).
	 *
	 * This avoids having to carry the row ID through the RPC call.  The uuid is
	 * unique per session (generated at emit time) so the lookup is unambiguous.
	 */
	updateNeokaiActionMessageByUuid(
		sessionId: string,
		messageUuid: string,
		updated: NeokaiActionMessage
	): void {
		const stmt = this.db.prepare(
			`UPDATE sdk_messages SET sdk_message = ?
       WHERE session_id = ?
         AND message_type = 'neokai_action'
         AND json_extract(sdk_message, '$.uuid') = ?`
		);
		stmt.run(JSON.stringify(updated), sessionId, messageUuid);
	}
}
