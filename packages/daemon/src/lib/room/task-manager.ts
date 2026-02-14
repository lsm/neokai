/**
 * TaskManager - Task management with status transitions
 *
 * Handles:
 * - Creating tasks
 * - Listing and filtering tasks
 * - Status transitions (pending -> in_progress -> completed/failed)
 * - Task assignment to sessions
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { NeoTaskRepository } from '../../storage/repositories/task-repository';
import type {
	NeoTask,
	TaskStatus,
	TaskPriority,
	TaskFilter,
	CreateTaskParams,
} from '@neokai/shared';

export class TaskManager {
	private taskRepo: NeoTaskRepository;

	constructor(
		private db: BunDatabase,
		private roomId: string
	) {
		this.taskRepo = new NeoTaskRepository(db);
	}

	/**
	 * Create task
	 */
	async createTask(params: Omit<CreateTaskParams, 'roomId'>): Promise<NeoTask> {
		const task = this.taskRepo.createTask({
			roomId: this.roomId,
			title: params.title,
			description: params.description,
			priority: params.priority,
			dependsOn: params.dependsOn,
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
	 * Start task (assign session)
	 */
	async startTask(taskId: string, sessionId: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'in_progress', {
			sessionId,
		});
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
	 * Block task
	 */
	async blockTask(taskId: string, reason?: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'blocked', {
			currentStep: reason,
		});
	}

	/**
	 * Unblock task (return to pending)
	 */
	async unblockTask(taskId: string): Promise<NeoTask> {
		return this.updateTaskStatus(taskId, 'pending', {
			currentStep: undefined,
		});
	}

	/**
	 * Get pending tasks count
	 */
	async getPendingCount(): Promise<number> {
		return this.taskRepo.countTasksByStatus(this.roomId, 'pending');
	}

	/**
	 * Get active (in_progress) tasks count
	 */
	async getActiveCount(): Promise<number> {
		return this.taskRepo.countTasksByStatus(this.roomId, 'in_progress');
	}

	/**
	 * Get all active tasks (non-completed, non-failed)
	 */
	async getActiveTasks(): Promise<NeoTask[]> {
		const tasks = await this.listTasks();
		return tasks.filter((t) => t.status !== 'completed' && t.status !== 'failed');
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
	 * Update task priority
	 */
	async updateTaskPriority(taskId: string, priority: TaskPriority): Promise<NeoTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updatedTask = this.taskRepo.updateTask(taskId, { priority });

		if (!updatedTask) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updatedTask;
	}

	/**
	 * Get next pending task (by priority)
	 */
	async getNextPendingTask(): Promise<NeoTask | null> {
		const pendingTasks = await this.listTasks({ status: 'pending' });

		if (pendingTasks.length === 0) {
			return null;
		}

		// Sort by priority: urgent > high > normal > low
		const priorityOrder: Record<TaskPriority, number> = {
			urgent: 0,
			high: 1,
			normal: 2,
			low: 3,
		};

		pendingTasks.sort((a, b) => {
			const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
			if (priorityDiff !== 0) return priorityDiff;
			return a.createdAt - b.createdAt; // Older first if same priority
		});

		// Check dependencies
		for (const task of pendingTasks) {
			if (await this.areDependenciesMet(task)) {
				return task;
			}
		}

		return null;
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
