/**
 * GoalManager - Goal management with progress tracking
 *
 * Handles:
 * - Creating goals
 * - Listing and filtering goals
 * - Status transitions (active -> completed/needs_human/archived)
 * - Linking tasks to goals
 * - Progress aggregation from linked tasks
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import {
	GoalRepository,
	type CreateGoalParams,
	type UpdateGoalParams,
} from '../../../storage/repositories/goal-repository';
import { TaskRepository } from '../../../storage/repositories/task-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type {
	RoomGoal,
	GoalStatus,
	GoalPriority,
	MissionExecution,
	MissionMetric,
	MetricHistoryEntry,
} from '@neokai/shared';

export interface MetricTargetResult {
	name: string;
	current: number;
	target: number;
	met: boolean;
}

export interface CheckMetricTargetsResult {
	allMet: boolean;
	results: MetricTargetResult[];
}

export class GoalManager {
	private goalRepo: GoalRepository;
	private taskRepo: TaskRepository;

	constructor(
		private db: BunDatabase,
		private roomId: string,
		reactiveDb: ReactiveDatabase
	) {
		this.goalRepo = new GoalRepository(db, reactiveDb);
		this.taskRepo = new TaskRepository(db, reactiveDb);
	}

	/**
	 * Create a new goal
	 */
	async createGoal(params: Omit<CreateGoalParams, 'roomId'>): Promise<RoomGoal> {
		const goal = this.goalRepo.createGoal({
			...params,
			roomId: this.roomId,
		});

		return goal;
	}

	/**
	 * Get a goal by ID
	 */
	async getGoal(goalId: string): Promise<RoomGoal | null> {
		const goal = this.goalRepo.getGoal(goalId);
		if (goal && goal.roomId === this.roomId) {
			return goal;
		}
		return null;
	}

	/**
	 * List goals with optional status filter
	 */
	async listGoals(status?: GoalStatus): Promise<RoomGoal[]> {
		return this.goalRepo.listGoals(this.roomId, status);
	}

	/**
	 * Synchronous version of listGoals. All bun:sqlite operations are synchronous;
	 * this avoids the extra microtask yield from the async wrapper when callers
	 * need to check for recurring goals without introducing async scheduling side-effects.
	 */
	listGoalsSync(status?: GoalStatus): RoomGoal[] {
		return this.goalRepo.listGoals(this.roomId, status);
	}

	/**
	 * Update goal status
	 */
	async updateGoalStatus(
		goalId: string,
		status: GoalStatus,
		updates?: Partial<RoomGoal>
	): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		const updatedGoal = this.goalRepo.updateGoal(goalId, {
			status,
			...updates,
		});

		if (!updatedGoal) {
			throw new Error(`Failed to update goal: ${goalId}`);
		}

		return updatedGoal;
	}

	/**
	 * Update goal progress
	 */
	async updateGoalProgress(
		goalId: string,
		progress: number,
		metrics?: Record<string, number>
	): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		const updatedGoal = this.goalRepo.updateGoal(goalId, {
			progress: Math.min(100, Math.max(0, progress)),
			metrics,
		});

		if (!updatedGoal) {
			throw new Error(`Failed to update goal: ${goalId}`);
		}

		return updatedGoal;
	}

	/**
	 * Mark goal as needing human input
	 */
	async needsHumanGoal(goalId: string): Promise<RoomGoal> {
		return this.updateGoalStatus(goalId, 'needs_human');
	}

	/**
	 * Reactivate goal (return to active)
	 */
	async reactivateGoal(goalId: string): Promise<RoomGoal> {
		return this.updateGoalStatus(goalId, 'active');
	}

	/**
	 * Link a task to a goal
	 */
	async linkTaskToGoal(goalId: string, taskId: string): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		// Verify task exists in this room
		const task = this.taskRepo.getTask(taskId);
		if (!task || task.roomId !== this.roomId) {
			throw new Error(`Task not found in this room: ${taskId}`);
		}

		const updatedGoal = this.goalRepo.linkTaskToGoal(goalId, taskId);
		if (!updatedGoal) {
			throw new Error(`Failed to link task to goal: ${goalId}`);
		}

		// Recalculate progress
		await this.recalculateProgress(goalId);

		return this.getGoal(goalId) as Promise<RoomGoal>;
	}

	/**
	 * Atomically link a task to a recurring mission execution AND the parent goal.
	 *
	 * Use this for all recurring-mission task linkage. It writes to both
	 * mission_executions.task_ids and goals.linked_task_ids in one transaction.
	 * For non-recurring missions, use linkTaskToGoal() instead.
	 */
	async linkTaskToExecution(
		goalId: string,
		executionId: string,
		taskId: string
	): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		// Verify task exists in this room
		const task = this.taskRepo.getTask(taskId);
		if (!task || task.roomId !== this.roomId) {
			throw new Error(`Task not found in this room: ${taskId}`);
		}

		const updatedGoal = this.goalRepo.linkTaskToExecution(goalId, executionId, taskId);
		if (!updatedGoal) {
			throw new Error(`Failed to link task to execution: ${executionId}`);
		}

		// Recalculate progress
		await this.recalculateProgress(goalId);

		return this.getGoal(goalId) as Promise<RoomGoal>;
	}

	/**
	 * Recalculate goal progress from linked tasks
	 */
	async recalculateProgress(goalId: string): Promise<number> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		const progress = await this.calculateProgressFromTasks(goal);
		await this.updateGoalProgress(goalId, progress);
		return progress;
	}

	/**
	 * Calculate progress from linked tasks
	 *
	 * Progress is calculated as the average of all linked task progress values.
	 * Tasks that are not started (no progress) are treated as 0%.
	 * Tasks that are completed are treated as 100%.
	 */
	async calculateProgressFromTasks(goal: RoomGoal): Promise<number> {
		if (!goal.linkedTaskIds || goal.linkedTaskIds.length === 0) {
			return 0;
		}

		let totalProgress = 0;
		let taskCount = 0;

		for (const taskId of goal.linkedTaskIds) {
			const task = this.taskRepo.getTask(taskId);
			if (task && task.roomId === this.roomId) {
				if (task.status === 'completed') {
					totalProgress += 100;
				} else if (task.status === 'needs_attention' || task.status === 'cancelled') {
					// Terminal tasks (needs_attention or cancelled) don't contribute to progress
					totalProgress += 0;
				} else {
					totalProgress += task.progress ?? 0;
				}
				taskCount++;
			}
		}

		if (taskCount === 0) {
			return 0;
		}

		return Math.round(totalProgress / taskCount);
	}

	/**
	 * Get all goals that have a specific task linked
	 */
	async getGoalsForTask(taskId: string): Promise<RoomGoal[]> {
		return this.goalRepo.getGoalsForTask(taskId);
	}

	/**
	 * Update all goals that have a specific task linked (recalculate progress)
	 */
	async updateGoalsForTask(taskId: string): Promise<void> {
		const goals = await this.getGoalsForTask(taskId);
		for (const goal of goals) {
			if (goal.roomId === this.roomId) {
				await this.recalculateProgress(goal.id);
			}
		}
	}

	/**
	 * Update goal priority
	 */
	async updateGoalPriority(goalId: string, priority: GoalPriority): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		const updatedGoal = this.goalRepo.updateGoal(goalId, { priority });
		if (!updatedGoal) {
			throw new Error(`Failed to update goal: ${goalId}`);
		}

		return updatedGoal;
	}

	/**
	 * General-purpose patch for editable fields (title, description, missionType,
	 * autonomyLevel, structuredMetrics, schedule, priority, and similar).
	 * Does NOT change status or recalculate progress.
	 */
	async patchGoal(goalId: string, patch: UpdateGoalParams): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		const updatedGoal = this.goalRepo.updateGoal(goalId, patch);
		if (!updatedGoal) {
			throw new Error(`Failed to update goal: ${goalId}`);
		}
		return updatedGoal;
	}

	/**
	 * Get all active goals (active or needs_human)
	 */
	async getActiveGoals(): Promise<RoomGoal[]> {
		const goals = await this.listGoals();
		return goals.filter((g) => g.status === 'active' || g.status === 'needs_human');
	}

	/**
	 * Get next goal to work on (by priority)
	 */
	async getNextGoal(): Promise<RoomGoal | null> {
		const activeGoals = await this.getActiveGoals();

		if (activeGoals.length === 0) {
			return null;
		}

		// Sort by priority: urgent > high > normal > low
		const priorityOrder: Record<GoalPriority, number> = {
			urgent: 0,
			high: 1,
			normal: 2,
			low: 3,
		};

		activeGoals.sort((a, b) => {
			const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
			if (priorityDiff !== 0) return priorityDiff;
			return a.createdAt - b.createdAt; // Older first if same priority
		});

		// Prefer 'active' goals over 'needs_human' (which are blocked on human input)
		const readyGoals = activeGoals.filter((g) => g.status === 'active');
		if (readyGoals.length > 0) {
			return readyGoals[0];
		}

		return activeGoals[0];
	}

	/**
	 * Increment planning_attempts counter on a goal.
	 * Called when the Runtime spawns a planning group.
	 */
	async incrementPlanningAttempts(goalId: string): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		const updatedGoal = this.goalRepo.updateGoal(goalId, {
			planning_attempts: (goal.planning_attempts ?? 0) + 1,
		});
		if (!updatedGoal) {
			throw new Error(`Failed to update planning_attempts for goal: ${goalId}`);
		}
		return updatedGoal;
	}

	// =========================================================================
	// Mission Execution management (recurring missions)
	// =========================================================================

	/**
	 * Get the currently running execution for a recurring mission.
	 * Returns null if no execution is running (or if this is not a recurring mission).
	 */
	getActiveExecution(goalId: string): MissionExecution | null {
		return this.goalRepo.getActiveExecution(goalId);
	}

	/**
	 * Atomically start a new execution for a recurring mission.
	 * In a single SQLite transaction:
	 *   1. Clears goals.linked_task_ids (fresh task list per execution)
	 *   2. Resets goals.planning_attempts to 0 (per-execution counter)
	 *   3. Inserts mission_executions row with the next execution_number
	 *   4. Advances goals.next_run_at (optional — avoids a separate updateNextRunAt call)
	 *
	 * Passing nextRunAt here prevents the window between insertExecution and a
	 * subsequent updateNextRunAt where a crash could leave an execution running
	 * with an expired next_run_at (which would be stuck due to overlap prevention).
	 *
	 * Returns the new MissionExecution record.
	 * Throws if the goal does not exist.
	 */
	startExecution(goalId: string, nextRunAt?: number): MissionExecution {
		const goal = this.goalRepo.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		return this.goalRepo.atomicStartExecution(goalId, nextRunAt);
	}

	/**
	 * Mark an execution as completed and optionally record a result summary.
	 * Returns the updated MissionExecution or null if not found.
	 */
	completeExecution(executionId: string, resultSummary?: string): MissionExecution | null {
		const now = Math.floor(Date.now() / 1000);
		return this.goalRepo.updateExecution(executionId, {
			status: 'completed',
			completedAt: now,
			resultSummary,
		});
	}

	/**
	 * Mark an execution as failed.
	 * Returns the updated MissionExecution or null if not found.
	 */
	failExecution(executionId: string, resultSummary?: string): MissionExecution | null {
		const now = Math.floor(Date.now() / 1000);
		return this.goalRepo.updateExecution(executionId, {
			status: 'failed',
			completedAt: now,
			resultSummary,
		});
	}

	/**
	 * Update the next_run_at timestamp for a recurring mission.
	 */
	async updateNextRunAt(goalId: string, nextRunAt: number | null): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		const updated = this.goalRepo.updateGoal(goalId, { nextRunAt });
		if (!updated) {
			throw new Error(`Failed to update nextRunAt for goal: ${goalId}`);
		}
		return updated;
	}

	/**
	 * List executions for a goal (most recent first).
	 */
	listExecutions(goalId: string, limit?: number): MissionExecution[] {
		return this.goalRepo.listExecutions(goalId, limit);
	}

	/**
	 * Update the consecutiveFailures counter on a goal.
	 * Called by the runtime to track consecutive task failures for escalation policy.
	 * Pass 0 to reset after a successful task completion.
	 */
	async updateConsecutiveFailures(goalId: string, count: number): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		const updatedGoal = this.goalRepo.updateGoal(goalId, { consecutiveFailures: count });
		if (!updatedGoal) {
			throw new Error(`Failed to update consecutiveFailures for goal: ${goalId}`);
		}
		return updatedGoal;
	}

	/**
	 * Delete a goal
	 */
	async deleteGoal(goalId: string): Promise<boolean> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			return false;
		}

		return this.goalRepo.deleteGoal(goalId);
	}

	// =========================================================================
	// Measurable Mission — Metric Methods
	// =========================================================================

	/**
	 * Validate a single metric configuration.
	 * Returns an error string if invalid, or null if valid.
	 */
	validateMetric(metric: MissionMetric): string | null {
		const direction = metric.direction ?? 'increase';
		if (direction === 'increase') {
			if (metric.target <= 0) {
				return `Metric "${metric.name}": target must be > 0 for increase direction`;
			}
		} else {
			if (metric.baseline === undefined) {
				return `Metric "${metric.name}": baseline is required for decrease direction`;
			}
			if (metric.baseline <= metric.target) {
				return `Metric "${metric.name}": baseline must be > target for decrease direction`;
			}
		}
		return null;
	}

	/**
	 * Calculate progress for a measurable mission based on structured metrics.
	 *
	 * - increase (default): progress = average(min(current / target, 1.0) * 100)
	 * - decrease: progress = average(min((baseline - current) / (baseline - target), 1.0) * 100)
	 *
	 * Metrics with invalid configuration (target ≤ 0 for increase; missing/invalid baseline for
	 * decrease) are skipped to guard against divide-by-zero.
	 */
	calculateMeasurableProgress(metrics: MissionMetric[]): number {
		if (!metrics || metrics.length === 0) return 0;

		let totalProgress = 0;
		let validCount = 0;

		for (const m of metrics) {
			const direction = m.direction ?? 'increase';
			let progress: number;

			if (direction === 'increase') {
				if (m.target <= 0) continue; // skip invalid
				progress = Math.min(m.current / m.target, 1.0) * 100;
			} else {
				// decrease direction
				if (m.baseline === undefined || m.baseline <= m.target) continue; // skip invalid
				const range = m.baseline - m.target;
				if (range === 0) continue; // guard against divide-by-zero
				progress = Math.min((m.baseline - m.current) / range, 1.0) * 100;
			}

			totalProgress += progress;
			validCount++;
		}

		if (validCount === 0) return 0;
		return Math.round(totalProgress / validCount);
	}

	/**
	 * Record a metric value for a measurable mission.
	 *
	 * - Updates `current` in `structuredMetrics`
	 * - Inserts a history row in `mission_metric_history`
	 * - Derives and writes legacy `metrics` field for backward compat
	 * - Recalculates and stores progress for measurable missions
	 */
	async recordMetric(
		goalId: string,
		metricName: string,
		value: number,
		timestamp?: number
	): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		if (goal.missionType !== 'measurable') {
			throw new Error(
				`Cannot record metric for goal ${goalId}: not a measurable mission (missionType="${goal.missionType}")`
			);
		}

		// Update structuredMetrics — find by name and update current
		const existingMetrics = goal.structuredMetrics ?? [];
		let found = false;
		const updatedMetrics: MissionMetric[] = existingMetrics.map((m) => {
			if (m.name === metricName) {
				found = true;
				return { ...m, current: value };
			}
			return m;
		});

		// Reject unknown metric names before writing any history row — auto-creating
		// would set target === current (always met) and leave an orphaned history entry.
		if (!found) {
			throw new Error(
				`Metric "${metricName}" is not defined in structuredMetrics for goal ${goalId}. ` +
					`Known metrics: ${existingMetrics.map((m) => m.name).join(', ') || '(none)'}`
			);
		}

		// Insert history entry only after successful validation
		this.goalRepo.insertMetricHistory(goalId, metricName, value, timestamp);

		// Derive legacy metrics record: { [name]: current }
		const legacyMetrics: Record<string, number> = {};
		for (const m of updatedMetrics) {
			legacyMetrics[m.name] = m.current;
		}

		// Recalculate progress for measurable missions using metric-based formula
		const progress = this.calculateMeasurableProgress(updatedMetrics);

		const updatedGoal = this.goalRepo.updateGoal(goalId, {
			structuredMetrics: updatedMetrics,
			metrics: legacyMetrics,
			progress,
		});

		if (!updatedGoal) {
			throw new Error(`Failed to update goal: ${goalId}`);
		}
		return updatedGoal;
	}

	/**
	 * Query metric history for a goal.
	 * Optionally filtered by metric name and time range.
	 */
	async getMetricHistory(
		goalId: string,
		metricName?: string,
		timeRange?: { fromTs?: number; toTs?: number }
	): Promise<MetricHistoryEntry[]> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		return this.goalRepo.queryMetricHistory(goalId, {
			metricName,
			fromTs: timeRange?.fromTs,
			toTs: timeRange?.toTs,
		});
	}

	/**
	 * Check whether all metric targets are met for a measurable mission.
	 *
	 * - increase: met when current >= target
	 * - decrease: met when current <= target
	 *
	 * Returns allMet=true with empty results if goal has no structuredMetrics (legacy compat).
	 */
	async checkMetricTargets(goalId: string): Promise<CheckMetricTargetsResult> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		const metrics = goal.structuredMetrics;
		if (!metrics || metrics.length === 0) {
			return { allMet: true, results: [] };
		}

		const results: MetricTargetResult[] = metrics.map((m) => {
			const direction = m.direction ?? 'increase';
			const met = direction === 'increase' ? m.current >= m.target : m.current <= m.target;
			return { name: m.name, current: m.current, target: m.target, met };
		});

		return { allMet: results.every((r) => r.met), results };
	}
}
