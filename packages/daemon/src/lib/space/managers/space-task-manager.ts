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
import type {
	SpaceTask,
	SpaceTaskStatus,
	CreateSpaceTaskParams,
	UpdateSpaceTaskParams,
} from '@neokai/shared';

/**
 * Valid task status transitions for space tasks
 * Maps current status -> allowed next statuses
 */
export const VALID_SPACE_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
	draft: ['pending'],
	pending: ['in_progress', 'cancelled'],
	in_progress: ['review', 'completed', 'needs_attention', 'cancelled'],
	review: ['completed', 'needs_attention', 'in_progress'],
	completed: ['in_progress', 'archived'], // Reactivate or archive
	needs_attention: ['pending', 'in_progress', 'review', 'archived'], // Restart allowed + archive
	cancelled: ['pending', 'in_progress', 'archived'], // Restart or archive
	archived: [], // True terminal state — no going back
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
	 * List tasks belonging to a specific workflow run
	 */
	async listTasksByWorkflowRun(workflowRunId: string): Promise<SpaceTask[]> {
		return this.taskRepo.listByWorkflowRun(workflowRunId);
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
	 * Archive a task - transitions to 'archived' status and sets archivedAt timestamp.
	 * Validates that the current status allows transitioning to 'archived'.
	 */
	async archiveTask(taskId: string): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		if (!isValidSpaceTaskTransition(task.status, 'archived')) {
			throw new Error(
				`Cannot archive task in '${task.status}' status. ` +
					`Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
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
	 * Update task fields directly (non-status fields).
	 * For status transitions use setTaskStatus instead.
	 */
	async updateTask(taskId: string, params: UpdateSpaceTaskParams): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Status changes must go through setTaskStatus for transition validation
		if (params.status !== undefined && params.status !== task.status) {
			throw new Error('Use setTaskStatus to change task status — it enforces valid transitions');
		}

		// Strip status from the update params so the repo call is clean
		const { status: _status, ...repoParams } = params;
		const updated = this.taskRepo.updateTask(taskId, repoParams);
		if (!updated) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Retry a failed or cancelled task by resetting it to pending.
	 * Optionally updates the description on retry.
	 *
	 * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
	 */
	async retryTask(taskId: string, options?: { description?: string }): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const retryableStatuses: SpaceTaskStatus[] = ['needs_attention', 'cancelled', 'completed'];
		if (!retryableStatuses.includes(task.status)) {
			throw new Error(
				`Cannot retry task in '${task.status}' status. Task must be in 'needs_attention', 'cancelled', or 'completed' status.`
			);
		}

		// Transition to in_progress for completed/cancelled (reactivation), pending for needs_attention
		const targetStatus: SpaceTaskStatus =
			task.status === 'completed' || task.status === 'cancelled' ? 'in_progress' : 'pending';
		// Transition first — if this fails, the description is untouched (no partial state)
		// setTaskStatus handles clearing error/result/progress on transition
		const retried = await this.setTaskStatus(taskId, targetStatus);

		// Apply optional description update after successful status transition
		if (options?.description !== undefined) {
			return this.updateTask(taskId, { description: options.description });
		}

		return retried;
	}

	/**
	 * Reassign a task to a different agent.
	 * Only allowed for tasks in 'pending', 'needs_attention', or 'cancelled' status.
	 * Tasks in 'in_progress', 'review', 'completed', or 'draft' cannot be reassigned.
	 *
	 * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
	 */
	async reassignTask(
		taskId: string,
		customAgentId: string | null | undefined,
		assignedAgent?: 'coder' | 'general'
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const allowedStatuses: SpaceTaskStatus[] = [
			'pending',
			'needs_attention',
			'cancelled',
			'completed',
		];
		if (!allowedStatuses.includes(task.status)) {
			throw new Error(
				`Cannot reassign task in '${task.status}' status. Task must be in 'pending', 'needs_attention', 'cancelled', or 'completed' status.`
			);
		}

		const updates: UpdateSpaceTaskParams = {};
		// Only update customAgentId when explicitly provided (undefined = leave as-is)
		if (customAgentId !== undefined) {
			updates.customAgentId = customAgentId;
		}
		if (assignedAgent !== undefined) {
			updates.assignedAgent = assignedAgent;
		}

		return this.updateTask(taskId, updates);
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
