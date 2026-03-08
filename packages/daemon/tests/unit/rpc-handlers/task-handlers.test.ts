/**
 * Tests for task.sendHumanMessage RPC Handler
 *
 * Covers:
 * - Parameter validation (missing roomId/taskId/message, empty message)
 * - Missing runtimeService
 * - Runtime not found for room
 * - Task not found in room (cross-room ownership validation)
 * - Routing error (group state disallows messaging)
 * - Happy path success
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { NeoTask } from '@neokai/shared';
import { setupTaskHandlers } from '../../../src/lib/rpc-handlers/task-handlers';
import type { TaskManagerFactory } from '../../../src/lib/rpc-handlers/task-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomRuntimeService } from '../../../src/lib/room/runtime/room-runtime-service';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { Database } from '../../../src/storage/database';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// ─── Mock helpers ───

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

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

const mockTask: NeoTask = {
	id: 'task-1',
	roomId: 'room-1',
	title: 'Test Task',
	description: 'Test description',
	status: 'in_progress',
	priority: 'normal',
	taskType: 'coding',
	progress: 0,
	dependsOn: [],
	createdAt: Date.now(),
	updatedAt: Date.now(),
};

/** Build a minimal TaskManagerFactory that returns a controlled task. */
function makeTaskManagerFactory(task: NeoTask | null): TaskManagerFactory {
	const cancelledTask = task ? { ...task, status: 'cancelled' as const } : null;
	const manager = {
		createTask: mock(async () => task!),
		getTask: mock(async () => task),
		listTasks: mock(async () => []),
		failTask: mock(async () => task!),
		cancelTask: mock(async () => cancelledTask!),
	};
	return mock(() => manager);
}

/**
 * Build a mock SQLite row that SessionGroupRepository.rowToGroup() can parse.
 * All fields that rowToGroup() reads are included.
 */
function makeGroupRow(state: string): Record<string, unknown> {
	return {
		id: 'group-1',
		group_type: 'task',
		ref_id: 'task-1',
		state,
		version: 1,
		metadata: JSON.stringify({
			workerRole: 'coder',
			feedbackIteration: 0,
			leaderContractViolations: 0,
			leaderCalledTool: false,
			lastProcessedLeaderTurnId: null,
			lastForwardedMessageId: null,
			activeWorkStartedAt: null,
			activeWorkElapsed: 0,
			hibernatedAt: null,
			tokensUsed: 0,
			submittedForReview: false,
			approved: false,
		}),
		created_at: Date.now(),
		completed_at: null,
		worker_session_id: 'worker-session',
		leader_session_id: 'leader-session',
	};
}

/**
 * Build a mock Database whose getDatabase() returns a fake Bun SQLite db.
 * All prepare() calls return a statement that responds with the given groupRow.
 */
function makeDb(groupRow: Record<string, unknown> | null): Database {
	const stmt = {
		get: mock(() => groupRow),
		run: mock(() => ({ lastInsertRowid: 1 })),
		all: mock(() => []),
	};
	const rawDb = { prepare: mock(() => stmt) };
	return { getDatabase: mock(() => rawDb) } as unknown as Database;
}

/** Build a mock RoomRuntimeService with a runtime that can resume/inject. */
function makeRuntimeService(resumeResult = true, injectResult = true) {
	const resumeWorkerFromHuman = mock(async () => resumeResult);
	const injectMessageToLeader = mock(async () => injectResult);
	const runtime = { resumeWorkerFromHuman, injectMessageToLeader };
	const service = {
		getRuntime: mock(() => runtime),
	} as unknown as RoomRuntimeService;
	return { service, runtime };
}

/** Build a mock RoomRuntimeService whose getRuntime() always returns null. */
function makeNullRuntimeService(): RoomRuntimeService {
	return { getRuntime: mock(() => null) } as unknown as RoomRuntimeService;
}

const mockRoomManager = {
	getRoomOverview: mock(() => null),
} as unknown as RoomManager;

// ─── Test suite ───

