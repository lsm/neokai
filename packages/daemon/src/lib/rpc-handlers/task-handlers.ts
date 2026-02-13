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
import type { RoomManager } from '../neo/room-manager';
import type { Database } from '../../storage/database';
import type { RoomNeo } from '../neo/room-neo';

/**
 * Registry of active RoomNeo instances
 * Shared with memory-handlers and neo-message-handlers via getOrCreateRoomNeo
 */
const neoInstances = new Map<string, RoomNeo>();

/**
 * Get or create a RoomNeo instance for a room
 * Exported for sharing with memory-handlers and neo-message-handlers
 */
export async function getOrCreateRoomNeo(
	roomId: string,
	daemonHub: DaemonHub,
	db: Database,
	roomManager: RoomManager
): Promise<RoomNeo> {
	let neo = neoInstances.get(roomId);
	if (!neo) {
		const { RoomNeo: RoomNeoClass } = await import('../neo/room-neo');
		const room = roomManager.getRoom(roomId);
		if (!room) {
			throw new Error(`Room not found: ${roomId}`);
		}
		neo = new RoomNeoClass(roomId, daemonHub, db, {
			workspacePath: room.defaultWorkspace,
			model: room.defaultModel,
		});
		await neo.initialize();
		neoInstances.set(roomId, neo);
	}
	return neo;
}

export function setupTaskHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const task = await neo.getTaskManager().createTask({
			title: params.title,
			description: params.description ?? '',
			priority: params.priority,
			dependsOn: params.dependsOn,
		});

		// Broadcast task creation event
		daemonHub
			.emit('task.created', {
				sessionId: 'global',
				roomId: params.roomId,
				taskId: task.id,
				task,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const tasks = await neo.getTaskManager().listTasks({
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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const task = await neo.getTaskManager().getTask(params.taskId);

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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const taskManager = neo.getTaskManager();

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

		// Broadcast task update event
		daemonHub
			.emit('task.updated', {
				sessionId: 'global',
				roomId: params.roomId,
				taskId: task.id,
				task,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const task = await neo.getTaskManager().startTask(params.taskId, params.sessionId);

		// Broadcast task update event
		daemonHub
			.emit('task.updated', {
				sessionId: 'global',
				roomId: params.roomId,
				taskId: task.id,
				task,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const task = await neo.getTaskManager().completeTask(params.taskId, params.result ?? '');

		// Broadcast task update event
		daemonHub
			.emit('task.updated', {
				sessionId: 'global',
				roomId: params.roomId,
				taskId: task.id,
				task,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const task = await neo.getTaskManager().failTask(params.taskId, params.error ?? '');

		// Broadcast task update event
		daemonHub
			.emit('task.updated', {
				sessionId: 'global',
				roomId: params.roomId,
				taskId: task.id,
				task,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

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

		const neo = await getOrCreateRoomNeo(params.roomId, daemonHub, db, roomManager);
		const deleted = await neo.getTaskManager().deleteTask(params.taskId);

		return { success: deleted };
	});
}
