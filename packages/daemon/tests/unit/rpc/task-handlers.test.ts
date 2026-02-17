/**
 * Tests for Task RPC Handlers
 *
 * Tests the RPC handlers for task operations:
 * - task.create - Create a task in a room
 * - task.list - List tasks in a room
 * - task.get - Get task details
 * - task.update - Update a task
 * - task.start - Start a task (assign to session)
 * - task.complete - Complete a task
 * - task.fail - Fail a task
 * - task.delete - Delete a task
 *
 * Mocks TaskManager to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type NeoTask, type TaskPriority, type TaskStatus } from '@neokai/shared';
import {
	setupTaskHandlers,
	type TaskManagerLike,
} from '../../../src/lib/rpc-handlers/task-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { RoomManager } from '../../../src/lib/room/room-manager';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock TaskManager module
const mockTaskManager = {
	createTask: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				description: 'Test description',
				status: 'pending' as TaskStatus,
				priority: 'medium' as TaskPriority,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}) as NeoTask
	),
	getTask: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				description: 'Test description',
				status: 'pending' as TaskStatus,
				priority: 'medium' as TaskPriority,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}) as NeoTask
	),
	listTasks: mock(async () => [] as NeoTask[]),
	updateTaskStatus: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				status: 'in_progress' as TaskStatus,
				updatedAt: Date.now(),
			}) as NeoTask
	),
	updateTaskProgress: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				progress: 50,
				currentStep: 'Processing',
				updatedAt: Date.now(),
			}) as NeoTask
	),
	startTask: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				status: 'in_progress' as TaskStatus,
				sessionId: 'session-123',
				startedAt: Date.now(),
				updatedAt: Date.now(),
			}) as NeoTask
	),
	completeTask: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				status: 'completed' as TaskStatus,
				result: 'Task completed successfully',
				completedAt: Date.now(),
				updatedAt: Date.now(),
			}) as NeoTask
	),
	failTask: mock(
		async () =>
			({
				id: 'task-123',
				roomId: 'room-123',
				title: 'Test Task',
				status: 'failed' as TaskStatus,
				error: 'Task failed',
				failedAt: Date.now(),
				updatedAt: Date.now(),
			}) as NeoTask
	),
	deleteTask: mock(async () => true),
};

const createMockTaskManager = (): TaskManagerLike => mockTaskManager as unknown as TaskManagerLike;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

// Helper to create mock RoomManager
function createMockRoomManager(): {
	roomManager: RoomManager;
	getRoomOverview: ReturnType<typeof mock>;
} {
	const getRoomOverviewMock = mock(() => ({
		room: { id: 'room-123', name: 'Test Room' },
		sessions: [],
		activeTasks: [],
	}));

	const roomManager = {
		createRoom: mock(() => ({ id: 'room-123' })),
		listRooms: mock(() => []),
		getRoom: mock(() => null),
		getRoomOverview: getRoomOverviewMock,
		updateRoom: mock(() => null),
		archiveRoom: mock(() => null),
		getRoomStatus: mock(() => null),
		assignSession: mock(() => null),
		unassignSession: mock(() => null),
		addAllowedPath: mock(() => null),
		removeAllowedPath: mock(() => null),
	} as unknown as RoomManager;

	return { roomManager, getRoomOverview: getRoomOverviewMock };
}

// Helper to create mock Database
function createMockDatabase(): Database {
	const mockRawDb = {
		prepare: mock(() => ({
			run: mock(() => ({ changes: 1 })),
			get: mock(() => null),
			all: mock(() => []),
		})),
		run: mock(() => ({ changes: 1 })),
		get: mock(() => null),
		all: mock(() => []),
	};

	return {
		getDatabase: mock(() => mockRawDb),
	} as unknown as Database;
}

describe('Task RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let roomManagerData: ReturnType<typeof createMockRoomManager>;
	let db: Database;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		roomManagerData = createMockRoomManager();
		db = createMockDatabase();

		// Reset all mocks
		mockTaskManager.createTask.mockClear();
		mockTaskManager.getTask.mockClear();
		mockTaskManager.listTasks.mockClear();
		mockTaskManager.updateTaskStatus.mockClear();
		mockTaskManager.updateTaskProgress.mockClear();
		mockTaskManager.startTask.mockClear();
		mockTaskManager.completeTask.mockClear();
		mockTaskManager.failTask.mockClear();
		mockTaskManager.deleteTask.mockClear();

		// Setup handlers with mocked dependencies
		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager
		);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('task.create', () => {
		it('creates task with all parameters', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				title: 'Implement Feature X',
				description: 'Detailed description of the feature',
				priority: 'high' as TaskPriority,
				dependsOn: ['task-456'],
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.createTask).toHaveBeenCalled();
			expect(result.task).toBeDefined();
			expect(result.task.roomId).toBe('room-123');
		});

		it('creates task with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				title: 'Simple Task',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.createTask).toHaveBeenCalled();
			expect(result.task).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			const params = {
				title: 'Test Task',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when title is missing', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Task title is required');
		});

		it('emits room overview event on creation', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', title: 'Test Task' }, {});

			expect(roomManagerData.getRoomOverview).toHaveBeenCalledWith('room-123');
			expect(daemonHubData.emit).toHaveBeenCalled();
		});
	});

	describe('task.list', () => {
		it('lists all tasks in a room', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { tasks: NeoTask[] };

			expect(mockTaskManager.listTasks).toHaveBeenCalled();
			expect(Array.isArray(result.tasks)).toBe(true);
		});

		it('filters by status', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				status: 'pending' as TaskStatus,
			};

			await handler!(params, {});

			expect(mockTaskManager.listTasks).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'pending' })
			);
		});

		it('filters by priority', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				priority: 'high' as TaskPriority,
			};

			await handler!(params, {});

			expect(mockTaskManager.listTasks).toHaveBeenCalledWith(
				expect.objectContaining({ priority: 'high' })
			);
		});

		it('filters by sessionId', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				sessionId: 'session-123',
			};

			await handler!(params, {});

			expect(mockTaskManager.listTasks).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'session-123' })
			);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('task.get', () => {
		it('returns task details', async () => {
			const handler = messageHubData.handlers.get('task.get');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.getTask).toHaveBeenCalledWith('task-123');
			expect(result.task).toBeDefined();
			expect(result.task.id).toBe('task-123');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.get');
			expect(handler).toBeDefined();

			await expect(handler!({ taskId: 'task-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('task.get');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Task ID is required');
		});

		it('throws error when task not found', async () => {
			const handler = messageHubData.handlers.get('task.get');
			expect(handler).toBeDefined();

			// Mock getTask to return null
			mockTaskManager.getTask.mockResolvedValueOnce(null);

			await expect(handler!({ roomId: 'room-123', taskId: 'non-existent' }, {})).rejects.toThrow(
				'Task not found: non-existent'
			);
		});
	});

	describe('task.update', () => {
		it('updates task status', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
				status: 'in_progress' as TaskStatus,
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.updateTaskStatus).toHaveBeenCalledWith(
				'task-123',
				'in_progress',
				expect.any(Object)
			);
			expect(result.task).toBeDefined();
		});

		it('updates task progress', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
				progress: 50,
				currentStep: 'Processing data',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.updateTaskProgress).toHaveBeenCalledWith(
				'task-123',
				50,
				'Processing data'
			);
			expect(result.task).toBeDefined();
		});

		it('updates task status with additional fields', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
				status: 'in_progress' as TaskStatus,
				progress: 25,
				currentStep: 'Initializing',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(result.task).toBeDefined();
		});

		it('throws error when no update fields provided', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('No update fields provided');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			await expect(handler!({ taskId: 'task-123', status: 'completed' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', status: 'completed' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('emits task update event', async () => {
			const handler = messageHubData.handlers.get('task.update');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', taskId: 'task-123', status: 'in_progress' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'room.task.update',
				expect.objectContaining({
					roomId: 'room-123',
				})
			);
		});
	});

	describe('task.start', () => {
		it('starts task with session assignment', async () => {
			const handler = messageHubData.handlers.get('task.start');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
				sessionId: 'session-456',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.startTask).toHaveBeenCalledWith('task-123', 'session-456');
			expect(result.task).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.start');
			expect(handler).toBeDefined();

			await expect(handler!({ taskId: 'task-123', sessionId: 'session-456' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('task.start');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', sessionId: 'session-456' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('throws error when sessionId is missing', async () => {
			const handler = messageHubData.handlers.get('task.start');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', taskId: 'task-123' }, {})).rejects.toThrow(
				'Session ID is required'
			);
		});

		it('emits task update event', async () => {
			const handler = messageHubData.handlers.get('task.start');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', taskId: 'task-123', sessionId: 'session-456' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'room.task.update',
				expect.objectContaining({
					roomId: 'room-123',
				})
			);
		});
	});

	describe('task.complete', () => {
		it('completes task with result', async () => {
			const handler = messageHubData.handlers.get('task.complete');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
				result: 'Task completed successfully',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.completeTask).toHaveBeenCalledWith(
				'task-123',
				'Task completed successfully'
			);
			expect(result.task).toBeDefined();
		});

		it('completes task without result', async () => {
			const handler = messageHubData.handlers.get('task.complete');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.completeTask).toHaveBeenCalledWith('task-123', '');
			expect(result.task).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.complete');
			expect(handler).toBeDefined();

			await expect(handler!({ taskId: 'task-123', result: 'Done' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('task.complete');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', result: 'Done' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('emits room overview event', async () => {
			const handler = messageHubData.handlers.get('task.complete');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', taskId: 'task-123', result: 'Done' }, {});

			expect(roomManagerData.getRoomOverview).toHaveBeenCalledWith('room-123');
			expect(daemonHubData.emit).toHaveBeenCalled();
		});
	});

	describe('task.fail', () => {
		it('fails task with error message', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
				error: 'Something went wrong',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.failTask).toHaveBeenCalledWith('task-123', 'Something went wrong');
			expect(result.task).toBeDefined();
		});

		it('fails task without error message', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
			};

			const result = (await handler!(params, {})) as { task: NeoTask };

			expect(mockTaskManager.failTask).toHaveBeenCalledWith('task-123', '');
			expect(result.task).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			await expect(handler!({ taskId: 'task-123', error: 'Failed' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', error: 'Failed' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('emits room overview event', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', taskId: 'task-123', error: 'Failed' }, {});

			expect(roomManagerData.getRoomOverview).toHaveBeenCalledWith('room-123');
			expect(daemonHubData.emit).toHaveBeenCalled();
		});
	});

	describe('task.delete', () => {
		it('deletes task successfully', async () => {
			const handler = messageHubData.handlers.get('task.delete');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				taskId: 'task-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(mockTaskManager.deleteTask).toHaveBeenCalledWith('task-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.delete');
			expect(handler).toBeDefined();

			await expect(handler!({ taskId: 'task-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('task.delete');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Task ID is required');
		});

		it('emits room overview event', async () => {
			const handler = messageHubData.handlers.get('task.delete');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', taskId: 'task-123' }, {});

			expect(roomManagerData.getRoomOverview).toHaveBeenCalledWith('room-123');
			expect(daemonHubData.emit).toHaveBeenCalled();
		});

		it('returns false when delete fails', async () => {
			const handler = messageHubData.handlers.get('task.delete');
			expect(handler).toBeDefined();

			mockTaskManager.deleteTask.mockResolvedValueOnce(false);

			const result = (await handler!({ roomId: 'room-123', taskId: 'task-123' }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(false);
		});
	});
});
