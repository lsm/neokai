/**
 * Worker Session Repository
 *
 * Repository for worker session tracking CRUD operations.
 * Manages the relationship between workers and tasks within rooms.
 *
 * CRITICAL FIXES APPLIED (v1.0):
 * - FIX 2: room_session_id is mode-agnostic (not hardcoded to room_self)
 * - FIX 3: session_id column added for direct agent session lookup
 * - FIX 3: getWorkerBySessionId() fully implemented (not null placeholder)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { WorkerSession, WorkerStatus } from '@neokai/shared';

/**
 * Data for creating a new worker session tracking record
 */
export interface CreateWorkerSessionData {
	id: string;
	roomId: string;
	roomSessionId: string; // FIX 2: Mode-agnostic (was roomSelfSessionId)
	sessionId: string; // FIX 3: The actual agent session ID
	roomSessionType: 'room_chat' | 'room_self'; // FIX 2: Discriminator
	taskId: string;
	status: WorkerStatus;
	createdAt: number;
	updatedAt: number;
}

export class WorkerSessionRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new worker session tracking record
	 */
	createWorkerSession(data: CreateWorkerSessionData): WorkerSession {
		const stmt = this.db.prepare(`
			INSERT INTO worker_sessions (id, session_id, room_id, room_session_id, room_session_type, task_id, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			data.id,
			data.sessionId, // FIX 3
			data.roomId,
			data.roomSessionId, // FIX 2
			data.roomSessionType, // FIX 2
			data.taskId,
			data.status,
			data.createdAt,
			data.updatedAt
		);
		return this.getWorkerSession(data.id)!;
	}

	/**
	 * Get a worker session by tracking ID
	 */
	getWorkerSession(id: string): WorkerSession | null {
		const stmt = this.db.prepare(`SELECT * FROM worker_sessions WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToWorker(row) : null;
	}

	/**
	 * Get a worker session by agent session ID - FIX 3: Fully implemented
	 *
	 * This allows looking up worker metadata when you have the session ID.
	 * Essential for session lifecycle management and event handling.
	 */
	getWorkerBySessionId(sessionId: string): WorkerSession | null {
		const stmt = this.db.prepare(`SELECT * FROM worker_sessions WHERE session_id = ?`);
		const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
		return row ? this.rowToWorker(row) : null;
	}

	/**
	 * Get a worker session by task ID
	 */
	getWorkerByTask(taskId: string): WorkerSession | null {
		const stmt = this.db.prepare(`SELECT * FROM worker_sessions WHERE task_id = ?`);
		const row = stmt.get(taskId) as Record<string, unknown> | undefined;
		return row ? this.rowToWorker(row) : null;
	}

	/**
	 * Get an active worker session by task ID (not completed/failed)
	 * Returns null if no active worker exists for the task
	 */
	getActiveWorkerByTask(taskId: string): WorkerSession | null {
		const stmt = this.db.prepare(`
			SELECT * FROM worker_sessions
			WHERE task_id = ? AND status IN ('starting', 'running', 'waiting_for_review')
		`);
		const row = stmt.get(taskId) as Record<string, unknown> | undefined;
		return row ? this.rowToWorker(row) : null;
	}

	/**
	 * Get all worker sessions for a room
	 */
	getWorkersByRoom(roomId: string): WorkerSession[] {
		const stmt = this.db.prepare(
			`SELECT * FROM worker_sessions WHERE room_id = ? ORDER BY created_at DESC`
		);
		const rows = stmt.all(roomId) as Record<string, unknown>[];
		return rows.map((row) => this.rowToWorker(row));
	}

	/**
	 * Get all worker sessions for a specific room agent session - FIX 2
	 *
	 * Replaces getWorkersByRoomSelf() with mode-agnostic version
	 */
	getWorkersByRoomSession(roomSessionId: string): WorkerSession[] {
		const stmt = this.db.prepare(
			`SELECT * FROM worker_sessions WHERE room_session_id = ? ORDER BY created_at DESC`
		);
		const rows = stmt.all(roomSessionId) as Record<string, unknown>[];
		return rows.map((row) => this.rowToWorker(row));
	}

	/**
	 * Update the status of a worker session by tracking ID
	 */
	updateWorkerStatus(id: string, status: WorkerStatus): WorkerSession | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE worker_sessions SET status = ?, updated_at = ? WHERE id = ?`
		);
		const result = stmt.run(status, now, id);
		if (result.changes === 0) return null;
		return this.getWorkerSession(id);
	}

	/**
	 * Update worker status by session ID - FIX 3
	 *
	 * Allows updating worker status when you have the agent session ID
	 * rather than the tracking record ID.
	 */
	updateWorkerStatusBySessionId(sessionId: string, status: WorkerStatus): WorkerSession | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE worker_sessions SET status = ?, updated_at = ? WHERE session_id = ?`
		);
		const result = stmt.run(status, now, sessionId);
		if (result.changes === 0) return null;
		return this.getWorkerBySessionId(sessionId);
	}

	/**
	 * Complete a worker session
	 */
	completeWorkerSession(id: string): WorkerSession | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE worker_sessions SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?`
		);
		const result = stmt.run(now, now, id);
		if (result.changes === 0) return null;
		return this.getWorkerSession(id);
	}

	/**
	 * Complete worker session by session ID - FIX 3
	 */
	completeWorkerSessionBySessionId(sessionId: string): WorkerSession | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE worker_sessions SET status = 'completed', updated_at = ?, completed_at = ? WHERE session_id = ?`
		);
		const result = stmt.run(now, now, sessionId);
		if (result.changes === 0) return null;
		return this.getWorkerBySessionId(sessionId);
	}

	/**
	 * Delete a worker session tracking record
	 */
	deleteWorkerSession(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM worker_sessions WHERE id = ?`);
		return stmt.run(id).changes > 0;
	}

	/**
	 * Convert a database row to a WorkerSession object - FIX 2 & 3 applied
	 */
	private rowToWorker(row: Record<string, unknown>): WorkerSession {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			roomSessionId: row.room_session_id as string, // FIX 2
			sessionId: row.session_id as string, // FIX 3
			roomSessionType: row.room_session_type as 'room_chat' | 'room_self', // FIX 2
			taskId: row.task_id as string,
			status: row.status as WorkerStatus,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			completedAt: row.completed_at as number | undefined,
		};
	}
}
