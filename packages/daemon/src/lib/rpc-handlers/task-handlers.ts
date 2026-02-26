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
 * - task.escalate - Escalate a task (needs human input)
 * - task.deescalate - De-escalate a task (return to pending)
 * - task.delete - Delete a task
 *
 * Renamed from neo.task.* to task.* for cleaner API.
 */

import type { MessageHub, NeoTask, TaskPriority, TaskStatus } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { RoomManager } from '../room/room-manager';
import { TaskManager } from '../room';
import { SessionGroupRepository } from '../room/session-group-repository';
import { Logger } from '../logger';

const log = new Logger('task-handlers');

export type TaskManagerLike = Pick<
	TaskManager,
	| 'createTask'
	| 'getTask'
	| 'listTasks'
	| 'updateTaskStatus'
	| 'updateTaskProgress'
	| 'startTask'
	| 'completeTask'
	| 'failTask'
	| 'escalateTask'
	| 'deescalateTask'
	| 'deleteTask'
>;

export type TaskManagerFactory = (db: Database, roomId: string) => TaskManagerLike;

/**
 * Create a TaskManager instance for a room
 */
function createTaskManager(db: Database, roomId: string): TaskManagerLike {
	const rawDb = db.getDatabase();
	return new TaskManager(rawDb, roomId);
}

export function setupTaskHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	db: Database,
	taskManagerFactory: TaskManagerFactory = createTaskManager
): void {
	/**
	 * Emit room.task.update event to notify UI clients
	 */
	const emitTaskUpdate = (roomId: string, task: NeoTask) => {
		daemonHub
			.emit('room.task.update', {
				sessionId: `room:${roomId}`,
				roomId,
				task,
			})
			.catch((error) => {
				log.warn(`Failed to emit room.task.update for room ${roomId}:`, error);
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
					activeTasks: overview.activeTasks,
				})
				.catch((error) => {
					log.warn(`Failed to emit room.overview for room ${roomId}:`, error);
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

		const taskManager = taskManagerFactory(db, params.roomId);
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
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const tasks = await taskManager.listTasks({
			status: params.status,
			priority: params.priority,
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

		const taskManager = taskManagerFactory(db, params.roomId);
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

		const taskManager = taskManagerFactory(db, params.roomId);

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

	// task.start - Start a task (mark as in_progress)
	messageHub.onRequest('task.start', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.startTask(params.taskId);

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

		const taskManager = taskManagerFactory(db, params.roomId);
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

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.failTask(params.taskId, params.error ?? '');

		// Emit room overview for task failure (significant status change)
		emitRoomOverview(params.roomId);

		return { task };
	});

	// task.escalate - Escalate a task (needs human input)
	messageHub.onRequest('task.escalate', async (data) => {
		const params = data as { roomId: string; taskId: string; reason?: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.escalateTask(params.taskId, params.reason);

		emitTaskUpdate(params.roomId, task);

		return { task };
	});

	// task.deescalate - De-escalate a task (return to pending)
	messageHub.onRequest('task.deescalate', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.deescalateTask(params.taskId);

		emitTaskUpdate(params.roomId, task);

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

		const taskManager = taskManagerFactory(db, params.roomId);
		const deleted = await taskManager.deleteTask(params.taskId);

		// Emit room overview for task deletion (significant change)
		emitRoomOverview(params.roomId);

		return { success: deleted };
	});

	// task.getPair - Get the active session group (Craft + Lead sessions) for a task
	messageHub.onRequest('task.getPair', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const groupRepo = new SessionGroupRepository(db.getDatabase());
		const group = groupRepo.getGroupByTaskId(params.taskId);

		if (!group) {
			return { pair: null };
		}

		return {
			pair: {
				id: group.id,
				taskId: group.taskId,
				craftSessionId: group.craftSessionId,
				leadSessionId: group.leadSessionId,
				state: group.state,
				feedbackIteration: group.feedbackIteration,
				createdAt: group.createdAt,
				completedAt: group.completedAt,
			},
		};
	});
}
