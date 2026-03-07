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
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/preact';
import { useEffect } from 'preact/hooks';
// Static import gives access to vi.mocked(useAutoScroll) for call assertions
import { useAutoScroll } from '../../hooks/useAutoScroll.ts';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();
const mockOnEvent = vi.fn((_eventName: string, _handler: (event: unknown) => void) => () => {});
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

// mockMessageCount controls how many messages the TaskConversationRenderer mock reports.
// Set before rendering to simulate message arrival (onMessageCountChange fires in useEffect).
const mockMessageCount = { value: 0 };

// Mock TaskConversationRenderer — calls onMessageCountChange in a useEffect so tests can
// exercise the isFirstLoad flip without triggering "setState during render" warnings.
vi.mock('./TaskConversationRenderer.tsx', () => ({
	TaskConversationRenderer: ({
		onMessageCountChange,
	}: {
		onMessageCountChange?: (n: number) => void;
	}) => {
		useEffect(() => {
			onMessageCountChange?.(mockMessageCount.value);
		}, [onMessageCountChange]);
		return <div data-testid="conversation" />;
	},
}));

// Mock useAutoScroll so we can control showScrollButton and inspect call args
const mockScrollToBottom = vi.fn();
const mockShowScrollButton = { value: false };

vi.mock('../../hooks/useAutoScroll.ts', () => ({
	useAutoScroll: vi.fn(() => ({
		showScrollButton: mockShowScrollButton.value,
		scrollToBottom: mockScrollToBottom,
		isNearBottom: !mockShowScrollButton.value,
	})),
}));

// Mock ScrollToBottomButton — forwards bottomClass as a data attribute so tests can assert it.
vi.mock('../ScrollToBottomButton.tsx', () => ({
	ScrollToBottomButton: ({
		onClick,
		bottomClass,
	}: {
		onClick: () => void;
		bottomClass?: string;
	}) => (
		<button data-testid="scroll-to-bottom" data-bottom-class={bottomClass} onClick={onClick}>
			↓
		</button>
	),
}));

// Mock InputTextarea so we don't need its full dependencies.
// Forwards maxChars as maxLength so tests can verify the 50000 limit is passed.
vi.mock('../InputTextarea.tsx', () => ({
	InputTextarea: ({
		content,
		onContentChange,
		onSubmit,
		disabled,
		placeholder,
		maxChars,
	}: {
		content: string;
		onContentChange: (v: string) => void;
		onSubmit: () => void;
		disabled?: boolean;
		placeholder?: string;
		maxChars?: number;
	}) => (
		<div data-testid="input-textarea">
			<textarea
				data-testid="input-textarea-field"
				value={content}
				onInput={(e) => onContentChange((e.target as HTMLTextAreaElement).value)}
				disabled={disabled}
				placeholder={placeholder}
				maxLength={maxChars}
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
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows pulsing "Awaiting your review" badge when group.state === awaiting_human', async () => {
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('does NOT render scroll-to-bottom button when showScrollButton is false', async () => {
		mockShowScrollButton.value = false;
		mockMessageCount.value = 0;
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders InputTextarea in awaiting_human state', async () => {
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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
		mockRequest.mockImplementation(async (method) => {
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

describe('TaskView — useAutoScroll call args', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('calls useAutoScroll with enabled:true and isInitialLoad:true on initial render', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(vi.mocked(useAutoScroll)).toHaveBeenCalled();
		});

		// On the initial render, autoScroll=true and isFirstLoad=true
		const firstCall = vi.mocked(useAutoScroll).mock.calls[0][0];
		expect(firstCall).toMatchObject({ enabled: true, isInitialLoad: true });
	});
});

describe('TaskView — InputTextarea maxChars forwarding', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('passes maxChars=50000 to InputTextarea in awaiting_human state', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea-field')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		expect(textarea.maxLength).toBe(50000);
	});

	it('passes maxChars=50000 to InputTextarea in awaiting_leader state', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_leader') };
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea-field')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		expect(textarea.maxLength).toBe(50000);
	});
});

describe('TaskView — isFirstLoad state transitions', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('flips isFirstLoad to false after first messages arrive via onMessageCountChange', async () => {
		// Simulate TaskConversationRenderer reporting 3 messages on mount
		mockMessageCount.value = 3;
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		render(<TaskView roomId="room-1" taskId="task-1" />);

		// Wait until useAutoScroll is called with isInitialLoad:false (after messageCount > 0)
		await waitFor(() => {
			const calls = vi.mocked(useAutoScroll).mock.calls;
			const lastCall = calls[calls.length - 1]?.[0];
			expect(lastCall?.isInitialLoad).toBe(false);
		});
	});

	it('starts with isInitialLoad:true when no messages have arrived yet', async () => {
		// mockMessageCount.value = 0 (default) — mock never calls onMessageCountChange with > 0
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(vi.mocked(useAutoScroll)).toHaveBeenCalled();
		});

		const firstCall = vi.mocked(useAutoScroll).mock.calls[0][0];
		expect(firstCall.isInitialLoad).toBe(true);
	});
});

