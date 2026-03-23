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
	type MissionExecution,
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
	patchGoal: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Updated Goal',
			description: 'Updated description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
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
	deleteGoal: mock(async (): Promise<boolean> => true),
	getActiveExecution: mock((): MissionExecution | null => null),
	linkTaskToExecution: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: 'Test description',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: ['task-456'],
			missionType: 'recurring',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	updateNextRunAt: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: '',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 0,
			linkedTaskIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	listExecutions: mock((): MissionExecution[] => []),
	recordMetric: mock(
		async (): Promise<RoomGoal> => ({
			id: 'goal-123',
			roomId: 'room-123',
			title: 'Test Goal',
			description: '',
			status: 'active' as GoalStatus,
			priority: 'normal' as GoalPriority,
			progress: 50,
			linkedTaskIds: [],
			missionType: 'measurable',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	),
	checkMetricTargets: mock(
		async (): Promise<{
			allMet: boolean;
			results: Array<{ name: string; current: number; target: number; met: boolean }>;
		}> => ({
			allMet: false,
			results: [{ name: 'coverage', current: 70, target: 90, met: false }],
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
		mockGoalManager.patchGoal.mockClear();
		mockGoalManager.needsHumanGoal.mockClear();
		mockGoalManager.reactivateGoal.mockClear();
		mockGoalManager.linkTaskToGoal.mockClear();
		mockGoalManager.deleteGoal.mockClear();
		mockGoalManager.getActiveExecution.mockClear();
		mockGoalManager.linkTaskToExecution.mockClear();
		mockGoalManager.updateNextRunAt.mockClear();
		mockGoalManager.listExecutions.mockClear();
		mockGoalManager.recordMetric.mockClear();
		mockGoalManager.checkMetricTargets.mockClear();

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

		it('patches title via patchGoal', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			const result = await handler!(
				{ roomId: 'room-123', goalId: 'goal-123', updates: { title: 'New Title' } },
				{}
			);

			expect(mockGoalManager.patchGoal).toHaveBeenCalledWith('goal-123', { title: 'New Title' });
			expect((result as { goal: RoomGoal }).goal).toBeDefined();
		});

		it('patches missionType and autonomyLevel via patchGoal', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await handler!(
				{
					roomId: 'room-123',
					goalId: 'goal-123',
					updates: {
						missionType: 'measurable',
						autonomyLevel: 'semi_autonomous',
						priority: 'high',
					},
				},
				{}
			);

			expect(mockGoalManager.patchGoal).toHaveBeenCalledWith('goal-123', {
				priority: 'high',
				missionType: 'measurable',
				autonomyLevel: 'semi_autonomous',
			});
		});

		it('patches structuredMetrics and schedule via patchGoal', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			const metrics = [{ name: 'Coverage', target: 90, current: 0 }];
			const schedule = { expression: '@daily', timezone: 'UTC' };

			await handler!(
				{
					roomId: 'room-123',
					goalId: 'goal-123',
					updates: { structuredMetrics: metrics, schedule },
				},
				{}
			);

			expect(mockGoalManager.patchGoal).toHaveBeenCalledWith('goal-123', {
				structuredMetrics: metrics,
				schedule,
			});
		});

		it('throws error when updates has truly no recognized fields', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-123', updates: {} }, {})
			).rejects.toThrow('No update fields provided');
		});

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.update');
			expect(handler).toBeDefined();

			await handler!(
				{ roomId: 'room-123', goalId: 'goal-123', updates: { status: 'active' as GoalStatus } },
				{}
			);

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
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

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.needsHuman');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
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

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.reactivate');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
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

		it('does not emit goal.updated or goal.progressUpdated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123', taskId: 'task-456' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
			expect(daemonHubData.emit).not.toHaveBeenCalledWith(
				'goal.progressUpdated',
				expect.anything()
			);
		});

		it('uses linkTaskToExecution for recurring mission with active execution', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask')!;

			// Mock: goal is a recurring mission
			mockGoalManager.getGoal.mockResolvedValueOnce({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Recurring Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				missionType: 'recurring',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as RoomGoal);

			// Mock: active execution exists
			const fakeExecution: MissionExecution = {
				id: 'exec-1',
				goalId: 'goal-123',
				executionNumber: 1,
				startedAt: Math.floor(Date.now() / 1000),
				completedAt: null,
				status: 'running',
				resultSummary: null,
				taskIds: [],
			};
			mockGoalManager.getActiveExecution.mockReturnValueOnce(fakeExecution);

			await handler!({ roomId: 'room-123', goalId: 'goal-123', taskId: 'task-456' }, {});

			expect(mockGoalManager.linkTaskToExecution).toHaveBeenCalledWith(
				'goal-123',
				'exec-1',
				'task-456'
			);
			expect(mockGoalManager.linkTaskToGoal).not.toHaveBeenCalled();
		});

		it('falls back to linkTaskToGoal for recurring mission without active execution', async () => {
			const handler = messageHubData.handlers.get('goal.linkTask')!;

			mockGoalManager.getGoal.mockResolvedValueOnce({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Recurring Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				missionType: 'recurring',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as RoomGoal);

			// No active execution
			mockGoalManager.getActiveExecution.mockReturnValueOnce(null);

			await handler!({ roomId: 'room-123', goalId: 'goal-123', taskId: 'task-456' }, {});

			expect(mockGoalManager.linkTaskToGoal).toHaveBeenCalledWith('goal-123', 'task-456');
			expect(mockGoalManager.linkTaskToExecution).not.toHaveBeenCalled();
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

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.delete');
			expect(handler).toBeDefined();

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
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

	// ---- recurring mission schedule handlers ----

	const recurringGoal: RoomGoal = {
		id: 'goal-123',
		roomId: 'room-123',
		title: 'Daily Backup',
		description: 'Run daily backup',
		status: 'active' as GoalStatus,
		priority: 'normal' as GoalPriority,
		progress: 0,
		linkedTaskIds: [],
		missionType: 'recurring',
		schedule: { expression: '@daily', timezone: 'UTC' },
		nextRunAt: Math.floor(Date.now() / 1000) + 3600,
		schedulePaused: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	describe('goal.setSchedule', () => {
		it('registers the handler', () => {
			expect(messageHubData.handlers.get('goal.setSchedule')).toBeDefined();
		});

		it('sets a valid cron schedule and returns updated goal and nextRunAt', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(recurringGoal);
			mockGoalManager.updateGoalStatus.mockResolvedValueOnce({
				...recurringGoal,
				schedule: { expression: '0 9 * * *', timezone: 'UTC' },
			});

			const result = (await handler!(
				{ roomId: 'room-123', goalId: 'goal-123', cronExpression: '0 9 * * *' },
				{}
			)) as { goal: RoomGoal; nextRunAt: number };

			expect(mockGoalManager.updateGoalStatus).toHaveBeenCalledWith(
				'goal-123',
				'active',
				expect.objectContaining({
					schedule: expect.objectContaining({ expression: '0 9 * * *' }),
					missionType: 'recurring',
				})
			);
			expect(typeof result.nextRunAt).toBe('number');
			expect(result.goal).toBeDefined();
		});

		it('throws when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			await expect(handler!({ goalId: 'goal-123', cronExpression: '@daily' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			await expect(handler!({ roomId: 'room-123', cronExpression: '@daily' }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});

		it('throws when cronExpression is missing', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'Cron expression is required'
			);
		});

		it('throws when goal is not found', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(null);
			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-missing', cronExpression: '@daily' }, {})
			).rejects.toThrow('Goal not found');
		});

		it('throws when goal is not a recurring mission', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce({
				...recurringGoal,
				missionType: 'one_shot',
			});
			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-123', cronExpression: '@daily' }, {})
			).rejects.toThrow('not a recurring mission');
		});

		it('throws when cron expression is invalid', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(recurringGoal);
			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-123', cronExpression: 'not-valid-cron' }, {})
			).rejects.toThrow('Invalid cron expression');
		});

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.setSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(recurringGoal);
			mockGoalManager.updateGoalStatus.mockResolvedValueOnce(recurringGoal);

			await handler!({ roomId: 'room-123', goalId: 'goal-123', cronExpression: '@weekly' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
		});
	});

	describe('goal.pauseSchedule', () => {
		it('registers the handler', () => {
			expect(messageHubData.handlers.get('goal.pauseSchedule')).toBeDefined();
		});

		it('sets schedulePaused=true and returns updated goal', async () => {
			const handler = messageHubData.handlers.get('goal.pauseSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(recurringGoal);
			mockGoalManager.updateGoalStatus.mockResolvedValueOnce({
				...recurringGoal,
				schedulePaused: true,
			});

			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				goal: RoomGoal;
			};

			expect(mockGoalManager.updateGoalStatus).toHaveBeenCalledWith(
				'goal-123',
				'active',
				expect.objectContaining({ schedulePaused: true })
			);
			expect(result.goal).toBeDefined();
		});

		it('throws when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.pauseSchedule')!;
			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.pauseSchedule')!;
			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('throws when goal is not a recurring mission', async () => {
			const handler = messageHubData.handlers.get('goal.pauseSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce({
				...recurringGoal,
				missionType: 'one_shot',
			});
			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'not a recurring mission'
			);
		});

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.pauseSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(recurringGoal);
			mockGoalManager.updateGoalStatus.mockResolvedValueOnce({
				...recurringGoal,
				schedulePaused: true,
			});

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
		});
	});

	describe('goal.resumeSchedule', () => {
		const pausedGoal: RoomGoal = { ...recurringGoal, schedulePaused: true };

		it('registers the handler', () => {
			expect(messageHubData.handlers.get('goal.resumeSchedule')).toBeDefined();
		});

		it('sets schedulePaused=false and returns updated goal with nextRunAt', async () => {
			const handler = messageHubData.handlers.get('goal.resumeSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(pausedGoal);
			mockGoalManager.updateGoalStatus.mockResolvedValueOnce({
				...pausedGoal,
				schedulePaused: false,
			});

			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				goal: RoomGoal;
				nextRunAt: number | null;
			};

			expect(mockGoalManager.updateGoalStatus).toHaveBeenCalledWith(
				'goal-123',
				'active',
				expect.objectContaining({ schedulePaused: false })
			);
			expect(result.goal).toBeDefined();
		});

		it('throws when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.resumeSchedule')!;
			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.resumeSchedule')!;
			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('throws when goal is not a recurring mission', async () => {
			const handler = messageHubData.handlers.get('goal.resumeSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce({
				...recurringGoal,
				missionType: 'one_shot',
			});
			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'not a recurring mission'
			);
		});

		it('throws when goal has no schedule', async () => {
			const handler = messageHubData.handlers.get('goal.resumeSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce({
				...recurringGoal,
				schedule: undefined,
				schedulePaused: true,
			});
			await expect(handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})).rejects.toThrow(
				'no schedule set'
			);
		});

		it('does not emit goal.updated (superseded by LiveQuery delta delivery)', async () => {
			const handler = messageHubData.handlers.get('goal.resumeSchedule')!;
			mockGoalManager.getGoal.mockResolvedValueOnce(pausedGoal);
			mockGoalManager.updateGoalStatus.mockResolvedValueOnce({
				...pausedGoal,
				schedulePaused: false,
			});

			await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {});

			expect(daemonHubData.emit).not.toHaveBeenCalledWith('goal.updated', expect.anything());
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

	describe('goal.recordMetric', () => {
		it('records a metric for a measurable mission', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Metrics Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				missionType: 'measurable' as const,
				structuredMetrics: [{ name: 'coverage', target: 90, current: 70 }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));

			const handler = messageHubData.handlers.get('goal.recordMetric');
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ roomId: 'room-123', goalId: 'goal-123', metricName: 'coverage', value: 75 },
				{}
			)) as { goal: RoomGoal; metric: { name: string; value: number; goalProgress: number } };

			expect(mockGoalManager.recordMetric).toHaveBeenCalledWith('goal-123', 'coverage', 75);
			expect(result.metric.name).toBe('coverage');
			expect(result.metric.value).toBe(75);
		});

		it('throws when goal not found', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => null);
			const handler = messageHubData.handlers.get('goal.recordMetric');
			await expect(
				handler!({ roomId: 'room-123', goalId: 'no-such', metricName: 'x', value: 1 }, {})
			).rejects.toThrow('Goal not found');
		});

		it('throws when goal is not measurable', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'One-shot',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				missionType: 'one_shot' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
			const handler = messageHubData.handlers.get('goal.recordMetric');
			await expect(
				handler!({ roomId: 'room-123', goalId: 'goal-123', metricName: 'x', value: 1 }, {})
			).rejects.toThrow('not a measurable mission');
		});

		it('throws when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.recordMetric');
			await expect(handler!({ goalId: 'goal-123', metricName: 'x', value: 1 }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.recordMetric');
			await expect(handler!({ roomId: 'room-123', metricName: 'x', value: 1 }, {})).rejects.toThrow(
				'Goal ID is required'
			);
		});
	});

	describe('goal.getMetrics', () => {
		it('returns metric targets for a measurable mission', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Metrics Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 50,
				linkedTaskIds: [],
				missionType: 'measurable' as const,
				structuredMetrics: [{ name: 'coverage', target: 90, current: 70, unit: '%' }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));

			const handler = messageHubData.handlers.get('goal.getMetrics');
			expect(handler).toBeDefined();

			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				missionType: string;
				allTargetsMet: boolean;
				metrics: Array<{ name: string; current: number; target: number; met: boolean }>;
			};

			expect(mockGoalManager.checkMetricTargets).toHaveBeenCalledWith('goal-123');
			expect(result.missionType).toBe('measurable');
			expect(result.allTargetsMet).toBe(false);
			expect(result.metrics).toHaveLength(1);
			expect(result.metrics[0].name).toBe('coverage');
		});

		it('returns legacy fallback when no structuredMetrics', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Legacy Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				missionType: 'one_shot' as const,
				metrics: { old_metric: 42 },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));

			const handler = messageHubData.handlers.get('goal.getMetrics');
			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				missionType: string;
				structuredMetrics: unknown[];
				legacyMetrics: Record<string, number>;
				note: string;
			};

			expect(result.missionType).toBe('one_shot');
			expect(result.structuredMetrics).toEqual([]);
			expect(result.legacyMetrics).toEqual({ old_metric: 42 });
			expect(result.note).toBeDefined();
		});

		it('throws when goal not found', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => null);
			const handler = messageHubData.handlers.get('goal.getMetrics');
			await expect(handler!({ roomId: 'room-123', goalId: 'no-such' }, {})).rejects.toThrow(
				'Goal not found'
			);
		});

		it('throws when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.getMetrics');
			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.getMetrics');
			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});
	});

	describe('goal.listExecutions', () => {
		it('is registered as a handler', () => {
			const handler = messageHubData.handlers.get('goal.listExecutions');
			expect(handler).toBeDefined();
		});

		it('throws when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.listExecutions');
			await expect(handler!({ goalId: 'goal-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws when goalId is missing', async () => {
			const handler = messageHubData.handlers.get('goal.listExecutions');
			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Goal ID is required');
		});

		it('throws when goal not found', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => null);
			const handler = messageHubData.handlers.get('goal.listExecutions');
			await expect(handler!({ roomId: 'room-123', goalId: 'no-such' }, {})).rejects.toThrow(
				'Goal not found'
			);
		});

		it('returns empty executions list for goal with no executions', async () => {
			// Some tests leave getGoal returning null — restore the default goal here
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Test Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
			const handler = messageHubData.handlers.get('goal.listExecutions');
			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				executions: MissionExecution[];
			};
			expect(mockGoalManager.getGoal).toHaveBeenCalledWith('goal-123');
			expect(mockGoalManager.listExecutions).toHaveBeenCalledWith('goal-123', 20);
			expect(result.executions).toEqual([]);
		});

		it('passes custom limit to listExecutions', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Test Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
			const handler = messageHubData.handlers.get('goal.listExecutions');
			await handler!({ roomId: 'room-123', goalId: 'goal-123', limit: 5 }, {});
			expect(mockGoalManager.listExecutions).toHaveBeenCalledWith('goal-123', 5);
		});

		it('returns executions when present', async () => {
			mockGoalManager.getGoal.mockImplementation(async () => ({
				id: 'goal-123',
				roomId: 'room-123',
				title: 'Test Goal',
				description: '',
				status: 'active' as GoalStatus,
				priority: 'normal' as GoalPriority,
				progress: 0,
				linkedTaskIds: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
			const fakeExecution: MissionExecution = {
				id: 'exec-1',
				goalId: 'goal-123',
				executionNumber: 1,
				status: 'completed',
				startedAt: Date.now() - 1000,
				completedAt: Date.now(),
				resultSummary: 'done',
				taskIds: [],
				planningAttempts: 0,
			};
			mockGoalManager.listExecutions.mockImplementation(() => [fakeExecution]);
			const handler = messageHubData.handlers.get('goal.listExecutions');
			const result = (await handler!({ roomId: 'room-123', goalId: 'goal-123' }, {})) as {
				executions: MissionExecution[];
			};
			expect(result.executions).toHaveLength(1);
			expect(result.executions[0].id).toBe('exec-1');
		});
	});
});