describe('task.sendHumanMessage RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	/**
	 * Wire up setupTaskHandlers and capture the registered handler.
	 */
	function setup(opts: {
		task?: NeoTask | null;
		groupState?: string;
		runtimeService?: RoomRuntimeService;
	}) {
		const { task = mockTask, groupState = 'awaiting_human', runtimeService } = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(groupState)),
			makeTaskManagerFactory(task),
			runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('task.sendHumanMessage');
		expect(h).toBeDefined();
		return h!;
	}

	beforeEach(() => {
		const { service } = makeRuntimeService();
		setup({ runtimeService: service });
	});

	// ─── Parameter validation ───

	describe('parameter validation', () => {
		it('throws when roomId is missing', async () => {
			await expect(getHandler()({ taskId: 'task-1', message: 'hi' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws when taskId is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1', message: 'hi' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('throws when message is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Message is required'
			);
		});

		it('throws when message is an empty string', async () => {
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: '' }, {})
			).rejects.toThrow('Message is required');
		});

		it('throws when message is whitespace only', async () => {
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: '   ' }, {})
			).rejects.toThrow('Message cannot be empty');
		});
	});

	// ─── Runtime service validation ───

	describe('runtime service validation', () => {
		it('throws when runtimeService is not provided', async () => {
			setup({ runtimeService: undefined });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'hello' }, {})
			).rejects.toThrow('Runtime service is required');
		});

		it('throws when runtime is not found for the room', async () => {
			setup({ runtimeService: makeNullRuntimeService() });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'hello' }, {})
			).rejects.toThrow('No runtime found for room');
		});
	});

	// ─── Cross-room ownership ───

	describe('cross-room ownership validation', () => {
		it('throws when the task is not found in the given room', async () => {
			const { service } = makeRuntimeService();
			setup({ task: null, runtimeService: service });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'hello' }, {})
			).rejects.toThrow('not found in room');
		});
	});

	// ─── Routing behaviour ───

	describe('routing', () => {
		it('returns { success: true } when group is in awaiting_human state', async () => {
			const { service } = makeRuntimeService(true);
			setup({ groupState: 'awaiting_human', runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'please continue' },
				{}
			);
			expect(result).toEqual({ success: true });
		});

		it('throws when group is in awaiting_worker state', async () => {
			const { service } = makeRuntimeService();
			setup({ groupState: 'awaiting_worker', runtimeService: service });

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'hello' }, {})
			).rejects.toThrow('Worker is running');
		});

		it('throws when no active group exists for the task', async () => {
			// makeDb with null groupRow → getGroupByTaskId returns null
			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;

			const { service } = makeRuntimeService();
			setupTaskHandlers(
				hub,
				mockRoomManager,
				createMockDaemonHub(),
				makeDb(null), // no group row
				makeTaskManagerFactory(mockTask),
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'hello' }, {})
			).rejects.toThrow('No active session group');
		});
	});
});

// ─── task.cancel Tests ───

describe('task.cancel RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	function setup(opts: {
		task?: NeoTask | null;
		groupState?: string;
		runtimeService?: RoomRuntimeService;
	}) {
		const { task = mockTask, groupState = 'awaiting_human', runtimeService } = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(groupState)),
			makeTaskManagerFactory(task),
			runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('task.cancel');
		expect(h).toBeDefined();
		return h!;
	}

	describe('parameter validation', () => {
		beforeEach(() => {
			setup({ runtimeService: makeNullRuntimeService() });
		});

		it('throws when roomId is missing', async () => {
			await expect(getHandler()({ taskId: 'task-1' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws when taskId is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1' }, {})).rejects.toThrow('Task ID is required');
		});
	});

	describe('task status validation', () => {
		it('throws when task is not found', async () => {
			setup({ task: null, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task not found'
			);
		});

		it('throws when task status is completed', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			setup({ task: completedTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task cannot be cancelled'
			);
		});

		it('throws when task status is failed', async () => {
			const failedTask = { ...mockTask, status: 'failed' as const };
			setup({ task: failedTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task cannot be cancelled'
			);
		});

		it('throws when task status is cancelled', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			setup({ task: cancelledTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task cannot be cancelled'
			);
		});
	});

	describe('happy paths', () => {
		it('cancels a pending task without active group', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });
			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});
			expect(result).toEqual({ task: { ...pendingTask, status: 'cancelled' } });
		});

		it('cancels an in_progress task without active group', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			setup({ task: inProgressTask, runtimeService: makeNullRuntimeService() });
			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});
			expect(result).toEqual({ task: { ...inProgressTask, status: 'cancelled' } });
		});

		it('cancels a review task without active group', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			setup({ task: reviewTask, runtimeService: makeNullRuntimeService() });
			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});
			expect(result).toEqual({ task: { ...reviewTask, status: 'cancelled' } });
		});
	});
});

