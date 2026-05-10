/**
 * TaskScheduleRepository — CRUD for the `task_schedules` table.
 *
 * Schedules are immutable after creation except through the explicit mutation
 * methods (update, updateStatus, updateAfterFire, updatePendingJobId).
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	TaskSchedule,
	TaskScheduleStatus,
	TaskScheduleTriggerType,
	SpaceTaskPriority,
} from '@neokai/shared';

export interface CreateTaskScheduleParams {
	spaceId: string;
	title: string;
	description?: string;
	priority?: SpaceTaskPriority;
	preferredWorkflowId?: string | null;
	labels?: string[];
	triggerType: TaskScheduleTriggerType;
	cronExpression?: string | null;
	runAt?: number | null;
	timezone?: string;
	nextRunAt?: number | null;
	createdByAgent?: string | null;
	createdBySession?: string | null;
}

export interface UpdateTaskScheduleParams {
	title?: string;
	description?: string;
	priority?: SpaceTaskPriority;
	preferredWorkflowId?: string | null;
	labels?: string[];
	cronExpression?: string | null;
	runAt?: number | null;
	timezone?: string;
	nextRunAt?: number | null;
}

export class TaskScheduleRepository {
	constructor(private db: BunDatabase) {}

	// ─── Create ──────────────────────────────────────────────────────────────────

	create(params: CreateTaskScheduleParams): TaskSchedule {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO task_schedules (
					id, space_id, title, description, priority, preferred_workflow_id,
					labels, trigger_type, cron_expression, run_at, timezone,
					next_run_at, last_run_at, last_created_task_id, pending_job_id,
					status, created_by_agent, created_by_session, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.title,
				params.description ?? '',
				params.priority ?? 'normal',
				params.preferredWorkflowId ?? null,
				JSON.stringify(params.labels ?? []),
				params.triggerType,
				params.cronExpression ?? null,
				params.runAt ?? null,
				params.timezone ?? 'UTC',
				params.nextRunAt ?? null,
				null, // last_run_at
				null, // last_created_task_id
				null, // pending_job_id
				'active',
				params.createdByAgent ?? null,
				params.createdBySession ?? null,
				now,
				now
			);

		return this.getById(id)!;
	}

	// ─── Read ─────────────────────────────────────────────────────────────────────

	getById(id: string): TaskSchedule | null {
		const row = this.db.prepare(`SELECT * FROM task_schedules WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.rowToSchedule(row) : null;
	}

	listBySpace(spaceId: string, status?: TaskScheduleStatus): TaskSchedule[] {
		let query = `SELECT * FROM task_schedules WHERE space_id = ?`;
		const params: (string | number)[] = [spaceId];
		if (status !== undefined) {
			query += ` AND status = ?`;
			params.push(status);
		}
		query += ` ORDER BY created_at DESC`;
		const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSchedule(r));
	}

	/**
	 * List active schedules whose nextRunAt <= now.
	 * Used for startup re-seeding to recover lost jobs.
	 */
	listActiveDue(now: number, limit = 100): TaskSchedule[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM task_schedules
				 WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
				 ORDER BY next_run_at ASC
				 LIMIT ?`
			)
			.all(now, limit) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSchedule(r));
	}

	/**
	 * List active schedules with a pendingJobId set.
	 * Used during startup to verify pending jobs still exist.
	 */
	listActiveWithPendingJob(): TaskSchedule[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM task_schedules
				 WHERE status = 'active' AND pending_job_id IS NOT NULL`
			)
			.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToSchedule(r));
	}

	// ─── Update ───────────────────────────────────────────────────────────────────

	update(id: string, params: UpdateTaskScheduleParams): TaskSchedule | null {
		const now = Date.now();
		const sets: string[] = ['updated_at = ?'];
		const values: (string | number | null)[] = [now];

		if (params.title !== undefined) {
			sets.push('title = ?');
			values.push(params.title);
		}
		if (params.description !== undefined) {
			sets.push('description = ?');
			values.push(params.description);
		}
		if (params.priority !== undefined) {
			sets.push('priority = ?');
			values.push(params.priority);
		}
		if ('preferredWorkflowId' in params) {
			sets.push('preferred_workflow_id = ?');
			values.push(params.preferredWorkflowId ?? null);
		}
		if (params.labels !== undefined) {
			sets.push('labels = ?');
			values.push(JSON.stringify(params.labels));
		}
		if ('cronExpression' in params) {
			sets.push('cron_expression = ?');
			values.push(params.cronExpression ?? null);
		}
		if ('runAt' in params) {
			sets.push('run_at = ?');
			values.push(params.runAt ?? null);
		}
		if (params.timezone !== undefined) {
			sets.push('timezone = ?');
			values.push(params.timezone);
		}
		if ('nextRunAt' in params) {
			sets.push('next_run_at = ?');
			values.push(params.nextRunAt ?? null);
		}

		if (sets.length === 1) return this.getById(id); // nothing changed

		values.push(id);
		this.db.prepare(`UPDATE task_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
		return this.getById(id);
	}

	/** Update the pending job ID (called after each enqueue / cancel). */
	updatePendingJobId(id: string, pendingJobId: string | null): void {
		this.db
			.prepare(`UPDATE task_schedules SET pending_job_id = ?, updated_at = ? WHERE id = ?`)
			.run(pendingJobId, Date.now(), id);
	}

	/** Update status (active / paused / completed). */
	updateStatus(id: string, status: TaskScheduleStatus): void {
		this.db
			.prepare(`UPDATE task_schedules SET status = ?, updated_at = ? WHERE id = ?`)
			.run(status, Date.now(), id);
	}

	/**
	 * Called after a schedule fires — records last fire time, the created task ID,
	 * updates nextRunAt, and optionally marks as completed (for 'at' triggers).
	 */
	updateAfterFire(
		id: string,
		opts: {
			lastCreatedTaskId: string;
			lastRunAt: number;
			nextRunAt: number | null;
			status: TaskScheduleStatus;
			pendingJobId: string | null;
		}
	): void {
		this.db
			.prepare(
				`UPDATE task_schedules
				 SET last_created_task_id = ?, last_run_at = ?, next_run_at = ?,
				     status = ?, pending_job_id = ?, updated_at = ?
				 WHERE id = ?`
			)
			.run(
				opts.lastCreatedTaskId,
				opts.lastRunAt,
				opts.nextRunAt,
				opts.status,
				opts.pendingJobId,
				Date.now(),
				id
			);
	}

	// ─── Delete ───────────────────────────────────────────────────────────────────

	delete(id: string): boolean {
		const result = this.db.prepare(`DELETE FROM task_schedules WHERE id = ?`).run(id);
		return result.changes > 0;
	}

	// ─── Private helpers ──────────────────────────────────────────────────────────

	private rowToSchedule(row: Record<string, unknown>): TaskSchedule {
		return {
			id: row.id as string,
			spaceId: row.space_id as string,
			title: row.title as string,
			description: (row.description as string) ?? '',
			priority: (row.priority as SpaceTaskPriority) ?? 'normal',
			preferredWorkflowId: (row.preferred_workflow_id as string | null) ?? null,
			labels: JSON.parse((row.labels as string) ?? '[]') as string[],
			triggerType: row.trigger_type as TaskScheduleTriggerType,
			cronExpression: (row.cron_expression as string | null) ?? null,
			runAt: (row.run_at as number | null) ?? null,
			timezone: (row.timezone as string) ?? 'UTC',
			nextRunAt: (row.next_run_at as number | null) ?? null,
			lastRunAt: (row.last_run_at as number | null) ?? null,
			lastCreatedTaskId: (row.last_created_task_id as string | null) ?? null,
			pendingJobId: (row.pending_job_id as string | null) ?? null,
			status: row.status as TaskScheduleStatus,
			createdByAgent: (row.created_by_agent as string | null) ?? null,
			createdBySession: (row.created_by_session as string | null) ?? null,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
