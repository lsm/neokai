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
 * - task.review - Move a task to review (awaiting human approval)
 * - task.approve - Approve a reviewed task (human approval, promotes planning drafts)
 * - task.delete - Delete a task
 *
 * Renamed from neo.task.* to task.* for cleaner API.
 */

import type { MessageHub, NeoTask, TaskPriority, TaskStatus } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { RoomManager } from '../room/managers/room-manager';
import { TaskManager } from '../room';
import { SessionGroupRepository } from '../room/state/session-group-repository';
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
	| 'reviewTask'
	| 'approveTask'
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

		emitTaskUpdate(params.roomId, task);
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

		emitTaskUpdate(params.roomId, task);
		emitRoomOverview(params.roomId);

		return { task };
	});

	// task.review - Move a task to review (awaiting human approval)
	messageHub.onRequest('task.review', async (data) => {
		const params = data as { roomId: string; taskId: string; prUrl?: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.reviewTask(params.taskId, params.prUrl);

		emitTaskUpdate(params.roomId, task);

		return { task };
	});

	// task.approve - Approve a task in review status (human approval)
	// For planning tasks, this promotes draft children to pending
	messageHub.onRequest('task.approve', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const { task, promotedCount } = await taskManager.approveTask(params.taskId);

		emitTaskUpdate(params.roomId, task);
		emitRoomOverview(params.roomId);

		if (promotedCount > 0) {
			log.info(
				`Approved planning task ${params.taskId}: promoted ${promotedCount} draft task(s) to pending`
			);
			// Emit updates for promoted tasks so UI reflects the change
			const pendingTasks = await taskManager.listTasks({ status: 'pending' });
			for (const t of pendingTasks) {
				emitTaskUpdate(params.roomId, t);
			}
		}

		return { task, promotedCount };
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
