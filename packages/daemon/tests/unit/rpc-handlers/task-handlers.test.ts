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
import { VALID_STATUS_TRANSITIONS } from '../../../src/lib/room/managers/task-manager';
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
	const failedTask = task ? { ...task, status: 'needs_attention' as const } : null;
	const archivedTask = task ? { ...task, archivedAt: Date.now() } : null;
	const manager = {
		createTask: mock(async () => task!),
		getTask: mock(async () => task),
		listTasks: mock(async () => []),
		failTask: mock(async () => failedTask!),
		cancelTask: mock(async () => cancelledTask!),
		setTaskStatus: mock(async () => task!),
		archiveTask: mock(async () => archivedTask!),
	};
	return mock(() => manager);
}

/**
 * Build a mock SQLite row that SessionGroupRepository.rowToGroup() can parse.
 * All fields that rowToGroup() reads are included.
 */
function makeGroupRow(submittedForReview = false): Record<string, unknown> {
	return {
		id: 'group-1',
		group_type: 'task',
		ref_id: 'task-1',
		state: submittedForReview ? 'awaiting_human' : 'awaiting_worker', // DB column kept for compat
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
			submittedForReview,
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
function makeRuntimeService(resumeResult = true, injectResult = true, reviveResult = true) {
	const resumeWorkerFromHuman = mock(async () => resumeResult);
	const injectMessageToLeader = mock(async () => injectResult);
	const injectMessageToWorker = mock(async () => injectResult);
	const reviveTaskForMessage = mock(async () => reviveResult);
	const cancelTask = mock(async () => ({
		success: injectResult,
		cancelledTaskIds: injectResult ? ['task-1'] : [],
	}));
	const terminateTaskGroup = mock(async () => injectResult);
	const interruptTaskSession = mock(async () => ({ success: injectResult }));
	const archiveTaskGroup = mock(async () => true);
	const runtime = {
		resumeWorkerFromHuman,
		injectMessageToLeader,
		injectMessageToWorker,
		reviveTaskForMessage,
		cancelTask,
		terminateTaskGroup,
		interruptTaskSession,
		archiveTaskGroup,
	};
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
		submittedForReview?: boolean;
		runtimeService?: RoomRuntimeService;
	}) {
		const { task = mockTask, submittedForReview = false, runtimeService } = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(submittedForReview)),
			{ notifyChange: () => {} } as never,
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
		it('returns { success: true } when group is active (submittedForReview)', async () => {
			const { service } = makeRuntimeService(true);
			setup({ submittedForReview: true, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'please continue' },
				{}
			);
			expect(result).toEqual({ success: true });
		});

		it('returns { success: true } when group is active (not submittedForReview)', async () => {
			const { service } = makeRuntimeService(true);
			setup({ submittedForReview: false, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'hello' },
				{}
			);
			expect(result).toEqual({ success: true });
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
				{ notifyChange: () => {} } as never,
				makeTaskManagerFactory(mockTask),
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'hello' }, {})
			).rejects.toThrow('No active session group');
		});
	});

	describe('needs_attention task revival', () => {
		it('revives the task to review status and returns success', async () => {
			const failedTask = { ...mockTask, status: 'needs_attention' as const };
			const { service, runtime } = makeRuntimeService(true, true, true);
			setup({ task: failedTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'please retry' },
				{}
			);

			expect(result).toEqual({ success: true });
			// Sets status to review before reviving
			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith('task-1', 'please retry', 'worker');
		});

		it('throws and rolls back status when reviveTaskForMessage returns false', async () => {
			const needsAttentionTask = { ...mockTask, status: 'needs_attention' as const };
			const { service, runtime } = makeRuntimeService(true, true, false);

			// Build factory manually to expose setTaskStatus spy for rollback assertion
			const setTaskStatus = mock(async () => needsAttentionTask);
			const factory: TaskManagerFactory = mock(() => ({
				createTask: mock(async () => needsAttentionTask),
				getTask: mock(async () => needsAttentionTask),
				listTasks: mock(async () => []),
				failTask: mock(async () => needsAttentionTask),
				cancelTask: mock(async () => ({ ...needsAttentionTask, status: 'cancelled' as const })),
				setTaskStatus,
			}));

			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;
			setupTaskHandlers(
				hub,
				mockRoomManager,
				createMockDaemonHub(),
				makeDb(makeGroupRow()),
				{ notifyChange: () => {} } as never,
				factory,
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'retry' }, {})
			).rejects.toThrow('agent sessions could not be restored');

			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith('task-1', 'retry', 'worker');
			// Verify rollback: first transitioned to 'review', then rolled back to 'needs_attention'
			expect(setTaskStatus).toHaveBeenCalledWith('task-1', 'review');
			expect(setTaskStatus).toHaveBeenCalledWith('task-1', 'needs_attention');
		});
	});

	describe('completed task auto-reactivation', () => {
		it('auto-reactivates a completed task and injects the message', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const { service, runtime } = makeRuntimeService(true, true, true);
			setup({ task: completedTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'please continue' },
				{}
			);

			expect(result).toEqual({ success: true });
			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith(
				'task-1',
				'please continue',
				'worker'
			);
		});

		it('throws and rolls back when reviveTaskForMessage fails for completed task', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const { service, runtime } = makeRuntimeService(true, true, false);

			const setTaskStatus = mock(async () => completedTask);
			const factory: TaskManagerFactory = mock(() => ({
				createTask: mock(async () => completedTask),
				getTask: mock(async () => completedTask),
				listTasks: mock(async () => []),
				failTask: mock(async () => completedTask),
				cancelTask: mock(async () => ({ ...completedTask, status: 'cancelled' as const })),
				setTaskStatus,
			}));

			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;
			setupTaskHandlers(
				hub,
				mockRoomManager,
				createMockDaemonHub(),
				makeDb(makeGroupRow()),
				{ notifyChange: () => {} } as never,
				factory,
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'continue' }, {})
			).rejects.toThrow('agent sessions could not be restored');

			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith('task-1', 'continue', 'worker');
			// Verify intermediate transition to in_progress, then rollback to completed
			expect(setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress');
			expect(setTaskStatus).toHaveBeenCalledWith('task-1', 'completed');
		});
	});

	describe('cancelled task auto-reactivation', () => {
		it('auto-reactivates a cancelled task and injects the message', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			const { service, runtime } = makeRuntimeService(true, true, true);
			setup({ task: cancelledTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'restart please' },
				{}
			);

			expect(result).toEqual({ success: true });
			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith(
				'task-1',
				'restart please',
				'worker'
			);
		});

		it('throws and rolls back when reviveTaskForMessage fails for cancelled task', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			const { service, runtime } = makeRuntimeService(true, true, false);

			const setTaskStatus = mock(async () => cancelledTask);
			const factory: TaskManagerFactory = mock(() => ({
				createTask: mock(async () => cancelledTask),
				getTask: mock(async () => cancelledTask),
				listTasks: mock(async () => []),
				failTask: mock(async () => cancelledTask),
				cancelTask: mock(async () => cancelledTask),
				setTaskStatus,
			}));

			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;
			setupTaskHandlers(
				hub,
				mockRoomManager,
				createMockDaemonHub(),
				makeDb(makeGroupRow()),
				{ notifyChange: () => {} } as never,
				factory,
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'retry' }, {})
			).rejects.toThrow('agent sessions could not be restored');

			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith('task-1', 'retry', 'worker');
			// Verify intermediate transition to in_progress, then rollback to cancelled
			expect(setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress');
			expect(setTaskStatus).toHaveBeenCalledWith('task-1', 'cancelled');
		});
	});

	describe('target parameter routing for needs_attention tasks', () => {
		it('passes target=worker to reviveTaskForMessage when human selects worker', async () => {
			const needsAttentionTask = { ...mockTask, status: 'needs_attention' as const };
			const { service, runtime } = makeRuntimeService(true, true, true);
			setup({ task: needsAttentionTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'hello worker', target: 'worker' },
				{}
			);

			expect(result).toEqual({ success: true });
			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith('task-1', 'hello worker', 'worker');
		});

		it('passes target=leader to reviveTaskForMessage when human selects leader', async () => {
			const needsAttentionTask = { ...mockTask, status: 'needs_attention' as const };
			const { service, runtime } = makeRuntimeService(true, true, true);
			setup({ task: needsAttentionTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'hello leader', target: 'leader' },
				{}
			);

			expect(result).toEqual({ success: true });
			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith('task-1', 'hello leader', 'leader');
		});

		it('defaults to target=worker when no target specified', async () => {
			const needsAttentionTask = { ...mockTask, status: 'needs_attention' as const };
			const { service, runtime } = makeRuntimeService(true, true, true);
			setup({ task: needsAttentionTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', message: 'hello default' },
				{}
			);

			expect(result).toEqual({ success: true });
			expect(runtime.reviveTaskForMessage).toHaveBeenCalledWith(
				'task-1',
				'hello default',
				'worker'
			);
		});
	});

	describe('archived task messaging — archived is truly terminal', () => {
		it('throws when task is archived — messaging is not allowed (with runtime)', async () => {
			const archivedTask = { ...mockTask, status: 'archived' as const };
			const { service } = makeRuntimeService(true, true, true);
			setup({ task: archivedTask, runtimeService: service });

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'can you still work?' }, {})
			).rejects.toThrow('is archived and cannot receive messages');
		});

		it('throws when task is archived — messaging is not allowed (without runtime)', async () => {
			const archivedTask = { ...mockTask, status: 'archived' as const };
			setup({ task: archivedTask, runtimeService: makeNullRuntimeService() });

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', message: 'can you still work?' }, {})
			).rejects.toThrow('is archived and cannot receive messages');
		});
	});
});

