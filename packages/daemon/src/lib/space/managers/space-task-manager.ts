/**
 * SpaceTaskManager - Space task management with status transitions
 *
 * Handles:
 * - Creating space tasks with dependency validation
 * - Status transitions (open -> in_progress -> done/blocked/cancelled -> archived)
 * - Task assignment and progress tracking
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
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
	open: ['in_progress', 'blocked', 'done', 'cancelled'],
	in_progress: ['open', 'review', 'done', 'blocked', 'cancelled'],
	review: ['done', 'in_progress', 'cancelled', 'archived'], // Approve, reopen, cancel, or archive
	done: ['in_progress', 'archived'], // Reactivate or archive
	blocked: ['open', 'in_progress', 'archived'], // Restart allowed + archive
	cancelled: ['open', 'in_progress', 'done', 'archived'], // Restart, complete, or archive
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
		private spaceId: string,
		private reactiveDb?: ReactiveDatabase
	) {
		this.taskRepo = new SpaceTaskRepository(db, reactiveDb);
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
	 * Get a task by its space-scoped numeric ID (e.g. task #5)
	 */
	async getTaskByNumber(taskNumber: number): Promise<SpaceTask | null> {
		return this.taskRepo.getTaskByNumber(this.spaceId, taskNumber);
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
		options?: { result?: string }
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

		if (newStatus === 'done' || newStatus === 'blocked') {
			if (options?.result) updates.result = options.result;
		}

		// Clear result when restarting or deprioritizing.
		// Covers blocked, cancelled, done → reactivation, and in_progress → open (pause).
		if (
			(task.status === 'blocked' && (newStatus === 'open' || newStatus === 'in_progress')) ||
			(task.status === 'cancelled' && (newStatus === 'open' || newStatus === 'in_progress')) ||
			(task.status === 'done' && newStatus === 'in_progress') ||
			(task.status === 'in_progress' && newStatus === 'open')
		) {
			updates.result = null;
		}

		const updated = this.taskRepo.updateTask(taskId, updates);
		if (!updated) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updated;
	}

	// updateTaskProgress has been removed — progress tracking moved to node-level executions

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
		return this.setTaskStatus(taskId, 'done', { result });
	}

	/**
	 * Fail a task (mark as blocked)
	 */
	async failTask(taskId: string, error?: string): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'blocked', error ? { result: error } : undefined);
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

		const pendingTasks = await this.listTasksByStatus('open');
		for (const t of pendingTasks) {
			if (t.dependsOn?.includes(taskId)) {
				await this.doCancelCascade(t.id, acc);
			}
		}

		return acc;
	}

	/**
	 * Submit PR for a task (records PR metadata while keeping task in_progress).
	 * Note: 'review' status no longer exists — PR submission is now tracked via prUrl/prNumber fields.
	 */
	async reviewTask(taskId: string, prUrl?: string): Promise<SpaceTask> {
		// Apply PR metadata
		const prUpdates: Parameters<SpaceTaskRepository['updateTask']>[1] = {};

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
	 * Retry a failed, cancelled, or done task.
	 * Done/cancelled tasks are reactivated to in_progress; blocked tasks reset to open.
	 * Optionally updates the description on retry.
	 *
	 * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
	 */
	async retryTask(taskId: string, options?: { description?: string }): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const retryableStatuses: SpaceTaskStatus[] = ['blocked', 'cancelled', 'done'];
		if (!retryableStatuses.includes(task.status)) {
			throw new Error(
				`Cannot retry task in '${task.status}' status. Task must be in 'blocked', 'cancelled', or 'done' status.`
			);
		}

		// Transition to in_progress for done/cancelled (reactivation), open for blocked
		const targetStatus: SpaceTaskStatus =
			task.status === 'done' || task.status === 'cancelled' ? 'in_progress' : 'open';
		// Transition first — if this fails, the description is untouched (no partial state)
		const retried = await this.setTaskStatus(taskId, targetStatus);

		// Apply optional description update after successful status transition
		if (options?.description !== undefined) {
			return this.updateTask(taskId, { description: options.description });
		}

		return retried;
	}

	/**
	 * Reassign a task to a different agent.
	 * Only allowed for tasks in 'open', 'blocked', 'cancelled', or 'done' status.
	 *
	 * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
	 * TODO: Update callers to use new status values — customAgentId/assignedAgent fields removed.
	 */
	async reassignTask(
		taskId: string,
		_customAgentId?: string | null,
		_assignedAgent?: string
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const allowedStatuses: SpaceTaskStatus[] = ['open', 'blocked', 'cancelled', 'done'];
		if (!allowedStatuses.includes(task.status)) {
			throw new Error(
				`Cannot reassign task in '${task.status}' status. Task must be in 'open', 'blocked', 'cancelled', or 'done' status.`
			);
		}

		// Agent assignment fields removed from SpaceTask — return task unchanged
		return task;
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
			if (!dep || dep.status !== 'done') {
				return false;
			}
		}

		return true;
	}
}
