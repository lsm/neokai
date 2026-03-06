// @ts-nocheck
/**
 * Tests for TaskView Component
 *
 * Tests the "Awaiting your review" pulsing badge in the header
 * when group.state === 'awaiting_human', and its absence otherwise.
 *
 * Also covers the shared autoscroll/ScrollToBottomButton integration and
 * InputTextarea usage in HumanInputArea.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/preact';

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

// Mock TaskConversationRenderer so it doesn't need its own deps.
// We don't call onMessageCountChange here because useAutoScroll is fully mocked
// and calling setState during render causes a "cannot update during render" warning.
vi.mock('./TaskConversationRenderer.tsx', () => ({
	TaskConversationRenderer: () => <div data-testid="conversation" />,
}));

// Mock useAutoScroll so we can control showScrollButton
const mockScrollToBottom = vi.fn();
const mockShowScrollButton = { value: false };

vi.mock('../../hooks/useAutoScroll.ts', () => ({
	useAutoScroll: vi.fn(() => ({
		showScrollButton: mockShowScrollButton.value,
		scrollToBottom: mockScrollToBottom,
		isNearBottom: !mockShowScrollButton.value,
	})),
}));

// Mock ScrollToBottomButton
vi.mock('../ScrollToBottomButton.tsx', () => ({
	ScrollToBottomButton: ({ onClick }: { onClick: () => void }) => (
		<button data-testid="scroll-to-bottom" onClick={onClick}>
			↓
		</button>
	),
}));

// Mock InputTextarea so we don't need its full dependencies
vi.mock('../InputTextarea.tsx', () => ({
	InputTextarea: ({
		content,
		onContentChange,
		onSubmit,
		disabled,
		placeholder,
	}: {
		content: string;
		onContentChange: (v: string) => void;
		onSubmit: () => void;
		disabled?: boolean;
		placeholder?: string;
	}) => (
		<div data-testid="input-textarea">
			<textarea
				data-testid="input-textarea-field"
				value={content}
				onInput={(e) => onContentChange((e.target as HTMLTextAreaElement).value)}
				disabled={disabled}
				placeholder={placeholder}
			/>
			<button data-testid="input-textarea-send" onClick={onSubmit} disabled={disabled}>
				Send
			</button>
		</div>
	),
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

function makeGroup(state: string, feedbackIteration = 0) {
	return {
		id: 'group-1',
		taskId: 'task-1',
		workerSessionId: 'sess-w',
		leaderSessionId: 'sess-l',
		workerRole: 'worker',
		state,
		feedbackIteration,
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
		mockShowScrollButton.value = false;
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

describe('TaskView — autoscroll / ScrollToBottomButton', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('does NOT render scroll-to-bottom button when showScrollButton is false', async () => {
		mockShowScrollButton.value = false;
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { queryByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(queryByTestId('scroll-to-bottom')).toBeNull();
		});
	});

	it('renders scroll-to-bottom button when showScrollButton is true', async () => {
		mockShowScrollButton.value = true;
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { queryByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(queryByTestId('scroll-to-bottom')).not.toBeNull();
		});
	});

	it('calls scrollToBottom when scroll-to-bottom button is clicked', async () => {
		mockShowScrollButton.value = true;
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('scroll-to-bottom')).toBeTruthy();
		});

		fireEvent.click(getByTestId('scroll-to-bottom'));
		expect(mockScrollToBottom).toHaveBeenCalledWith(true);
	});
});

describe('TaskView — HumanInputArea uses InputTextarea', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('renders InputTextarea in awaiting_human state', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { queryByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(queryByTestId('input-textarea')).not.toBeNull();
		});
	});

	it('renders InputTextarea in awaiting_leader state', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_leader') };
			return {};
		});

		const { queryByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(queryByTestId('input-textarea')).not.toBeNull();
		});
	});

	it('does NOT render InputTextarea in awaiting_worker state (disabled raw textarea)', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { queryByTestId, container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		// awaiting_worker uses a raw disabled textarea, not InputTextarea
		expect(queryByTestId('input-textarea')).toBeNull();
		const rawTextarea = container.querySelector('textarea[disabled]');
		expect(rawTextarea).not.toBeNull();
	});

	it('sends feedback via task.sendHumanMessage in awaiting_human state', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Nice work!' } });

		fireEvent.click(getByTestId('input-textarea-send'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Nice work!',
			});
		});
	});

	it('approves task via goal.approveTask in awaiting_human state', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			if (method === 'goal.approveTask') return {};
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			const approveBtn = container.querySelector('button.bg-green-700');
			expect(approveBtn).not.toBeNull();
		});

		const approveBtn = container.querySelector('button.bg-green-700') as HTMLButtonElement;
		fireEvent.click(approveBtn);

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('goal.approveTask', {
				roomId: 'room-1',
				taskId: 'task-1',
			});
		});
	});

	it('sends message to leader via task.sendHumanMessage in awaiting_leader state', async () => {
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_leader') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Please focus on auth first' } });

		fireEvent.click(getByTestId('input-textarea-send'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Please focus on auth first',
			});
		});
	});
});
