/**
 * Goal Repository
 *
 * Repository for room goal CRUD operations.
 * Goals track structured objectives for rooms with progress aggregation from linked tasks.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	RoomGoal,
	GoalStatus,
	GoalPriority,
	MissionType,
	AutonomyLevel,
	MissionMetric,
	CronSchedule,
	MetricHistoryEntry,
	MissionExecution,
	MissionExecutionStatus,
} from '@neokai/shared';
import type { SQLiteValue } from '../types';

export interface CreateGoalParams {
	roomId: string;
	title: string;
	description?: string;
	priority?: GoalPriority;
	missionType?: MissionType;
	autonomyLevel?: AutonomyLevel;
	structuredMetrics?: MissionMetric[];
	schedule?: CronSchedule;
	schedulePaused?: boolean;
	nextRunAt?: number;
	maxConsecutiveFailures?: number;
	maxPlanningAttempts?: number;
	consecutiveFailures?: number;
	replanCount?: number;
}

export interface UpdateGoalParams {
	title?: string;
	description?: string;
	status?: GoalStatus;
	priority?: GoalPriority;
	progress?: number;
	linkedTaskIds?: string[];
	metrics?: Record<string, number>;
	planning_attempts?: number;
	missionType?: MissionType;
	autonomyLevel?: AutonomyLevel;
	structuredMetrics?: MissionMetric[] | null;
	schedule?: CronSchedule | null;
	schedulePaused?: boolean;
	nextRunAt?: number | null;
	maxConsecutiveFailures?: number;
	maxPlanningAttempts?: number;
	consecutiveFailures?: number;
	replanCount?: number;
}

export interface CreateExecutionParams {
	goalId: string;
	executionNumber: number;
	startedAt?: number;
	taskIds?: string[];
}

export interface UpdateExecutionParams {
	status?: MissionExecutionStatus;
	completedAt?: number;
	resultSummary?: string;
	taskIds?: string[];
	planningAttempts?: number;
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
			`INSERT INTO goals (
				id, room_id, title, description, status, priority, progress, linked_task_ids,
				metrics, created_at, updated_at,
				mission_type, autonomy_level, schedule, schedule_paused, next_run_at,
				structured_metrics, max_consecutive_failures, max_planning_attempts, consecutive_failures,
				replan_count
			)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.roomId,
			params.title,
			params.description ?? '',
			'active',
			params.priority ?? 'normal',
			0,
			'[]',
			'{}',
			now,
			now,
			params.missionType ?? 'one_shot',
			params.autonomyLevel ?? 'supervised',
			params.schedule ? JSON.stringify(params.schedule) : null,
			params.schedulePaused ? 1 : 0,
			params.nextRunAt ?? null,
			params.structuredMetrics ? JSON.stringify(params.structuredMetrics) : null,
			params.maxConsecutiveFailures ?? 3,
			params.maxPlanningAttempts ?? 5,
			params.consecutiveFailures ?? 0,
			params.replanCount ?? 0
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
		if (params.planning_attempts !== undefined) {
			fields.push('planning_attempts = ?');
			values.push(params.planning_attempts);
		}
		if (params.missionType !== undefined) {
			fields.push('mission_type = ?');
			values.push(params.missionType);
		}
		if (params.autonomyLevel !== undefined) {
			fields.push('autonomy_level = ?');
			values.push(params.autonomyLevel);
		}
		if (params.structuredMetrics !== undefined) {
			fields.push('structured_metrics = ?');
			values.push(
				params.structuredMetrics !== null ? JSON.stringify(params.structuredMetrics) : null
			);
		}
		if (params.schedule !== undefined) {
			fields.push('schedule = ?');
			values.push(params.schedule !== null ? JSON.stringify(params.schedule) : null);
		}
		if (params.schedulePaused !== undefined) {
			fields.push('schedule_paused = ?');
			values.push(params.schedulePaused ? 1 : 0);
		}
		if (params.nextRunAt !== undefined) {
			fields.push('next_run_at = ?');
			values.push(params.nextRunAt);
		}
		if (params.maxConsecutiveFailures !== undefined) {
			fields.push('max_consecutive_failures = ?');
			values.push(params.maxConsecutiveFailures);
		}
		if (params.maxPlanningAttempts !== undefined) {
			fields.push('max_planning_attempts = ?');
			values.push(params.maxPlanningAttempts);
		}
		if (params.consecutiveFailures !== undefined) {
			fields.push('consecutive_failures = ?');
			values.push(params.consecutiveFailures);
		}
		if (params.replanCount !== undefined) {
			fields.push('replan_count = ?');
			values.push(params.replanCount);
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
	 * Atomically link a task to both a mission execution and the parent goal.
	 *
	 * This is the single write path for recurring-mission task linkage:
	 * - Appends taskId to mission_executions.task_ids (execution-scoped history)
	 * - Appends taskId to goals.linked_task_ids (current execution snapshot for progress)
	 *
	 * For non-recurring missions use linkTaskToGoal() instead.
	 * Returns null if the execution or goal does not exist.
	 */
	linkTaskToExecution(goalId: string, executionId: string, taskId: string): RoomGoal | null {
		return this.db.transaction(() => {
			// 1. Update mission_executions.task_ids
			const execRow = this.db
				.prepare(`SELECT task_ids FROM mission_executions WHERE id = ? AND goal_id = ?`)
				.get(executionId, goalId) as { task_ids: string } | undefined;
			if (!execRow) return null;

			const execTaskIds: string[] = JSON.parse(execRow.task_ids);
			if (!execTaskIds.includes(taskId)) {
				execTaskIds.push(taskId);
			}
			this.db
				.prepare(`UPDATE mission_executions SET task_ids = ? WHERE id = ?`)
				.run(JSON.stringify(execTaskIds), executionId);

			// 2. Update goals.linked_task_ids
			const goal = this.getGoal(goalId);
			if (!goal) return null;
			const goalTaskIds = [...new Set([...goal.linkedTaskIds, taskId])];
			return this.updateGoal(goalId, { linkedTaskIds: goalTaskIds });
		})();
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
			`SELECT COUNT(*) as count FROM goals WHERE room_id = ? AND status IN ('active', 'needs_human')`
		);
		const row = stmt.get(roomId) as { count: number } | undefined;
		return row?.count ?? 0;
	}

	// =========================================================================
	// Mission Metric History
	// =========================================================================

	/**
	 * Insert a metric history data point for a goal
	 */
	insertMetricHistory(
		goalId: string,
		metricName: string,
		value: number,
		recordedAt?: number
	): MetricHistoryEntry {
		const id = generateUUID();
		const ts = recordedAt ?? Math.floor(Date.now() / 1000);

		this.db
			.prepare(
				`INSERT INTO mission_metric_history (id, goal_id, metric_name, value, recorded_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.run(id, goalId, metricName, value, ts);

		return { metricName, value, recordedAt: ts };
	}

	/**
	 * Query metric history for a goal, optionally filtered by metric name and time range
	 */
	queryMetricHistory(
		goalId: string,
		opts: {
			metricName?: string;
			fromTs?: number;
			toTs?: number;
			limit?: number;
		} = {}
	): MetricHistoryEntry[] {
		let query = `SELECT metric_name, value, recorded_at FROM mission_metric_history WHERE goal_id = ?`;
		const params: SQLiteValue[] = [goalId];

		if (opts.metricName) {
			query += ` AND metric_name = ?`;
			params.push(opts.metricName);
		}
		if (opts.fromTs !== undefined) {
			query += ` AND recorded_at >= ?`;
			params.push(opts.fromTs);
		}
		if (opts.toTs !== undefined) {
			query += ` AND recorded_at <= ?`;
			params.push(opts.toTs);
		}

		query += ` ORDER BY recorded_at ASC`;

		if (opts.limit !== undefined) {
			query += ` LIMIT ?`;
			params.push(opts.limit);
		}

		const rows = this.db.prepare(query).all(...params) as Array<{
			metric_name: string;
			value: number;
			recorded_at: number;
		}>;

		return rows.map((r) => ({
			metricName: r.metric_name,
			value: r.value,
			recordedAt: r.recorded_at,
		}));
	}

	// =========================================================================
	// Mission Executions
	// =========================================================================

	/**
	 * Return the next execution number for a goal (max existing + 1, or 1 if none).
	 */
	getNextExecutionNumber(goalId: string): number {
		const row = this.db
			.prepare(
				`SELECT MAX(execution_number) as max_num FROM mission_executions WHERE goal_id = ?`
			)
			.get(goalId) as { max_num: number | null } | undefined;
		const maxNum = row?.max_num ?? 0;
		return maxNum + 1;
	}

	/**
	 * Clear linked_task_ids on a goal (used when a new recurring execution starts).
	 * Returns updated goal or null if not found.
	 */
	clearLinkedTaskIds(goalId: string): RoomGoal | null {
		return this.updateGoal(goalId, { linkedTaskIds: [] });
	}

	/**
	 * Insert a new mission execution record
	 */
	insertExecution(params: CreateExecutionParams): MissionExecution {
		const id = generateUUID();
		const now = Math.floor(Date.now() / 1000);

		this.db
			.prepare(
				`INSERT INTO mission_executions
				 (id, goal_id, execution_number, started_at, status, task_ids, planning_attempts)
				 VALUES (?, ?, ?, ?, 'running', ?, 0)`
			)
			.run(
				id,
				params.goalId,
				params.executionNumber,
				params.startedAt ?? now,
				JSON.stringify(params.taskIds ?? [])
			);

		return this.getExecution(id)!;
	}

	/**
	 * Get a single execution by ID
	 */
	getExecution(id: string): MissionExecution | null {
		const row = this.db.prepare(`SELECT * FROM mission_executions WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return this.rowToExecution(row);
	}

	/**
	 * List executions for a goal (most recent first)
	 */
	listExecutions(goalId: string, limit?: number): MissionExecution[] {
		let query = `SELECT * FROM mission_executions WHERE goal_id = ? ORDER BY execution_number DESC`;
		const params: SQLiteValue[] = [goalId];
		if (limit !== undefined) {
			query += ` LIMIT ?`;
			params.push(limit);
		}
		const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.rowToExecution(r));
	}

	/**
	 * Update a mission execution (status, completedAt, resultSummary, taskIds, planningAttempts)
	 */
	updateExecution(id: string, params: UpdateExecutionParams): MissionExecution | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
		}
		if (params.completedAt !== undefined) {
			fields.push('completed_at = ?');
			values.push(params.completedAt);
		}
		if (params.resultSummary !== undefined) {
			fields.push('result_summary = ?');
			values.push(params.resultSummary);
		}
		if (params.taskIds !== undefined) {
			fields.push('task_ids = ?');
			values.push(JSON.stringify(params.taskIds));
		}
		if (params.planningAttempts !== undefined) {
			fields.push('planning_attempts = ?');
			values.push(params.planningAttempts);
		}

		if (fields.length === 0) return this.getExecution(id);

		values.push(id);
		this.db
			.prepare(`UPDATE mission_executions SET ${fields.join(', ')} WHERE id = ?`)
			.run(...values);
		return this.getExecution(id);
	}

	/**
	 * Get the currently running execution for a goal (at most one due to partial unique index)
	 */
	getActiveExecution(goalId: string): MissionExecution | null {
		const row = this.db
			.prepare(`SELECT * FROM mission_executions WHERE goal_id = ? AND status = 'running' LIMIT 1`)
			.get(goalId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToExecution(row);
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

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
			planning_attempts: (row.planning_attempts as number | null) ?? 0,
			goal_review_attempts: (row.goal_review_attempts as number | null) ?? 0,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			completedAt: (row.completed_at as number | null) ?? undefined,
			// Mission V2 fields
			missionType: (row.mission_type as MissionType | null) ?? 'one_shot',
			autonomyLevel: (row.autonomy_level as AutonomyLevel | null) ?? 'supervised',
			structuredMetrics:
				row.structured_metrics != null
					? (JSON.parse(row.structured_metrics as string) as MissionMetric[])
					: undefined,
			schedule:
				row.schedule != null ? (JSON.parse(row.schedule as string) as CronSchedule) : undefined,
			schedulePaused: row.schedule_paused === 1,
			nextRunAt: (row.next_run_at as number | null) ?? undefined,
			maxConsecutiveFailures: (row.max_consecutive_failures as number | null) ?? 3,
			maxPlanningAttempts: (row.max_planning_attempts as number | null) ?? 5,
			consecutiveFailures: (row.consecutive_failures as number | null) ?? 0,
			replanCount: (row.replan_count as number | null) ?? undefined,
		};
	}

	/**
	 * Convert a database row to a MissionExecution object
	 */
	private rowToExecution(row: Record<string, unknown>): MissionExecution {
		return {
			id: row.id as string,
			goalId: row.goal_id as string,
			executionNumber: row.execution_number as number,
			startedAt: row.started_at as number,
			completedAt: (row.completed_at as number | null) ?? undefined,
			status: row.status as MissionExecutionStatus,
			resultSummary: (row.result_summary as string | null) ?? undefined,
			taskIds: JSON.parse(row.task_ids as string) as string[],
			planningAttempts: (row.planning_attempts as number | null) ?? 0,
		};
	}
}

/**
 * Compute the effective max planning attempts for a goal.
 *
 * Priority order:
 * 1. goal.maxPlanningAttempts (per-goal override, stored in DB)
 * 2. roomConfig.maxPlanningRetries + 1 (room-level config, legacy key)
 * 3. Default: 1 (no retries)
 */
export function getEffectiveMaxPlanningAttempts(
	goal: RoomGoal,
	roomConfig?: Record<string, unknown>
): number {
	// Per-goal override takes highest precedence
	if (
		goal.maxPlanningAttempts !== undefined &&
		Number.isInteger(goal.maxPlanningAttempts) &&
		goal.maxPlanningAttempts > 0
	) {
		return goal.maxPlanningAttempts;
	}

	// Room-level config: maxPlanningRetries is "retries after first failure"
	// so 0 means 1 total attempt, N means N+1 total attempts
	if (roomConfig !== undefined) {
		const retries = roomConfig['maxPlanningRetries'];
		if (typeof retries === 'number' && Number.isInteger(retries) && retries >= 0) {
			return retries + 1;
		}
	}

	// Global default: 1 total attempt (no retries)
	return 1;
}
