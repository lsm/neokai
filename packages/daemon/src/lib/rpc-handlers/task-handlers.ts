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

import type { MessageHub, TaskStatus, TaskPriority } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { RoomManager } from '../room/room-manager';
import { TaskManager } from '../room';

/**
 * Create a TaskManager instance for a room
 */
function createTaskManager(db: Database, roomId: string): TaskManager {
	const rawDb = db.getDatabase();
	return new TaskManager(rawDb, roomId);
}

export function setupTaskHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	db: Database
): void {
	/**
	 * Emit room.task.update event to notify UI clients
	 */
	const emitTaskUpdate = (
		roomId: string,
		task: {
			id: string;
			roomId: string;
			title: string;
			status: TaskStatus;
			priority: TaskPriority;
			progress?: number;
			currentStep?: string;
			result?: string;
			error?: string;
			dependsOn: string[];
			createdAt: number;
			startedAt?: number;
			completedAt?: number;
			sessionId?: string;
			description: string;
		}
	) => {
		daemonHub
			.emit('room.task.update', {
				sessionId: `room:${roomId}`,
				roomId,
				task: task as typeof task & { roomId: string },
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit room.overview event to notify UI clients of full room state
	 */
	const emitRoomOverview = (roomId: string) => {
		const overview = roomManager.getRoomOverview(roomId);
		if (overview) {
			daemonHub
				.emit('room.overview', {
					sessionId: `room:${roomId}`,
					room: overview.room,
					sessions: overview.sessions,
					activeTasks: overview.activeTasks as Array<{
						id: string;
						roomId: string;
						title: string;
						status: TaskStatus;
						priority: TaskPriority;
						progress?: number;
						currentStep?: string;
						result?: string;
						error?: string;
						dependsOn: string[];
						createdAt: number;
						startedAt?: number;
						completedAt?: number;
						sessionId?: string;
						description: string;
					}>,
				})
				.catch(() => {
					// Event emission error - non-critical, continue
				});
		}
	};

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

		// Emit room.overview for new task creation (significant change)
		emitRoomOverview(params.roomId);

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

		// Emit task update event
		if (task) {
			emitTaskUpdate(params.roomId, task);
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

		// Emit task update event (status change from pending to in_progress)
		if (task) {
			emitTaskUpdate(params.roomId, task);
		}

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

		// Emit room overview for task completion (significant status change)
		emitRoomOverview(params.roomId);

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

		// Emit room overview for task failure (significant status change)
		emitRoomOverview(params.roomId);

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

		// Emit room overview for task deletion (significant change)
		emitRoomOverview(params.roomId);

		return { success: deleted };
	});
}