// ─── task.cancel Tests ───

describe('task.cancel RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	function setup(opts: {
		task?: NeoTask | null;
		submittedForReview?: boolean;
		runtimeService?: RoomRuntimeService;
	}) {
		const { task = mockTask, submittedForReview = false, runtimeService } = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(submittedForReview)),
			{ notifyChange: () => {} } as never,
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

		it('throws when task needs attention', async () => {
			const failedTask = { ...mockTask, status: 'needs_attention' as const };
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
		it('uses runtime.cancelTask when runtime is available', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			const { service, runtime } = makeRuntimeService(true);
			setup({ task: inProgressTask, submittedForReview: false, runtimeService: service });

			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});
			expect(runtime.cancelTask).toHaveBeenCalledWith('task-1');
			expect(result).toEqual({ task: inProgressTask });
		});

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
		submittedForReview?: boolean;
		runtimeService?: RoomRuntimeService;
	}) {
		const { task = mockTask, submittedForReview = false, runtimeService } = opts;

		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;

		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow(submittedForReview)),
			{ notifyChange: () => {} } as never,
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

	describe('group validation', () => {
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
				{ notifyChange: () => {} } as never,
				makeTaskManagerFactory(reviewTask),
				service
			);

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'not good' }, {})
			).rejects.toThrow('No active session group for this task');
		});
	});

	describe('happy path', () => {
		it('rejects a task in review with active group', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			const { service, runtime } = makeRuntimeService(true);
			setup({ task: reviewTask, submittedForReview: true, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', feedback: 'please fix the bug' },
				{}
			);
			expect(runtime.resumeWorkerFromHuman).toHaveBeenCalledWith(
				'task-1',
				'[Human Rejection]\n\nplease fix the bug',
				{ approved: false }
			);
			expect(result).toEqual({ success: true });
		});

		it('throws when runtime resume fails', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			const { service } = makeRuntimeService(false);
			setup({ task: reviewTask, submittedForReview: true, runtimeService: service });

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', feedback: 'please fix' }, {})
			).rejects.toThrow('Failed to reject task');
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
			setTaskStatus: mock(async (_id: string, status: string, opts?: { mode?: string }) => {
				// Validate transition like the real manager (single source of truth)
				if (
					opts?.mode !== 'manual' &&
					!VALID_STATUS_TRANSITIONS[task!.status]?.includes(status as NeoTask['status'])
				) {
					throw new Error(`Invalid status transition from '${task!.status}' to '${status}'.`);
				}
				return { ...task!, status: status as NeoTask['status'] };
			}),
			archiveTask: mock(async (_id: string, opts?: { mode?: string }) => {
				// Validate archival like the real manager (single source of truth)
				if (
					opts?.mode !== 'manual' &&
					!VALID_STATUS_TRANSITIONS[task!.status]?.includes('archived' as NeoTask['status'])
				) {
					throw new Error(`Invalid status transition from '${task!.status}' to 'archived'.`);
				}
				return { ...task!, status: 'archived' as const };
			}),
		};
		return mock(() => manager);
	}

	/** Create a runtime service with cancelTask/terminateTaskGroup controls. */
	function makeRuntimeServiceWithRuntimeCleanup(options?: {
		cancelSuccess?: boolean;
		terminateSuccess?: boolean;
	}) {
		const cancelTask = mock(async () => ({
			success: options?.cancelSuccess ?? true,
			cancelledTaskIds: options?.cancelSuccess === false ? [] : ['task-1'],
		}));
		const terminateTaskGroup = mock(async () => options?.terminateSuccess ?? true);
		const runtime = { cancelTask, terminateTaskGroup };
		const service = {
			getRuntime: mock(() => runtime),
		} as unknown as RoomRuntimeService;
		return { service, runtime, cancelTask, terminateTaskGroup };
	}

	function setup(opts: {
		task?: NeoTask | null;
		submittedForReview?: boolean;
		runtimeService?: RoomRuntimeService;
		taskManagerFactory?: TaskManagerFactory;
	}) {
		const {
			task = mockTask,
			submittedForReview = false,
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
			makeDb(makeGroupRow(submittedForReview)),
			{ notifyChange: () => {} } as never,
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

		it('throws for any transition from archived — archived is truly terminal', async () => {
			const archivedTask = { ...mockTask, status: 'archived' as const };
			setup({ task: archivedTask, runtimeService: makeNullRuntimeService() });
			// Try every possible target status — all must be rejected
			for (const targetStatus of [
				'pending',
				'in_progress',
				'review',
				'completed',
				'cancelled',
				'needs_attention',
			] as const) {
				await expect(
					getHandler()({ roomId: 'room-1', taskId: 'task-1', status: targetStatus }, {})
				).rejects.toThrow('Invalid status transition');
			}
		});
	});

	describe('group cancellation', () => {
		it('throws when group cancellation fails due to version conflict', async () => {
			const { service } = makeRuntimeServiceWithRuntimeCleanup({ terminateSuccess: false });

			setup({
				task: mockTask, // in_progress status
				submittedForReview: true,
				runtimeService: service,
			});

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'completed' }, {})
			).rejects.toThrow('Failed to terminate task group');
		});

		it('succeeds when group cancellation succeeds', async () => {
			const { service, terminateTaskGroup } = makeRuntimeServiceWithRuntimeCleanup();

			setup({
				task: mockTask, // in_progress status
				submittedForReview: true,
				runtimeService: service,
			});

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'completed' },
				{}
			);
			expect(terminateTaskGroup).toHaveBeenCalledWith('task-1');
			expect(result).toEqual({ task: { ...mockTask, status: 'completed' } });
		});

		it('uses runtime.cancelTask when moving to cancelled', async () => {
			const { service, cancelTask, terminateTaskGroup } = makeRuntimeServiceWithRuntimeCleanup({
				cancelSuccess: true,
			});

			setup({
				task: mockTask, // in_progress status
				submittedForReview: true,
				runtimeService: service,
			});

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'cancelled' },
				{}
			);
			expect(cancelTask).toHaveBeenCalledWith('task-1');
			expect(terminateTaskGroup).not.toHaveBeenCalled();
			expect(result).toEqual({ task: mockTask });
		});

		it('does not terminate group when moving to non-terminal state', async () => {
			const { service, cancelTask, terminateTaskGroup } = makeRuntimeServiceWithRuntimeCleanup();

			setup({
				task: mockTask, // in_progress status
				submittedForReview: true,
				runtimeService: service,
			});

			// Moving to 'review' is not a terminal state, so group shouldn't be terminated
			await getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'review' }, {});
			expect(cancelTask).not.toHaveBeenCalled();
			expect(terminateTaskGroup).not.toHaveBeenCalled();
		});

		it('does not cancel group when no runtime service', async () => {
			// Without runtime service, the group cancellation code path is not entered
			setup({
				task: mockTask,
				submittedForReview: true,
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

		it('allows valid transition from needs_attention to pending (restart)', async () => {
			const failedTask = { ...mockTask, status: 'needs_attention' as const };
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

		it('allows valid transition from completed to in_progress (lightweight revival, no group wipe)', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const { service, cancelTask, terminateTaskGroup } = makeRuntimeServiceWithRuntimeCleanup();
			setup({ task: completedTask, runtimeService: service });

			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'in_progress' },
				{}
			);
			// completed → in_progress: group is NOT reset/terminated — lightweight revival
			expect(cancelTask).not.toHaveBeenCalled();
			expect(terminateTaskGroup).not.toHaveBeenCalled();
			expect(result).toEqual({ task: { ...completedTask, status: 'in_progress' } });
		});
	});

	describe('archived transition', () => {
		function makeSetStatusWithArchiveFactory(task: NeoTask | null): TaskManagerFactory {
			const archivedTask = task ? { ...task, status: 'archived' as const } : null;
			const archiveTask = mock(async () => archivedTask!);
			const manager = {
				createTask: mock(async () => task!),
				getTask: mock(async () => task),
				listTasks: mock(async () => []),
				failTask: mock(async () => task!),
				cancelTask: mock(async () => task!),
				setTaskStatus: mock(async (_id: string, status: string) => ({
					...task!,
					status: status as NeoTask['status'],
				})),
				archiveTask,
			};
			return Object.assign(
				mock(() => manager),
				{ _archiveTask: archiveTask }
			);
		}

		it('delegates to runtime.archiveTaskGroup when runtime is available', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const { service, runtime } = makeRuntimeService();
			setup({ task: completedTask, runtimeService: service });

			await getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'archived' }, {});

			expect(runtime.archiveTaskGroup).toHaveBeenCalledWith('task-1', undefined);
		});

		it('emits task update and room overview after archiving via runtime', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const { service } = makeRuntimeService();

			const mh = createMockMessageHub();
			const daemonHub = createMockDaemonHub();
			setupTaskHandlers(
				mh.hub,
				mockRoomManager,
				daemonHub,
				makeDb(makeGroupRow()),
				{ notifyChange: () => {} } as never,
				makeSetStatusWithArchiveFactory(completedTask),
				service
			);

			const handler = mh.handlers.get('task.setStatus')!;
			await handler({ roomId: 'room-1', taskId: 'task-1', status: 'archived' }, {});

			expect(daemonHub.emit).toHaveBeenCalledWith(
				'room.task.update',
				expect.objectContaining({ roomId: 'room-1' })
			);
		});

		it('calls taskManager.archiveTask when no runtime is available', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const factory = makeSetStatusWithArchiveFactory(completedTask);
			setup({ task: completedTask, runtimeService: undefined, taskManagerFactory: factory });

			await getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'archived' }, {});

			expect(
				(factory as unknown as { _archiveTask: ReturnType<typeof mock> })._archiveTask
			).toHaveBeenCalledWith('task-1', undefined);
		});

		it('calls taskManager.archiveTask when runtime has no runtime for room', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			const factory = makeSetStatusWithArchiveFactory(cancelledTask);
			setup({
				task: cancelledTask,
				runtimeService: makeNullRuntimeService(),
				taskManagerFactory: factory,
			});

			await getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'archived' }, {});

			expect(
				(factory as unknown as { _archiveTask: ReturnType<typeof mock> })._archiveTask
			).toHaveBeenCalledWith('task-1', undefined);
		});

		it('throws for invalid transition from in_progress to archived', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			setup({ task: inProgressTask, runtimeService: makeNullRuntimeService() });

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'archived' }, {})
			).rejects.toThrow('Invalid status transition');
		});
	});

	describe('manual mode', () => {
		it('allows invalid transitions when mode is manual', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });

			// pending → completed is invalid in runtime mode but allowed in manual mode
			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'completed', mode: 'manual' },
				{}
			);
			expect(result).toEqual({ task: { ...pendingTask, status: 'completed' } });
		});

		it('allows archived → pending transition in manual mode', async () => {
			const archivedTask = { ...mockTask, status: 'archived' as const };
			setup({ task: archivedTask, runtimeService: makeNullRuntimeService() });

			// archived → pending is normally terminal (no transitions), but manual mode allows it
			const result = await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'pending', mode: 'manual' },
				{}
			);
			expect(result).toEqual({ task: { ...archivedTask, status: 'pending' } });
		});

		it('still enforces transitions in runtime mode (explicitly)', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });

			await expect(
				getHandler()(
					{ roomId: 'room-1', taskId: 'task-1', status: 'completed', mode: 'runtime' },
					{}
				)
			).rejects.toThrow('Invalid status transition');
		});

		it('still enforces transitions when mode is not provided (default runtime behavior)', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });

			await expect(
				getHandler()({ roomId: 'room-1', taskId: 'task-1', status: 'completed' }, {})
			).rejects.toThrow('Invalid status transition');
		});

		it('passes mode to setTaskStatus', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			const factory = makeSetStatusTaskManagerFactory(pendingTask);
			setup({
				task: pendingTask,
				runtimeService: makeNullRuntimeService(),
				taskManagerFactory: factory,
			});

			await getHandler()(
				{ roomId: 'room-1', taskId: 'task-1', status: 'completed', mode: 'manual' },
				{}
			);

			// Verify that setTaskStatus was called with mode: 'manual'
			const taskManagerInstance = (factory as ReturnType<typeof mock>).mock.results[0].value;
			expect(taskManagerInstance.setTaskStatus).toHaveBeenCalledWith(
				'task-1',
				'completed',
				expect.objectContaining({ mode: 'manual' })
			);
		});
	});
});

