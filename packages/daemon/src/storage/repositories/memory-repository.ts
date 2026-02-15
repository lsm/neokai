/**
 * Memory Repository
 *
 * Repository for Neo memory CRUD operations.
 * Extracted from neo-db.ts for better organization.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { NeoMemory, CreateMemoryParams } from '@neokai/shared';

export class MemoryRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new memory
	 */
	createMemory(params: CreateMemoryParams): NeoMemory {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO memories (id, room_id, type, content, tags, importance, session_id, task_id, created_at, last_accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			params.type,
			params.content,
			JSON.stringify(params.tags ?? []),
			params.importance ?? 'normal',
			params.sessionId ?? null,
			params.taskId ?? null,
			now,
			now,
			0
		);

		return this.getMemory(id)!;
	}

	/**
	 * Get a memory by ID
	 */
	getMemory(id: string): NeoMemory | null {
		const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToMemory(row);
	}

	/**
	 * List memories for a room, optionally filtered by type
	 */
	listMemories(roomId: string, type?: string): NeoMemory[] {
		let query = `SELECT * FROM memories WHERE room_id = ?`;
		const params: (string | number)[] = [roomId];

		if (type) {
			query += ` AND type = ?`;
			params.push(type);
		}

		query += ` ORDER BY created_at DESC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToMemory(r));
	}

	/**
	 * Update access timestamp and increment count
	 */
	touchMemory(id: string): void {
		const stmt = this.db.prepare(
			`UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`
		);
		stmt.run(Date.now(), id);
	}

	/**
	 * Delete a memory by ID
	 */
	deleteMemory(id: string): void {
		const stmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
		stmt.run(id);
	}

	/**
	 * Delete all memories for a room
	 */
	deleteMemoriesForRoom(roomId: string): void {
		const stmt = this.db.prepare(`DELETE FROM memories WHERE room_id = ?`);
		stmt.run(roomId);
	}

	/**
	 * Count memories for a room
	 */
	countMemories(roomId: string): number {
		const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM memories WHERE room_id = ?`);
		const result = stmt.get(roomId) as { count: number };
		return result.count;
	}

	/**
	 * Convert a database row to a NeoMemory object
	 */
	private rowToMemory(row: Record<string, unknown>): NeoMemory {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			type: row.type as NeoMemory['type'],
			content: row.content as string,
			tags: JSON.parse(row.tags as string) as string[],
			importance: row.importance as NeoMemory['importance'],
			sessionId: (row.session_id as string | null) ?? undefined,
			taskId: (row.task_id as string | null) ?? undefined,
			createdAt: row.created_at as number,
			lastAccessedAt: row.last_accessed_at as number,
			accessCount: row.access_count as number,
		};
	}
}
