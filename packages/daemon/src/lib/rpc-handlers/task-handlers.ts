/**
 * Task RPC Handlers
 *
 * RPC handlers for Neo task operations:
 * - task.create - Create task in room
 * - task.list - List tasks in room
 * - task.get - Get task details
 * - task.update - Update task
 * - task.start - Start a task (assign to session)
 * - task.complete - Complete a task
 * - task.fail - Fail a task
 * - task.delete - Delete a task
 *
 * Renamed from neo.task.* to task.* for cleaner API.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub, TaskStatus, TaskPriority } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import { TaskManager } from '../room';

/**
 * Create a TaskManager instance for a room
 */
function createTaskManager(db: Database, roomId: string): TaskManager {
	const rawDb = (db as unknown as { db: BunDatabase }).db;
	return new TaskManager(rawDb, roomId);
}

export function setupTaskHandlers(
	messageHub: MessageHub,
	_roomManager: unknown,
	_daemonHub: DaemonHub,
	db: Database
): void {
	// task.create - Create task in room
	messageHub.onRequest('task.create', async (data) => {
		const params = data as {
			roomId: string;
			title: string;
			description: string;
			priority?: TaskPriority;
			dependsOn?: string[];
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.title) {
			throw new Error('Task title is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const task = await taskManager.createTask({
			title: params.title,
			description: params.description ?? '',
			priority: params.priority,
			dependsOn: params.dependsOn,
		});

		return { task };
	});

	// task.list - List tasks in room
	messageHub.onRequest('task.list', async (data) => {
		const params = data as {
			roomId: string;
			status?: TaskStatus;
			priority?: TaskPriority;
			sessionId?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const tasks = await taskManager.listTasks({
			status: params.status,
			priority: params.priority,
			sessionId: params.sessionId,
		});

		return { tasks };
	});

	// task.get - Get task details
	messageHub.onRequest('task.get', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const task = await taskManager.getTask(params.taskId);

		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		return { task };
	});

	// task.update - Update task
	messageHub.onRequest('task.update', async (data) => {
		const params = data as {
			roomId: string;
			taskId: string;
			status?: TaskStatus;
			progress?: number;
			currentStep?: string;
			result?: string;
			error?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);

		let task;
		if (params.status) {
			task = await taskManager.updateTaskStatus(params.taskId, params.status, {
				progress: params.progress,
				currentStep: params.currentStep,
				result: params.result,
				error: params.error,
			});
		} else if (params.progress !== undefined) {
			task = await taskManager.updateTaskProgress(
				params.taskId,
				params.progress,
				params.currentStep
			);
		} else {
			throw new Error('No update fields provided');
		}

		return { task };
	});

	// task.start - Start a task (assign to session)
	messageHub.onRequest('task.start', async (data) => {
		const params = data as { roomId: string; taskId: string; sessionId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!params.sessionId) {
			throw new Error('Session ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const task = await taskManager.startTask(params.taskId, params.sessionId);

		return { task };
	});

	// task.complete - Complete a task
	messageHub.onRequest('task.complete', async (data) => {
		const params = data as { roomId: string; taskId: string; result: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const task = await taskManager.completeTask(params.taskId, params.result ?? '');

		return { task };
	});

	// task.fail - Fail a task
	messageHub.onRequest('task.fail', async (data) => {
		const params = data as { roomId: string; taskId: string; error: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const task = await taskManager.failTask(params.taskId, params.error ?? '');

		return { task };
	});

	// task.delete - Delete a task
	messageHub.onRequest('task.delete', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = createTaskManager(db, params.roomId);
		const deleted = await taskManager.deleteTask(params.taskId);

		return { success: deleted };
	});
}
