/**
 * Recurring Job Repository
 *
 * Repository for recurring job CRUD operations.
 * Jobs spawn tasks on a schedule (cron, interval, daily, weekly).
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { RecurringJob, RecurringJobSchedule, RecurringTaskTemplate } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export interface CreateRecurringJobParams {
	roomId: string;
	name: string;
	description?: string;
	schedule: RecurringJobSchedule;
	taskTemplate: RecurringTaskTemplate;
	enabled?: boolean;
	maxRuns?: number;
}

export interface UpdateRecurringJobParams {
	name?: string;
	description?: string;
	schedule?: RecurringJobSchedule;
	taskTemplate?: RecurringTaskTemplate;
	enabled?: boolean;
	lastRunAt?: number;
	nextRunAt?: number;
	runCount?: number;
	maxRuns?: number;
}

export class RecurringJobRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new recurring job
	 */
	createJob(params: CreateRecurringJobParams): RecurringJob {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO recurring_jobs (id, room_id, name, description, schedule, task_template, enabled, run_count, max_runs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			params.name,
			params.description ?? '',
			JSON.stringify(params.schedule),
			JSON.stringify(params.taskTemplate),
			params.enabled !== false ? 1 : 0,
			0,
			params.maxRuns ?? null,
			now,
			now
		);

		return this.getJob(id)!;
	}

	/**
	 * Get a job by ID
	 */
	getJob(id: string): RecurringJob | null {
		const stmt = this.db.prepare(`SELECT * FROM recurring_jobs WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToJob(row);
	}

	/**
	 * List jobs for a room
	 */
	listJobs(roomId: string, enabledOnly?: boolean): RecurringJob[] {
		let query = `SELECT * FROM recurring_jobs WHERE room_id = ?`;
		const params: SQLiteValue[] = [roomId];

		if (enabledOnly) {
			query += ` AND enabled = 1`;
		}

		query += ` ORDER BY created_at ASC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToJob(r));
	}

	/**
	 * Get all enabled jobs (for scheduler)
	 */
	getAllEnabledJobs(): RecurringJob[] {
		const stmt = this.db.prepare(
			`SELECT * FROM recurring_jobs WHERE enabled = 1 ORDER BY next_run_at ASC`
		);
		const rows = stmt.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToJob(r));
	}

	/**
	 * Get jobs due to run (next_run_at <= now)
	 */
	getDueJobs(now: number = Date.now()): RecurringJob[] {
		const stmt = this.db.prepare(
			`SELECT * FROM recurring_jobs WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at ASC`
		);
		const rows = stmt.all(now) as Record<string, unknown>[];
		return rows.map((r) => this.rowToJob(r));
	}

	/**
	 * Update a job with partial updates
	 */
	updateJob(id: string, params: UpdateRecurringJobParams): RecurringJob | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.name !== undefined) {
			fields.push('name = ?');
			values.push(params.name);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description);
		}
		if (params.schedule !== undefined) {
			fields.push('schedule = ?');
			values.push(JSON.stringify(params.schedule));
		}
		if (params.taskTemplate !== undefined) {
			fields.push('task_template = ?');
			values.push(JSON.stringify(params.taskTemplate));
		}
		if (params.enabled !== undefined) {
			fields.push('enabled = ?');
			values.push(params.enabled ? 1 : 0);
		}
		if (params.lastRunAt !== undefined) {
			fields.push('last_run_at = ?');
			values.push(params.lastRunAt);
		}
		if (params.nextRunAt !== undefined) {
			fields.push('next_run_at = ?');
			values.push(params.nextRunAt);
		}
		if (params.runCount !== undefined) {
			fields.push('run_count = ?');
			values.push(params.runCount);
		}
		if (params.maxRuns !== undefined) {
			fields.push('max_runs = ?');
			values.push(params.maxRuns);
		}

		if (fields.length === 0) {
			return this.getJob(id);
		}

		// Always update updated_at
		fields.push('updated_at = ?');
		values.push(Date.now());

		values.push(id);

		const stmt = this.db.prepare(`UPDATE recurring_jobs SET ${fields.join(', ')} WHERE id = ?`);
		stmt.run(...values);

		return this.getJob(id);
	}

	/**
	 * Mark a job as run (increment run_count, set last_run_at, calculate next_run_at)
	 */
	markJobRun(id: string, nextRunAt: number): RecurringJob | null {
		const job = this.getJob(id);
		if (!job) return null;

		return this.updateJob(id, {
			lastRunAt: Date.now(),
			nextRunAt,
			runCount: job.runCount + 1,
		});
	}

	/**
	 * Enable a job
	 */
	enableJob(id: string): RecurringJob | null {
		return this.updateJob(id, { enabled: true });
	}

	/**
	 * Disable a job
	 */
	disableJob(id: string): RecurringJob | null {
		return this.updateJob(id, { enabled: false });
	}

	/**
	 * Delete a job
	 */
	deleteJob(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM recurring_jobs WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Check if a job has reached max runs
	 */
	hasReachedMaxRuns(job: RecurringJob): boolean {
		if (job.maxRuns === undefined || job.maxRuns === null) {
			return false;
		}
		return job.runCount >= job.maxRuns;
	}

	/**
	 * Convert a database row to a RecurringJob object
	 */
	private rowToJob(row: Record<string, unknown>): RecurringJob {
		return {
			id: row.id as string,
			roomId: row.room_id as string,
			name: row.name as string,
			description: row.description as string,
			schedule: JSON.parse(row.schedule as string) as RecurringJobSchedule,
			taskTemplate: JSON.parse(row.task_template as string) as RecurringTaskTemplate,
			enabled: row.enabled === 1,
			lastRunAt: row.last_run_at as number | undefined,
			nextRunAt: row.next_run_at as number | undefined,
			runCount: row.run_count as number,
			maxRuns: row.max_runs as number | undefined,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}