// ─── task.interruptSession Tests ───

describe('task.interruptSession RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	function setup(opts: { task?: NeoTask | null; runtimeService?: RoomRuntimeService }) {
		const { task = mockTask, runtimeService } = opts;
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow()),
			{ notifyChange: () => {} } as never,
			makeTaskManagerFactory(task),
			runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('task.interruptSession');
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

		it('throws when task status is pending', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task cannot be interrupted'
			);
		});

		it('throws when task status is completed', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			setup({ task: completedTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task cannot be interrupted'
			);
		});

		it('throws when no runtime found for room', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			// makeNullRuntimeService returns a service with getRuntime() = null (no room runtime)
			setup({ task: inProgressTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'No runtime found for room'
			);
		});
	});

	describe('happy paths', () => {
		it('calls runtime.interruptTaskSession for in_progress task and returns success', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			const { service, runtime } = makeRuntimeService(true);
			setup({ task: inProgressTask, runtimeService: service });

			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});
			expect(runtime.interruptTaskSession).toHaveBeenCalledWith('task-1');
			// Returns just { success: true }, NOT the task (task status is unchanged)
			expect(result).toEqual({ success: true });
		});

		it('calls runtime.interruptTaskSession for review task and returns success', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			const { service, runtime } = makeRuntimeService(true);
			setup({ task: reviewTask, runtimeService: service });

			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});
			expect(runtime.interruptTaskSession).toHaveBeenCalledWith('task-1');
			expect(result).toEqual({ success: true });
		});

		it('throws when runtime.interruptTaskSession returns failure', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			// Pass false as injectResult to make interruptTaskSession fail
			const { service } = makeRuntimeService(true, false);
			setup({ task: inProgressTask, runtimeService: service });

			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Failed to interrupt task session'
			);
		});
	});
});

