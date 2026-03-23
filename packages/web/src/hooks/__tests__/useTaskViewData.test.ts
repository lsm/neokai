/**
 * Tests for useTaskViewData hook
 *
 * Verifies data-fetching, permission flag derivation, and action handler stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/preact';
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

vi.mock('../../lib/room-store.ts', () => ({
	roomStore: {
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

function makeTask(status = 'in_progress') {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		status,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		taskType: null,
		description: null,
		dependsOn: [],
		progress: null,
		result: null,
		prUrl: null,
		prNumber: null,
		activeSession: null,
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

		mockRequest.mockImplementation(async (method: string) => {
			if (mockMessageHubState.requestThrows) throw new Error('Connection lost');
			if (method === 'task.get') return { task: makeTask('in_progress') };
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
		// Start with isConnected = false
		mockMessageHubState.isConnected = false;

		const { result, rerender } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Error should be null because load() returned early
		expect(result.current.error).toBeNull();
		expect(result.current.task).toBeNull();

		// Now simulate reconnection - isConnected becomes true
		mockMessageHubState.isConnected = true;

		// Rerender to trigger effect (isConnected changed from false to true)
		rerender();

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Task should be loaded successfully, error should be cleared
		expect(result.current.error).toBeNull();
		expect(result.current.task).not.toBeNull();
	});

	it('does not permanently show error when isConnected transitions during reconnection', async () => {
		// Simulate the bug scenario: same hook, isConnected transitions
		// isConnected=true -> isConnected=false -> isConnected=true
		// (what happens when connectionState goes disconnected -> reconnecting -> connected)

		// Start with isConnected = true but request will fail
		mockMessageHubState.requestThrows = true;

		const { result, rerender } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Error is set because request failed (simulating mid-resume failure)
		expect(result.current.error).toBe('Connection lost');

		// Simulate reconnection: isConnected goes false (reconnecting)
		mockMessageHubState.isConnected = false;
		mockMessageHubState.requestThrows = false; // Will succeed when reconnected

		// Rerender to trigger effect (isConnected changed from true to false)
		rerender();

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Error should be cleared because load() returned early due to !isConnected
		expect(result.current.error).toBeNull();

		// Simulate reconnection complete: isConnected goes true
		mockMessageHubState.isConnected = true;

		// Rerender to trigger effect (isConnected changed from false to true)
		rerender();

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Task should be loaded, error should remain cleared
		expect(result.current.error).toBeNull();
		expect(result.current.task).not.toBeNull();
	});
});

describe('useTaskViewData', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();

		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup() };
			if (method === 'session.get') return { session: null };
			return {};
		});
	});

	it('loads task and group on mount', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.task).not.toBeNull();
		expect(result.current.task?.id).toBe('task-1');
		expect(result.current.group).not.toBeNull();
		expect(result.current.group?.id).toBe('group-1');
	});

	it('sets error when task.get fails', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') throw new Error('Not found');
			return {};
		});

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.error).toBe('Not found');
		expect(result.current.task).toBeNull();
	});

	it('derives canComplete true when task is in_progress', async () => {
		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canComplete).toBe(true);
	});

	it('derives canComplete false when task is pending', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('pending') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

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
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('completed') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { result } = renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.canReactivate).toBe(true);
	});

	it('derives canArchive true for completed task', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('completed') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

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

	it('joins the room channel and subscribes to task updates', async () => {
		renderHook(() => useTaskViewData('room-1', 'task-1'));

		await waitFor(() => {
			expect(mockJoinRoom).toHaveBeenCalledWith('room:room-1');
		});

		expect(mockOnEvent).toHaveBeenCalledWith('room.task.update', expect.any(Function));
	});
});

describe('useTaskViewData — action handlers', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		vi.mocked(navigateToRoom).mockClear();
		vi.mocked(toast.success).mockClear();
		vi.mocked(toast.info).mockClear();
		vi.mocked(toast.error).mockClear();

		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('in_progress') };
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
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('completed') };
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
			if (method === 'task.get') return { task: makeTask() };
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
			if (method === 'task.get') return { task: makeTask() };
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
