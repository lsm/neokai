/**
 * Task Repository
 *
 * Repository for Neo task CRUD operations.
 * Extracted from neo-db.ts for better organization.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { NeoTask, TaskFilter, CreateTaskParams, UpdateTaskParams } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class TaskRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new task
	 */
	createTask(params: CreateTaskParams): NeoTask {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, session_id, status, priority, depends_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			params.title,
			params.description,
			null,
			'pending',
			params.priority ?? 'normal',
			JSON.stringify(params.dependsOn ?? []),
			now
		);

		return this.getTask(id)!;
	}

	/**
	 * Get a task by ID
	 */
	getTask(id: string): NeoTask | null {
		const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToTask(row);
	}

	/**
	 * List tasks for a room, optionally filtered
	 */
	listTasks(roomId: string, filter?: TaskFilter): NeoTask[] {
		let query = `SELECT * FROM tasks WHERE room_id = ?`;
		const params: SQLiteValue[] = [roomId];

		if (filter?.status) {
			query += ` AND status = ?`;
			params.push(filter.status);
		}
		if (filter?.priority) {
			query += ` AND priority = ?`;
			params.push(filter.priority);
		}
		if (filter?.sessionId) {
			query += ` AND session_id = ?`;
			params.push(filter.sessionId);
		}

		query += ` ORDER BY created_at DESC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToTask(r));
	}

	/**
	 * Update a task with partial updates
	 */
	updateTask(id: string, params: UpdateTaskParams): NeoTask | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.title !== undefined) {
			fields.push('title = ?');
			values.push(params.title);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description);
		}
		if (params.sessionId !== undefined) {
			fields.push('session_id = ?');
			values.push(params.sessionId ?? null);
		}
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);

			// Update timestamps based on status
			if (params.status === 'in_progress') {
				fields.push('started_at = ?');
				values.push(Date.now());
			} else if (params.status === 'completed' || params.status === 'failed') {
				fields.push('completed_at = ?');
				values.push(Date.now());
			}
		}
		if (params.priority !== undefined) {
			fields.push('priority = ?');
			values.push(params.priority);
		}
		if (params.progress !== undefined) {
			fields.push('progress = ?');
			values.push(params.progress);
		}
		if (params.currentStep !== undefined) {
			fields.push('current_step = ?');
			values.push(params.currentStep ?? null);
		}
		if (params.result !== undefined) {
			fields.push('result = ?');
			values.push(params.result ?? null);
		}
		if (params.error !== undefined) {
			fields.push('error = ?');
			values.push(params.error ?? null);
		}
		if (params.dependsOn !== undefined) {
			fields.push('depends_on = ?');
			values.push(JSON.stringify(params.dependsOn));
		}

		if (fields.length > 0) {
			values.push(id);
			const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
		}

		return this.getTask(id);
	}

	/**
	 * Delete a task by ID
	 */
	deleteTask(id: string): void {
		const stmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
		stmt.run(id);
	}

	/**
	 * Delete all tasks for a room
	 */
	deleteTasksForRoom(roomId: string): void {
		const stmt = this.db.prepare(`DELETE FROM tasks WHERE room_id = ?`);
		stmt.run(roomId);
	}

	/**
	 * Count tasks for a room by status
	 */
	countTasksByStatus(roomId: string, status: string): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM tasks WHERE room_id = ? AND status = ?`
		);
		const result = stmt.get(roomId, status) as { count: number };
		return result.count;
	}

	/**
	 * Count all active (non-completed, non-failed) tasks for a room
	 */
	countActiveTasks(roomId: string): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM tasks WHERE room_id = ? AND status NOT IN ('completed', 'failed')`
		);
		const result = stmt.get(roomId) as { count: number };
		return result.count;
	}

	/**
	 * Convert a database row to a NeoTask object
	 */
	private rowToTask(row: Record<string, unknown>): NeoTask {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			title: row.title as string,
			description: row.description as string,
			sessionId: (row.session_id as string | null) ?? undefined,
			status: row.status as NeoTask['status'],
			priority: row.priority as NeoTask['priority'],
			progress: (row.progress as number | null) ?? undefined,
			currentStep: (row.current_step as string | null) ?? undefined,
			result: (row.result as string | null) ?? undefined,
			error: (row.error as string | null) ?? undefined,
			dependsOn: JSON.parse(row.depends_on as string) as string[],
			createdAt: row.created_at as number,
			startedAt: (row.started_at as number | null) ?? undefined,
			completedAt: (row.completed_at as number | null) ?? undefined,
		};
	}
}
