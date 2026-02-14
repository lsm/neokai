/**
 * MemoryManager - Memory system with room tagging and retrieval
 *
 * Handles:
 * - Adding memories with room tags
 * - Recalling memories by type/tags
 * - Searching memories by content
 * - Recording access statistics
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { NeoMemoryRepository } from '../../storage/repositories/memory-repository';
import type { NeoMemory, MemoryType, MemoryImportance } from '@neokai/shared';

export class MemoryManager {
	private memoryRepo: NeoMemoryRepository;

	constructor(
		private db: BunDatabase,
		private roomId: string
	) {
		this.memoryRepo = new NeoMemoryRepository(db);
	}

	/**
	 * Add memory with room tag
	 */
	async addMemory(params: {
		type: MemoryType;
		content: string;
		tags?: string[];
		importance?: MemoryImportance;
		sessionId?: string;
		taskId?: string;
	}): Promise<NeoMemory> {
		const memory = this.memoryRepo.createMemory({
			roomId: this.roomId,
			type: params.type,
			content: params.content,
			tags: params.tags,
			importance: params.importance,
			sessionId: params.sessionId,
			taskId: params.taskId,
		});

		return memory;
	}

	/**
	 * Recall memories matching query
	 */
	async recallMemories(query: {
		type?: MemoryType;
		tags?: string[];
		limit?: number;
	}): Promise<NeoMemory[]> {
		let sql = `SELECT * FROM neo_memories WHERE room_id = ?`;
		const params: (string | number)[] = [this.roomId];

		if (query.type) {
			sql += ` AND type = ?`;
			params.push(query.type);
		}

		if (query.tags && query.tags.length > 0) {
			// Simple JSON array contains check using LIKE
			for (const tag of query.tags) {
				sql += ` AND tags LIKE ?`;
				params.push(`%"${tag}"%`);
			}
		}

		sql += ` ORDER BY importance DESC, created_at DESC`;

		if (query.limit) {
			sql += ` LIMIT ?`;
			params.push(query.limit);
		}

		const stmt = this.db.prepare(sql);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		return rows.map((row) => this.rowToMemory(row));
	}

	/**
	 * Search memories by content (simple LIKE for now)
	 */
	async searchMemories(searchTerm: string, limit?: number): Promise<NeoMemory[]> {
		let sql = `SELECT * FROM neo_memories WHERE room_id = ? AND content LIKE ?`;
		const params: (string | number)[] = [this.roomId, `%${searchTerm}%`];

		sql += ` ORDER BY importance DESC, last_accessed_at DESC`;

		if (limit) {
			sql += ` LIMIT ?`;
			params.push(limit);
		}

		const stmt = this.db.prepare(sql);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		const memories = rows.map((row) => this.rowToMemory(row));

		// Record access for each returned memory
		for (const memory of memories) {
			await this.recordAccess(memory.id);
		}

		return memories;
	}

	/**
	 * Get a specific memory by ID
	 */
	async getMemory(memoryId: string): Promise<NeoMemory | null> {
		const memory = this.memoryRepo.getMemory(memoryId);
		if (memory && memory.roomId === this.roomId) {
			return memory;
		}
		return null;
	}

	/**
	 * Record access (updates last_accessed_at, access_count)
	 */
	async recordAccess(memoryId: string): Promise<void> {
		this.memoryRepo.touchMemory(memoryId);
	}

	/**
	 * Delete a memory
	 */
	async deleteMemory(memoryId: string): Promise<boolean> {
		const memory = await this.getMemory(memoryId);
		if (!memory) {
			return false;
		}

		this.memoryRepo.deleteMemory(memoryId);
		return true;
	}

	/**
	 * Get memory count for room
	 */
	async getMemoryCount(): Promise<number> {
		return this.memoryRepo.countMemories(this.roomId);
	}

	/**
	 * List all memories for room
	 */
	async listMemories(type?: MemoryType): Promise<NeoMemory[]> {
		return this.memoryRepo.listMemories(this.roomId, type);
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
