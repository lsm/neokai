/**
 * Tests for TaskViewV2 Component
 *
 * Covers:
 * - data-testid="task-view-v2" presence
 * - Loading and error states
 * - Turn blocks rendered for all agents
 * - Runtime messages rendered inline between turn blocks
 * - Clicking a turn block opens slide-out panel
 * - Only one slide-out panel at a time (opening a new one closes previous)
 * - Review bar appears when group.submittedForReview
 * - Auto-scroll integration (isFirstLoad flip, autoScrollEnabled toggle)
 * - Shared sub-components (HumanInputArea, TaskActionDialogs, TaskReviewBar, RejectModal)
 * - conversationKey bump forces re-render key
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/preact';
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { NeoTask } from '@neokai/shared';
import type { TurnBlock, TurnBlockItem } from '../../hooks/useTurnBlocks';
import type { SessionGroupMessage } from '../../hooks/useGroupMessages';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
		isConnected: true,
	}),
}));

// useGroupMessages — controlled by mockGroupMessages
let mockGroupMessages: SessionGroupMessage[] = [];
let mockMessagesLoading = false;
let mockIsReconnecting = false;

vi.mock('../../hooks/useGroupMessages.ts', () => ({
	useGroupMessages: () => ({
		messages: mockGroupMessages,
		isLoading: mockMessagesLoading,
		isReconnecting: mockIsReconnecting,
	}),
}));

// useTurnBlocks — controlled by mockTurnBlockItems
let mockTurnBlockItems: TurnBlockItem[] = [];

vi.mock('../../hooks/useTurnBlocks.ts', () => ({
	useTurnBlocks: () => mockTurnBlockItems,
}));

// useAutoScroll — controlled
const mockScrollToBottom = vi.fn();
let mockShowScrollButton = false;

vi.mock('../../hooks/useAutoScroll.ts', () => ({
	useAutoScroll: vi.fn(() => ({
		showScrollButton: mockShowScrollButton,
		scrollToBottom: mockScrollToBottom,
		isNearBottom: true,
	})),
}));

// useTaskInputDraft — minimal stub for HumanInputArea
const _draftContent = signal('');
vi.mock('../../hooks/useTaskInputDraft.ts', () => ({
	useTaskInputDraft: () => ({
		get content() {
			return _draftContent.value;
		},
		setContent: vi.fn((v: string) => {
			_draftContent.value = v;
		}),
		clear: vi.fn(),
		get draftRestored() {
			return false;
		},
	}),
}));

// roomStore.goalByTaskId — no goal
vi.mock('../../lib/room-store.ts', () => ({
	roomStore: {
		goalByTaskId: { value: new Map() },
	},
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

vi.mock('../../lib/signals.ts', () => ({
	currentRoomTabSignal: { value: 'chat' },
}));

vi.mock('../../lib/toast.ts', () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// TurnSummaryBlock — renders agent label + click handler
vi.mock('./TurnSummaryBlock.tsx', () => ({
	TurnSummaryBlock: ({
		turn,
		onClick,
		isSelected,
	}: {
		turn: TurnBlock;
		onClick: (t: TurnBlock) => void;
		isSelected: boolean;
	}) => (
		<div
			data-testid="turn-block"
			data-turn-id={turn.id}
			data-selected={String(isSelected)}
			onClick={() => onClick(turn)}
		>
			{turn.agentLabel}
		</div>
	),
}));

// RuntimeMessageRenderer — simple stub
vi.mock('./RuntimeMessageRenderer.tsx', () => ({
	RuntimeMessageRenderer: ({ message }: { message: { index: number } }) => (
		<div data-testid="runtime-message" data-index={message.index} />
	),
}));

// SlideOutPanel — renders sessionId when open
vi.mock('./SlideOutPanel.tsx', () => ({
	SlideOutPanel: ({
		isOpen,
		sessionId,
		agentLabel,
		onClose,
	}: {
		isOpen: boolean;
		sessionId: string | null;
		agentLabel?: string;
		onClose: () => void;
	}) =>
		isOpen ? (
			<div data-testid="slide-out-panel" data-session-id={sessionId ?? ''}>
				<span>{agentLabel}</span>
				<button data-testid="slide-out-close" onClick={onClose}>
					Close
				</button>
			</div>
		) : null,
}));

// TaskInfoPanel — minimal stub
vi.mock('./TaskInfoPanel.tsx', () => ({
	TaskInfoPanel: ({ isOpen }: { isOpen: boolean }) =>
		isOpen ? <div data-testid="task-info-panel" /> : null,
}));

// task-shared stubs
vi.mock('./task-shared/HumanInputArea.tsx', () => ({
	HumanInputArea: () => <div data-testid="human-input-area" />,
}));

vi.mock('./task-shared/TaskHeaderActions.tsx', () => ({
	TaskHeaderActions: ({ onToggleInfoPanel }: { onToggleInfoPanel: () => void }) => (
		<button data-testid="toggle-info-panel" onClick={onToggleInfoPanel}>
			Info
		</button>
	),
}));

vi.mock('./task-shared/TaskReviewBar.tsx', () => ({
	TaskReviewBar: ({
		onApprove,
		onOpenRejectModal,
	}: {
		onApprove: () => void;
		onOpenRejectModal: () => void;
	}) => (
		<div data-testid="task-review-bar">
			<button data-testid="approve-button" onClick={onApprove}>
				Approve
			</button>
			<button data-testid="open-reject-modal" onClick={onOpenRejectModal}>
				Reject
			</button>
		</div>
	),
}));

vi.mock('./task-shared/TaskActionDialogs.tsx', () => ({
	CompleteTaskDialog: () => null,
	CancelTaskDialog: () => null,
	ArchiveTaskDialog: () => null,
	SetStatusModal: () => null,
}));

vi.mock('../ui/RejectModal.tsx', () => ({
	RejectModal: ({
		isOpen,
		onConfirm,
		onClose,
	}: {
		isOpen: boolean;
		onConfirm: (feedback: string) => void;
		onClose: () => void;
	}) =>
		isOpen ? (
			<div data-testid="reject-modal">
				<button data-testid="reject-confirm" onClick={() => onConfirm('bad')}>
					Confirm
				</button>
				<button data-testid="reject-close" onClick={onClose}>
					Close
				</button>
			</div>
		) : null,
}));

vi.mock('../ui/CircularProgressIndicator.tsx', () => ({
	CircularProgressIndicator: () => <div data-testid="circular-progress" />,
}));

vi.mock('../ScrollToBottomButton.tsx', () => ({
	ScrollToBottomButton: ({ onClick }: { onClick: () => void }) => (
		<button data-testid="scroll-to-bottom" onClick={onClick}>
			↓
		</button>
	),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		status: 'in_progress',
		priority: 'medium',
		createdAt: Date.now(),
		description: '',
		dependsOn: [],
		...overrides,
	} as NeoTask;
}

function makeGroup(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: 'group-1',
		taskId: 'task-1',
		workerSessionId: 'session-worker',
		leaderSessionId: 'session-leader',
		workerRole: 'worker',
		feedbackIteration: 0,
		submittedForReview: false,
		createdAt: Date.now(),
		completedAt: null,
		...overrides,
	};
}

function makeTurn(overrides: Partial<TurnBlock> = {}): TurnBlock {
	return {
		id: 'turn-1',
		sessionId: 'session-worker',
		agentRole: 'worker',
		agentLabel: 'Worker',
		startTime: Date.now() - 5000,
		endTime: Date.now(),
		messageCount: 3,
		toolCallCount: 2,
		thinkingCount: 1,
		assistantCount: 2,
		lastAction: 'Read',
		previewMessage: null,
		isActive: false,
		isError: false,
		errorMessage: null,
		messages: [],
		hiddenCount: 0,
		...overrides,
	};
}

// Setup default useTaskViewData mock state — overrideable in each test.
// Use vi.fn() so mockReturnValue() takes effect on the next render call.
let mockTaskViewData: ReturnType<typeof import('../../hooks/useTaskViewData').useTaskViewData>;
const useTaskViewDataFn = vi.fn((_roomId: string, _taskId: string) => mockTaskViewData);

// Signal-driven conversationKey — changing this signal causes Preact to
// reactively re-render any component that reads it (via the getter in the mock
// below). This is more reliable than rerender() + mockReturnValue for testing
// effects that depend on conversationKey changing.
const mockConversationKeySignal = signal(0);

vi.mock('../../hooks/useTaskViewData.ts', () => ({
	useTaskViewData: (roomId: string, taskId: string) => {
		const base = useTaskViewDataFn(roomId, taskId);
		return {
			...base,
			// Getter so that Preact's signal tracking picks up the dependency
			// when the component destructures conversationKey during render.
			get conversationKey() {
				return mockConversationKeySignal.value;
			},
		};
	},
}));

function makeDefaultTaskViewData(
	task: NeoTask | null = makeTask(),
	group: ReturnType<typeof makeGroup> | null = makeGroup()
) {
	const approveReviewedTask = vi.fn(async () => {
		// Simulate conversationKey bump
	});
	const rejectReviewedTask = vi.fn(async (_feedback: string) => {});

	let _rejectOpen = false;
	let _completeOpen = false;
	let _cancelOpen = false;
	let _archiveOpen = false;
	let _setStatusOpen = false;

	return {
		task,
		group,
		workerSession: null,
		leaderSession: null,
		isLoading: false,
		error: null,
		associatedGoal: null,
		conversationKey: 0,
		approveReviewedTask,
		rejectReviewedTask,
		interruptSession: vi.fn(async () => {}),
		reactivateTask: vi.fn(async () => {}),
		completeTask: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		archiveTask: vi.fn(async () => {}),
		setTaskStatusManually: vi.fn(async () => {}),
		approving: false,
		rejecting: false,
		interrupting: false,
		reactivating: false,
		reviewError: null,
		rejectModal: {
			isOpen: _rejectOpen,
			open: vi.fn(() => {
				_rejectOpen = true;
			}),
			close: vi.fn(() => {
				_rejectOpen = false;
			}),
		},
		completeModal: {
			isOpen: _completeOpen,
			open: vi.fn(),
			close: vi.fn(),
		},
		cancelModal: {
			isOpen: _cancelOpen,
			open: vi.fn(),
			close: vi.fn(),
		},
		archiveModal: {
			isOpen: _archiveOpen,
			open: vi.fn(),
			close: vi.fn(),
		},
		setStatusModal: {
			isOpen: _setStatusOpen,
			open: vi.fn(),
			close: vi.fn(),
		},
		canCancel: true,
		canInterrupt: true,
		canReactivate: false,
		canComplete: true,
		canArchive: false,
	} as unknown as ReturnType<typeof import('../../hooks/useTaskViewData').useTaskViewData>;
}

// ---------------------------------------------------------------------------
// Import subject under test (after all mocks are set up)
// ---------------------------------------------------------------------------

// Dynamic import deferred to after vi.mock hoisting
const { TaskViewV2 } = await import('./TaskViewV2.tsx');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskViewV2', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGroupMessages = [];
		mockTurnBlockItems = [];
		mockMessagesLoading = false;
		mockIsReconnecting = false;
		mockShowScrollButton = false;
		_draftContent.value = '';
		mockConversationKeySignal.value = 0;
		mockTaskViewData = makeDefaultTaskViewData();
		useTaskViewDataFn.mockImplementation(() => mockTaskViewData);
	});

	afterEach(() => {
		cleanup();
	});

	// --- Rendering basics ---

	it('renders data-testid="task-view-v2" on the root container', () => {
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('task-view-v2')).toBeTruthy();
	});

	it('shows loading state when isLoading is true', () => {
		mockTaskViewData = { ...makeDefaultTaskViewData(), isLoading: true } as typeof mockTaskViewData;
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('Loading task');
	});

	it('shows error state when error is set', () => {
		mockTaskViewData = {
			...makeDefaultTaskViewData(),
			error: 'Failed to fetch',
			task: null,
		} as typeof mockTaskViewData;
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('Failed to fetch');
	});

	it('shows "Task not found" when task is null and no error', () => {
		mockTaskViewData = {
			...makeDefaultTaskViewData(),
			task: null,
			error: null,
		} as typeof mockTaskViewData;
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('Task not found');
	});

	// --- Header ---

	it('renders task title in header', () => {
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('Test Task');
	});

	it('renders status badge', () => {
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('task-status-badge').textContent).toContain('in progress');
	});

	it('does not render review bar when group.submittedForReview is false', () => {
		const { queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(queryByTestId('task-review-bar')).toBeNull();
	});

	it('renders review bar when group.submittedForReview is true', () => {
		mockTaskViewData = makeDefaultTaskViewData(
			makeTask({ status: 'review' }),
			makeGroup({ submittedForReview: true })
		);
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('task-review-bar')).toBeTruthy();
	});

	// --- Turn blocks ---

	it('renders turn blocks for each turn in turnBlocks', () => {
		const turn1 = makeTurn({ id: 'turn-1', agentLabel: 'Worker' });
		const turn2 = makeTurn({ id: 'turn-2', sessionId: 'session-leader', agentLabel: 'Leader' });
		mockTurnBlockItems = [
			{ type: 'turn', turn: turn1 },
			{ type: 'turn', turn: turn2 },
		];
		const { getAllByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		const blocks = getAllByTestId('turn-block');
		expect(blocks).toHaveLength(2);
		expect(blocks[0].textContent).toContain('Worker');
		expect(blocks[1].textContent).toContain('Leader');
	});

	it('renders runtime messages inline between turn blocks', () => {
		const turn1 = makeTurn({ id: 'turn-1' });
		mockTurnBlockItems = [
			{ type: 'turn', turn: turn1 },
			{ type: 'runtime', message: {} as never, index: 1 },
			{ type: 'turn', turn: makeTurn({ id: 'turn-2' }) },
		];
		const { getAllByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getAllByTestId('turn-block')).toHaveLength(2);
		expect(getAllByTestId('runtime-message')).toHaveLength(1);
	});

	it('shows loading message when messagesLoading and no blocks yet', () => {
		mockMessagesLoading = true;
		mockTurnBlockItems = [];
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('Loading conversation');
	});

	it('shows "No messages yet" when not loading and no blocks', () => {
		mockMessagesLoading = false;
		mockTurnBlockItems = [];
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('No messages yet');
	});

	it('shows empty state when group is null', () => {
		mockTaskViewData = makeDefaultTaskViewData(makeTask({ status: 'pending' }), null);
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('No active agent group');
	});

	// --- Slide-out panel ---

	it('does not render slide-out panel initially', () => {
		const { queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(queryByTestId('slide-out-panel')).toBeNull();
	});

	it('opens slide-out panel when a turn block is clicked', async () => {
		const turn = makeTurn({ id: 'turn-1', sessionId: 'session-worker', agentLabel: 'Worker' });
		mockTurnBlockItems = [{ type: 'turn', turn }];
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		fireEvent.click(getByTestId('turn-block'));

		await waitFor(() => {
			const panel = getByTestId('slide-out-panel');
			expect(panel).toBeTruthy();
			expect(panel.getAttribute('data-session-id')).toBe('session-worker');
		});
	});

	it('closes slide-out panel when close button is clicked', async () => {
		const turn = makeTurn({ id: 'turn-1' });
		mockTurnBlockItems = [{ type: 'turn', turn }];
		const { getByTestId, queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		fireEvent.click(getByTestId('turn-block'));
		await waitFor(() => expect(getByTestId('slide-out-panel')).toBeTruthy());

		fireEvent.click(getByTestId('slide-out-close'));
		await waitFor(() => expect(queryByTestId('slide-out-panel')).toBeNull());
	});

	it('clicking the same turn block again toggles the panel closed', async () => {
		const turn = makeTurn({ id: 'turn-1' });
		mockTurnBlockItems = [{ type: 'turn', turn }];
		const { getByTestId, queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		// Open
		fireEvent.click(getByTestId('turn-block'));
		await waitFor(() => expect(getByTestId('slide-out-panel')).toBeTruthy());

		// Toggle closed by clicking same turn
		fireEvent.click(getByTestId('turn-block'));
		await waitFor(() => expect(queryByTestId('slide-out-panel')).toBeNull());
	});

	it('only one panel open at a time — clicking second turn replaces first', async () => {
		const turn1 = makeTurn({ id: 'turn-1', sessionId: 'session-a', agentLabel: 'Agent A' });
		const turn2 = makeTurn({ id: 'turn-2', sessionId: 'session-b', agentLabel: 'Agent B' });
		mockTurnBlockItems = [
			{ type: 'turn', turn: turn1 },
			{ type: 'turn', turn: turn2 },
		];
		const { getAllByTestId, getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		const blocks = getAllByTestId('turn-block');
		// Open first
		fireEvent.click(blocks[0]);
		await waitFor(() =>
			expect(getByTestId('slide-out-panel').getAttribute('data-session-id')).toBe('session-a')
		);

		// Click second — should switch to session-b
		fireEvent.click(blocks[1]);
		await waitFor(() =>
			expect(getByTestId('slide-out-panel').getAttribute('data-session-id')).toBe('session-b')
		);
	});

	// --- Selected state ---

	it('passes isSelected=true to the active turn block', async () => {
		const turn = makeTurn({ id: 'turn-1' });
		mockTurnBlockItems = [{ type: 'turn', turn }];
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		fireEvent.click(getByTestId('turn-block'));
		await waitFor(() =>
			expect(getByTestId('turn-block').getAttribute('data-selected')).toBe('true')
		);
	});

	// --- HumanInputArea ---

	it('renders HumanInputArea', () => {
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('human-input-area')).toBeTruthy();
	});

	// --- Autoscroll ---

	it('shows scroll-to-bottom button when showScrollButton is true', () => {
		mockShowScrollButton = true;
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('scroll-to-bottom')).toBeTruthy();
	});

	it('does not show scroll-to-bottom button when showScrollButton is false', () => {
		mockShowScrollButton = false;
		const { queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(queryByTestId('scroll-to-bottom')).toBeNull();
	});

	it('auto-scroll toggle button is present', () => {
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		const btn = container.querySelector('[title="Disable auto-scroll"]');
		expect(btn).toBeTruthy();
	});

	it('clicking autoscroll toggle changes button title', async () => {
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		const btn = container.querySelector('[title="Disable auto-scroll"]') as HTMLElement;
		expect(btn).toBeTruthy();
		fireEvent.click(btn);
		await waitFor(() => {
			expect(container.querySelector('[title="Enable auto-scroll"]')).toBeTruthy();
		});
	});

	// --- Review flow ---

	it('calls approveReviewedTask when approve button clicked', async () => {
		mockTaskViewData = makeDefaultTaskViewData(
			makeTask({ status: 'review' }),
			makeGroup({ submittedForReview: true })
		);
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		fireEvent.click(getByTestId('approve-button'));
		await waitFor(() => {
			expect(mockTaskViewData.approveReviewedTask).toHaveBeenCalledTimes(1);
		});
	});

	it('opens reject modal when reject button clicked', async () => {
		const data = makeDefaultTaskViewData(
			makeTask({ status: 'review' }),
			makeGroup({ submittedForReview: true })
		);
		mockTaskViewData = data;
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		fireEvent.click(getByTestId('open-reject-modal'));
		expect(data.rejectModal.open).toHaveBeenCalled();
	});

	// --- Info panel ---

	it('toggles info panel when header action button clicked', async () => {
		const { getByTestId, queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(queryByTestId('task-info-panel')).toBeNull();
		fireEvent.click(getByTestId('toggle-info-panel'));
		await waitFor(() => expect(getByTestId('task-info-panel')).toBeTruthy());
	});

	// --- Dependencies ---

	it('renders dependency links when task.dependsOn is non-empty', () => {
		mockTaskViewData = makeDefaultTaskViewData(
			makeTask({ dependsOn: ['dep-task-1234567890'] }),
			makeGroup()
		);
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('Depends on:');
		expect(container.textContent).toContain('dep-task');
	});

	// --- PR link ---

	it('renders PR link when task.prUrl is set', () => {
		mockTaskViewData = makeDefaultTaskViewData(
			makeTask({ prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 }),
			makeGroup()
		);
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(container.textContent).toContain('PR #42');
	});

	// --- conversationKey state resets ---

	it('replaces turn-blocks-container DOM node when conversationKey changes (rendererKey drives state reset)', async () => {
		// When conversationKey changes, rendererKey changes, which:
		// 1. Replaces the turn-blocks-container div (key-based unmount+remount)
		// 2. Triggers useEffect([rendererKey]) to reset selectedTurn, autoScrollEnabled, isFirstLoad
		//
		// We use mockConversationKeySignal (a Preact signal) so the component
		// reactively re-renders when the signal changes — more reliable than
		// calling rerender() with the same props.
		const turn = makeTurn({ id: 'turn-1', sessionId: 'session-worker' });
		mockTurnBlockItems = [{ type: 'turn', turn }];

		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		const containerBefore = getByTestId('turn-blocks-container');

		// Bump conversationKey via signal → reactive re-render
		await act(async () => {
			mockConversationKeySignal.value = 1;
		});

		// The turn-blocks-container should be a NEW DOM node (key changed = unmount+remount)
		const containerAfter = getByTestId('turn-blocks-container');
		expect(containerAfter).not.toBe(containerBefore);
	});

	it('resets slide-out panel (selectedTurn → null) when conversationKey changes', async () => {
		const turn = makeTurn({ id: 'turn-1', sessionId: 'session-worker' });
		mockTurnBlockItems = [{ type: 'turn', turn }];

		const { getByTestId, queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		// Open the slide-out panel
		fireEvent.click(getByTestId('turn-block'));
		await waitFor(() => expect(getByTestId('slide-out-panel')).toBeTruthy());

		// Bump conversationKey via signal → reactive re-render → useEffect resets selectedTurn
		await act(async () => {
			mockConversationKeySignal.value = 1;
		});

		// Slide-out should be closed after conversationKey change
		await waitFor(() => expect(queryByTestId('slide-out-panel')).toBeNull());
	});

	it('resets autoScrollEnabled to true when conversationKey changes', async () => {
		const { container } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);

		// Disable auto-scroll
		const toggleBtn = container.querySelector('[title="Disable auto-scroll"]') as HTMLElement;
		fireEvent.click(toggleBtn);
		await waitFor(() =>
			expect(container.querySelector('[title="Enable auto-scroll"]')).toBeTruthy()
		);

		// Bump conversationKey via signal → reactive re-render → useEffect resets autoScrollEnabled
		await act(async () => {
			mockConversationKeySignal.value = 1;
		});

		await waitFor(() =>
			expect(container.querySelector('[title="Disable auto-scroll"]')).toBeTruthy()
		);
	});

	// --- isReconnecting ---

	it('shows reconnecting banner when isReconnecting is true', () => {
		mockIsReconnecting = true;
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('reconnecting-banner')).toBeTruthy();
	});

	it('does not show reconnecting banner when isReconnecting is false', () => {
		mockIsReconnecting = false;
		const { queryByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(queryByTestId('reconnecting-banner')).toBeNull();
	});

	it('reconnecting banner shows text "Reconnecting…"', () => {
		mockIsReconnecting = true;
		const { getByTestId } = render(<TaskViewV2 roomId="room-1" taskId="task-1" />);
		expect(getByTestId('reconnecting-banner').textContent).toContain('Reconnecting');
	});
});
