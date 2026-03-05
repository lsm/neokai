/**
 * Tests for Task RPC Handlers
 *
 * Tests the RPC handlers for task operations:
 * - task.list - List tasks in a room
 * - task.fail - Fail a task
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
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock TaskManager module
const mockTaskManager = {
	listTasks: mock(async () => [] as NeoTask[]),
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

		mockTaskManager.listTasks.mockClear();
		mockTaskManager.failTask.mockClear();

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

	describe('task.list', () => {
		it('lists all tasks in a room', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123' }, {})) as { tasks: NeoTask[] };

			expect(mockTaskManager.listTasks).toHaveBeenCalled();
			expect(Array.isArray(result.tasks)).toBe(true);
		});

		it('filters by status', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', status: 'pending' as TaskStatus }, {});

			expect(mockTaskManager.listTasks).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'pending' })
			);
		});

		it('filters by priority', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', priority: 'high' as TaskPriority }, {});

			expect(mockTaskManager.listTasks).toHaveBeenCalledWith(
				expect.objectContaining({ priority: 'high' })
			);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('task.fail', () => {
		it('fails task with error message', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ roomId: 'room-123', taskId: 'task-123', error: 'Something went wrong' },
				{}
			)) as { task: NeoTask };

			expect(mockTaskManager.failTask).toHaveBeenCalledWith('task-123', 'Something went wrong');
			expect(result.task).toBeDefined();
		});

		it('fails task without error message', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123', taskId: 'task-123' }, {})) as {
				task: NeoTask;
			};

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

		it('emits room overview and task update events', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', taskId: 'task-123', error: 'Failed' }, {});

			expect(roomManagerData.getRoomOverview).toHaveBeenCalledWith('room-123');
			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'room.task.update',
				expect.objectContaining({ roomId: 'room-123' })
			);
		});
	});
});