// ─── task.archive Tests ───

describe('task.archive RPC Handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;

	function makeArchiveTaskManagerFactory(task: NeoTask | null): TaskManagerFactory {
		const archivedTask = task ? { ...task, archivedAt: Date.now() } : null;
		const archiveTask = mock(async () => archivedTask!);
		const manager = {
			createTask: mock(async () => task!),
			getTask: mock(async () => task),
			listTasks: mock(async () => []),
			failTask: mock(async () => task!),
			cancelTask: mock(async () => task!),
			setTaskStatus: mock(async () => task!),
			archiveTask,
		};
		return Object.assign(
			mock(() => manager),
			{ _archiveTask: archiveTask, _manager: manager }
		);
	}

	function setup(opts: {
		task?: NeoTask | null;
		runtimeService?: RoomRuntimeService;
		taskManagerFactory?: TaskManagerFactory;
	}) {
		const { task = { ...mockTask, status: 'completed' as const }, runtimeService } = opts;
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow()),
			{ notifyChange: () => {} } as never,
			opts.taskManagerFactory ?? makeTaskManagerFactory(task),
			runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('task.archive');
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

	describe('task state validation', () => {
		it('throws when task is not found', async () => {
			setup({ task: null, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				'Task not found'
			);
		});

		it('throws when task is in_progress (non-terminal)', async () => {
			const inProgressTask = { ...mockTask, status: 'in_progress' as const };
			setup({ task: inProgressTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				"Cannot archive task in 'in_progress' state"
			);
		});

		it('throws when task is pending (non-terminal)', async () => {
			const pendingTask = { ...mockTask, status: 'pending' as const };
			setup({ task: pendingTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				"Cannot archive task in 'pending' state"
			);
		});

		it('throws when task is review (non-terminal)', async () => {
			const reviewTask = { ...mockTask, status: 'review' as const };
			setup({ task: reviewTask, runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {})).rejects.toThrow(
				"Cannot archive task in 'review' state"
			);
		});
	});

	describe('archive with runtime', () => {
		it('delegates to runtime.archiveTaskGroup when runtime is available', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const { service, runtime } = makeRuntimeService();
			setup({ task: completedTask, runtimeService: service });

			await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});

			expect(runtime.archiveTaskGroup).toHaveBeenCalledWith('task-1');
		});

		it('allows archiving cancelled tasks via runtime', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			const { service, runtime } = makeRuntimeService();
			setup({ task: cancelledTask, runtimeService: service });

			await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});

			expect(runtime.archiveTaskGroup).toHaveBeenCalledWith('task-1');
		});

		it('allows archiving needs_attention tasks via runtime', async () => {
			const failedTask = { ...mockTask, status: 'needs_attention' as const };
			const { service, runtime } = makeRuntimeService();
			setup({ task: failedTask, runtimeService: service });

			await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});

			expect(runtime.archiveTaskGroup).toHaveBeenCalledWith('task-1');
		});
	});

	describe('archive without runtime — archivedAt must always be set', () => {
		it('calls taskManager.archiveTask when runtimeService is absent', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			const factory = makeArchiveTaskManagerFactory(completedTask);
			setup({ task: completedTask, runtimeService: undefined, taskManagerFactory: factory });

			await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});

			// archiveTask must be called even without a runtime
			expect(
				(factory as unknown as { _archiveTask: ReturnType<typeof mock> })._archiveTask
			).toHaveBeenCalledWith('task-1');
		});

		it('calls taskManager.archiveTask when runtime is not found for room', async () => {
			const cancelledTask = { ...mockTask, status: 'cancelled' as const };
			const factory = makeArchiveTaskManagerFactory(cancelledTask);
			setup({
				task: cancelledTask,
				runtimeService: makeNullRuntimeService(),
				taskManagerFactory: factory,
			});

			await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});

			expect(
				(factory as unknown as { _archiveTask: ReturnType<typeof mock> })._archiveTask
			).toHaveBeenCalledWith('task-1');
		});

		it('returns the task after archiving without runtime', async () => {
			const completedTask = { ...mockTask, status: 'completed' as const };
			setup({ task: completedTask, runtimeService: makeNullRuntimeService() });

			const result = await getHandler()({ roomId: 'room-1', taskId: 'task-1' }, {});

			expect(result).toMatchObject({ task: expect.objectContaining({ id: 'task-1' }) });
		});
	});
});

