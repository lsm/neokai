/**
 * SpaceTaskManager - Space task management with status transitions
 *
 * Handles:
 * - Creating space tasks with dependency validation
 * - Status transitions (draft -> pending -> in_progress -> completed/needs_attention/cancelled/review)
 * - Task assignment and progress tracking
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceTask, SpaceTaskStatus, CreateSpaceTaskParams } from '@neokai/shared';

/**
 * Valid task status transitions for space tasks
 * Maps current status -> allowed next statuses
 */
export const VALID_SPACE_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
	draft: ['pending'],
	pending: ['in_progress', 'cancelled'],
	in_progress: ['review', 'completed', 'needs_attention', 'cancelled'],
	review: ['completed', 'needs_attention', 'in_progress'],
	completed: [],
	needs_attention: ['pending', 'in_progress', 'review'],
	cancelled: ['pending', 'in_progress'],
};

/**
 * Check if a space task status transition is valid
 */
export function isValidSpaceTaskTransition(from: SpaceTaskStatus, to: SpaceTaskStatus): boolean {
	return VALID_SPACE_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export class SpaceTaskManager {
	private taskRepo: SpaceTaskRepository;

	constructor(
		private db: BunDatabase,
		private spaceId: string
	) {
		this.taskRepo = new SpaceTaskRepository(db);
	}

	/**
	 * Create a task in this space
	 */
	async createTask(params: Omit<CreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
		// Validate dependency task IDs exist in this space
		if (params.dependsOn && params.dependsOn.length > 0) {
			for (const depId of params.dependsOn) {
				const dep = await this.getTask(depId);
				if (!dep) {
					throw new Error(`Dependency task not found in space: ${depId}`);
				}
			}
		}

		return this.taskRepo.createTask({ ...params, spaceId: this.spaceId });
	}

	/**
	 * Get a task by ID (validates it belongs to this space)
	 */
	async getTask(taskId: string): Promise<SpaceTask | null> {
		const task = this.taskRepo.getTask(taskId);
		if (task && task.spaceId === this.spaceId) {
			return task;
		}
		return null;
	}

	/**
	 * List tasks in this space
	 */
	async listTasks(includeArchived = false): Promise<SpaceTask[]> {
		return this.taskRepo.listBySpace(this.spaceId, includeArchived);
	}

	/**
	 * List tasks by status
	 */
	async listTasksByStatus(status: SpaceTaskStatus): Promise<SpaceTask[]> {
		return this.taskRepo.listByStatus(this.spaceId, status);
	}

	/**
	 * Update task status with validation
	 */
	async setTaskStatus(
		taskId: string,
		newStatus: SpaceTaskStatus,
		options?: { result?: string; error?: string }
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		if (!isValidSpaceTaskTransition(task.status, newStatus)) {
			throw new Error(
				`Invalid status transition from '${task.status}' to '${newStatus}'. ` +
					`Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
		}

		const updates: Parameters<SpaceTaskRepository['updateTask']>[1] = { status: newStatus };

		if (newStatus === 'completed') {
			updates.progress = 100;
			if (options?.result) updates.result = options.result;
		}

		if (newStatus === 'needs_attention' && options?.error) {
			updates.error = options.error;
		}

		// Clear error/result/progress when restarting from a failed/cancelled state.
		// For needs_attention: allowed targets are pending, in_progress, review.
		// For cancelled: allowed targets are pending, in_progress (review is not valid from cancelled).
		if (
			(task.status === 'needs_attention' &&
				(newStatus === 'pending' || newStatus === 'in_progress' || newStatus === 'review')) ||
			(task.status === 'cancelled' && (newStatus === 'pending' || newStatus === 'in_progress'))
		) {
			updates.error = null;
			updates.result = null;
			updates.progress = null;
		}

		const updated = this.taskRepo.updateTask(taskId, updates);
		if (!updated) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Update task progress
	 */
	async updateTaskProgress(
		taskId: string,
		progress: number,
		currentStep?: string
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updated = this.taskRepo.updateTask(taskId, {
			progress: Math.min(100, Math.max(0, progress)),
			currentStep,
		});

		if (!updated) {
			throw new Error(`Failed to update task progress: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Start a task (mark as in_progress)
	 */
	async startTask(taskId: string): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'in_progress');
	}

	/**
	 * Complete a task
	 */
	async completeTask(taskId: string, result: string): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'completed', { result });
	}

	/**
	 * Fail a task (mark as needs_attention)
	 */
	async failTask(taskId: string, error: string): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'needs_attention', { error });
	}

	/**
	 * Cancel a task and cascade to pending dependents
	 */
	async cancelTask(taskId: string): Promise<SpaceTask> {
		const all = await this.cancelTaskCascade(taskId);
		return all[0];
	}

	/**
	 * Cancel task and cascade to pending dependents recursively
	 */
	async cancelTaskCascade(taskId: string): Promise<SpaceTask[]> {
		return this.doCancelCascade(taskId, []);
	}

	private async doCancelCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
		const result = await this.setTaskStatus(taskId, 'cancelled');
		acc.push(result);

		const pendingTasks = await this.listTasksByStatus('pending');
		for (const t of pendingTasks) {
			if (t.dependsOn?.includes(taskId)) {
				await this.doCancelCascade(t.id, acc);
			}
		}

		return acc;
	}

	/**
	 * Move task to review (work done, awaiting human approval).
	 * Validates the transition via setTaskStatus, then applies PR metadata.
	 */
	async reviewTask(taskId: string, prUrl?: string): Promise<SpaceTask> {
		// setTaskStatus handles existence check, transition validation, and field clearing
		await this.setTaskStatus(taskId, 'review');

		// Apply PR metadata on top of the transition
		const prUpdates: Parameters<SpaceTaskRepository['updateTask']>[1] = {
			currentStep: prUrl ?? 'Awaiting review',
			progress: 80,
		};

		if (prUrl !== undefined) {
			prUpdates.prUrl = prUrl;
			const match = prUrl.match(/\/pull\/(\d+)/);
			prUpdates.prNumber = match ? parseInt(match[1], 10) : null;
			prUpdates.prCreatedAt = Date.now();
		}

		const updated = this.taskRepo.updateTask(taskId, prUpdates);
		if (!updated) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Promote draft tasks created by a planning task to pending
	 */
	async promoteDraftTasks(creatorTaskId: string): Promise<number> {
		return this.taskRepo.promoteDraftTasksByCreator(creatorTaskId);
	}

	/**
	 * Archive a task
	 */
	async archiveTask(taskId: string): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updated = this.taskRepo.archiveTask(taskId);
		if (!updated) {
			throw new Error(`Failed to archive task: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Delete a task
	 */
	async deleteTask(taskId: string): Promise<boolean> {
		const task = await this.getTask(taskId);
		if (!task) {
			return false;
		}

		return this.taskRepo.deleteTask(taskId);
	}

	/**
	 * Check if all dependencies for a task are met (completed)
	 */
	async areDependenciesMet(task: SpaceTask): Promise<boolean> {
		if (!task.dependsOn || task.dependsOn.length === 0) {
			return true;
		}

		for (const depId of task.dependsOn) {
			const dep = await this.getTask(depId);
			if (!dep || dep.status !== 'completed') {
				return false;
			}
		}

		return true;
	}
}
