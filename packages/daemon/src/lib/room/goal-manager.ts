/**
 * GoalManager - Goal management with progress tracking
 *
 * Handles:
 * - Creating goals
 * - Listing and filtering goals
 * - Status transitions (pending -> in_progress -> completed/blocked)
 * - Linking tasks to goals
 * - Progress aggregation from linked tasks
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { DaemonHub } from '../daemon-hub';
import { GoalRepository, type CreateGoalParams } from '../../storage/repositories/goal-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import type { RoomGoal, GoalStatus, GoalPriority } from '@neokai/shared';

export class GoalManager {
	private goalRepo: GoalRepository;
	private taskRepo: TaskRepository;

	constructor(
		private db: BunDatabase,
		private roomId: string,
		private daemonHub?: DaemonHub
	) {
		this.goalRepo = new GoalRepository(db);
		this.taskRepo = new TaskRepository(db);
	}

	/**
	 * Create a new goal
	 */
	async createGoal(params: Omit<CreateGoalParams, 'roomId'>): Promise<RoomGoal> {
		const goal = this.goalRepo.createGoal({
			roomId: this.roomId,
			title: params.title,
			description: params.description,
			priority: params.priority,
		});

		// Emit goal.created event
		if (this.daemonHub) {
			await this.daemonHub.emit('goal.created', {
				sessionId: `room:${this.roomId}`,
				roomId: this.roomId,
				goalId: goal.id,
				goal,
			});
		}

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

		// Emit goal.updated event
		if (this.daemonHub) {
			await this.daemonHub.emit('goal.updated', {
				sessionId: `room:${this.roomId}`,
				roomId: this.roomId,
				goalId,
				goal: updatedGoal,
			});
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

		// Emit progress update event
		if (this.daemonHub) {
			await this.daemonHub.emit('goal.progressUpdated', {
				sessionId: `room:${this.roomId}`,
				roomId: this.roomId,
				goalId,
				progress: updatedGoal.progress,
			});
		}

		return updatedGoal;
	}

	/**
	 * Start goal (mark as in_progress)
	 */
	async startGoal(goalId: string): Promise<RoomGoal> {
		return this.updateGoalStatus(goalId, 'in_progress');
	}

	/**
	 * Complete goal
	 */
	async completeGoal(goalId: string): Promise<RoomGoal> {
		return this.updateGoalStatus(goalId, 'completed', {
			progress: 100,
		});
	}

	/**
	 * Block goal
	 */
	async blockGoal(goalId: string): Promise<RoomGoal> {
		return this.updateGoalStatus(goalId, 'blocked');
	}

	/**
	 * Unblock goal (return to pending)
	 */
	async unblockGoal(goalId: string): Promise<RoomGoal> {
		return this.updateGoalStatus(goalId, 'pending');
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
	 * Unlink a task from a goal
	 */
	async unlinkTaskFromGoal(goalId: string, taskId: string): Promise<RoomGoal> {
		const goal = await this.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		const updatedGoal = this.goalRepo.unlinkTaskFromGoal(goalId, taskId);
		if (!updatedGoal) {
			throw new Error(`Failed to unlink task from goal: ${goalId}`);
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
				} else if (task.status === 'failed') {
					// Failed tasks don't contribute to progress
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
	 * Get active (non-completed) goals count
	 */
	async getActiveCount(): Promise<number> {
		return this.goalRepo.getActiveGoalCount(this.roomId);
	}

	/**
	 * Get all active goals (pending or in_progress)
	 */
	async getActiveGoals(): Promise<RoomGoal[]> {
		const goals = await this.listGoals();
		return goals.filter((g) => g.status === 'pending' || g.status === 'in_progress');
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

		// Prefer in_progress goals, then pending
		const inProgressGoals = activeGoals.filter((g) => g.status === 'in_progress');
		if (inProgressGoals.length > 0) {
			return inProgressGoals[0];
		}

		return activeGoals[0];
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
}
