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
	const manager = {
		createTask: mock(async () => task!),
		getTask: mock(async () => task),
		listTasks: mock(async () => []),
		failTask: mock(async () => task!),
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

const mockRoomManager = {} as unknown as RoomManager;

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
