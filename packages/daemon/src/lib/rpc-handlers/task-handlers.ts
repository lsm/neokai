/**
 * Task RPC Handlers
 *
 * RPC handlers for Neo task operations:
 * - task.list - List tasks in room
 * - task.fail - Fail a task (used by tests to simulate failure)
 * - task.getGroup - Get session group for a task
 * - task.getGroupMessages - Get messages for a session group
 */

import type { MessageHub, NeoTask, TaskPriority, TaskStatus } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { RoomManager } from '../room/managers/room-manager';
import { TaskManager } from '../room';
import { SessionGroupRepository } from '../room/state/session-group-repository';
import { Logger } from '../logger';

const log = new Logger('task-handlers');

export type TaskManagerLike = Pick<TaskManager, 'listTasks' | 'failTask'>;

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
					allTasks: overview.allTasks,
				})
				.catch((error) => {
					log.warn(`Failed to emit room.overview for room ${roomId}:`, error);
				});
		}
	};

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
}
