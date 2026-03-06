// @ts-nocheck
/**
 * Tests for TaskView Component
 *
 * Tests the "Awaiting your review" pulsing badge in the header
 * when group.state === 'awaiting_human', and its absence otherwise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/preact';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();
const mockOnEvent = vi.fn(() => () => {}); // returns unsub noop
const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
	}),
}));

const mockNavigateToRoom = vi.fn();
const mockNavigateToRoomTask = vi.fn();

vi.mock('../../lib/router.ts', () => ({
	get navigateToRoom() {
		return mockNavigateToRoom;
	},
	get navigateToRoomTask() {
		return mockNavigateToRoomTask;
	},
}));

// Mock TaskConversationRenderer so it doesn't need its own deps
vi.mock('./TaskConversationRenderer.tsx', () => ({
	TaskConversationRenderer: () => <div data-testid="conversation" />,
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeTask(id: string, status = 'in_progress', title = `Task ${id}`) {
	return {
		id,
		title,
		status,
		priority: 'normal',
		progress: 0,
		dependsOn: [],
		taskType: null,
	};
}

function makeGroup(state: string) {
	return {
		id: 'group-1',
		taskId: 'task-1',
		workerSessionId: 'sess-w',
		leaderSessionId: 'sess-l',
		workerRole: 'worker',
		state,
		feedbackIteration: 0,
		createdAt: Date.now(),
		completedAt: null,
	};
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

import { TaskView } from './TaskView';

describe('TaskView — awaiting_human badge', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows pulsing "Awaiting your review" badge when group.state === awaiting_human', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const badge = container.querySelector('.animate-pulse');
		expect(badge).toBeTruthy();
		expect(badge?.textContent).toContain('Awaiting your review');
	});

	it('does NOT show pulsing badge when group.state is not awaiting_human', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.textContent).not.toContain('Awaiting your review');
	});

	it('does NOT show pulsing badge when group is null', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'pending') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.textContent).not.toContain('Awaiting your review');
	});

	it('shows group state label in header', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_leader') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('Leader reviewing');
		});
	});
});
