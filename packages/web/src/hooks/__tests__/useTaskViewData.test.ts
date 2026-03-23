/**
 * Tests for useTaskViewData hook
 *
 * Verifies data-fetching, permission flag derivation, and action handler stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/preact';
import { useTaskViewData } from '../useTaskViewData';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();
const mockOnEvent = vi.fn((_eventName: string, _handler: unknown) => () => {});
const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
		isConnected: true,
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