describe('TaskView — ScrollToBottomButton bottomClass', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = true;
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('passes bottomClass="bottom-0" to ScrollToBottomButton', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('scroll-to-bottom')).toBeTruthy();
		});

		expect(getByTestId('scroll-to-bottom').getAttribute('data-bottom-class')).toBe('bottom-0');
	});
});

describe('TaskView — cancelled flag prevents post-unmount state updates', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('does not call task.getGroup after unmount mid-fetch', async () => {
		// Defer task.get so we can unmount before it resolves
		let resolveTaskGet!: (value: { task: ReturnType<typeof makeTask> }) => void;
		mockRequest.mockImplementation((method: unknown) =>
			method === 'task.get'
				? new Promise<{ task: ReturnType<typeof makeTask> }>((resolve) => {
						resolveTaskGet = resolve;
					})
				: Promise.resolve({ group: null })
		);

		const { unmount } = render(<TaskView roomId="room-1" taskId="task-1" />);

		// Unmount before task.get resolves
		act(() => {
			unmount();
		});

		// Resolve task.get after unmount — cancelled flag should block fetchGroup call
		await act(async () => {
			resolveTaskGet({ task: makeTask('task-1') });
		});

		// task.getGroup must NOT have been called since the component was cancelled
		expect(mockRequest).not.toHaveBeenCalledWith('task.getGroup', expect.anything());
		// leaveRoom should have been called (cleanup ran)
		expect(mockLeaveRoom).toHaveBeenCalledWith(`room:room-1`);
	});

	it('does not call task.getGroup when room.task.update fires after unmount', async () => {
		// Capture the room.task.update event handler so we can fire it manually
		let taskUpdateHandler: ((event: unknown) => void) | null = null;
		mockOnEvent.mockImplementation((eventName: string, handler: (event: unknown) => void) => {
			if (eventName === 'room.task.update') taskUpdateHandler = handler;
			return () => {};
		});
		mockRequest.mockImplementation(async (method: unknown) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { unmount } = render(<TaskView roomId="room-1" taskId="task-1" />);

		// Wait for initial load to complete
		await waitFor(() => {
			expect(taskUpdateHandler).not.toBeNull();
		});

		// Reset call count to track only post-unmount calls
		mockRequest.mockClear();

		// Unmount the component
		act(() => {
			unmount();
		});

		// Fire room.task.update event after unmount
		await act(async () => {
			taskUpdateHandler?.({ task: makeTask('task-1', 'completed'), roomId: 'room-1' });
		});

		// The event fired after unmount must not trigger a task.getGroup request
		expect(mockRequest).not.toHaveBeenCalledWith('task.getGroup', expect.anything());
	});
});
