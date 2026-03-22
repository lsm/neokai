/**
 * TaskManager - Task management with status transitions
 *
 * Handles:
 * - Creating tasks
 * - Listing and filtering tasks
 * - Status transitions (draft -> pending -> in_progress -> completed/needs_attention/cancelled/review -> archived)
 * - Task assignment to sessions
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { TaskRepository } from '../../../storage/repositories/task-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type {
	NeoTask,
	TaskStatus,
	TaskPriority,
	TaskFilter,
	CreateTaskParams,
	AgentType,
} from '@neokai/shared';

/**
 * Valid task status transitions
 * Maps current status -> allowed next statuses
 */
export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	draft: ['pending'],
	pending: ['in_progress', 'cancelled'],
	in_progress: ['review', 'completed', 'needs_attention', 'cancelled'],
	review: ['completed', 'needs_attention', 'in_progress'],
	completed: ['in_progress', 'archived'], // Reactivate or archive
	needs_attention: ['pending', 'in_progress', 'review', 'archived'], // Restart allowed + archive
	cancelled: ['pending', 'in_progress', 'completed', 'archived'], // Restart, complete, or archive
	archived: [], // True terminal state — no going back
};

/**
 * Parse PR URL to extract PR number.
 * Supports: https://github.com/org/repo/pull/123
 */
