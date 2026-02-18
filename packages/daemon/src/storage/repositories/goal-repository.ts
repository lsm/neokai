/**
 * Goal Repository
 *
 * Repository for room goal CRUD operations.
 * Goals track structured objectives for rooms with progress aggregation from linked tasks.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { RoomGoal, GoalStatus, GoalPriority } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export interface CreateGoalParams {
	roomId: string;
	title: string;
	description?: string;
	priority?: GoalPriority;
}

export interface UpdateGoalParams {
	title?: string;
	description?: string;
	status?: GoalStatus;
	priority?: GoalPriority;
	progress?: number;
	linkedTaskIds?: string[];
	metrics?: Record<string, number>;
}

export class GoalRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new goal
	 */
	createGoal(params: CreateGoalParams): RoomGoal {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			params.title,
			params.description ?? '',
			'pending',
			params.priority ?? 'normal',
			0,
			'[]',
			'{}',
			now,
			now
		);

		return this.getGoal(id)!;
	}

	/**
	 * Get a goal by ID
	 */
	getGoal(id: string): RoomGoal | null {
		const stmt = this.db.prepare(`SELECT * FROM goals WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToGoal(row);
	}

	/**
	 * List goals for a room
	 */
	listGoals(roomId: string, status?: GoalStatus): RoomGoal[] {
		let query = `SELECT * FROM goals WHERE room_id = ?`;
		const params: SQLiteValue[] = [roomId];

		if (status) {
			query += ` AND status = ?`;
			params.push(status);
		}

		query += ` ORDER BY priority DESC, created_at ASC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToGoal(r));
	}

	/**
	 * Update a goal with partial updates
	 */
	updateGoal(id: string, params: UpdateGoalParams): RoomGoal | null {
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
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);

			// Set completed_at when status changes to completed
			if (params.status === 'completed') {
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
		if (params.linkedTaskIds !== undefined) {
			fields.push('linked_task_ids = ?');
			values.push(JSON.stringify(params.linkedTaskIds));
		}
		if (params.metrics !== undefined) {
			fields.push('metrics = ?');
			values.push(JSON.stringify(params.metrics));
		}

		if (fields.length === 0) {
			return this.getGoal(id);
		}

		// Always update updated_at
		fields.push('updated_at = ?');
		values.push(Date.now());

		values.push(id);

		const stmt = this.db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`);
		stmt.run(...values);

		return this.getGoal(id);
	}

	/**
	 * Delete a goal
	 */
	deleteGoal(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM goals WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Link a task to a goal
	 */
	linkTaskToGoal(goalId: string, taskId: string): RoomGoal | null {
		const goal = this.getGoal(goalId);
		if (!goal) return null;

		const linkedTaskIds = [...new Set([...goal.linkedTaskIds, taskId])];
		return this.updateGoal(goalId, { linkedTaskIds });
	}

	/**
	 * Unlink a task from a goal
	 */
	unlinkTaskFromGoal(goalId: string, taskId: string): RoomGoal | null {
		const goal = this.getGoal(goalId);
		if (!goal) return null;

		const linkedTaskIds = goal.linkedTaskIds.filter((id) => id !== taskId);
		return this.updateGoal(goalId, { linkedTaskIds });
	}

	/**
	 * Get goals that have a specific task linked
	 */
	getGoalsForTask(taskId: string): RoomGoal[] {
		const stmt = this.db.prepare(
			`SELECT * FROM goals WHERE linked_task_ids LIKE ? ORDER BY created_at ASC`
		);
		const rows = stmt.all(`%"${taskId}"%`) as Record<string, unknown>[];
		return rows.map((r) => this.rowToGoal(r));
	}

	/**
	 * Get active goal count for a room
	 */
	getActiveGoalCount(roomId: string): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM goals WHERE room_id = ? AND status IN ('pending', 'in_progress')`
		);
		const row = stmt.get(roomId) as { count: number } | undefined;
		return row?.count ?? 0;
	}

	/**
	 * Convert a database row to a RoomGoal object
	 */
	private rowToGoal(row: Record<string, unknown>): RoomGoal {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			title: row.title as string,
			description: row.description as string,
			status: row.status as GoalStatus,
			priority: row.priority as GoalPriority,
			progress: row.progress as number,
			linkedTaskIds: JSON.parse(row.linked_task_ids as string) as string[],
			metrics: JSON.parse(row.metrics as string) as Record<string, number>,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			completedAt: row.completed_at as number | undefined,
		};
	}
}
