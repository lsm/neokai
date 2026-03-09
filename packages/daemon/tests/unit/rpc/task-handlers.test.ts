/**
 * Tests for Task RPC Handlers
 *
 * Tests the RPC handlers for task operations:
 * - task.create - Create a task in a room
 * - task.list - List tasks in a room
 * - task.get - Get task details
 * - task.fail - Fail a task
 * - task.sendHumanMessage - Send a human message to the active group
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
import type { RoomRuntimeService } from '../../../src/lib/room/runtime/room-runtime-service';

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

// Helper to create mock RoomRuntimeService
// routeHumanMessageToGroup calls runtime.injectMessageToLeader (awaiting_leader)
// or runtime.resumeWorkerFromHuman (awaiting_human)
function createMockRuntimeService(methodResult = true): {
	runtimeService: RoomRuntimeService;
	injectMessageToLeader: ReturnType<typeof mock>;
	injectMessageToWorker: ReturnType<typeof mock>;
	resumeWorkerFromHuman: ReturnType<typeof mock>;
	getRuntime: ReturnType<typeof mock>;
} {
	const injectMessageToLeader = mock(async () => methodResult);
	const injectMessageToWorker = mock(async () => methodResult);
	const resumeWorkerFromHuman = mock(async () => methodResult);
	const mockRuntime = { injectMessageToLeader, injectMessageToWorker, resumeWorkerFromHuman };
	const getRuntime = mock(() => mockRuntime);
	const runtimeService = {
		getRuntime,
	} as unknown as RoomRuntimeService;
	return {
		runtimeService,
		injectMessageToLeader,
		injectMessageToWorker,
		resumeWorkerFromHuman,
		getRuntime,
	};
}

// Helper to create a mock Database that returns a group with the given state
function createMockDatabaseWithGroup(groupState: string = 'awaiting_leader'): Database {
	const groupRow = {
		id: 'group-123',
		ref_id: 'task-123',
		group_type: 'task_pair',
		state: groupState,
		version: 1,
		metadata: JSON.stringify({
			workerRole: 'coder',
			feedbackIteration: 0,
			approved: false,
			leaderCalledTool: false,
			leaderContractViolations: 0,
		}),
		worker_session_id: 'worker-session-123',
		leader_session_id: 'leader-session-123',
		created_at: Date.now(),
		completed_at: null,
	};
	const mockRawDb = {
		prepare: mock(() => ({
			run: mock(() => ({ changes: 1 })),
			get: mock(() => groupRow),
			all: mock(() => []),
		})),
		run: mock(() => ({ changes: 1 })),
		get: mock(() => groupRow),
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

		mockTaskManager.createTask.mockClear();
		mockTaskManager.getTask.mockClear();
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

	describe('task.create', () => {
		it('creates task with all parameters', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{
					roomId: 'room-123',
					title: 'Implement Feature X',
					description: 'Detailed description of the feature',
					priority: 'high' as TaskPriority,
					dependsOn: ['task-456'],
				},
				{}
			)) as { task: NeoTask };

			expect(mockTaskManager.createTask).toHaveBeenCalled();
			expect(result.task).toBeDefined();
			expect(result.task.roomId).toBe('room-123');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			await expect(handler!({ title: 'Test Task' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when title is missing', async () => {
			const handler = messageHubData.handlers.get('task.create');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Task title is required');
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

	describe('task.get', () => {
		it('returns task details', async () => {
			const handler = messageHubData.handlers.get('task.get');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123', taskId: 'task-123' }, {})) as {
				task: NeoTask;
			};

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

			mockTaskManager.getTask.mockResolvedValueOnce(null);

			await expect(handler!({ roomId: 'room-123', taskId: 'non-existent' }, {})).rejects.toThrow(
				'Task not found: non-existent'
			);
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

			expect(mockTaskManager.failTask).toHaveBeenCalledWith('task-123', 'Something went wrong', {
				autoRetry: false,
			});
			expect(result.task).toBeDefined();
		});

		it('fails task without error message', async () => {
			const handler = messageHubData.handlers.get('task.fail');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123', taskId: 'task-123' }, {})) as {
				task: NeoTask;
			};

			expect(mockTaskManager.failTask).toHaveBeenCalledWith('task-123', '', {
				autoRetry: false,
			});
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

describe('task.sendHumanMessage handler', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let roomManagerData: ReturnType<typeof createMockRoomManager>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		roomManagerData = createMockRoomManager();
	});

	afterEach(() => {
		mock.restore();
	});

	it('sends human message successfully when runtime is available', async () => {
		const { runtimeService, injectMessageToWorker } = createMockRuntimeService(true);
		const db = createMockDatabaseWithGroup('awaiting_leader');

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage');
		expect(handler).toBeDefined();

		const result = (await handler!(
			{ roomId: 'room-123', taskId: 'task-123', message: 'Looks good!' },
			{}
		)) as { success: boolean };

		expect(injectMessageToWorker).toHaveBeenCalledWith('task-123', 'Looks good!');
		expect(result.success).toBe(true);
	});

	it('trims whitespace from message before sending', async () => {
		const { runtimeService, injectMessageToWorker } = createMockRuntimeService(true);
		const db = createMockDatabaseWithGroup('awaiting_leader');

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await handler!({ roomId: 'room-123', taskId: 'task-123', message: '  please fix it  ' }, {});

		expect(injectMessageToWorker).toHaveBeenCalledWith('task-123', 'please fix it');
	});

	it('throws error when roomId is missing', async () => {
		const { runtimeService } = createMockRuntimeService();
		const db = createMockDatabase();

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await expect(handler!({ taskId: 'task-123', message: 'hello' }, {})).rejects.toThrow(
			'Room ID is required'
		);
	});

	it('throws error when taskId is missing', async () => {
		const { runtimeService } = createMockRuntimeService();
		const db = createMockDatabase();

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await expect(handler!({ roomId: 'room-123', message: 'hello' }, {})).rejects.toThrow(
			'Task ID is required'
		);
	});

	it('throws error when message is missing', async () => {
		const { runtimeService } = createMockRuntimeService();
		const db = createMockDatabase();

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await expect(handler!({ roomId: 'room-123', taskId: 'task-123' }, {})).rejects.toThrow(
			'Message is required'
		);
	});

	it('throws error when message is empty/whitespace', async () => {
		const { runtimeService } = createMockRuntimeService();
		const db = createMockDatabase();

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await expect(
			handler!({ roomId: 'room-123', taskId: 'task-123', message: '   ' }, {})
		).rejects.toThrow('Message cannot be empty');
	});

	it('throws error when runtimeService is not provided', async () => {
		const db = createMockDatabase();
		// Set up without runtimeService
		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager
			// no runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await expect(
			handler!({ roomId: 'room-123', taskId: 'task-123', message: 'hello' }, {})
		).rejects.toThrow('Runtime service is required');
	});

	it('throws error when no runtime found for room', async () => {
		const db = createMockDatabase();
		const getRuntime = mock(() => null);
		const runtimeService = { getRuntime } as unknown as RoomRuntimeService;

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		await expect(
			handler!({ roomId: 'room-999', taskId: 'task-123', message: 'hello' }, {})
		).rejects.toThrow('No runtime found for room: room-999');
	});

	it('routes to worker when group is in awaiting_worker state', async () => {
		const { runtimeService, injectMessageToWorker } = createMockRuntimeService(true);
		const db = createMockDatabaseWithGroup('awaiting_worker');

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		const result = (await handler!(
			{ roomId: 'room-123', taskId: 'task-123', message: 'hello' },
			{}
		)) as { success: boolean };

		expect(injectMessageToWorker).toHaveBeenCalledWith('task-123', 'hello');
		expect(result.success).toBe(true);
	});

	it('routes to worker when target=worker in awaiting_worker state', async () => {
		const { runtimeService, injectMessageToWorker } = createMockRuntimeService(true);
		const db = createMockDatabaseWithGroup('awaiting_worker');

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		const result = (await handler!(
			{ roomId: 'room-123', taskId: 'task-123', message: 'hello', target: 'worker' },
			{}
		)) as { success: boolean };

		expect(injectMessageToWorker).toHaveBeenCalledWith('task-123', 'hello');
		expect(result.success).toBe(true);
	});

	it('throws error when message exceeds 10,000 characters', async () => {
		const { runtimeService } = createMockRuntimeService(true);
		const db = createMockDatabase();

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		const oversizedMessage = 'a'.repeat(10_001);
		await expect(
			handler!({ roomId: 'room-123', taskId: 'task-123', message: oversizedMessage }, {})
		).rejects.toThrow('Message is too long');
	});

	it('accepts message at exactly 10,000 characters', async () => {
		const { runtimeService, injectMessageToWorker } = createMockRuntimeService(true);
		const db = createMockDatabaseWithGroup('awaiting_leader');

		setupTaskHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			db,
			createMockTaskManager,
			runtimeService
		);

		const handler = messageHubData.handlers.get('task.sendHumanMessage')!;
		const maxMessage = 'a'.repeat(10_000);
		const result = (await handler!(
			{ roomId: 'room-123', taskId: 'task-123', message: maxMessage },
			{}
		)) as { success: boolean };

		expect(injectMessageToWorker).toHaveBeenCalledWith('task-123', maxMessage);
		expect(result.success).toBe(true);
	});
});