export function extractPrNumber(prUrl: string): number | null {
	const match = prUrl.match(/\/pull\/(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if a status transition is valid
 */
export function isValidStatusTransition(from: TaskStatus, to: TaskStatus): boolean {
	return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export class TaskManager {
	private taskRepo: TaskRepository;

	constructor(
		private db: BunDatabase,
		private roomId: string,
		private reactiveDb: ReactiveDatabase
	) {
		this.taskRepo = new TaskRepository(db);
	}

	/**
	 * Create task
	 */
	async createTask(params: Omit<CreateTaskParams, 'roomId'>): Promise<NeoTask> {
		// Validate that all dependency task IDs exist in this room
		if (params.dependsOn && params.dependsOn.length > 0) {
			for (const depId of params.dependsOn) {
				const depTask = await this.getTask(depId);
				if (!depTask) {
					throw new Error(`Dependency task not found in room: ${depId}`);
				}
			}
		}

		const task = this.taskRepo.createTask({
			roomId: this.roomId,
			title: params.title,
			description: params.description,
			priority: params.priority,
			dependsOn: params.dependsOn,
			taskType: params.taskType,
			assignedAgent: params.assignedAgent,
			status: params.status,
			createdByTaskId: params.createdByTaskId,
		});

		this.reactiveDb.notifyChange('tasks');
		return task;
	}

	/**
	 * Get task
	 */
	async getTask(taskId: string): Promise<NeoTask | null> {
		const task = this.taskRepo.getTask(taskId);
		if (task && task.roomId === this.roomId) {
			return task;
		}
		return null;
	}

	/**
	 * List tasks with filter
	 */
	async listTasks(filter?: TaskFilter): Promise<NeoTask[]> {
		return this.taskRepo.listTasks(this.roomId, filter);
	}

	/**
	 * Update task status
	 */
	async updateTaskStatus(
		taskId: string,
		status: TaskStatus,
		updates?: Partial<NeoTask>
	): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updatedTask = this.taskRepo.updateTask(taskId, {
			status,
			...updates,
		});

		if (!updatedTask) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		this.reactiveDb.notifyChange('tasks');
		return updatedTask;
	}

	/**
	 * Update task progress
	 */
	async updateTaskProgress(
		taskId: string,
		progress: number,
		currentStep?: string
	): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updatedTask = this.taskRepo.updateTask(taskId, {
			progress: Math.min(100, Math.max(0, progress)),
			currentStep,
		});

		if (!updatedTask) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		this.reactiveDb.notifyChange('tasks');
		return updatedTask;
	}

	/**
	 * Start task (mark as in_progress)
	 */
	async startTask(taskId: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'in_progress');
	}

	/**
	 * Complete task
	 */
	async completeTask(taskId: string, result: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'completed', {
			result,
			progress: 100,
		});
	}

	/**
	 * Set task status with validation.
	 * Validates that the transition is allowed before applying.
	 * Optionally clears error/result fields when restarting from failed/cancelled.
	 * Optionally sets result for completed status.
	 */
	async setTaskStatus(
		taskId: string,
		newStatus: TaskStatus,
		options?: { result?: string; error?: string; mode?: 'runtime' | 'manual' }
	): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Validate transition (skipped in manual mode — UI allows any transition)
		if (options?.mode !== 'manual' && !isValidStatusTransition(task.status, newStatus)) {
			throw new Error(
				`Invalid status transition from '${task.status}' to '${newStatus}'. ` +
					`Allowed transitions: ${VALID_STATUS_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
		}

		// Build updates based on new status
		const updates: Partial<NeoTask> = {};

		if (newStatus === 'completed') {
			updates.progress = 100;
			if (options?.result) {
				updates.result = options.result;
			}
		}

		if (newStatus === 'needs_attention') {
			if (options?.error) {
				updates.error = options.error;
			}
		}

		// Clear error/result/progress when restarting from a terminal/failed state.
		// Covers needs_attention, cancelled, completed → reactivation transitions.
		// In manual mode, also covers archived → active and completed → pending transitions.
		if (
			((task.status === 'needs_attention' || task.status === 'cancelled') &&
				(newStatus === 'pending' || newStatus === 'in_progress' || newStatus === 'review')) ||
			(task.status === 'completed' && newStatus === 'in_progress') ||
			(options?.mode === 'manual' &&
				(task.status === 'archived' ||
					task.status === 'completed' ||
					task.status === 'cancelled' ||
					task.status === 'needs_attention') &&
				(newStatus === 'pending' ||
					newStatus === 'in_progress' ||
					newStatus === 'review' ||
					newStatus === 'completed'))
		) {
			// Use null to explicitly clear these fields in the database
			updates.error = null;
			updates.result = null;
			updates.progress = null;
		}

		// When transitioning FROM archived (unarchiving), clear the archived_at timestamp
		if (task.status === 'archived') {
			updates.archivedAt = null;
		}

		return this.updateTaskStatus(taskId, newStatus, updates);
	}

	/**
	 * Fail task
	 */
	async failTask(taskId: string, error: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'needs_attention', {
			error,
		});
	}

	/**
	 * Reset task to pending for automatic re-spawn after daemon restart.
	 *
	 * Used during recovery when a group's sessions are lost and the task should
	 * be automatically re-queued rather than requiring human intervention.
	 * Directly sets status to 'pending' regardless of current status (bypasses
	 * state machine validation since 'in_progress → pending' is not a normal
	 * user-facing transition).
	 */
	async resetTaskToPending(taskId: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'pending', {
			error: null,
			result: null,
			progress: null,
		});
	}

	/**
	 * Cancel task (intentionally stopped, distinct from failure).
	 * Cascades cancellation to any pending tasks that depend on this task,
	 * since they can never be satisfied once their dependency is cancelled.
	 */
	async cancelTask(taskId: string): Promise<NeoTask> {
		const all = await this.cancelTaskCascade(taskId);
		return all[0];
	}

	/**
	 * Cancel task and cascade to pending dependents recursively.
	 * Returns all cancelled tasks (root first, then cascaded) so callers can
	 * emit update events for every affected task.
	 */
	async cancelTaskCascade(taskId: string): Promise<NeoTask[]> {
		return this.doCancelCascade(taskId, []);
	}

	private async doCancelCascade(taskId: string, acc: NeoTask[]): Promise<NeoTask[]> {
		const result = await this.updateTaskStatus(taskId, 'cancelled');
		acc.push(result);

		const pendingTasks = await this.listTasks({ status: 'pending' });
		for (const t of pendingTasks) {
			if (t.dependsOn?.includes(taskId)) {
				await this.doCancelCascade(t.id, acc);
			}
		}

		return acc;
	}

	/**
	 * Move task to review (work done, awaiting human approval)
	 */
	async reviewTask(taskId: string, prUrl?: string): Promise<NeoTask> {
		const updates: Partial<NeoTask> = {
			currentStep: prUrl ?? 'Awaiting review', // Keep for backward compatibility
			progress: 80,
		};

		// Only update PR fields when prUrl is explicitly provided.
		// When prUrl is omitted (e.g. runtime escalation), preserve any existing PR data.
		if (prUrl !== undefined) {
			updates.prUrl = prUrl;
			updates.prNumber = extractPrNumber(prUrl);
			updates.prCreatedAt = Date.now();
		}

		return this.updateTaskStatus(taskId, 'review', updates);
	}

	/**
	 * Promote all draft tasks created by a planning task to pending.
	 * Called when a planning task completes so its children enter the execution queue.
	 */
	async promoteDraftTasks(creatorTaskId: string): Promise<number> {
		const count = this.taskRepo.promoteDraftTasksByCreator(creatorTaskId);
		if (count > 0) {
			this.reactiveDb.notifyChange('tasks');
		}
		return count;
	}

	/**
	 * Update a draft task (only allowed for tasks in 'draft' status).
	 * Used by the Planner agent during plan polishing with Leader feedback.
	 */
	async updateDraftTask(
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			priority?: TaskPriority;
			assignedAgent?: AgentType;
		}
	): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}
		if (task.status !== 'draft') {
			throw new Error(
				`Can only update draft tasks, but task ${taskId} has status '${task.status}'`
			);
		}

		const updateParams: Record<string, unknown> = {};
		if (updates.title !== undefined) updateParams.title = updates.title;
		if (updates.description !== undefined) updateParams.description = updates.description;
		if (updates.priority !== undefined) updateParams.priority = updates.priority;

		const updatedTask = this.taskRepo.updateTask(taskId, updateParams);
		if (!updatedTask) {
			throw new Error(`Failed to update draft task: ${taskId}`);
		}

		// Handle assignedAgent separately since it's not in UpdateTaskParams
		if (updates.assignedAgent !== undefined) {
			this.db
				.prepare(`UPDATE tasks SET assigned_agent = ? WHERE id = ?`)
				.run(updates.assignedAgent, taskId);
			this.reactiveDb.notifyChange('tasks');
			return (await this.getTask(taskId))!;
		}

		this.reactiveDb.notifyChange('tasks');
		return updatedTask;
	}

	/**
	 * Remove a draft task (only allowed for tasks in 'draft' status).
	 * Used by the Planner agent during plan polishing with Leader feedback.
	 */
	async removeDraftTask(taskId: string): Promise<boolean> {
		const task = await this.getTask(taskId);
		if (!task) {
			return false;
		}
		if (task.status !== 'draft') {
			throw new Error(
				`Can only remove draft tasks, but task ${taskId} has status '${task.status}'`
			);
		}

		this.taskRepo.deleteTask(taskId);
		this.reactiveDb.notifyChange('tasks');
		return true;
	}

	/**
	 * Get all draft tasks created by a specific planning task.
	 * Used to build the plan envelope for Leader review.
	 */
	async getDraftTasksByCreator(creatorTaskId: string): Promise<NeoTask[]> {
		return this.taskRepo.getDraftTasksByCreator(creatorTaskId);
	}

	/**
	 * Cancel all pending tasks in the given list.
	 * Used during mid-execution replanning to clear stale plan.
	 *
	 * Note: each call to cancelTask cascades to pending dependents, so tasks
	 * outside the explicit list may also be cancelled if they depended on a
	 * task in the list. The return count reflects only directly-cancelled tasks.
	 */
	async cancelPendingTasks(taskIds: string[]): Promise<number> {
		let cancelled = 0;
		const alreadyCancelled = new Set<string>();
		for (const taskId of taskIds) {
			if (alreadyCancelled.has(taskId)) continue;
			const task = await this.getTask(taskId);
			if (task && task.status === 'pending') {
				const all = await this.cancelTaskCascade(taskId);
				for (const ct of all) {
					alreadyCancelled.add(ct.id);
				}
				cancelled++;
			}
		}
		return cancelled;
	}

	/**
	 * Delete task
	 */
	async deleteTask(taskId: string): Promise<boolean> {
		const task = await this.getTask(taskId);
		if (!task) {
			return false;
		}

		this.taskRepo.deleteTask(taskId);
		this.reactiveDb.notifyChange('tasks');
		return true;
	}

	/**
	 * Archive task - transitions to 'archived' status and sets archivedAt timestamp.
	 * Validates that the current status allows transitioning to 'archived'.
	 */
	async archiveTask(taskId: string, options?: { mode?: 'runtime' | 'manual' }): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		if (options?.mode !== 'manual' && !isValidStatusTransition(task.status, 'archived')) {
			throw new Error(
				`Cannot archive task in '${task.status}' status. ` +
					`Allowed transitions: ${VALID_STATUS_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
		}

		const updatedTask = this.taskRepo.archiveTask(taskId);
		if (!updatedTask) {
			throw new Error(`Failed to archive task: ${taskId}`);
		}

		this.reactiveDb.notifyChange('tasks');
		return updatedTask;
	}

	/**
	 * Update task fields (title, description, priority, dependsOn) without changing status.
	 * Works for tasks in any status — used by the room agent.
	 */
	async updateTaskFields(
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			priority?: TaskPriority;
			dependsOn?: string[];
		}
	): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Validate that all new dependency task IDs exist in this room
		if (updates.dependsOn && updates.dependsOn.length > 0) {
			for (const depId of updates.dependsOn) {
				const depTask = await this.getTask(depId);
				if (!depTask) {
					throw new Error(`Dependency task not found in room: ${depId}`);
				}
			}
		}

		const updatedTask = this.taskRepo.updateTask(taskId, updates);
		if (!updatedTask) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		this.reactiveDb.notifyChange('tasks');
		return updatedTask;
	}

	/**
	 * Check if all dependencies for a task are met (completed)
	 */
	async areDependenciesMet(task: NeoTask): Promise<boolean> {
		if (!task.dependsOn || task.dependsOn.length === 0) {
			return true;
		}

		for (const depId of task.dependsOn) {
			const depTask = await this.getTask(depId);
			if (!depTask || depTask.status !== 'completed') {
				return false;
			}
		}

		return true;
	}
}
