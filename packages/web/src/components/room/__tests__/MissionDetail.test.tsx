/**
 * Tests for MissionDetail Component
 *
 * Covers:
 * - Loading skeleton shown when goal is null
 * - Renders mission title and badges when goal is loaded
 * - Back button calls navigateToRoom AND sets currentRoomTabSignal to 'goals'
 * - Edit button opens edit modal
 * - Delete button opens confirm modal
 * - Status sidebar shows priority, type, autonomy badges
 * - Quick actions (reactivate, complete, needs_human, archive) rendered for available actions
 * - Run Now button shown only for recurring missions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/preact';
import type { RoomGoal } from '@neokai/shared';
import { MissionDetail } from '../MissionDetail';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Use vi.hoisted so these values are available when vi.mock factories are hoisted
const { mockNavigateToRoom, mockCurrentRoomTabSignal } = vi.hoisted(() => ({
	mockNavigateToRoom: vi.fn(),
	mockCurrentRoomTabSignal: { value: null as string | null },
}));

vi.mock('../../../lib/router', () => ({
	navigateToRoom: (...args: unknown[]) => mockNavigateToRoom(...args),
}));

vi.mock('../../../lib/signals', () => ({
	currentRoomTabSignal: mockCurrentRoomTabSignal,
}));

// Mock toast
vi.mock('../../../lib/toast', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

// Mock useMissionDetailData — default returns null goal (loading state)
const mockUseMissionDetailData = vi.fn();
vi.mock('../../../hooks/useMissionDetailData', () => ({
	useMissionDetailData: (...args: unknown[]) => mockUseMissionDetailData(...args),
}));

// Mock sub-components from GoalsEditor to avoid deep dependency chains
vi.mock('../GoalsEditor', () => ({
	StatusIndicator: ({ status }: { status: string }) => (
		<span data-testid="status-indicator">{status}</span>
	),
	PriorityBadge: ({ priority }: { priority: string }) => (
		<span data-testid="priority-badge">{priority}</span>
	),
	MissionTypeBadge: ({ type }: { type: string }) => (
		<span data-testid="mission-type-badge">{type}</span>
	),
	AutonomyBadge: ({ level }: { level: string }) => (
		<span data-testid="autonomy-badge">{level}</span>
	),
	GoalShortIdBadge: ({ shortId }: { shortId: string }) => (
		<span data-testid="short-id-badge">{shortId}</span>
	),
	GoalForm: ({
		onSubmit,
		onCancel,
	}: {
		onSubmit: (data: unknown) => Promise<void>;
		onCancel: () => void;
	}) => (
		<form
			data-testid="goal-form"
			onSubmit={(e: Event) => {
				e.preventDefault();
				onSubmit({ title: 'Updated Title' });
			}}
		>
			<button type="submit">Save</button>
			<button type="button" onClick={onCancel}>
				Cancel
			</button>
		</form>
	),
}));

// Mock UI components — paths are relative to the test file location (room/__tests__/)
// so they need to go up two levels to reach src/components/ui/
vi.mock('../../ui/Button', () => ({
	Button: ({
		children,
		onClick,
		...rest
	}: {
		children?: import('preact').ComponentChildren;
		onClick?: () => void;
		[key: string]: unknown;
	}) => (
		<button onClick={onClick} {...rest}>
			{children}
		</button>
	),
}));

vi.mock('../../ui/MobileMenuButton', () => ({
	MobileMenuButton: () => <button data-testid="mobile-menu-button" />,
}));

vi.mock('../../ui/Modal', () => ({
	Modal: ({
		isOpen,
		children,
		title,
		onClose,
	}: {
		isOpen: boolean;
		children: import('preact').ComponentChildren;
		title: string;
		onClose: () => void;
	}) =>
		isOpen ? (
			<div data-testid="modal" role="dialog">
				<span data-testid="modal-title">{title}</span>
				<button data-testid="modal-close" onClick={onClose}>
					×
				</button>
				{children}
			</div>
		) : null,
}));

vi.mock('../../ui/ConfirmModal', () => ({
	ConfirmModal: ({
		isOpen,
		onClose,
		onConfirm,
		title,
		isLoading,
		confirmTestId,
	}: {
		isOpen: boolean;
		onClose: () => void;
		onConfirm: () => void;
		title: string;
		isLoading?: boolean;
		confirmTestId?: string;
	}) =>
		isOpen ? (
			<div data-testid="confirm-modal" role="dialog">
				<span data-testid="confirm-modal-title">{title}</span>
				<button
					data-testid={confirmTestId ?? 'confirm-button'}
					onClick={onConfirm}
					disabled={isLoading}
				>
					Confirm
				</button>
				<button data-testid="cancel-button" onClick={onClose}>
					Cancel
				</button>
			</div>
		) : null,
}));

vi.mock('../../ui/Skeleton', () => ({
	Skeleton: () => <div data-testid="skeleton" />,
}));

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const BASE_GOAL: RoomGoal = {
	id: 'goal-uuid-1',
	roomId: 'room-1',
	shortId: 'g-abc123',
	title: 'Ship the feature',
	description: 'A test mission',
	status: 'active',
	priority: 'normal',
	missionType: 'one_shot',
	autonomyLevel: 'supervised',
	progress: 0,
	linkedTaskIds: [],
	structuredMetrics: [],
	createdAt: 1700000000000,
	updatedAt: 1700000001000,
};

function makeDefaultHookResult(
	overrides: Partial<ReturnType<typeof mockUseMissionDetailData>> = {}
) {
	return {
		goal: BASE_GOAL,
		goalsLoading: false,
		linkedTasks: [],
		executions: null,
		isLoadingExecutions: false,
		isUpdating: false,
		isTriggering: false,
		isDeleting: false,
		availableStatusActions: ['complete', 'needs_human', 'archive'],
		updateGoal: vi.fn().mockResolvedValue(undefined),
		deleteGoal: vi.fn().mockResolvedValue(undefined),
		triggerNow: vi.fn().mockResolvedValue(undefined),
		scheduleNext: vi.fn().mockResolvedValue(undefined),
		linkTask: vi.fn().mockResolvedValue(undefined),
		changeStatus: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MissionDetail', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCurrentRoomTabSignal.value = null;
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult());
	});

	afterEach(() => {
		cleanup();
	});

	// ── Loading state ──────────────────────────────────────────────────────────

	it('shows skeleton when goal is null and goalsLoading is true', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ goal: null, goalsLoading: true })
		);
		const { getAllByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-1" />);
		expect(getAllByTestId('skeleton').length).toBeGreaterThan(0);
	});

	it('does not show main content when loading', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ goal: null, goalsLoading: true })
		);
		const { queryByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-1" />);
		expect(queryByTestId('mission-detail')).toBeNull();
		expect(queryByTestId('mission-not-found')).toBeNull();
	});

	// ── Not found state ────────────────────────────────────────────────────────

	it('shows "Mission not found" when goal is null and goals have loaded', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ goal: null, goalsLoading: false })
		);
		const { getByTestId, getByText } = render(<MissionDetail roomId="room-1" goalId="bad-id" />);
		expect(getByTestId('mission-not-found')).toBeTruthy();
		expect(getByText('Mission not found')).toBeTruthy();
	});

	it('not-found back button calls navigateToRoom and sets tab signal', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ goal: null, goalsLoading: false })
		);
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="bad-id" />);
		fireEvent.click(getByTestId('mission-not-found-back-button'));
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		expect(mockCurrentRoomTabSignal.value).toBe('goals');
	});

	it('not-found state does not show the skeleton', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ goal: null, goalsLoading: false })
		);
		const { queryByTestId } = render(<MissionDetail roomId="room-1" goalId="bad-id" />);
		expect(queryByTestId('skeleton')).toBeNull();
	});

	// ── Header ────────────────────────────────────────────────────────────────

	it('renders mission title in header', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail-title').textContent).toBe('Ship the feature');
	});

	it('renders status indicator', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('status-indicator').textContent).toBe('active');
	});

	it('renders short ID badge when shortId is present', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('short-id-badge').textContent).toBe('g-abc123');
	});

	it('does not render short ID badge when shortId is absent', () => {
		const goal = { ...BASE_GOAL, shortId: undefined };
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ goal }));
		const { queryByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(queryByTestId('short-id-badge')).toBeNull();
	});

	// ── Back button ───────────────────────────────────────────────────────────

	it('back button calls navigateToRoom with correct roomId', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		fireEvent.click(getByTestId('mission-detail-back-button'));
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
	});

	it('back button sets currentRoomTabSignal to "goals"', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		fireEvent.click(getByTestId('mission-detail-back-button'));
		expect(mockCurrentRoomTabSignal.value).toBe('goals');
	});

	it('does not call navigateToRoom on initial render', () => {
		render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(mockNavigateToRoom).not.toHaveBeenCalled();
	});

	// ── Edit action ───────────────────────────────────────────────────────────

	it('edit button opens the edit modal', () => {
		const { getByTestId, queryByTestId } = render(
			<MissionDetail roomId="room-1" goalId="goal-uuid-1" />
		);
		expect(queryByTestId('modal')).toBeNull();
		fireEvent.click(getByTestId('mission-detail-edit-button'));
		expect(getByTestId('modal')).toBeTruthy();
		expect(getByTestId('modal-title').textContent).toBe('Edit Mission');
	});

	it('edit modal contains GoalForm', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		fireEvent.click(getByTestId('mission-detail-edit-button'));
		expect(getByTestId('goal-form')).toBeTruthy();
	});

	it('closes edit modal when GoalForm cancel is clicked', () => {
		const { getByTestId, queryByTestId } = render(
			<MissionDetail roomId="room-1" goalId="goal-uuid-1" />
		);
		fireEvent.click(getByTestId('mission-detail-edit-button'));
		expect(getByTestId('modal')).toBeTruthy();
		// Click Cancel inside GoalForm mock
		const cancelBtn = getByTestId('modal').querySelector('button[type="button"]');
		expect(cancelBtn).toBeTruthy();
		fireEvent.click(cancelBtn!);
		expect(queryByTestId('modal')).toBeNull();
	});

	// ── Delete action ─────────────────────────────────────────────────────────

	it('delete button opens the confirm modal', () => {
		const { getByTestId, queryByTestId } = render(
			<MissionDetail roomId="room-1" goalId="goal-uuid-1" />
		);
		expect(queryByTestId('confirm-modal')).toBeNull();
		fireEvent.click(getByTestId('mission-detail-delete-button'));
		expect(getByTestId('confirm-modal')).toBeTruthy();
		expect(getByTestId('confirm-modal-title').textContent).toBe('Delete Mission');
	});

	it('confirm delete calls deleteGoal', async () => {
		const deleteGoal = vi.fn().mockResolvedValue(undefined);
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ deleteGoal }));
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		fireEvent.click(getByTestId('mission-detail-delete-button'));
		await act(async () => {
			fireEvent.click(getByTestId('mission-detail-delete-confirm'));
		});
		expect(deleteGoal).toHaveBeenCalled();
	});

	it('closes confirm modal when cancel is clicked', () => {
		const { getByTestId, queryByTestId } = render(
			<MissionDetail roomId="room-1" goalId="goal-uuid-1" />
		);
		fireEvent.click(getByTestId('mission-detail-delete-button'));
		expect(getByTestId('confirm-modal')).toBeTruthy();
		fireEvent.click(getByTestId('cancel-button'));
		expect(queryByTestId('confirm-modal')).toBeNull();
	});

	// ── Disabled states ───────────────────────────────────────────────────────

	it('edit button is disabled when isUpdating is true', () => {
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ isUpdating: true }));
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail-edit-button').hasAttribute('disabled')).toBe(true);
	});

	it('edit button is enabled when isUpdating is false', () => {
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ isUpdating: false }));
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail-edit-button').hasAttribute('disabled')).toBe(false);
	});

	it('delete button is disabled when isDeleting is true', () => {
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ isDeleting: true }));
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail-delete-button').hasAttribute('disabled')).toBe(true);
	});

	it('delete button is enabled when isDeleting is false', () => {
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ isDeleting: false }));
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail-delete-button').hasAttribute('disabled')).toBe(false);
	});

	// ── Status sidebar ────────────────────────────────────────────────────────

	it('renders priority badge in sidebar', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('priority-badge').textContent).toBe('normal');
	});

	it('renders mission type badge in sidebar', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-type-badge').textContent).toBe('one_shot');
	});

	it('renders autonomy badge in sidebar', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('autonomy-badge').textContent).toBe('supervised');
	});

	// ── Quick actions ─────────────────────────────────────────────────────────

	it('shows "Mark Complete" action when complete is available', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ availableStatusActions: ['complete'] })
		);
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByText('✓ Mark Complete')).toBeTruthy();
	});

	it('shows "Needs Review" action when needs_human is available', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ availableStatusActions: ['needs_human'] })
		);
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByText('⚑ Needs Review')).toBeTruthy();
	});

	it('shows "Reactivate" action when reactivate is available', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ availableStatusActions: ['reactivate'] })
		);
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByText('↺ Reactivate')).toBeTruthy();
	});

	it('shows "Archive" action when archive is available', () => {
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ availableStatusActions: ['archive'] })
		);
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByText('Archive')).toBeTruthy();
	});

	it('does NOT show "Run Now" for one_shot missions', () => {
		const { queryByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(queryByText('▶ Run Now')).toBeNull();
	});

	it('shows "Run Now" for recurring missions', () => {
		const goal = { ...BASE_GOAL, missionType: 'recurring' as const };
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ goal }));
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByText('▶ Run Now')).toBeTruthy();
	});

	it('clicking "Run Now" calls triggerNow', async () => {
		const triggerNow = vi.fn().mockResolvedValue(undefined);
		const goal = { ...BASE_GOAL, missionType: 'recurring' as const };
		mockUseMissionDetailData.mockReturnValue(makeDefaultHookResult({ goal, triggerNow }));
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		await act(async () => {
			fireEvent.click(getByText('▶ Run Now'));
		});
		expect(triggerNow).toHaveBeenCalled();
	});

	it('clicking "↺ Reactivate" calls changeStatus with "reactivate"', async () => {
		const changeStatus = vi.fn().mockResolvedValue(undefined);
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ availableStatusActions: ['reactivate'], changeStatus })
		);
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		await act(async () => {
			fireEvent.click(getByText('↺ Reactivate'));
		});
		expect(changeStatus).toHaveBeenCalledWith('reactivate');
	});

	it('clicking "✓ Mark Complete" calls changeStatus with "complete"', async () => {
		const changeStatus = vi.fn().mockResolvedValue(undefined);
		mockUseMissionDetailData.mockReturnValue(
			makeDefaultHookResult({ availableStatusActions: ['complete'], changeStatus })
		);
		const { getByText } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		await act(async () => {
			fireEvent.click(getByText('✓ Mark Complete'));
		});
		expect(changeStatus).toHaveBeenCalledWith('complete');
	});

	// ── Hook invocation ───────────────────────────────────────────────────────

	it('passes correct roomId and goalId to useMissionDetailData', () => {
		render(<MissionDetail roomId="room-99" goalId="goal-abc" />);
		expect(mockUseMissionDetailData).toHaveBeenCalledWith('room-99', 'goal-abc');
	});

	// ── Layout ────────────────────────────────────────────────────────────────

	it('renders mission-detail root element with correct test id', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail')).toBeTruthy();
	});

	it('renders main content area', () => {
		const { getByTestId } = render(<MissionDetail roomId="room-1" goalId="goal-uuid-1" />);
		expect(getByTestId('mission-detail-main-content')).toBeTruthy();
	});
});
