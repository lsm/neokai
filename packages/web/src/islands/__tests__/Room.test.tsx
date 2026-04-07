// @ts-nocheck
/**
 * Tests for the Room Island component.
 *
 * Focuses on the rendering priority logic:
 * - taskViewId present → TaskViewToggle overlay (tabs still visible behind it)
 * - sessionViewId present (including synthetic room:chat:<roomId>) → ChatContainer
 * - neither → tabbed dashboard
 *
 * Tab state is driven by currentRoomActiveTabSignal (single source of truth).
 * Tab clicks delegate to navigateToRoomTab which updates both the URL and the signal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { currentRoomAgentActiveSignal, currentRoomActiveTabSignal } from '../../lib/signals';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
	mockNavigateToHome,
	mockNavigateToRoomTask,
	mockNavigateToRoomTab,
	mockNavigateToRoomMission,
	mockToastSuccess,
	mockRoomStoreSelect,
} = vi.hoisted(() => ({
	mockNavigateToHome: vi.fn(),
	mockNavigateToRoomTask: vi.fn(),
	mockNavigateToRoomTab: vi.fn(),
	mockNavigateToRoomMission: vi.fn(),
	mockToastSuccess: vi.fn(),
	// Hoisted so it stays the same reference across all mock accesses
	mockRoomStoreSelect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/router', () => ({
	navigateToHome: mockNavigateToHome,
	navigateToRoomTask: mockNavigateToRoomTask,
	navigateToRoomTab: mockNavigateToRoomTab,
	navigateToRoomMission: mockNavigateToRoomMission,
}));

vi.mock('../../lib/toast', () => ({
	toast: { success: mockToastSuccess, error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// roomStore mock signals
// ---------------------------------------------------------------------------

let mockLoadingSignal: ReturnType<typeof signal<boolean>>;
let mockErrorSignal: ReturnType<typeof signal<string | null>>;
let mockRoomSignal: ReturnType<typeof signal<any>>;
let mockGoalsSignal: ReturnType<typeof signal<any[]>>;
let mockTasksSignal: ReturnType<typeof signal<any[]>>;
let mockGoalsLoadingSignal: ReturnType<typeof signal<boolean>>;
let mockAutoCompletedNotificationsSignal: ReturnType<typeof signal<any[]>>;
let mockReviewTaskCountSignal: ReturnType<typeof signal<number>>;
let mockGoalByTaskIdSignal: ReturnType<typeof signal<Record<string, any>>>;
let mockRuntimeStateSignal: ReturnType<typeof signal<string | null>>;
let mockActiveTasksSignal: ReturnType<typeof signal<any[]>>;
let mockReviewTasksSignal: ReturnType<typeof signal<any[]>>;

function initRoomStoreSignals(roomOverride?: object) {
	mockLoadingSignal = signal(false);
	mockErrorSignal = signal(null);
	mockRoomSignal = signal(
		roomOverride !== undefined
			? roomOverride
			: { id: 'room-1', name: 'Test Room', description: '', goal: null }
	);
	mockGoalsSignal = signal([]);
	mockTasksSignal = signal([]);
	mockGoalsLoadingSignal = signal(false);
	mockAutoCompletedNotificationsSignal = signal([]);
	mockReviewTaskCountSignal = signal(0);
	mockGoalByTaskIdSignal = signal({});
	mockRuntimeStateSignal = signal(null);
	mockActiveTasksSignal = signal([]);
	mockReviewTasksSignal = signal([]);
}

vi.mock('../../lib/room-store', () => ({
	get roomStore() {
		return {
			get loading() {
				return mockLoadingSignal;
			},
			get error() {
				return mockErrorSignal;
			},
			get room() {
				return mockRoomSignal;
			},
			get goals() {
				return mockGoalsSignal;
			},
			get tasks() {
				return mockTasksSignal;
			},
			get goalsLoading() {
				return mockGoalsLoadingSignal;
			},
			get autoCompletedNotifications() {
				return mockAutoCompletedNotificationsSignal;
			},
			get reviewTaskCount() {
				return mockReviewTaskCountSignal;
			},
			get goalByTaskId() {
				return mockGoalByTaskIdSignal;
			},
			get runtimeState() {
				return mockRuntimeStateSignal;
			},
			get activeTasks() {
				return mockActiveTasksSignal;
			},
			get reviewTasks() {
				return mockReviewTasksSignal;
			},
			select: mockRoomStoreSelect,
			subscribeRoom: vi.fn().mockResolvedValue(undefined),
			unsubscribeRoom: vi.fn(),
			createGoal: vi.fn(),
			updateGoal: vi.fn(),
			deleteGoal: vi.fn(),
			linkTaskToGoal: vi.fn(),
			archiveRoom: vi.fn().mockResolvedValue(undefined),
			deleteRoom: vi.fn().mockResolvedValue(undefined),
			updateSettings: vi.fn(),
			listExecutions: vi.fn(),
			dismissAutoCompleted: vi.fn(),
			setTaskStatus: vi.fn().mockResolvedValue(undefined),
			triggerNow: vi.fn().mockResolvedValue(undefined),
			scheduleNext: vi.fn().mockResolvedValue(undefined),
		};
	},
}));

// ---------------------------------------------------------------------------
// Lightweight component stubs
// ---------------------------------------------------------------------------

vi.mock('../ChatContainer', () => ({
	default: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="chat-container" data-session-id={sessionId}>
			ChatContainer
		</div>
	),
}));

vi.mock('../../components/room/TaskViewToggle', () => ({
	TaskViewToggle: ({ taskId }: { taskId: string }) => (
		<div data-testid="task-view-toggle" data-task-id={taskId}>
			TaskViewToggle
		</div>
	),
}));

vi.mock('../../hooks/useRoomLiveQuery', () => ({
	useRoomLiveQuery: vi.fn(),
}));

vi.mock('../../components/room/RoomDashboard', () => ({
	RoomDashboard: () => <div data-testid="room-dashboard">RoomDashboard</div>,
}));

vi.mock('../../components/room', () => ({
	GoalsEditor: () => <div data-testid="goals-editor">GoalsEditor</div>,
	RoomSettings: () => <div data-testid="room-settings">RoomSettings</div>,
	RoomAgents: () => <div data-testid="room-agents">RoomAgents</div>,
}));

vi.mock('../../components/room/RoomAgentContextStrip', () => ({
	RoomAgentContextStrip: () => <div data-testid="room-agent-context-strip" />,
}));

vi.mock('../../components/room/RoomTasks', () => ({
	RoomTasks: () => <div data-testid="room-tasks">RoomTasks</div>,
}));

vi.mock('../../components/ui/Skeleton', () => ({
	Skeleton: () => <div data-testid="skeleton">Skeleton</div>,
}));

vi.mock('../../components/ui/Button', () => ({
	Button: ({ children, onClick }: any) => (
		<button onClick={onClick} data-testid="button">
			{children}
		</button>
	),
}));

vi.mock('../../components/ui/MobileMenuButton', () => ({
	MobileMenuButton: () => <div data-testid="mobile-menu-button" />,
}));

// ---------------------------------------------------------------------------
// Initialize signals before imports so mocks capture them
// ---------------------------------------------------------------------------

initRoomStoreSignals();

import Room from '../Room';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Room', () => {
	const roomId = 'room-1';

	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		// Re-apply the resolved value since clearAllMocks resets mockImplementation
		mockRoomStoreSelect.mockResolvedValue(undefined);
		initRoomStoreSignals();
		currentRoomAgentActiveSignal.value = false;
		currentRoomActiveTabSignal.value = null;
	});

	afterEach(() => {
		cleanup();
	});

	describe('View rendering priority', () => {
		it('renders ChatContainer when sessionViewId is provided (session route)', () => {
			render(<Room roomId={roomId} sessionViewId="session-abc" />);

			expect(screen.getByTestId('chat-container')).toBeTruthy();
			expect(screen.getByTestId('chat-container').getAttribute('data-session-id')).toBe(
				'session-abc'
			);
			expect(screen.queryByTestId('task-view-toggle')).toBeNull();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders Chat tab with ChatContainer when currentRoomActiveTabSignal is "chat"', () => {
			currentRoomActiveTabSignal.value = 'chat';
			render(<Room roomId={roomId} />);

			// Chat tab is rendered (always mounted), and dashboard is not visible
			const containers = screen.getAllByTestId('chat-container');
			expect(containers.length).toBeGreaterThan(0);
			// Overview dashboard should not be visible since chat tab is active
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders TaskViewToggle overlay when taskViewId is provided (task route)', () => {
			render(<Room roomId={roomId} taskViewId="task-xyz" />);

			const taskViewToggle = screen.getByTestId('task-view-toggle');
			expect(taskViewToggle).toBeTruthy();
			expect(taskViewToggle.getAttribute('data-task-id')).toBe('task-xyz');
			// tabs and tab content are still in the DOM behind the overlay
			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
		});

		it('non-agent sessionViewId takes over the full area', () => {
			render(<Room roomId={roomId} taskViewId="task-xyz" sessionViewId="some-worker-session" />);

			// Non-agent sessionViewId replaces the whole content area
			const container = screen.getByTestId('chat-container');
			expect(container).toBeTruthy();
			expect(container.getAttribute('data-session-id')).toBe('some-worker-session');
			expect(screen.queryByTestId('task-view-toggle')).toBeNull();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders tabbed dashboard when neither sessionViewId nor taskViewId is set', () => {
			render(<Room roomId={roomId} />);

			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
			expect(screen.queryByTestId('task-view-toggle')).toBeNull();
		});

		it('renders tabbed dashboard when sessionViewId is null', () => {
			render(<Room roomId={roomId} sessionViewId={null} />);

			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
		});

		it('renders tabbed dashboard when taskViewId is null', () => {
			render(<Room roomId={roomId} taskViewId={null} />);

			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
			expect(screen.queryByTestId('task-view-toggle')).toBeNull();
		});
	});

	describe('roomStore lifecycle', () => {
		it('calls roomStore.select with roomId on mount', async () => {
			await act(async () => {
				render(<Room roomId={roomId} />);
			});

			expect(mockRoomStoreSelect).toHaveBeenCalledWith(roomId);
		});

		it('calls roomStore.select(null) on unmount', async () => {
			const { unmount } = render(<Room roomId={roomId} />);
			await act(async () => {
				unmount();
			});

			expect(mockRoomStoreSelect).toHaveBeenCalledWith(null);
		});
	});

	describe('Tab navigation', () => {
		it('renders Tasks tab content when currentRoomActiveTabSignal is "tasks"', () => {
			currentRoomActiveTabSignal.value = 'tasks';
			render(<Room roomId={roomId} />);

			expect(screen.getByTestId('room-tasks')).toBeTruthy();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders Missions tab content when currentRoomActiveTabSignal is "goals"', () => {
			currentRoomActiveTabSignal.value = 'goals';
			render(<Room roomId={roomId} />);

			expect(screen.getByTestId('goals-editor')).toBeTruthy();
		});

		it('renders Settings tab content when currentRoomActiveTabSignal is "settings"', () => {
			currentRoomActiveTabSignal.value = 'settings';
			render(<Room roomId={roomId} />);

			expect(screen.getByTestId('room-settings')).toBeTruthy();
		});

		it('renders Agents tab content when currentRoomActiveTabSignal is "agents"', () => {
			currentRoomActiveTabSignal.value = 'agents';
			render(<Room roomId={roomId} />);

			expect(screen.getByTestId('room-agents')).toBeTruthy();
		});

		it('calls navigateToRoomTab when a tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Tasks'));

			expect(mockNavigateToRoomTab).toHaveBeenCalledWith(roomId, 'tasks');
		});

		it('calls navigateToRoomTab with "chat" when Coordinator tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Coordinator'));

			expect(mockNavigateToRoomTab).toHaveBeenCalledWith(roomId, 'chat');
		});

		it('calls navigateToRoomTab with "goals" when Missions tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Missions'));

			expect(mockNavigateToRoomTab).toHaveBeenCalledWith(roomId, 'goals');
		});

		it('calls navigateToRoomTab with "settings" when Settings tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Settings'));

			expect(mockNavigateToRoomTab).toHaveBeenCalledWith(roomId, 'settings');
		});

		it('defaults to overview tab when currentRoomActiveTabSignal is null', () => {
			currentRoomActiveTabSignal.value = null;
			render(<Room roomId={roomId} />);

			// Overview is the default tab
			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
		});

		it('clears currentRoomActiveTabSignal on unmount', async () => {
			currentRoomActiveTabSignal.value = 'tasks';
			const { unmount } = render(<Room roomId={roomId} />);
			await act(async () => {
				unmount();
			});

			expect(currentRoomActiveTabSignal.value).toBeNull();
		});
	});

	describe('Error and loading states', () => {
		it('renders loading skeleton during initial load', () => {
			// initialLoad state starts as true and only flips after roomStore.select() resolves
			// (async microtask). render() is synchronous so initialLoad is still true here,
			// making the skeleton assertion safe without needing act().
			mockLoadingSignal.value = true;
			mockRoomSignal.value = null;
			render(<Room roomId={roomId} />);

			expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
		});

		it('renders error state when room fails to load', () => {
			mockErrorSignal.value = 'Room not found';
			mockRoomSignal.value = null;
			render(<Room roomId={roomId} />);

			expect(screen.getByText('Failed to load room')).toBeTruthy();
			expect(screen.getByText('Room not found')).toBeTruthy();
		});

		it('renders "Room not found" when room is null with no error', () => {
			mockRoomSignal.value = null;
			render(<Room roomId={roomId} />);

			expect(screen.getByText('Room not found')).toBeTruthy();
		});
	});
});
