/**
 * Tests for useTaskViewData hook
 *
 * Verifies data-fetching, permission flag derivation, and action handler stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { NeoTask } from '@neokai/shared';
import { useTaskViewData } from '../useTaskViewData';
import { navigateToRoom } from '../../lib/router';
import { toast } from '../../lib/toast';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();
const mockOnEvent = vi.fn((_eventName: string, _handler: unknown) => () => {});
const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

// Module-level state for dynamic mocking (used by tab-resume tests)
const mockMessageHubState = {
	isConnected: true,
	requestThrows: false,
};

vi.mock('../useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
		get isConnected() {
			return mockMessageHubState.isConnected;
		},
	}),
}));

// roomStore mock — tasks is a signal<NeoTask[]> so useComputed can subscribe reactively.
const mockTasksSignal = signal<NeoTask[]>([]);

vi.mock('../../lib/room-store.ts', () => ({
	roomStore: {
		get tasks() {
			return mockTasksSignal;
		},
		goalByTaskId: { value: new Map() },
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToRoom: vi.fn(),
	navigateToRoomTask: vi.fn(),
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

function makeTask(status = 'in_progress'): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		status: status as NeoTask['status'],
		priority: 'normal',
		description: '',
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeGroup() {
	return {
		id: 'group-1',
		taskId: 'task-1',
		workerSessionId: 'worker-1',
		leaderSessionId: 'leader-1',
		workerRole: 'coder',
		feedbackIteration: 0,
		submittedForReview: false,
		createdAt: Date.now(),
		completedAt: null,
	};
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('useTaskViewData — tab resume behavior', () => {
	beforeEach(() => {
		// Reset state for each test
		mockMessageHubState.isConnected = true;
		mockMessageHubState.requestThrows = false;
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockTasksSignal.value = [makeTask('in_progress')];

		mockRequest.mockImplementation(async (method: string) => {
			if (mockMessageHubState.requestThrows) throw new Error('Connection lost');
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'session.get') return { session: null };
			return {};
		});
	});

	it('returns early and clears error when isConnected is false', async () => {
		// First render with connection - loads successfully
		const { result, rerender } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.task).not.toBeNull();
		expect(result.current.error).toBeNull();

		// Simulate connection loss by setting isConnected to false
		// This simulates what happens when connectionState becomes 'disconnected' or 'reconnecting'
		mockMessageHubState.isConnected = false;

		// Rerender to trigger effect (isConnected changed from true to false)
		rerender();

		// Wait for the effect to run
		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Error should be cleared because load() returned early due to !isConnected
		expect(result.current.error).toBeNull();
	});

	it('clears stale error and loads task when isConnected becomes true', async () => {
		// Start with isConnected = false, no tasks in store
		mockMessageHubState.isConnected = false;
		mockTasksSignal.value = [];

		const { result, rerender } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Error should be null because load() returned early
		expect(result.current.error).toBeNull();
		// Task is null because roomStore.tasks is empty
		expect(result.current.task).toBeNull();

		// Now simulate reconnection - isConnected becomes true and tasks are populated
		mockMessageHubState.isConnected = true;
		mockTasksSignal.value = [makeTask('in_progress')];

		// Rerender to trigger effect (isConnected changed from false to true)
		rerender();

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Task should be loaded successfully, error should be cleared
		expect(result.current.error).toBeNull();
		expect(result.current.task).not.toBeNull();
	});

	it('skips group fetch when isConnected is false and returns early with no error', async () => {
		// When disconnected, load() exits early — no RPC calls, no error
		mockMessageHubState.isConnected = false;

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// No group fetch attempted while disconnected
		expect(result.current.group).toBeNull();
		expect(result.current.error).toBeNull();
		// Task is still reactive from store
		expect(result.current.task).not.toBeNull();

		// No task.getGroup call should have been made
		expect(mockRequest).not.toHaveBeenCalledWith('task.getGroup', expect.anything());
	});
});

describe('useTaskViewData', () => {
	beforeEach(() => {
		mockMessageHubState.isConnected = true;
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockTasksSignal.value = [makeTask('in_progress')];

		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'session.get') return { session: null };
			return {};
		});
	});

	it('loads task from roomStore.tasks and group on mount', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Task is derived from roomStore.tasks signal
		expect(result.current.task).not.toBeNull();
		expect(result.current.task?.id).toBe('task-1');
		// Group is fetched via RPC
		expect(result.current.group).not.toBeNull();
		expect(result.current.group?.id).toBe('group-1');
	});

	it('task is null when taskId is not in roomStore.tasks', async () => {
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.task).toBeNull();
	});

	it('task updates reactively when roomStore.tasks changes', async () => {
		mockTasksSignal.value = [makeTask('pending')];

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.task?.status).toBe('pending');

		// Simulate LiveQuery delta: task transitions to in_progress
		act(() => {
			mockTasksSignal.value = [makeTask('in_progress')];
		});

		expect(result.current.task?.status).toBe('in_progress');
	});

	it('does not subscribe to room.task.update events', async () => {
		renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(mockJoinRoom).toHaveBeenCalledWith('room:room-1');
		});

		expect(mockOnEvent).not.toHaveBeenCalledWith('room.task.update', expect.any(Function));
	});

	it('fetchGroup failure is swallowed: isLoading becomes false, group stays null', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') throw new Error('Group fetch failed');
			return {};
		});

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		// fetchGroup retries once after 1s; wait up to 5s for isLoading to clear
		await waitFor(
			() => {
				expect(result.current.isLoading).toBe(false);
			},
			{ timeout: 5000 }
		);

		// Group stays null; task is available from store; no error surfaced
		expect(result.current.group).toBeNull();
		expect(result.current.task).not.toBeNull();
		expect(result.current.error).toBeNull();
	});

	it('derives canComplete true when task is in_progress', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canComplete).toBe(true);
	});

	it('derives canComplete false when task is pending', async () => {
		mockTasksSignal.value = [makeTask('pending')];

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canComplete).toBe(false);
	});

	it('derives canCancel true when task is in_progress', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canCancel).toBe(true);
	});

	it('derives canReactivate false for in_progress task', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canReactivate).toBe(false);
	});

	it('derives canReactivate true for completed task', async () => {
		mockTasksSignal.value = [makeTask('completed')];

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canReactivate).toBe(true);
	});

	it('derives canArchive true for completed task', async () => {
		mockTasksSignal.value = [makeTask('completed')];

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canArchive).toBe(true);
	});

	it('derives canInterrupt true for in_progress task', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canInterrupt).toBe(true);
	});

	it('modal states start closed', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.completeModal.isOpen).toBe(false);
		expect(result.current.cancelModal.isOpen).toBe(false);
		expect(result.current.archiveModal.isOpen).toBe(false);
		expect(result.current.rejectModal.isOpen).toBe(false);
		expect(result.current.setStatusModal.isOpen).toBe(false);
	});

	it('opens completeModal', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		act(() => {
			result.current.completeModal.open();
		});

		expect(result.current.completeModal.isOpen).toBe(true);
	});

	it('joins the room channel and subscribes to session.updated', async () => {
		renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(mockJoinRoom).toHaveBeenCalledWith('room:room-1');
		});

		expect(mockOnEvent).toHaveBeenCalledWith('session.updated', expect.any(Function));
	});
});

describe('useTaskViewData — short ID deep link resolution', () => {
	beforeEach(() => {
		mockMessageHubState.isConnected = true;
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();

		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'session.get') return { session: null };
			return {};
		});
	});

	afterEach(() => {
		cleanup();
	});

	it('resolves task by shortId when taskId is a short ID (e.g. t-42)', async () => {
		const taskWithShortId = makeTask('in_progress');
		taskWithShortId.shortId = 't-42';
		mockTasksSignal.value = [taskWithShortId];

		const { result } = renderHook(() => useTaskViewData('room-1', 't-42'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.task).not.toBeNull();
		expect(result.current.task?.id).toBe('task-1');
		expect(result.current.task?.shortId).toBe('t-42');
	});

	it('resolves task by UUID when taskId is a UUID', async () => {
		const taskWithShortId = makeTask('in_progress');
		taskWithShortId.shortId = 't-42';
		mockTasksSignal.value = [taskWithShortId];

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.task).not.toBeNull();
		expect(result.current.task?.id).toBe('task-1');
	});

	it('returns null when short ID does not match any task', async () => {
		const taskWithShortId = makeTask('in_progress');
		taskWithShortId.shortId = 't-42';
		mockTasksSignal.value = [taskWithShortId];

		const { result } = renderHook(() => useTaskViewData('room-1', 't-999'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.task).toBeNull();
	});

	it('sends short ID to RPC calls (daemon resolves it)', async () => {
		const taskWithShortId = makeTask('in_progress');
		taskWithShortId.shortId = 't-42';
		mockTasksSignal.value = [taskWithShortId];

		renderHook(() => useTaskViewData('room-1', 't-42'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.getGroup', {
				roomId: 'room-1',
				taskId: 't-42',
			});
		});
	});

	it('reactively updates when task appears in store after initial deep link load', async () => {
		// Simulate deep link load before LiveQuery delivers tasks
		mockTasksSignal.value = [];

		const { result } = renderHook(() => useTaskViewData('room-1', 't-42'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.task).toBeNull();

		// LiveQuery delivers the task
		const taskWithShortId = makeTask('in_progress');
		taskWithShortId.shortId = 't-42';

		act(() => {
			mockTasksSignal.value = [taskWithShortId];
		});

		expect(result.current.task).not.toBeNull();
		expect(result.current.task?.shortId).toBe('t-42');
	});
});

describe('useTaskViewData — action handlers', () => {
	beforeEach(() => {
		mockMessageHubState.isConnected = true;
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		vi.mocked(navigateToRoom).mockClear();
		vi.mocked(toast.success).mockClear();
		vi.mocked(toast.info).mockClear();
		vi.mocked(toast.error).mockClear();
		mockTasksSignal.value = [makeTask('in_progress')];

		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'session.get') return { session: null };
			return {};
		});
	});

	afterEach(() => {
		cleanup();
	});

	it('completeTask calls task.setStatus with correct payload', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.completeTask('Done');
		});

		expect(mockRequest).toHaveBeenCalledWith('task.setStatus', {
			roomId: 'room-1',
			taskId: 'task-1',
			status: 'completed',
			result: 'Done',
			mode: 'manual',
		});
		expect(toast.success).toHaveBeenCalledWith('Task completed');
		expect(navigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('completeTask uses fallback result text when summary is empty', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.completeTask('');
		});

		expect(mockRequest).toHaveBeenCalledWith(
			'task.setStatus',
			expect.objectContaining({ result: 'Marked complete by user' })
		);
	});

	it('cancelTask calls task.cancel and navigates', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.cancelTask();
		});

		expect(mockRequest).toHaveBeenCalledWith('task.cancel', {
			roomId: 'room-1',
			taskId: 'task-1',
		});
		expect(toast.info).toHaveBeenCalledWith('Task cancelled');
		expect(navigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('archiveTask calls task.setStatus with archived and navigates', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.archiveTask();
		});

		expect(mockRequest).toHaveBeenCalledWith('task.setStatus', {
			roomId: 'room-1',
			taskId: 'task-1',
			status: 'archived',
			mode: 'manual',
		});
		expect(toast.info).toHaveBeenCalledWith('Task archived');
		expect(navigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('setTaskStatusManually calls task.setStatus and navigates when archived', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.setTaskStatusManually('archived');
		});

		expect(mockRequest).toHaveBeenCalledWith('task.setStatus', {
			roomId: 'room-1',
			taskId: 'task-1',
			status: 'archived',
			mode: 'manual',
		});
		expect(navigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('setTaskStatusManually does NOT navigate when status is not archived', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.setTaskStatusManually('completed');
		});

		expect(navigateToRoom).not.toHaveBeenCalled();
	});

	it('reactivateTask calls task.setStatus with in_progress', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.reactivateTask();
		});

		expect(mockRequest).toHaveBeenCalledWith('task.setStatus', {
			roomId: 'room-1',
			taskId: 'task-1',
			status: 'in_progress',
			mode: 'manual',
		});
		expect(toast.success).toHaveBeenCalledWith('Task reactivated');
	});

	it('reactivateTask shows error toast on failure', async () => {
		mockTasksSignal.value = [makeTask('completed')];
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') return { group: null };
			if (method === 'task.setStatus') throw new Error('Server error');
			return {};
		});

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.reactivateTask();
		});

		expect(toast.error).toHaveBeenCalledWith('Server error');
	});

	it('interruptSession calls task.interruptSession', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.interruptSession();
		});

		expect(mockRequest).toHaveBeenCalledWith('task.interruptSession', {
			roomId: 'room-1',
			taskId: 'task-1',
		});
	});

	it('approveReviewedTask calls task.approve and bumps conversationKey', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		const initialKey = result.current.conversationKey;

		await act(async () => {
			await result.current.approveReviewedTask();
		});

		expect(mockRequest).toHaveBeenCalledWith('task.approve', {
			roomId: 'room-1',
			taskId: 'task-1',
		});
		expect(result.current.conversationKey).toBe(initialKey + 1);
	});

	it('approveReviewedTask sets reviewError on failure', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'task.approve') throw new Error('Approve failed');
			return {};
		});

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.approveReviewedTask();
		});

		expect(result.current.reviewError).toBe('Approve failed');
	});

	it('rejectReviewedTask calls task.reject and bumps conversationKey', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		const initialKey = result.current.conversationKey;

		await act(async () => {
			await result.current.rejectReviewedTask('Not good enough');
		});

		expect(mockRequest).toHaveBeenCalledWith('task.reject', {
			roomId: 'room-1',
			taskId: 'task-1',
			feedback: 'Not good enough',
		});
		expect(result.current.conversationKey).toBe(initialKey + 1);
	});

	it('rejectReviewedTask is idempotent when already rejecting', async () => {
		// Make reject take a long time so we can call it twice concurrently.
		// Use an object property to avoid TypeScript control-flow narrowing to `never`.
		const resolveRef: { current: (() => void) | null } = { current: null };
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'task.reject') {
				return new Promise<void>((resolve) => {
					resolveRef.current = resolve;
				});
			}
			return {};
		});

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		// Start first reject (does not await)
		act(() => {
			void result.current.rejectReviewedTask('feedback');
		});

		await waitFor(() => expect(result.current.rejecting).toBe(true));

		// Second call should be ignored (guard: if (rejecting) return)
		await act(async () => {
			await result.current.rejectReviewedTask('second call');
		});

		// Only one task.reject call should have been made
		const rejectCalls = mockRequest.mock.calls.filter(([m]) => m === 'task.reject');
		expect(rejectCalls).toHaveLength(1);

		// Resolve the first reject
		resolveRef.current?.();
	});
});