// ─── session_group.stop RPC Handler ───

/**
 * Build a mock RoomRuntimeService with a controllable forceStopSessionGroup result.
 */
function makeForceStopRuntimeService(result: { success: boolean; error?: string }) {
	const forceStopSessionGroup = mock(async () => result);
	const runtime = { forceStopSessionGroup };
	const service = { getRuntime: mock(() => runtime) } as unknown as RoomRuntimeService;
	return { service, runtime };
}

describe('session_group.stop RPC Handler', () => {
	let handlers: Map<string, RequestHandler>;

	function setup(opts: { runtimeService?: RoomRuntimeService } = {}) {
		const mh = createMockMessageHub();
		handlers = mh.handlers;
		setupTaskHandlers(
			mh.hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb(makeGroupRow()),
			{ notifyChange: () => {} } as never,
			makeTaskManagerFactory(mockTask),
			opts.runtimeService
		);
	}

	function getHandler(): RequestHandler {
		const h = handlers.get('session_group.stop');
		expect(h).toBeDefined();
		return h!;
	}

	describe('parameter validation', () => {
		it('throws when roomId is missing', async () => {
			const { service } = makeForceStopRuntimeService({ success: true });
			setup({ runtimeService: service });
			await expect(getHandler()({ groupId: 'group-1' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws when groupId is missing', async () => {
			const { service } = makeForceStopRuntimeService({ success: true });
			setup({ runtimeService: service });
			await expect(getHandler()({ roomId: 'room-1' }, {})).rejects.toThrow('Group ID is required');
		});
	});

	describe('runtime service validation', () => {
		it('throws when runtimeService is not provided', async () => {
			setup({ runtimeService: undefined });
			await expect(getHandler()({ roomId: 'room-1', groupId: 'group-1' }, {})).rejects.toThrow(
				'Runtime service is required'
			);
		});

		it('throws when runtime is not found for the room', async () => {
			setup({ runtimeService: makeNullRuntimeService() });
			await expect(getHandler()({ roomId: 'room-1', groupId: 'group-1' }, {})).rejects.toThrow(
				'No runtime found for room'
			);
		});
	});

	describe('happy path', () => {
		it('returns { success: true } and invokes forceStopSessionGroup with correct groupId', async () => {
			const { service, runtime } = makeForceStopRuntimeService({ success: true });
			setup({ runtimeService: service });

			const result = await getHandler()({ roomId: 'room-1', groupId: 'group-abc' }, {});

			expect(result).toEqual({ success: true });
			expect(runtime.forceStopSessionGroup).toHaveBeenCalledWith('group-abc');
		});
	});

	describe('error propagation', () => {
		it('throws with the error message from forceStopSessionGroup when success=false', async () => {
			const { service } = makeForceStopRuntimeService({
				success: false,
				error: 'Session group group-1 not found',
			});
			setup({ runtimeService: service });

			await expect(getHandler()({ roomId: 'room-1', groupId: 'group-1' }, {})).rejects.toThrow(
				'Session group group-1 not found'
			);
		});

		it('throws a generic fallback message when success=false with no error field', async () => {
			const { service } = makeForceStopRuntimeService({ success: false });
			setup({ runtimeService: service });

			await expect(getHandler()({ roomId: 'room-1', groupId: 'group-1' }, {})).rejects.toThrow(
				'Failed to stop session group group-1'
			);
		});
	});
});
