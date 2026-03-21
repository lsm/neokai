/**
 * Tests for TaskView Component
 *
 * Tests the "Awaiting your review" pulsing badge in the header
 * when group.submittedForReview is true, and its absence otherwise.
 *
 * Also covers the shared autoscroll/ScrollToBottomButton integration and
 * InputTextarea usage in HumanInputArea.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
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

// Mock useTaskInputDraft so component tests don't depend on hub connectivity.
// Uses Preact Signals so that updating the content triggers proper component re-renders,
// matching the real hook's behavior (which also uses signals internally).
const _draftContentSignal = signal('');
const _draftRestoredSignal = signal(false);
const mockSetMessageText = vi.fn((v: string) => {
	_draftContentSignal.value = v;
});
const mockClearDraft = vi.fn(() => {
	_draftContentSignal.value = '';
	_draftRestoredSignal.value = false;
});
vi.mock('../../hooks/useTaskInputDraft.ts', () => ({
	useTaskInputDraft: () => ({
		get content() {
			return _draftContentSignal.value;
		},
		setContent: mockSetMessageText,
		clear: mockClearDraft,
		get draftRestored() {
			return _draftRestoredSignal.value;
		},
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
// Forwards onKeyDown so keyboard-shortcut tests can exercise Enter/Shift+Enter/Cmd+Enter.
vi.mock('../InputTextarea.tsx', () => ({
	InputTextarea: ({
		content,
		onContentChange,
		onKeyDown,
		onSubmit,
		disabled,
		placeholder,
		maxChars,
		leadingElement,
	}: {
		content: string;
		onContentChange: (v: string) => void;
		onKeyDown?: (e: KeyboardEvent) => void;
		onSubmit: () => void;
		disabled?: boolean;
		placeholder?: string;
		maxChars?: number;
		leadingElement?: ComponentChildren;
	}) => (
		<div data-testid="input-textarea">
			{leadingElement}
			<textarea
				data-testid="input-textarea-field"
				value={content}
				onInput={(e) => onContentChange((e.target as HTMLTextAreaElement).value)}
				onKeyDown={onKeyDown}
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
		submittedForReview: state === 'awaiting_human',
		approved: false,
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

	it('does not show review bar when group is not submitted for review', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_leader') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});
		expect(container.querySelector('[data-testid="action-bar"]')).toBeNull();
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
		// Reset draft mock state
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
		mockSetMessageText.mockClear();
		mockClearDraft.mockClear();
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

	it('renders InputTextarea in awaiting_worker state', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { queryByTestId, container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(queryByTestId('input-textarea')).not.toBeNull();
		expect(queryByTestId('task-target-button')).not.toBeNull();
	});

	it('sends feedback via task.sendHumanMessage in awaiting_human state (default target: leader)', async () => {
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
				target: 'leader',
			});
		});
	});

	it('approves task via task.approve in awaiting_human state', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			if (method === 'task.approve') return {};
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		// Verify approve button is in the ActionBar
		await waitFor(() => {
			const actionBar = container.querySelector('[data-testid="action-bar"]');
			expect(actionBar).not.toBeNull();
			const approveBtn = actionBar?.querySelector('[data-testid="action-bar-primary"]');
			expect(approveBtn).not.toBeNull();
		});

		const approveBtn = container.querySelector(
			'[data-testid="action-bar-primary"]'
		) as HTMLButtonElement;
		fireEvent.click(approveBtn);

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.approve', {
				roomId: 'room-1',
				taskId: 'task-1',
			});
		});
	});

	it('shows feedback textarea in bottom area (not in header) when awaiting_human', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { container, getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		// Verify the feedback textarea is in the bottom area (border-t, not in amber header)
		const inputWrapper = getByTestId('input-textarea').closest('.border-t');
		expect(inputWrapper).not.toBeNull();
		// Verify it's NOT in the action bar
		const actionBar = container.querySelector('[data-testid="action-bar"]');
		expect(actionBar?.contains(getByTestId('input-textarea'))).toBe(false);
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

		// Explicitly select leader in the dropdown.
		// Note: 'leader' is the default since the default target changed, so this selection
		// is redundant but kept to make the intent of this test explicit.
		fireEvent.click(getByTestId('task-target-button'));
		fireEvent.click(getByTestId('task-target-option-leader'));
		fireEvent.click(getByTestId('input-textarea-send'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Please focus on auth first',
				target: 'leader',
			});
		});
	});

	it('sends message to worker in awaiting_worker state when worker is explicitly selected', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Add benchmarks too' } });

		// Explicitly select worker (default is now leader)
		fireEvent.click(getByTestId('task-target-button'));
		fireEvent.click(getByTestId('task-target-option-worker'));

		fireEvent.click(getByTestId('input-textarea-send'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Add benchmarks too',
				target: 'worker',
			});
		});
	});

	it('shows target dropdown with both options always available', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('task-target-button')).toBeTruthy();
		});

		fireEvent.click(getByTestId('task-target-button'));
		const workerOption = getByTestId('task-target-option-worker') as HTMLButtonElement;
		const leaderOption = getByTestId('task-target-option-leader') as HTMLButtonElement;
		expect(workerOption.disabled).toBe(false);
		expect(leaderOption.disabled).toBe(false);
	});

	it('default target is leader', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		// Default target button label should be "Leader"
		expect(getByTestId('task-target-button').textContent).toContain('Leader');
	});

	it('sends message when Enter is pressed (desktop)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Hello leader' } });

		// Plain Enter on desktop — should send
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false });

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Hello leader',
				target: 'leader',
			});
		});
	});

	it('does NOT send when Shift+Enter is pressed', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Hello\nworld' } });

		// Shift+Enter — should NOT send (used for newlines)
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false });

		// sendMessage is async, but the RPC call should not have been invoked synchronously
		// Verify immediately that no send was triggered (the handler does not send for Shift+Enter)
		expect(mockRequest).not.toHaveBeenCalledWith(
			'task.sendHumanMessage',
			expect.objectContaining({ message: expect.any(String) })
		);
	});

	it('sends message when Cmd+Enter is pressed', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Cmd enter works' } });

		// Cmd+Enter — should also send (backward compat, macOS)
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false });

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Cmd enter works',
				target: 'leader',
			});
		});
	});

	it('sends message when Ctrl+Enter is pressed', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Ctrl enter works' } });

		// Ctrl+Enter — should send (backward compat, Windows/Linux)
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true });

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
				roomId: 'room-1',
				taskId: 'task-1',
				message: 'Ctrl enter works',
				target: 'leader',
			});
		});
	});

	it('placeholder text reflects Enter-to-send UX', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('input-textarea-field')).toBeTruthy();
		});

		const textarea = getByTestId('input-textarea-field') as HTMLTextAreaElement;
		expect(textarea.placeholder).toContain('Enter to send');
		expect(textarea.placeholder).toContain('Shift+Enter');
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

// ─── Task Options Dropdown Tests ───

describe('TaskView — Task options dropdown menu', () => {
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

	it('shows cancel button for pending tasks (cancel only)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'pending') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).toBeNull();
	});

	it('shows cancel and complete buttons for in_progress tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).not.toBeNull();
	});

	it('shows cancel button for review tasks (no complete button — review status)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).toBeNull();
	});

	it('does NOT show action buttons for completed tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'completed') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).toBeNull();
	});

	it('does NOT show cancel button for needs_attention tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'needs_attention') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).toBeNull();
	});

	it('does NOT show action buttons for cancelled tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'cancelled') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).toBeNull();
	});

	it('shows both cancel and complete buttons for in_progress task', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).not.toBeNull();
	});

	it('shows only cancel button (no complete) for pending task', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'pending') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.querySelector('[data-testid="task-cancel-button"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="task-complete-button"]')).toBeNull();
	});

	it('opens cancel dialog when cancel button is clicked', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const cancelButton = container.querySelector(
			'[data-testid="task-cancel-button"]'
		) as HTMLElement;
		expect(cancelButton).not.toBeNull();
		fireEvent.click(cancelButton);

		// Cancel dialog should open
		await waitFor(() => {
			expect(document.querySelector('[data-testid="cancel-task-confirm"]')).not.toBeNull();
		});
	});

	it('opens complete dialog when complete button is clicked', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const completeButton = container.querySelector(
			'[data-testid="task-complete-button"]'
		) as HTMLElement;
		expect(completeButton).not.toBeNull();
		fireEvent.click(completeButton);

		// Complete dialog should open
		await waitFor(() => {
			expect(document.querySelector('[data-testid="complete-task-confirm"]')).not.toBeNull();
		});
	});

	it('calls task.cancel RPC and navigates away on cancel confirmation', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.cancel') return {};
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		// Click cancel button directly
		const cancelButton = container.querySelector(
			'[data-testid="task-cancel-button"]'
		) as HTMLElement;
		fireEvent.click(cancelButton);

		await waitFor(() => {
			expect(document.querySelector('[data-testid="cancel-task-confirm"]')).not.toBeNull();
		});

		// Confirm cancellation
		const confirmButton = document.querySelector(
			'[data-testid="cancel-task-confirm"]'
		) as HTMLElement;
		await act(async () => {
			fireEvent.click(confirmButton);
		});

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.cancel', {
				roomId: 'room-1',
				taskId: 'task-1',
			});
			expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		});
	});

	it('calls task.setStatus RPC and navigates away on complete confirmation', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			if (method === 'task.setStatus') return { task: makeTask('task-1', 'completed') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		// Click complete button directly
		const completeButton = container.querySelector(
			'[data-testid="task-complete-button"]'
		) as HTMLElement;
		fireEvent.click(completeButton);

		await waitFor(() => {
			expect(document.querySelector('[data-testid="complete-task-confirm"]')).not.toBeNull();
		});

		// Confirm completion
		const confirmButton = document.querySelector(
			'[data-testid="complete-task-confirm"]'
		) as HTMLElement;
		await act(async () => {
			fireEvent.click(confirmButton);
		});

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.setStatus', {
				roomId: 'room-1',
				taskId: 'task-1',
				status: 'completed',
				result: 'Marked complete by user',
			});
			expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		});
	});
});

// ─── Interrupt Button Tests ───

describe('TaskView — Interrupt button', () => {
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

	it('shows interrupt button for in_progress tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const stopButton = container.querySelector(
			'button[title="Interrupt generation (task stays active, type your suggestions)"]'
		);
		expect(stopButton).not.toBeNull();
	});

	it('shows interrupt button for review tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const stopButton = container.querySelector(
			'button[title="Interrupt generation (task stays active, type your suggestions)"]'
		);
		expect(stopButton).not.toBeNull();
	});

	it('does NOT show interrupt button for pending tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'pending') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const stopButton = container.querySelector(
			'button[title="Interrupt generation (task stays active, type your suggestions)"]'
		);
		expect(stopButton).toBeNull();
	});

	it('does NOT show interrupt button for failed tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'failed') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const stopButton = container.querySelector(
			'button[title="Interrupt generation (task stays active, type your suggestions)"]'
		);
		expect(stopButton).toBeNull();
	});

	it('does NOT show interrupt button for cancelled tasks', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'cancelled') };
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		const stopButton = container.querySelector(
			'button[title="Interrupt generation (task stays active, type your suggestions)"]'
		);
		expect(stopButton).toBeNull();
	});
});

// ─── Reject Button Tests ───

describe('TaskView — Reject button in HeaderReviewBar', () => {
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

	it('shows reject button when group.state === awaiting_human', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			const actionBar = container.querySelector('[data-testid="action-bar"]');
			expect(actionBar).not.toBeNull();
			const rejectBtn = actionBar?.querySelector('[data-testid="action-bar-secondary"]');
			expect(rejectBtn).not.toBeNull();
		});
	});

	it('does NOT show reject button when group.state is not awaiting_human', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		// No action bar should be shown
		const actionBar = container.querySelector('[data-testid="action-bar"]');
		expect(actionBar).toBeNull();
	});

	it('calls task.reject RPC when reject button is clicked', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			if (method === 'task.reject') return { success: true };
			return {};
		});

		const { container, getByRole, getByPlaceholderText } = render(
			<TaskView roomId="room-1" taskId="task-1" />
		);

		// Wait for the action bar to appear
		await waitFor(() => {
			const actionBar = container.querySelector('[data-testid="action-bar"]');
			expect(actionBar).not.toBeNull();
		});

		// Click reject button (opens modal)
		const rejectBtn = container.querySelector(
			'[data-testid="action-bar-secondary"]'
		) as HTMLButtonElement;
		fireEvent.click(rejectBtn);

		// Wait for modal to appear (using role="dialog")
		await waitFor(() => {
			expect(getByRole('dialog')).toBeTruthy();
		});

		// Find textarea in modal and type feedback
		const textarea = getByPlaceholderText(
			'Please provide feedback explaining why this work was rejected...'
		) as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Needs more work on error handling' } });

		// Click confirm button in modal (the one with "Reject" text)
		const confirmBtn = getByRole('dialog').querySelector('button.bg-red-600') as HTMLButtonElement;
		fireEvent.click(confirmBtn);

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('task.reject', {
				roomId: 'room-1',
				taskId: 'task-1',
				feedback: 'Needs more work on error handling',
			});
		});
	});
});

describe('TaskView — draft-restored banner', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockReturnValue(() => {});
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		mockShowScrollButton.value = false;
		mockMessageCount.value = 0;
		vi.mocked(useAutoScroll).mockClear();
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
		mockSetMessageText.mockClear();
		mockClearDraft.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows draft-restored banner when draftRestored is true', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { queryByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		// Wait for input area to appear
		await waitFor(() => {
			expect(queryByTestId('input-textarea')).not.toBeNull();
		});

		// Banner not visible initially
		expect(queryByTestId('draft-restored-banner')).toBeNull();

		// Simulate draft being restored from server
		act(() => {
			_draftRestoredSignal.value = true;
		});

		expect(queryByTestId('draft-restored-banner')).not.toBeNull();
	});

	it('hides draft-restored banner when draftRestored is false', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		// Start with banner visible
		_draftRestoredSignal.value = true;

		const { queryByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(queryByTestId('input-textarea')).not.toBeNull();
		});

		expect(queryByTestId('draft-restored-banner')).not.toBeNull();

		// Dismiss the banner
		act(() => {
			_draftRestoredSignal.value = false;
		});

		expect(queryByTestId('draft-restored-banner')).toBeNull();
	});

	it('calls clearDraft when "Discard draft" button is clicked', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'review') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		// Start with banner visible
		_draftRestoredSignal.value = true;

		const { getByTestId } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(getByTestId('draft-restored-banner')).not.toBeNull();
		});

		const dismissBtn = getByTestId('draft-dismiss-button');
		fireEvent.click(dismissBtn);

		expect(mockClearDraft).toHaveBeenCalledTimes(1);
	});
});

describe('TaskView — PR link in header', () => {
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

	it('shows PR link in header for in_progress task with prUrl', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get')
				return {
					task: {
						...makeTask('task-1', 'in_progress'),
						prUrl: 'https://github.com/org/repo/pull/42',
						prNumber: 42,
					},
				};
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('PR #42');
		});

		const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/42"]');
		expect(prLink).not.toBeNull();
	});

	it('does not show PR link in header for in_progress task without prUrl', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get') return { task: makeTask('task-1', 'in_progress') };
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).not.toContain('Loading task');
		});

		expect(container.textContent).not.toContain('PR #');
	});

	it('shows PR link in header AND in review bar for review task (both render)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get')
				return {
					task: {
						...makeTask('task-1', 'review'),
						prUrl: 'https://github.com/org/repo/pull/99',
						prNumber: 99,
					},
				};
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_human') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('PR #99');
		});

		// PR link appears in both the header badge and the review bar button.
		const prLinks = container.querySelectorAll('a[href="https://github.com/org/repo/pull/99"]');
		expect(prLinks.length).toBe(2);
	});

	it('shows PR link in header for needs_attention task with prUrl', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get')
				return {
					task: {
						...makeTask('task-1', 'needs_attention'),
						prUrl: 'https://github.com/org/repo/pull/7',
						prNumber: 7,
					},
				};
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('PR #7');
		});

		const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/7"]');
		expect(prLink).not.toBeNull();
	});

	it('shows PR link in header for review task even without submittedForReview (no review bar)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get')
				return {
					task: {
						...makeTask('task-1', 'review'),
						prUrl: 'https://github.com/org/repo/pull/55',
						prNumber: 55,
					},
				};
			// group not awaiting_human, so submittedForReview is false → review bar hidden
			if (method === 'task.getGroup') return { group: makeGroup('awaiting_worker') };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('PR #55');
		});

		// PR link is in the header only (no review bar since submittedForReview is false)
		const prLinks = container.querySelectorAll('a[href="https://github.com/org/repo/pull/55"]');
		expect(prLinks.length).toBe(1);
	});

	it('shows PR link in header for completed task with prUrl', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'task.get')
				return {
					task: {
						...makeTask('task-1', 'completed'),
						prUrl: 'https://github.com/org/repo/pull/101',
						prNumber: 101,
					},
				};
			if (method === 'task.getGroup') return { group: null };
			return {};
		});

		const { container } = render(<TaskView roomId="room-1" taskId="task-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('PR #101');
		});

		const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/101"]');
		expect(prLink).not.toBeNull();
	});
});
