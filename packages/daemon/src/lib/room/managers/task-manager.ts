/**
 * TaskManager - Task management with status transitions
 *
 * Handles:
 * - Creating tasks
 * - Listing and filtering tasks
 * - Status transitions (draft -> pending -> in_progress -> completed/failed/cancelled/review)
 * - Task assignment to sessions
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { TaskRepository } from '../../../storage/repositories/task-repository';
import type {
	NeoTask,
	TaskStatus,
	TaskPriority,
	TaskFilter,
	CreateTaskParams,
	AgentType,
} from '@neokai/shared';

export class TaskManager {
	private taskRepo: TaskRepository;

	constructor(
		private db: BunDatabase,
		private roomId: string
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
	 * Fail task
	 */
	async failTask(taskId: string, error: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'failed', {
			error,
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
		return this.updateTaskStatus(taskId, 'review', {
			currentStep: prUrl,
			progress: 80,
		});
	}

	/**
	 * Promote all draft tasks created by a planning task to pending.
	 * Called when a planning task completes so its children enter the execution queue.
	 */
	async promoteDraftTasks(creatorTaskId: string): Promise<number> {
		return this.taskRepo.promoteDraftTasksByCreator(creatorTaskId);
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
			return (await this.getTask(taskId))!;
		}

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
		return true;
	}

	/**
	 * Update task fields (title, description, priority) without changing status.
	 * Works for tasks in any status — used by the room agent.
	 */
	async updateTaskFields(
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			priority?: TaskPriority;
		}
	): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updatedTask = this.taskRepo.updateTask(taskId, updates);
		if (!updatedTask) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

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
