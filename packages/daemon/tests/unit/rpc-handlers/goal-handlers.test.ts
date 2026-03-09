/**
 * Tests for Goal RPC Handlers
 *
 * Tests the RPC handlers for goal operations:
 * - goal.create - Create a new goal
 * - goal.get - Get goal details
 * - goal.list - List goals in room
 * - goal.update - Update a goal
 * - goal.needsHuman - Mark goal as needing human input
 * - goal.reactivate - Reactivate a goal
 * - goal.linkTask - Link a task to a goal
 * - goal.delete - Delete a goal
 *
 * Mocks GoalManager to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import {
	MessageHub,
	type RoomGoal,
	type GoalStatus,
	type GoalPriority,
	type NeoTask,
} from '@neokai/shared';
import {
	setupGoalHandlers,
	type GoalManagerLike,
	type TaskManagerFactory,
} from '../../../src/lib/rpc-handlers/goal-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomRuntimeService } from '../../../src/lib/room/runtime/room-runtime-service';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock GoalManager methods
const mockGoalManager = {
	createGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	getGoal: mock(
		async (): Promise<RoomGoal | null> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	listGoals: mock(async (): Promise<RoomGoal[]> => []),
	updateGoalStatus: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	updateGoalProgress: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 50,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	updateGoalPriority: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'high' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	needsHumanGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'needs_human' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	reactivateGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	linkTaskToGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: ['task-123'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	deleteGoal: mock(
		async (): Promise<{ deleted: boolean; deletedTaskIds: string[] }> => ({
			deleted: true,
			deletedTaskIds: [],
		})
	),
};

const createMockGoalManager = (): GoalManagerLike => mockGoalManager as unknown as GoalManagerLike;

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

describe('Goal RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();

		// Reset all mocks
		mockGoalManager.createGoal.mockClear();
		mockGoalManager.getGoal.mockClear();
		mockGoalManager.listGoals.mockClear();
		mockGoalManager.updateGoalStatus.mockClear();
		mockGoalManager.updateGoalProgress.mockClear();
		mockGoalManager.updateGoalPriority.mockClear();
		mockGoalManager.needsHumanGoal.mockClear();
		mockGoalManager.reactivateGoal.mockClear();
		mockGoalManager.linkTaskToGoal.mockClear();
		mockGoalManager.deleteGoal.mockClear();

		// Setup handlers with mocked dependencies
		setupGoalHandlers(messageHubData.hub, daemonHubData.daemonHub, createMockGoalManager);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('goal.create', () => {
		it('creates goal with all parameters', async () => {
			const handler = messageHubData.handlers.get('goal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				title: 'Implement Feature X',
				description: 'Detailed description of the feature',
				priority: 'high' as GoalPriority,
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.createGoal).toHaveBeenCalled();
			expect(result.goal).toBeDefined();
			expect(result.goal.roomId).toBe('room-123');
		});

		it('creates goal with minimal parameters', async () => {
			const handler = messageHubData.handlers.get('goal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				title: 'Simple Goal',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.createGoal).toHaveBeenCalled();
			expect(result.goal).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.create');
			expect(handler).toBeDefined();

			const params = {
				title: 'Test Goal',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when title is missing', async () => {
			const handler = messageHubData.handlers.get('goal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			await expect(handler!(params, {})).rejects.toThrow('Goal title is required');
		});

		it('emits goal.created event', async () => {
			const handler = messageHubData.handlers.get('goal.create');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', title: 'Test Goal' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.created',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
		});
	});

	describe('goal.get', () => {
		it('returns goal details', async () => {
			const handler = messageHubData.handlers.get('goal.get');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.getGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.id).toBe('goal-123');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.get');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.get');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('throws error when goal not found', async () => {
			const handler = messageHubData.handlers.get('goal.get');
			expect(handler).toBeDefined();

			mockGoalManager.getGoal.mockResolvedValueOnce(null);

			await expect(handler!({ roomId: 'room-123', goalId: 'non-existent' }, {})).rejects.toThrow(
				'Goal not found: non-existent'
			);
		});
	});

	describe('goal.list', () => {
		it('lists all goals in a room', async () => {
			const handler = messageHubData.handlers.get('goal.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { goals: RoomGoal[] };

			expect(mockGoalManager.listGoals).toHaveBeenCalled();
			expect(Array.isArray(result.goals)).toBe(true);
		});

		it('filters by status', async () => {
			const handler = messageHubData.handlers.get('goal.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				status: 'active' as GoalStatus,
			};

			await handler!(params, {});

			expect(mockGoalManager.listGoals).toHaveBeenCalledWith('active');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('goal.update', () => {
		it('updates goal status when status is provided', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				updates: { status: 'completed' as GoalStatus },
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.updateGoalStatus).toHaveBeenCalledWith('goal-123', 'completed', {});
			expect(result.goal).toBeDefined();
		});

		it('updates goal progress when progress is provided', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				updates: { progress: 75 },
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.updateGoalProgress).toHaveBeenCalledWith('goal-123', 75, undefined);
			expect(result.goal).toBeDefined();
		});

		it('updates goal priority when priority is provided', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				updates: { priority: 'high' as GoalPriority },
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.updateGoalPriority).toHaveBeenCalledWith('goal-123', 'high');
			expect(result.goal).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ goalId: 'goal-123', updates: { status: 'active' } }, {})
			).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', updates: { status: 'active' } }, {})
			).rejects.toThrow('Goal ID is required');
		});

		it('throws error when no update fields are provided', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-123', updates: {} }, {})
			).rejects.toThrow('No update fields provided');
		});

		it('throws error when updates has no recognized fields', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-123', updates: { title: 'New Title' } }, {})
			).rejects.toThrow('No update fields provided');
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await handler!(
				{ roomId: 'room-123', goalId: 'goal-123', updates: { status: 'active' as GoalStatus } },
				{}
			);

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.updated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
		});
	});

	describe('goal.needsHuman', () => {
		it('marks a goal as needing human input', async () => {
			const handler = messageHubData.handlers.get('goal.needsHuman');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.needsHumanGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.status).toBe('needs_human');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.needsHuman');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.needsHuman');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.needsHuman');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.updated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
		});
	});

	describe('goal.reactivate', () => {
		it('reactivates a goal', async () => {
			const handler = messageHubData.handlers.get('goal.reactivate');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.reactivateGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.status).toBe('active');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.reactivate');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.reactivate');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.reactivate');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.updated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
		});
	});

	describe('goal.linkTask', () => {
		it('links a task to a goal', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				taskId: 'task-456',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.linkTaskToGoal).toHaveBeenCalledWith('goal-123', 'task-456');
			expect(result.goal).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123', taskId: 'task-456' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', taskId: 'task-456' }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('emits goal.updated and goal.progressUpdated events', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123', taskId: 'task-456' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.updated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.progressUpdated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
		});
	});

	describe('goal.delete', () => {
		it('deletes a goal', async () => {
			const handler = messageHubData.handlers.get('goal.delete');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { success: boolean };

			expect(mockGoalManager.deleteGoal).toHaveBeenCalledWith('goal-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.delete');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.delete');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.updated event with undefined goal to signal deletion', async () => {
			const handler = messageHubData.handlers.get('goal.delete');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.updated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
					goal: undefined,
				})
			);
		});

		it('returns false when delete fails', async () => {
			const handler = messageHubData.handlers.get('goal.delete');
			expect(handler).toBeDefined();

			mockGoalManager.deleteGoal.mockResolvedValueOnce({ deleted: false, deletedTaskIds: [] });

			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(false);
		});
	});

	describe('task approval handlers', () => {
		function setupApprovalHandlers(task: NeoTask | null, resumeResult = true) {
			const taskManager = {
				getTask: mock(async () => task),
				reviewTask: mock(async () => task),
				updateTaskStatus: mock(async () => task),
			};
			const taskManagerFactory: TaskManagerFactory = mock(() => taskManager);

			const runtime = {
				resumeWorkerFromHuman: mock(async () => resumeResult),
			};
			const runtimeService = {
				getRuntime: mock(() => runtime),
			} as unknown as RoomRuntimeService;

			setupGoalHandlers(
				messageHubData.hub,
				daemonHubData.daemonHub,
				createMockGoalManager,
				taskManagerFactory,
				runtimeService
			);

			return { taskManager, runtime, runtimeService };
		}

		it('registers task.approve handler', async () => {
			setupApprovalHandlers(null, true);
			expect(messageHubData.handlers.get('task.approve')).toBeDefined();
		});

		it('approves coding task via task.approve and resumes runtime', async () => {
			const task = {
				id: 'task-123',
				roomId: 'room-123',
				title: 'Task',
				description: '',
				status: 'review',
				priority: 'normal',
				taskType: 'coding',
				progress: 0,
				dependsOn: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as NeoTask;
			const { runtime } = setupApprovalHandlers(task, true);
			const handler = messageHubData.handlers.get('task.approve');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123', taskId: 'task-123' }, {})) as {
				success: boolean;
			};

			expect(runtime.resumeWorkerFromHuman).toHaveBeenCalledWith(
				'task-123',
				expect.stringContaining('Human has approved the PR'),
				{ approved: true }
			);
			expect(result.success).toBe(true);
		});

		it('approves planning task via task.approve and resumes runtime', async () => {
			const task = {
				id: 'task-123',
				roomId: 'room-123',
				title: 'Task',
				description: '',
				status: 'review',
				priority: 'normal',
				taskType: 'planning',
				progress: 0,
				dependsOn: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as NeoTask;
			const { runtime } = setupApprovalHandlers(task, true);
			const handler = messageHubData.handlers.get('task.approve');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123', taskId: 'task-123' }, {})) as {
				success: boolean;
			};

			expect(runtime.resumeWorkerFromHuman).toHaveBeenCalledWith(
				'task-123',
				expect.stringContaining('create tasks 1:1 from the approved plan'),
				{ approved: true }
			);
			expect(result.success).toBe(true);
		});

		it('throws when task.approve resume fails', async () => {
			const task = {
				id: 'task-123',
				roomId: 'room-123',
				title: 'Task',
				description: '',
				status: 'review',
				priority: 'normal',
				taskType: 'coding',
				progress: 0,
				dependsOn: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as NeoTask;
			setupApprovalHandlers(task, false);
			const handler = messageHubData.handlers.get('task.approve');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', taskId: 'task-123' }, {})).rejects.toThrow(
				'Failed to resume task task-123'
			);
		});
	});
});