// ─── task.reject Tests ───

describe('task.reject RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	function setup(opts: {
		task?: NeoTask | null;
		groupState?: string;
		runtimeService?: RoomRuntimeService;
	}) {
		const { task = mockTask, groupState = 'awaiting_human', runtimeService } = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(groupState)),
			makeTaskManagerFactory(task),
			runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('task.reject');
		expect(h).toBeDefined();
		return h!;
	}

	describe('parameter validation', () => {
		beforeEach(() => {
			const { service } = makeRuntimeService();
			setup({ runtimeService: service });
		});

		it('throws when roomId is missing', async () => {
			await expect(getHandler()({ taskId: 'task-1', feedback: 'not good' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws when taskId is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1', feedback: 'not good' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('throws when feedback is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Feedback is required for rejection'
			);
		});

		it('throws when feedback is empty string', async () => {
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: '' }, {})
			).rejects.toThrow('Feedback is required for rejection');
		});

		it('throws when feedback is whitespace only', async () => {
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: '   ' }, {})
			).rejects.toThrow('Feedback is required for rejection');
		});
	});

	describe('runtime validation', () => {
		it('throws when runtimeService is not provided', async () => {
			setup({ runtimeService: undefined });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('Runtime service is required');
		});

		it('throws when runtime is not found for the room', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			setup({ task: reviewTask, runtimeService: makeNullRuntimeService() });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('No runtime found for room');
		});
	});

	describe('task status validation', () => {
		it('throws when task is not found', async () => {
			const { service } = makeRuntimeService();
			setup({ task: null, runtimeService: service });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('Task not found');
		});

		it('throws when task is not in review status', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			const { service } = makeRuntimeService();
			setup({ task: inProgressTask, runtimeService: service });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('Task is not in review status');
		});
	});

	describe('group state validation', () => {
		it('throws when group is not in awaiting_human state', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			const { service } = makeRuntimeService();
			setup({ task: reviewTask, groupState: 'awaiting_worker', runtimeService: service });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('Task is not awaiting human review');
		});

		it('throws when no active group exists', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			const { service } = makeRuntimeService();

			// Setup with no group
			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;

			setupTaskHandlers(
				hub,
				mockRoomManager,
				createMockDaemonHub(),
				makeDb(null), // no group row
				makeTaskManagerFactory(reviewTask),
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('Task is not awaiting human review');
		});
	});

	describe('happy path', () => {
		it('rejects a task in review with awaiting_human group state', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			const { service } = makeRuntimeService(true);
			setup({ task: reviewTask, groupState: 'awaiting_human', runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', feedback: 'please fix the bug' },
				{}
			);
			expect(result).toEqual({ success: true });
		});
	});
});

// ─── task.setStatus Tests ───

