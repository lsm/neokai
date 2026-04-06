/**
 * Tests for useMissionDetailData hook
 *
 * Verifies reactive goal/task derivation, execution loading, available status
 * action matrix, and action handler behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { MissionExecution, NeoTask, RoomGoal } from '@neokai/shared';
import { useMissionDetailData } from '../useMissionDetailData';
import { navigateToRoom } from '../../lib/router';
import { toast } from '../../lib/toast';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();

vi.mock('../useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
	}),
}));

// roomStore mock — goals and tasks are signals so useComputed subscribes reactively.
const mockGoalsSignal = signal<RoomGoal[]>([]);
const mockTasksSignal = signal<NeoTask[]>([]);

const mockUpdateGoal = vi.fn();
const mockDeleteGoal = vi.fn();
const mockTriggerNow = vi.fn();
const mockScheduleNext = vi.fn();
const mockLinkTaskToGoal = vi.fn();
const mockListExecutions = vi.fn();

vi.mock('../../lib/room-store.ts', () => ({
	roomStore: {
		get goals() {
			return mockGoalsSignal;
		},
		get tasks() {
			return mockTasksSignal;
		},
		updateGoal: (...args: unknown[]) => mockUpdateGoal(...args),
		deleteGoal: (...args: unknown[]) => mockDeleteGoal(...args),
		triggerNow: (...args: unknown[]) => mockTriggerNow(...args),
		scheduleNext: (...args: unknown[]) => mockScheduleNext(...args),
		linkTaskToGoal: (...args: unknown[]) => mockLinkTaskToGoal(...args),
		listExecutions: (...args: unknown[]) => mockListExecutions(...args),
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToRoom: vi.fn(),
}));

vi.mock('../../lib/toast.ts', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeGoal(overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id: 'goal-1',
		shortId: 'g-1',
		roomId: 'room-1',
		title: 'Test Mission',
		description: 'Test description',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		missionType: 'one_shot',
		...overrides,
	};
}

function makeTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		status: 'pending',
		priority: 'normal',
		description: '',
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeExecution(overrides: Partial<MissionExecution> = {}): MissionExecution {
	return {
		id: 'exec-1',
		goalId: 'goal-1',
		executionNumber: 1,
		startedAt: Date.now(),
		status: 'completed',
		taskIds: [],
		planningAttempts: 1,
		...overrides,
	};
}

// -------------------------------------------------------
// Test suites
// -------------------------------------------------------

describe('useMissionDetailData — goal derivation', () => {
	beforeEach(() => {
		mockGoalsSignal.value = [makeGoal()];
		mockTasksSignal.value = [];
		mockListExecutions.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('derives goal by UUID', () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.goal).not.toBeNull();
		expect(result.current.goal?.id).toBe('goal-1');
	});

	it('derives goal by short ID', () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'g-1'));

		expect(result.current.goal).not.toBeNull();
		expect(result.current.goal?.id).toBe('goal-1');
		expect(result.current.goal?.shortId).toBe('g-1');
	});

	it('returns null when goalId does not match any goal', () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'nonexistent'));

		expect(result.current.goal).toBeNull();
	});

	it('updates reactively when goal appears in store after mount', () => {
		mockGoalsSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.goal).toBeNull();

		act(() => {
			mockGoalsSignal.value = [makeGoal()];
		});

		expect(result.current.goal).not.toBeNull();
		expect(result.current.goal?.id).toBe('goal-1');
	});

	it('updates reactively when goal status changes via LiveQuery delta', () => {
		mockGoalsSignal.value = [makeGoal({ status: 'active' })];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.goal?.status).toBe('active');

		act(() => {
			mockGoalsSignal.value = [makeGoal({ status: 'completed' })];
		});

		expect(result.current.goal?.status).toBe('completed');
	});
});

describe('useMissionDetailData — linked tasks derivation', () => {
	beforeEach(() => {
		mockListExecutions.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('returns empty array when goal has no linked tasks', () => {
		mockGoalsSignal.value = [makeGoal({ linkedTaskIds: [] })];
		mockTasksSignal.value = [makeTask()];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.linkedTasks).toEqual([]);
	});

	it('derives linked tasks from roomStore.tasks', () => {
		mockGoalsSignal.value = [makeGoal({ linkedTaskIds: ['task-1'] })];
		mockTasksSignal.value = [makeTask({ id: 'task-1' })];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.linkedTasks).toHaveLength(1);
		expect(result.current.linkedTasks[0].id).toBe('task-1');
	});

	it('omits tasks not present in roomStore (missing task IDs)', () => {
		mockGoalsSignal.value = [makeGoal({ linkedTaskIds: ['task-1', 'missing-task'] })];
		mockTasksSignal.value = [makeTask({ id: 'task-1' })];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.linkedTasks).toHaveLength(1);
		expect(result.current.linkedTasks[0].id).toBe('task-1');
	});

	it('updates reactively when a new linked task appears in store', () => {
		mockGoalsSignal.value = [makeGoal({ linkedTaskIds: ['task-1'] })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.linkedTasks).toHaveLength(0);

		act(() => {
			mockTasksSignal.value = [makeTask({ id: 'task-1' })];
		});

		expect(result.current.linkedTasks).toHaveLength(1);
	});
});

describe('useMissionDetailData — execution loading', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('does not load executions for one_shot missions', async () => {
		mockGoalsSignal.value = [makeGoal({ missionType: 'one_shot' })];
		mockTasksSignal.value = [];

		renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});

		expect(mockListExecutions).not.toHaveBeenCalled();
	});

	it('loads executions for recurring missions', async () => {
		const execs = [makeExecution()];
		mockListExecutions.mockResolvedValue(execs);
		mockGoalsSignal.value = [makeGoal({ missionType: 'recurring' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await waitFor(() => {
			expect(result.current.isLoadingExecutions).toBe(false);
		});

		expect(mockListExecutions).toHaveBeenCalledWith('goal-1');
		expect(result.current.executions).toEqual(execs);
	});

	it('loads executions when goal arrives asynchronously after mount', async () => {
		const execs = [makeExecution()];
		mockListExecutions.mockResolvedValue(execs);
		// Goal not yet in store on mount
		mockGoalsSignal.value = [];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		// No executions yet — goal is null
		expect(result.current.executions).toBeNull();
		expect(mockListExecutions).not.toHaveBeenCalled();

		// Goal arrives asynchronously (LiveQuery snapshot)
		act(() => {
			mockGoalsSignal.value = [makeGoal({ missionType: 'recurring' })];
		});

		await waitFor(() => {
			expect(result.current.isLoadingExecutions).toBe(false);
		});

		expect(mockListExecutions).toHaveBeenCalledWith('goal-1');
		expect(result.current.executions).toEqual(execs);
	});

	it('shows error toast and clears loading on execution fetch failure', async () => {
		mockListExecutions.mockRejectedValue(new Error('Server error'));
		mockGoalsSignal.value = [makeGoal({ missionType: 'recurring' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await waitFor(() => {
			expect(result.current.isLoadingExecutions).toBe(false);
		});

		expect(toast.error).toHaveBeenCalledWith('Server error');
		expect(result.current.executions).toBeNull();
	});

	it('executions start as null for non-recurring missions', () => {
		mockGoalsSignal.value = [makeGoal({ missionType: 'measurable' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.executions).toBeNull();
	});
});

describe('useMissionDetailData — availableStatusActions', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('returns empty array when goal is null', () => {
		mockGoalsSignal.value = [];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.availableStatusActions).toEqual([]);
	});

	it('returns complete, needs_human, archive for active goal', () => {
		mockGoalsSignal.value = [makeGoal({ status: 'active' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.availableStatusActions).toEqual(['complete', 'needs_human', 'archive']);
	});

	it('returns reactivate, complete, archive for needs_human goal', () => {
		mockGoalsSignal.value = [makeGoal({ status: 'needs_human' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.availableStatusActions).toEqual(['reactivate', 'complete', 'archive']);
	});

	it('returns reactivate, archive for completed goal', () => {
		mockGoalsSignal.value = [makeGoal({ status: 'completed' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.availableStatusActions).toEqual(['reactivate', 'archive']);
	});

	it('returns only reactivate for archived goal (no archive action)', () => {
		mockGoalsSignal.value = [makeGoal({ status: 'archived' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.availableStatusActions).toEqual(['reactivate']);
	});

	it('updates reactively when goal status changes', () => {
		mockGoalsSignal.value = [makeGoal({ status: 'active' })];
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		expect(result.current.availableStatusActions).toContain('complete');

		act(() => {
			mockGoalsSignal.value = [makeGoal({ status: 'completed' })];
		});

		expect(result.current.availableStatusActions).not.toContain('complete');
		expect(result.current.availableStatusActions).toContain('reactivate');
	});
});

describe('useMissionDetailData — action handlers', () => {
	beforeEach(() => {
		mockGoalsSignal.value = [makeGoal()];
		mockTasksSignal.value = [];
		mockListExecutions.mockResolvedValue([]);
		mockUpdateGoal.mockResolvedValue(undefined);
		mockDeleteGoal.mockResolvedValue(undefined);
		mockTriggerNow.mockResolvedValue(makeGoal());
		mockScheduleNext.mockResolvedValue(makeGoal());
		mockLinkTaskToGoal.mockResolvedValue(undefined);
		mockRequest.mockResolvedValue({});
		vi.mocked(navigateToRoom).mockClear();
		vi.mocked(toast.success).mockClear();
		vi.mocked(toast.info).mockClear();
		vi.mocked(toast.error).mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('updateGoal calls roomStore.updateGoal with correct args', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.updateGoal({ title: 'New title' });
		});

		expect(mockUpdateGoal).toHaveBeenCalledWith('goal-1', { title: 'New title' });
		expect(toast.success).toHaveBeenCalledWith('Mission updated');
	});

	it('updateGoal shows error toast on failure', async () => {
		mockUpdateGoal.mockRejectedValueOnce(new Error('Update failed'));

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.updateGoal({ title: 'New title' }).catch(() => {});
		});

		expect(toast.error).toHaveBeenCalledWith('Update failed');
	});

	it('updateGoal is idempotent while updating', async () => {
		let resolveUpdate!: () => void;
		mockUpdateGoal.mockReturnValueOnce(
			new Promise<void>((res) => {
				resolveUpdate = res;
			})
		);

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		// First call (not awaited)
		act(() => {
			void result.current.updateGoal({ title: 'A' });
		});

		await waitFor(() => expect(result.current.isUpdating).toBe(true));

		// Second call should be ignored because isUpdating is true
		await act(async () => {
			await result.current.updateGoal({ title: 'B' });
		});

		resolveUpdate();

		const calls = mockUpdateGoal.mock.calls;
		expect(calls).toHaveLength(1);
	});

	it('deleteGoal calls roomStore.deleteGoal and navigates to room', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.deleteGoal();
		});

		expect(mockDeleteGoal).toHaveBeenCalledWith('goal-1');
		expect(toast.info).toHaveBeenCalledWith('Mission deleted');
		expect(navigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('deleteGoal shows error toast on failure', async () => {
		mockDeleteGoal.mockRejectedValueOnce(new Error('Delete failed'));

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.deleteGoal().catch(() => {});
		});

		expect(toast.error).toHaveBeenCalledWith('Delete failed');
		expect(navigateToRoom).not.toHaveBeenCalled();
	});

	it('deleteGoal sets and clears isDeleting', async () => {
		let resolveDelete!: () => void;
		mockDeleteGoal.mockReturnValueOnce(new Promise<void>((res) => (resolveDelete = res)));

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		act(() => {
			void result.current.deleteGoal();
		});

		await waitFor(() => expect(result.current.isDeleting).toBe(true));

		resolveDelete();

		await waitFor(() => expect(result.current.isDeleting).toBe(false));
	});

	it('triggerNow calls roomStore.triggerNow', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.triggerNow();
		});

		expect(mockTriggerNow).toHaveBeenCalledWith('goal-1');
		expect(toast.success).toHaveBeenCalledWith('Mission triggered');
	});

	it('triggerNow sets and clears isTriggering', async () => {
		let resolveTrigger!: () => void;
		mockTriggerNow.mockReturnValueOnce(new Promise<void>((res) => (resolveTrigger = res)));

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		act(() => {
			void result.current.triggerNow();
		});

		await waitFor(() => expect(result.current.isTriggering).toBe(true));

		resolveTrigger();

		await waitFor(() => expect(result.current.isTriggering).toBe(false));
	});

	it('triggerNow shows error toast on failure', async () => {
		mockTriggerNow.mockRejectedValueOnce(new Error('Trigger failed'));

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.triggerNow().catch(() => {});
		});

		expect(toast.error).toHaveBeenCalledWith('Trigger failed');
	});

	it('scheduleNext calls roomStore.scheduleNext', async () => {
		const nextRun = Date.now() + 3600_000;
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.scheduleNext(nextRun);
		});

		expect(mockScheduleNext).toHaveBeenCalledWith('goal-1', nextRun);
		expect(toast.success).toHaveBeenCalledWith('Mission scheduled');
	});

	it('linkTask calls roomStore.linkTaskToGoal', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.linkTask('task-abc');
		});

		expect(mockLinkTaskToGoal).toHaveBeenCalledWith('goal-1', 'task-abc');
	});
});

describe('useMissionDetailData — changeStatus', () => {
	beforeEach(() => {
		mockGoalsSignal.value = [makeGoal({ status: 'active' })];
		mockTasksSignal.value = [];
		mockListExecutions.mockResolvedValue([]);
		mockUpdateGoal.mockResolvedValue(undefined);
		mockRequest.mockResolvedValue({});
		vi.mocked(toast.success).mockClear();
		vi.mocked(toast.info).mockClear();
		vi.mocked(toast.error).mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('complete calls roomStore.updateGoal with status=completed', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.changeStatus('complete');
		});

		expect(mockUpdateGoal).toHaveBeenCalledWith('goal-1', { status: 'completed' });
		expect(toast.success).toHaveBeenCalledWith('Mission completed');
	});

	it('archive calls roomStore.updateGoal with status=archived', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.changeStatus('archive');
		});

		expect(mockUpdateGoal).toHaveBeenCalledWith('goal-1', { status: 'archived' });
		expect(toast.info).toHaveBeenCalledWith('Mission archived');
	});

	it('reactivate uses dedicated goal.reactivate RPC (has server-side side effects)', async () => {
		mockGoalsSignal.value = [makeGoal({ status: 'completed' })];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.changeStatus('reactivate');
		});

		// Should use dedicated RPC — not generic updateGoal — so server can reset
		// consecutiveFailures and perform other side effects.
		expect(mockRequest).toHaveBeenCalledWith('goal.reactivate', {
			roomId: 'room-1',
			goalId: 'goal-1',
		});
		expect(mockUpdateGoal).not.toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledWith('Mission reactivated');
	});

	it('needs_human uses dedicated goal.needsHuman RPC (has server-side side effects)', async () => {
		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.changeStatus('needs_human');
		});

		// Dedicated RPC ensures recurring schedules are paused and other side effects run.
		expect(mockRequest).toHaveBeenCalledWith('goal.needsHuman', {
			roomId: 'room-1',
			goalId: 'goal-1',
		});
		expect(mockUpdateGoal).not.toHaveBeenCalled();
		expect(toast.info).toHaveBeenCalledWith('Mission marked as needs human input');
	});

	it('shows error toast on changeStatus failure', async () => {
		mockUpdateGoal.mockRejectedValueOnce(new Error('Status change failed'));

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.changeStatus('complete').catch(() => {});
		});

		expect(toast.error).toHaveBeenCalledWith('Status change failed');
	});

	it('does nothing when goal is null', async () => {
		mockGoalsSignal.value = [];

		const { result } = renderHook(() => useMissionDetailData('room-1', 'goal-1'));

		await act(async () => {
			await result.current.changeStatus('complete');
		});

		expect(mockUpdateGoal).not.toHaveBeenCalled();
		expect(mockRequest).not.toHaveBeenCalled();
	});
});
