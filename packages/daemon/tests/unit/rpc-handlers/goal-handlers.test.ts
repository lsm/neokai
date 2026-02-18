/**
 * Tests for Goal RPC Handlers
 *
 * Tests the RPC handlers for goal operations:
 * - goal.create - Create a new goal
 * - goal.get - Get goal details
 * - goal.list - List goals in room
 * - goal.updateStatus - Update goal status
 * - goal.updateProgress - Update goal progress
 * - goal.updatePriority - Update goal priority
 * - goal.start - Start a goal (mark as in_progress)
 * - goal.complete - Complete a goal
 * - goal.block - Block a goal
 * - goal.unblock - Unblock a goal
 * - goal.linkTask - Link a task to a goal
 * - goal.unlinkTask - Unlink a task from a goal
 * - goal.delete - Delete a goal
 * - goal.getNext - Get next goal to work on
 * - goal.getActive - Get all active goals
 *
 * Mocks GoalManager to focus on RPC handler logic.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type RoomGoal, type GoalStatus, type GoalPriority } from '@neokai/shared';
import {
	setupGoalHandlers,
	type GoalManagerLike,
} from '../../../src/lib/rpc-handlers/goal-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

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
			status: 'pending' as GoalStatus,
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
			status: 'pending' as GoalStatus,
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
			status: 'in_progress' as GoalStatus,
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
			status: 'in_progress' as GoalStatus,
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
			status: 'pending' as GoalStatus,
			priority: 'high' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	startGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'in_progress' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	completeGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'completed' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 100,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			completedAt: Date.now(),
		})
	),
	blockGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'blocked' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	unblockGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'pending' as GoalStatus,
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
			status: 'pending' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: ['task-123'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	unlinkTaskFromGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'pending' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	deleteGoal: mock(async (): Promise<boolean> => true),
	getNextGoal: mock(async (): Promise<RoomGoal | null> => null),
	getActiveGoals: mock(async (): Promise<RoomGoal[]> => []),
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
		mockGoalManager.startGoal.mockClear();
		mockGoalManager.completeGoal.mockClear();
		mockGoalManager.blockGoal.mockClear();
		mockGoalManager.unblockGoal.mockClear();
		mockGoalManager.linkTaskToGoal.mockClear();
		mockGoalManager.unlinkTaskFromGoal.mockClear();
		mockGoalManager.deleteGoal.mockClear();
		mockGoalManager.getNextGoal.mockClear();
		mockGoalManager.getActiveGoals.mockClear();

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
				status: 'pending' as GoalStatus,
			};

			await handler!(params, {});

			expect(mockGoalManager.listGoals).toHaveBeenCalledWith('pending');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('goal.updateStatus', () => {
		it('updates goal status', async () => {
			const handler = messageHubData.handlers.get('goal.updateStatus');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				status: 'in_progress' as GoalStatus,
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.updateGoalStatus).toHaveBeenCalledWith(
				'goal-123',
				'in_progress',
				undefined
			);
			expect(result.goal).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updateStatus');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123', status: 'in_progress' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updateStatus');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', status: 'in_progress' }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});

		it('throws error when status is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updateStatus');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'Status is required'
			);
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.updateStatus');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123', status: 'in_progress' }, {});

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

	describe('goal.updateProgress', () => {
		it('updates goal progress', async () => {
			const handler = messageHubData.handlers.get('goal.updateProgress');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				progress: 50,
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.updateGoalProgress).toHaveBeenCalledWith('goal-123', 50, undefined);
			expect(result.goal).toBeDefined();
		});

		it('updates goal progress with metrics', async () => {
			const handler = messageHubData.handlers.get('goal.updateProgress');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				progress: 75,
				metrics: { tasksCompleted: 3, tasksTotal: 4 },
			};

			await handler!(params, {});

			expect(mockGoalManager.updateGoalProgress).toHaveBeenCalledWith('goal-123', 75, {
				tasksCompleted: 3,
				tasksTotal: 4,
			});
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updateProgress');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123', progress: 50 }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updateProgress');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', progress: 50 }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});

		it('throws error when progress is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updateProgress');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'Progress is required'
			);
		});

		it('emits goal.progressUpdated event', async () => {
			const handler = messageHubData.handlers.get('goal.updateProgress');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123', progress: 50 }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.progressUpdated',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
					progress: 50,
				})
			);
		});
	});

	describe('goal.updatePriority', () => {
		it('updates goal priority', async () => {
			const handler = messageHubData.handlers.get('goal.updatePriority');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				priority: 'high' as GoalPriority,
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.updateGoalPriority).toHaveBeenCalledWith('goal-123', 'high');
			expect(result.goal).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updatePriority');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123', priority: 'high' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updatePriority');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', priority: 'high' }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});

		it('throws error when priority is missing', async () => {
			const handler = messageHubData.handlers.get('goal.updatePriority');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'Priority is required'
			);
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.updatePriority');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123', priority: 'high' }, {});

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

	describe('goal.start', () => {
		it('starts a goal', async () => {
			const handler = messageHubData.handlers.get('goal.start');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.startGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.status).toBe('in_progress');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.start');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.start');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.start');
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

	describe('goal.complete', () => {
		it('completes a goal', async () => {
			const handler = messageHubData.handlers.get('goal.complete');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.completeGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.status).toBe('completed');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.complete');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.complete');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.completed event', async () => {
			const handler = messageHubData.handlers.get('goal.complete');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'goal.completed',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					goalId: 'goal-123',
				})
			);
		});
	});

	describe('goal.block', () => {
		it('blocks a goal', async () => {
			const handler = messageHubData.handlers.get('goal.block');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.blockGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.status).toBe('blocked');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.block');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.block');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.block');
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

	describe('goal.unblock', () => {
		it('unblocks a goal', async () => {
			const handler = messageHubData.handlers.get('goal.unblock');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.unblockGoal).toHaveBeenCalledWith('goal-123');
			expect(result.goal).toBeDefined();
			expect(result.goal.status).toBe('pending');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.unblock');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.unblock');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('emits goal.updated event', async () => {
			const handler = messageHubData.handlers.get('goal.unblock');
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

	describe('goal.unlinkTask', () => {
		it('unlinks a task from a goal', async () => {
			const handler = messageHubData.handlers.get('goal.unlinkTask');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				goalId: 'goal-123',
				taskId: 'task-456',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal };

			expect(mockGoalManager.unlinkTaskFromGoal).toHaveBeenCalledWith('goal-123', 'task-456');
			expect(result.goal).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.unlinkTask');
			expect(handler).toBeDefined();

			await expect(handler!({ goalId: 'goal-123', taskId: 'task-456' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.unlinkTask');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', taskId: 'task-456' }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});

		it('throws error when taskId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.unlinkTask');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'Task ID is required'
			);
		});

		it('emits goal.updated and goal.progressUpdated events', async () => {
			const handler = messageHubData.handlers.get('goal.unlinkTask');
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

			mockGoalManager.deleteGoal.mockResolvedValueOnce(false);

			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(false);
		});
	});

	describe('goal.getNext', () => {
		it('returns next goal', async () => {
			const handler = messageHubData.handlers.get('goal.getNext');
			expect(handler).toBeDefined();

			const mockGoal: RoomGoal = {
				id: 'goal-456',
				roomId: 'room-123',
				title: 'Next Goal',
				description: '',
				status: 'pending',
				priority: 'high',
				progress: 0,
				linkedTaskIds: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			mockGoalManager.getNextGoal.mockResolvedValueOnce(mockGoal);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal | null };

			expect(mockGoalManager.getNextGoal).toHaveBeenCalled();
			expect(result.goal).toBeDefined();
		});

		it('returns null when no next goal', async () => {
			const handler = messageHubData.handlers.get('goal.getNext');
			expect(handler).toBeDefined();

			mockGoalManager.getNextGoal.mockResolvedValueOnce(null);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { goal: RoomGoal | null };

			expect(result.goal).toBeNull();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.getNext');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('goal.getActive', () => {
		it('returns active goals', async () => {
			const handler = messageHubData.handlers.get('goal.getActive');
			expect(handler).toBeDefined();

			const mockGoals: RoomGoal[] = [
				{
					id: 'goal-123',
					roomId: 'room-123',
					title: 'Active Goal 1',
					description: '',
					status: 'in_progress',
					priority: 'normal',
					progress: 50,
					linkedTaskIds: [],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: 'goal-456',
					roomId: 'room-123',
					title: 'Active Goal 2',
					description: '',
					status: 'pending',
					priority: 'high',
					progress: 0,
					linkedTaskIds: [],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockGoalManager.getActiveGoals.mockResolvedValueOnce(mockGoals);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { goals: RoomGoal[] };

			expect(mockGoalManager.getActiveGoals).toHaveBeenCalled();
			expect(result.goals).toHaveLength(2);
		});

		it('returns empty array when no active goals', async () => {
			const handler = messageHubData.handlers.get('goal.getActive');
			expect(handler).toBeDefined();

			mockGoalManager.getActiveGoals.mockResolvedValueOnce([]);

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { goals: RoomGoal[] };

			expect(result.goals).toHaveLength(0);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.getActive');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});
});
