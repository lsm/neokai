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
import { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';
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
			includeArchived?: boolean;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const tasks = await taskManager.listTasks({
			status: params.status,
			priority: params.priority,
			includeArchived: params.includeArchived,
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

	// task.getGroupMessages - Get a unified timeline for a session group
	messageHub.onRequest('task.getGroupMessages', async (data) => {
		const params = data as { groupId: string; afterId?: number; cursor?: string; limit?: number };

		if (!params.groupId) {
			throw new Error('Group ID is required');
		}

		const groupRepo = new SessionGroupRepository(db.getDatabase());
		const group = groupRepo.getGroup(params.groupId);
		if (!group) {
			return { messages: [], hasMore: false };
		}

		const sdkRepo = new SDKMessageRepository(db.getDatabase());
		const fetchAllSessionMessages = (sessionId: string): unknown[] => {
			const pageSize = 500;
			let before: number | undefined;
			const all: unknown[] = [];
			while (true) {
				const page = sdkRepo.getSDKMessages(sessionId, pageSize, before);
				if (page.messages.length === 0) break;
				all.unshift(...page.messages);
				if (!page.hasMore) break;
				const oldest = page.messages[0] as { timestamp?: number };
				if (typeof oldest.timestamp !== 'number') break;
				before = oldest.timestamp;
			}
			return all;
		};
		const workerMessages = fetchAllSessionMessages(group.workerSessionId);
		const leaderMessages = fetchAllSessionMessages(group.leaderSessionId);

		const toEnrichedTimeline = (messages: unknown[], sessionId: string, role: string) => {
			const shortSessionId = sessionId.slice(0, 8);
			return messages.map((message, idx) => {
				const messageObj = message as Record<string, unknown>;
				const timestamp =
					typeof messageObj.timestamp === 'number' ? messageObj.timestamp : Date.now();
				const uuid = typeof messageObj.uuid === 'string' ? messageObj.uuid : `${idx}`;
				const turnId = `turn_${group.id}_${group.feedbackIteration}_${shortSessionId}_${uuid}`;
				const { sendStatus: _sendStatus, ...messageWithoutSendStatus } = messageObj;
				const enriched = {
					...messageWithoutSendStatus,
					_taskMeta: {
						authorRole: role,
						authorSessionId: sessionId,
						turnId,
						iteration: group.feedbackIteration,
					},
				};
				const sourceKey = `sdk:${sessionId}:${uuid}`;
				return {
					createdAt: timestamp,
					sourceKey,
					groupId: group.id,
					sessionId,
					role,
					messageType: typeof messageObj.type === 'string' ? messageObj.type : 'unknown',
					content: JSON.stringify(enriched),
				};
			});
		};

		const fetchAllGroupEvents = (groupId: string) => {
			const pageSize = 500;
			let afterId = 0;
			const all = [] as ReturnType<SessionGroupRepository['getEvents']>['events'];
			while (true) {
				const page = groupRepo.getEvents(groupId, { limit: pageSize, afterId });
				all.push(...page.events);
				if (!page.hasMore || page.events.length === 0) break;
				afterId = page.events[page.events.length - 1].id;
			}
			return all;
		};
		const groupEvents = fetchAllGroupEvents(group.id);

		const merged = [
			...toEnrichedTimeline(workerMessages as unknown[], group.workerSessionId, group.workerRole),
			...toEnrichedTimeline(leaderMessages as unknown[], group.leaderSessionId, 'leader'),
			...groupEvents.map((event) => {
				let text = event.kind;
				if (event.payloadJson) {
					try {
						const parsed = JSON.parse(event.payloadJson) as { text?: string };
						if (parsed.text) text = parsed.text;
					} catch {
						// keep default text
					}
				}
				return {
					createdAt: event.createdAt,
					sourceKey: `event:${event.id}`,
					groupId: event.groupId,
					sessionId: null,
					role: 'system',
					messageType: 'status',
					content: text,
				};
			}),
		]
			.sort((a, b) => {
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				return a.sourceKey.localeCompare(b.sourceKey);
			})
			.map((msg) => ({
				cursor: `${String(msg.createdAt).padStart(16, '0')}|${msg.sourceKey}`,
				...msg,
			}));

		const limit = params.limit ?? 100;
		const cursor = params.cursor;
		const filtered = cursor
			? merged.filter((m) => m.cursor > cursor)
			: params.afterId != null
				? merged.slice(params.afterId)
				: merged;
		const page = filtered.slice(0, limit + 1);
		const hasMore = page.length > limit;
		const messages = page.slice(0, limit).map((msg, idx) => ({
			id: idx + 1,
			groupId: msg.groupId,
			sessionId: msg.sessionId,
			role: msg.role,
			messageType: msg.messageType,
			content: msg.content,
			createdAt: msg.createdAt,
		}));
		const nextCursor = messages.length > 0 ? page[messages.length - 1].cursor : null;

		return { messages, hasMore, nextCursor };
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
		if (params.message.length > 10_000) {
			throw new Error('Message is too long (max 10,000 characters)');
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
			params.message.trim(),
			messageHub
		);

		if (!result.success) {
			throw new Error(result.error ?? 'Failed to send human message');
		}

		return { success: true };
	});

	// task.archive - Archive a task
	messageHub.onRequest('task.archive', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.archiveTask(params.taskId);

		emitTaskUpdate(params.roomId, task);
		emitRoomOverview(params.roomId);

		return { task };
	});

	// task.unarchive - Unarchive a task
	messageHub.onRequest('task.unarchive', async (data) => {
		const params = data as { roomId: string; taskId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.taskId) {
			throw new Error('Task ID is required');
		}

		const taskManager = taskManagerFactory(db, params.roomId);
		const task = await taskManager.unarchiveTask(params.taskId);

		emitTaskUpdate(params.roomId, task);
		emitRoomOverview(params.roomId);

		return { task };
	});
}
