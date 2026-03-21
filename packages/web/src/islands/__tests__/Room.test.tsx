// @ts-nocheck
/**
 * Tests for the Room Island component.
 *
 * Focuses on the rendering priority logic:
 * - taskViewId present → TaskView
 * - sessionViewId present (including synthetic room:chat:<roomId>) → ChatContainer
 * - neither → tabbed dashboard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { signal } from '@preact/signals';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
	mockNavigateToHome,
	mockNavigateToRoomTask,
	mockNavigateToRoom,
	mockToastSuccess,
	mockRoomStoreSelect,
} = vi.hoisted(() => ({
	mockNavigateToHome: vi.fn(),
	mockNavigateToRoomTask: vi.fn(),
	mockNavigateToRoom: vi.fn(),
	mockToastSuccess: vi.fn(),
	// Hoisted so it stays the same reference across all mock accesses
	mockRoomStoreSelect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/router', () => ({
	navigateToHome: mockNavigateToHome,
	navigateToRoomTask: mockNavigateToRoomTask,
	navigateToRoom: mockNavigateToRoom,
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
			select: mockRoomStoreSelect,
			createGoal: vi.fn(),
			updateGoal: vi.fn(),
			deleteGoal: vi.fn(),
			linkTaskToGoal: vi.fn(),
			archiveRoom: vi.fn().mockResolvedValue(undefined),
			deleteRoom: vi.fn().mockResolvedValue(undefined),
			updateSettings: vi.fn(),
			listExecutions: vi.fn(),
			dismissAutoCompleted: vi.fn(),
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

vi.mock('../../components/room/TaskView', () => ({
	TaskView: ({ taskId }: { taskId: string }) => (
		<div data-testid="task-view" data-task-id={taskId}>
			TaskView
		</div>
	),
}));

vi.mock('../../components/room/RoomDashboard', () => ({
	RoomDashboard: () => <div data-testid="room-dashboard">RoomDashboard</div>,
}));

vi.mock('../../components/room', () => ({
	GoalsEditor: () => <div data-testid="goals-editor">GoalsEditor</div>,
	RoomContext: () => <div data-testid="room-context">RoomContext</div>,
	RoomSettings: () => <div data-testid="room-settings">RoomSettings</div>,
	RoomAgents: () => <div data-testid="room-agents">RoomAgents</div>,
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
			expect(screen.queryByTestId('task-view')).toBeNull();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders ChatContainer when sessionViewId is the synthetic room:chat:<roomId> value (agent route)', () => {
			const syntheticId = `room:chat:${roomId}`;
			render(<Room roomId={roomId} sessionViewId={syntheticId} />);

			const container = screen.getByTestId('chat-container');
			expect(container).toBeTruthy();
			expect(container.getAttribute('data-session-id')).toBe(syntheticId);
			expect(screen.queryByTestId('task-view')).toBeNull();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders TaskView when taskViewId is provided (task route)', () => {
			render(<Room roomId={roomId} taskViewId="task-xyz" />);

			const taskView = screen.getByTestId('task-view');
			expect(taskView).toBeTruthy();
			expect(taskView.getAttribute('data-task-id')).toBe('task-xyz');
			expect(screen.queryByTestId('chat-container')).toBeNull();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('taskViewId takes priority over sessionViewId when both are set', () => {
			render(<Room roomId={roomId} taskViewId="task-xyz" sessionViewId={`room:chat:${roomId}`} />);

			expect(screen.getByTestId('task-view')).toBeTruthy();
			expect(screen.queryByTestId('chat-container')).toBeNull();
		});

		it('renders tabbed dashboard when neither sessionViewId nor taskViewId is set', () => {
			render(<Room roomId={roomId} />);

			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
			expect(screen.queryByTestId('chat-container')).toBeNull();
			expect(screen.queryByTestId('task-view')).toBeNull();
		});

		it('renders tabbed dashboard when sessionViewId is null', () => {
			render(<Room roomId={roomId} sessionViewId={null} />);

			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
			expect(screen.queryByTestId('chat-container')).toBeNull();
		});

		it('renders tabbed dashboard when taskViewId is null', () => {
			render(<Room roomId={roomId} taskViewId={null} />);

			expect(screen.getByTestId('room-dashboard')).toBeTruthy();
			expect(screen.queryByTestId('task-view')).toBeNull();
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
		it('renders Context tab content when Context tab is clicked', () => {
			render(<Room roomId={roomId} />);

			// Default is overview (dashboard)
			expect(screen.getByTestId('room-dashboard')).toBeTruthy();

			fireEvent.click(screen.getByText('Context'));
			expect(screen.getByTestId('room-context')).toBeTruthy();
			expect(screen.queryByTestId('room-dashboard')).toBeNull();
		});

		it('renders Agents tab content when Agents tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Agents'));
			expect(screen.getByTestId('room-agents')).toBeTruthy();
		});

		it('renders Missions tab content when Missions tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Missions'));
			expect(screen.getByTestId('goals-editor')).toBeTruthy();
		});

		it('renders Settings tab content when Settings tab is clicked', () => {
			render(<Room roomId={roomId} />);

			fireEvent.click(screen.getByText('Settings'));
			expect(screen.getByTestId('room-settings')).toBeTruthy();
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
