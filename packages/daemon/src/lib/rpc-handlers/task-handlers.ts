/**
 * Task RPC Handlers
 *
 * RPC handlers for Neo task operations:
 * - task.create - Create task in room
 * - task.list - List tasks in room
 * - task.get - Get task details
 * - task.fail - Fail a task (used by tests to simulate failure)
 * - task.getGroup - Get session group for a task
 * - task.getGroupMessages - Get messages for a session group
 * - task.sendHumanMessage - Send a human message to the active agent in a task group
 */

import type { MessageHub, NeoTask, TaskPriority, TaskStatus } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { RoomManager } from '../room/managers/room-manager';
import type { RoomRuntimeService } from '../room/runtime/room-runtime-service';
import { TaskManager } from '../room/managers/task-manager';
import { SessionGroupRepository } from '../room/state/session-group-repository';
import { routeHumanMessageToGroup } from '../room/runtime/human-message-routing';
import { Logger } from '../logger';

const log = new Logger('task-handlers');

export type TaskManagerLike = Pick<
	TaskManager,
	'createTask' | 'getTask' | 'listTasks' | 'failTask'
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
	taskManagerFactory: TaskManagerFactory = createTaskManager,
	runtimeService?: RoomRuntimeService
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
					allTasks: overview.allTasks,
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

		emitTaskUpdate(params.roomId, task);
		emitRoomOverview(params.roomId);

		return { task };
	});

	// task.getGroup - Get the active session group (Craft + Lead sessions) for a task
	messageHub.onRequest('task.getGroup', async (data) => {
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
			return { group: null };
		}

		return {
			group: {
				id: group.id,
				taskId: group.taskId,
				workerSessionId: group.workerSessionId,
				leaderSessionId: group.leaderSessionId,
				state: group.state,
				feedbackIteration: group.feedbackIteration,
				approved: group.approved,
				createdAt: group.createdAt,
				completedAt: group.completedAt,
			},
		};
	});

	// task.getGroupMessages - Get messages for a session group
	messageHub.onRequest('task.getGroupMessages', async (data) => {
		const params = data as { groupId: string; afterId?: number; limit?: number };

		if (!params.groupId) {
			throw new Error('Group ID is required');
		}

		const groupRepo = new SessionGroupRepository(db.getDatabase());
		const result = groupRepo.getMessages(params.groupId, {
			afterId: params.afterId,
			limit: params.limit,
		});

		return { messages: result.messages, hasMore: result.hasMore };
	});

	// task.sendHumanMessage - Send a human message to the active agent in a task group
	messageHub.onRequest('task.sendHumanMessage', async (data) => {
		const params = data as { roomId: string; taskId: string; message: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}
		if (!params.message) {
			throw new Error('Message is required');
		}
		if (!params.message.trim()) {
			throw new Error('Message cannot be empty');
		}
		if (!runtimeService) {
			throw new Error('Runtime service is required for task.sendHumanMessage');
		}

		const runtime = runtimeService.getRuntime(params.roomId);
		if (!runtime) {
			throw new Error(`No runtime found for room: ${params.roomId}`);
		}

		// Cross-room ownership check: verify the task belongs to this room.
		// TaskManager is room-scoped, so getTask() returns null for tasks in other rooms.
		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task ${params.taskId} not found in room ${params.roomId}`);
		}

		const groupRepo = new SessionGroupRepository(db.getDatabase());
		const result = await routeHumanMessageToGroup(
			runtime,
			groupRepo,
			params.taskId,
			params.message
		);

		if (!result.success) {
			throw new Error(result.error ?? 'Failed to send human message');
		}

		return { success: true };
	});
}