describe('task.setStatus RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	/**
	 * Create a TaskManagerFactory that supports setTaskStatus
	 */
	function makeSetStatusTaskManagerFactory(task: NeoTask | null): TaskManagerFactory {
		const manager = {
			createTask: mock(async () => task!),
			getTask: mock(async () => task),
			listTasks: mock(async () => []),
			failTask: mock(async () => task!),
			cancelTask: mock(async () => ({ ...task!, status: 'cancelled' as const })),
			setTaskStatus: mock(async (_id: string, status: string, _opts?: unknown) => ({
				...task!,
				status: status as NeoTask['status'],
			})),
		};
		return mock(() => manager);
	}

	/**
	 * Create a runtime service with a taskGroupManager that can be controlled
	 */
	function makeRuntimeServiceWithGroupManager(
		cancelResult: unknown = { id: 'group-1', state: 'cancelled' }
	) {
		const cancel = mock(async () => cancelResult);
		const runtime = {
			taskGroupManager: { cancel },
		};
		const service = {
			getRuntime: mock(() => runtime),
		} as unknown as RoomRuntimeService;
		return { service, runtime, cancel };
	}

	function setup(opts: {
		task?: NeoTask | null;
		groupState?: string;
		runtimeService?: RoomRuntimeService;
		taskManagerFactory?: TaskManagerFactory;
	}) {
		const {
			task = mockTask,
			groupState = 'awaiting_human',
			runtimeService,
			taskManagerFactory,
		} = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(groupState)),
			taskManagerFactory ?? makeSetStatusTaskManagerFactory(task),
			runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('task.setStatus');
		expect(h).toBeDefined();
		return h!;
	}

	describe('parameter validation', () => {
		beforeEach(() => {
			setup({ runtimeService: makeNullRuntimeService() });
		});

		it('throws when roomId is missing', async () => {
			await expect(getHandler()({ taskId: 'task-1', status: 'completed' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws when taskId is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1', status: 'completed' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('throws when status is missing', async () => {
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Status is required'
			);
		});
	});

	describe('task validation', () => {
		it('throws when task is not found', async () => {
			setup({ task: null, runtimeService: makeNullRuntimeService() });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'completed' }, {})
			).rejects.toThrow('Task not found');
		});
	});

	describe('status transition validation', () => {
		it('throws for invalid transition from pending to completed', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'completed' }, {})
			).rejects.toThrow('Invalid status transition');
		});

		it('throws for invalid transition from completed to pending', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			setup({ task: completedTask, runtimeService: makeNullRuntimeService() });
			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'pending' }, {})
			).rejects.toThrow('Invalid status transition');
		});
	});

	describe('group cancellation', () => {
		it('throws when group cancellation fails due to version conflict', async () => {
			// Create runtime service where cancel returns null (simulating version conflict)
			const { service } = makeRuntimeServiceWithGroupManager(null);

			setup({
				task: mockTask, // in_progress status
				groupState: 'awaiting_human',
				runtimeService: service,
			});

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'completed' }, {})
			).rejects.toThrow('Failed to cancel task group');
		});

		it('succeeds when group cancellation succeeds', async () => {
			// Create runtime service where cancel returns a valid group
			const { service, cancel } = makeRuntimeServiceWithGroupManager({
				id: 'group-1',
				state: 'cancelled',
			});

			setup({
				task: mockTask, // in_progress status
				groupState: 'awaiting_human',
				runtimeService: service,
			});

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'completed' },
				{}
			);
			expect(cancel).toHaveBeenCalledWith('group-1');
			expect(result).toEqual({ task: { ...mockTask, status: 'completed' } });
		});

		it('does not cancel group when moving to non-terminal state', async () => {
			const { service, cancel } = makeRuntimeServiceWithGroupManager();

			setup({
				task: mockTask, // in_progress status
				groupState: 'awaiting_human',
				runtimeService: service,
			});

			// Moving to 'review' is not a terminal state, so group shouldn't be cancelled
			await getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'review' }, {});
			expect(cancel).not.toHaveBeenCalled();
		});

		it('does not cancel group when no runtime service', async () => {
			// Without runtime service, the group cancellation code path is not entered
			setup({
				task: mockTask,
				groupState: 'awaiting_human',
				runtimeService: undefined,
			});

			// This should succeed without attempting to cancel any group
			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'completed' },
				{}
			);
			expect(result).toEqual({ task: { ...mockTask, status: 'completed' } });
		});
	});

	describe('happy paths', () => {
		it('allows valid transition from in_progress to completed', async () => {
			setup({ task: mockTask, runtimeService: makeNullRuntimeService() });
			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'completed', result: 'Done' },
				{}
			);
			expect(result).toEqual({ task: { ...mockTask, status: 'completed' } });
		});

		it('allows valid transition from failed to pending (restart)', async () => {
			const failedTask = { ...mockTask, status: 'failed' as const };
			setup({ task: failedTask, runtimeService: makeNullRuntimeService() });
			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'pending' },
				{}
			);
			expect(result).toEqual({ task: { ...failedTask, status: 'pending' } });
		});

		it('allows valid transition from cancelled to in_progress (restart)', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			setup({ task: cancelledTask, runtimeService: makeNullRuntimeService() });
			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'in_progress' },
				{}
			);
			expect(result).toEqual({ task: { ...cancelledTask, status: 'in_progress' } });
		});
	});
});
