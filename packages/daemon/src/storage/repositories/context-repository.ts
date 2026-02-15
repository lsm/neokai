/**
 * Context Repository
 *
 * Repository for Neo context and context message CRUD operations.
 * Extracted from neo-db.ts for better organization.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { NeoContext, NeoContextMessage } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class ContextRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new context for a room
	 */
	createContext(roomId: string): NeoContext {
		const id = generateUUID();

		const stmt = this.db.prepare(
			`INSERT INTO contexts (id, room_id, total_tokens, status)
       VALUES (?, ?, 0, 'idle')`
		);

		stmt.run(id, roomId);

		return this.getContext(id)!;
	}

	/**
	 * Get a context by ID
	 */
	getContext(id: string): NeoContext | null {
		const stmt = this.db.prepare(`SELECT * FROM contexts WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToContext(row);
	}

	/**
	 * Get the context for a room
	 */
	getContextForRoom(roomId: string): NeoContext | null {
		const stmt = this.db.prepare(`SELECT * FROM contexts WHERE room_id = ?`);
		const row = stmt.get(roomId) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToContext(row);
	}

	/**
	 * Update context status and related fields
	 */
	updateContext(
		id: string,
		params: {
			status?: NeoContext['status'];
			totalTokens?: number;
			currentTaskId?: string | null;
			currentSessionId?: string | null;
			lastCompactedAt?: number;
		}
	): NeoContext | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
		}
		if (params.totalTokens !== undefined) {
			fields.push('total_tokens = ?');
			values.push(params.totalTokens);
		}
		if (params.currentTaskId !== undefined) {
			fields.push('current_task_id = ?');
			values.push(params.currentTaskId ?? null);
		}
		if (params.currentSessionId !== undefined) {
			fields.push('current_session_id = ?');
			values.push(params.currentSessionId ?? null);
		}
		if (params.lastCompactedAt !== undefined) {
			fields.push('last_compacted_at = ?');
			values.push(params.lastCompactedAt);
		}

		if (fields.length > 0) {
			values.push(id);
			const stmt = this.db.prepare(`UPDATE contexts SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
		}

		return this.getContext(id);
	}

	/**
	 * Add a message to a context
	 */
	addMessage(
		contextId: string,
		role: NeoContextMessage['role'],
		content: string,
		tokenCount: number,
		sessionId?: string,
		taskId?: string
	): NeoContextMessage {
		const id = generateUUID();
		const timestamp = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO context_messages (id, context_id, role, content, timestamp, token_count, session_id, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			contextId,
			role,
			content,
			timestamp,
			tokenCount,
			sessionId ?? null,
			taskId ?? null
		);

		// Update total tokens in context
		this.db
			.prepare(`UPDATE contexts SET total_tokens = total_tokens + ? WHERE id = ?`)
			.run(tokenCount, contextId);

		return this.getMessage(id)!;
	}

	/**
	 * Get a message by ID
	 */
	getMessage(id: string): NeoContextMessage | null {
		const stmt = this.db.prepare(`SELECT * FROM context_messages WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToMessage(row);
	}

	/**
	 * Get all messages for a context
	 */
	getMessages(contextId: string): NeoContextMessage[] {
		const stmt = this.db.prepare(
			`SELECT * FROM context_messages WHERE context_id = ? ORDER BY timestamp ASC`
		);
		const rows = stmt.all(contextId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToMessage(r));
	}

	/**
	 * Delete messages after a specific timestamp (for compaction)
	 */
	deleteMessagesAfter(contextId: string, timestamp: number): number {
		const stmt = this.db.prepare(
			`DELETE FROM context_messages WHERE context_id = ? AND timestamp > ?`
		);
		const result = stmt.run(contextId, timestamp);
		return result.changes;
	}

	/**
	 * Delete a context and all its messages
	 */
	deleteContext(id: string): void {
		const stmt = this.db.prepare(`DELETE FROM contexts WHERE id = ?`);
		stmt.run(id);
	}

	/**
	 * Convert a database row to a NeoContext object
	 */
	private rowToContext(row: Record<string, unknown>): NeoContext {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			totalTokens: row.total_tokens as number,
			lastCompactedAt: (row.last_compacted_at as number | null) ?? undefined,
			status: row.status as NeoContext['status'],
			currentTaskId: (row.current_task_id as string | null) ?? undefined,
			currentSessionId: (row.current_session_id as string | null) ?? undefined,
		};
	}

	/**
	 * Convert a database row to a NeoContextMessage object
	 */
	private rowToMessage(row: Record<string, unknown>): NeoContextMessage {
		return {
			id: row.id as string,
			contextId: row.context_id as string,
			role: row.role as NeoContextMessage['role'],
			content: row.content as string,
			timestamp: row.timestamp as number,
			tokenCount: row.token_count as number,
			sessionId: (row.session_id as string | null) ?? undefined,
			taskId: (row.task_id as string | null) ?? undefined,
		};
	}
}
