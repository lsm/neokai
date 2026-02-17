/**
 * Session Pair Repository
 *
 * Repository for session pair CRUD operations.
 * Manages the relationship between Manager and Worker sessions within a Room.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { SessionPair, SessionPairStatus } from '@neokai/shared';

export interface CreatePairData {
	id: string;
	roomId: string;
	roomSessionId: string;
	managerSessionId: string;
	workerSessionId: string;
	currentTaskId?: string;
}

export class SessionPairRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new session pair
	 */
	createPair(data: CreatePairData): SessionPair {
		const now = Date.now();
		const stmt = this.db.prepare(`
			INSERT INTO session_pairs (id, room_id, room_session_id, manager_session_id, worker_session_id, status, current_task_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
		`);
		stmt.run(
			data.id,
			data.roomId,
			data.roomSessionId,
			data.managerSessionId,
			data.workerSessionId,
			data.currentTaskId ?? null,
			now,
			now
		);
		return this.getPair(data.id)!;
	}

	/**
	 * Get a session pair by ID
	 */
	getPair(id: string): SessionPair | null {
		const stmt = this.db.prepare(`SELECT * FROM session_pairs WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToPair(row) : null;
	}

	/**
	 * Get all session pairs for a room
	 */
	getPairsByRoom(roomId: string): SessionPair[] {
		const stmt = this.db.prepare(
			`SELECT * FROM session_pairs WHERE room_id = ? ORDER BY created_at DESC`
		);
		const rows = stmt.all(roomId) as Record<string, unknown>[];
		return rows.map((row) => this.rowToPair(row));
	}

	/**
	 * Get a session pair by manager session ID
	 */
	getPairByManagerSession(managerSessionId: string): SessionPair | null {
		const stmt = this.db.prepare(`SELECT * FROM session_pairs WHERE manager_session_id = ?`);
		const row = stmt.get(managerSessionId) as Record<string, unknown> | undefined;
		return row ? this.rowToPair(row) : null;
	}

	/**
	 * Get a session pair by worker session ID
	 */
	getPairByWorkerSession(workerSessionId: string): SessionPair | null {
		const stmt = this.db.prepare(`SELECT * FROM session_pairs WHERE worker_session_id = ?`);
		const row = stmt.get(workerSessionId) as Record<string, unknown> | undefined;
		return row ? this.rowToPair(row) : null;
	}

	/**
	 * Get a session pair by either manager or worker session ID
	 */
	getPairBySession(sessionId: string): SessionPair | null {
		const byManager = this.getPairByManagerSession(sessionId);
		if (byManager) return byManager;
		return this.getPairByWorkerSession(sessionId);
	}

	/**
	 * Update the status of a session pair
	 */
	updatePairStatus(id: string, status: SessionPairStatus): SessionPair | null {
		const now = Date.now();
		const stmt = this.db.prepare(`
			UPDATE session_pairs SET status = ?, updated_at = ? WHERE id = ?
		`);
		const result = stmt.run(status, now, id);
		if (result.changes === 0) return null;
		return this.getPair(id);
	}

	/**
	 * Update the current task of a session pair
	 */
	updatePairTask(id: string, taskId: string | undefined): SessionPair | null {
		const now = Date.now();
		const stmt = this.db.prepare(`
			UPDATE session_pairs SET current_task_id = ?, updated_at = ? WHERE id = ?
		`);
		const result = stmt.run(taskId ?? null, now, id);
		if (result.changes === 0) return null;
		return this.getPair(id);
	}

	/**
	 * Delete a session pair by ID
	 */
	deletePair(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM session_pairs WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Convert a database row to a SessionPair object
	 */
	private rowToPair(row: Record<string, unknown>): SessionPair {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			roomSessionId: row.room_session_id as string,
			managerSessionId: row.manager_session_id as string,
			workerSessionId: row.worker_session_id as string,
			status: row.status as SessionPairStatus,
			currentTaskId: (row.current_task_id as string | null) ?? undefined,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
