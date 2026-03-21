/**
 * Tests for the rewritten RoomContextPanel component.
 *
 * Covers: pinned items, goals section with expandable tasks,
 * orphan tasks with tab filter, sessions section with create button,
 * selection highlighting, isDashboardSelected logic, and onNavigate calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals';
import type { NeoTask, RoomGoal, SessionSummary } from '@neokai/shared';

// -------------------------------------------------------
// Hoisted mocks
// -------------------------------------------------------

const {
	mockCreateSession,
	mockNavigateToRoomSession,
	mockNavigateToRoom,
	mockNavigateToRoomAgent,
	mockNavigateToRoomTask,
	mockToast,
} = vi.hoisted(() => ({
	mockCreateSession: vi.fn().mockResolvedValue('new-session-id'),
	mockNavigateToRoomSession: vi.fn(),
	mockNavigateToRoom: vi.fn(),
	mockNavigateToRoomAgent: vi.fn(),
	mockNavigateToRoomTask: vi.fn(),
	mockToast: vi.fn(),
}));

vi.mock('../../lib/toast.ts', () => ({
	toast: { error: mockToast },
}));

// -------------------------------------------------------
// Signals used in mocks
// -------------------------------------------------------

let mockTasksSignal!: Signal<NeoTask[]>;
let mockSessionsSignal!: Signal<SessionSummary[]>;
let mockGoalsSignal!: Signal<RoomGoal[]>;
let mockCurrentRoomSessionIdSignal!: Signal<string | null>;
let mockCurrentRoomTaskIdSignal!: Signal<string | null>;

// Computed signals derived from the mocks
let mockActiveGoals!: ReadonlySignal<RoomGoal[]>;
let mockTasksByGoalId!: ReadonlySignal<Map<string, NeoTask[]>>;
let mockOrphanTasks!: ReadonlySignal<NeoTask[]>;
let mockOrphanTasksActive!: ReadonlySignal<NeoTask[]>;
let mockOrphanTasksReview!: ReadonlySignal<NeoTask[]>;
let mockOrphanTasksDone!: ReadonlySignal<NeoTask[]>;

function initSignals() {
	mockTasksSignal = signal([]);
	mockSessionsSignal = signal([]);
	mockGoalsSignal = signal([]);
	mockCurrentRoomSessionIdSignal = signal(null);
	mockCurrentRoomTaskIdSignal = signal(null);

	mockActiveGoals = computed(() => mockGoalsSignal.value.filter((g) => g.status === 'active'));

	mockTasksByGoalId = computed(() => {
		const taskMap = new Map<string, NeoTask>();
		for (const t of mockTasksSignal.value) taskMap.set(t.id, t);
		const result = new Map<string, NeoTask[]>();
		for (const goal of mockGoalsSignal.value) {
			const linked: NeoTask[] = [];
			for (const taskId of goal.linkedTaskIds) {
				const task = taskMap.get(taskId);
				if (task) linked.push(task);
			}
			result.set(goal.id, linked);
		}
		return result;
	});

	mockOrphanTasks = computed(() => {
		const linkedIds = new Set<string>();
		for (const goal of mockGoalsSignal.value) {
			for (const taskId of goal.linkedTaskIds) linkedIds.add(taskId);
		}
		return mockTasksSignal.value.filter((t) => !linkedIds.has(t.id));
	});

	mockOrphanTasksActive = computed(() =>
		mockOrphanTasks.value.filter(
			(t) => t.status === 'draft' || t.status === 'pending' || t.status === 'in_progress'
		)
	);

	mockOrphanTasksReview = computed(() =>
		mockOrphanTasks.value.filter((t) => t.status === 'review' || t.status === 'needs_attention')
	);

	mockOrphanTasksDone = computed(() =>
		mockOrphanTasks.value.filter((t) => t.status === 'completed' || t.status === 'cancelled')
	);
}

initSignals();

vi.mock('../../lib/room-store.ts', () => ({
	get roomStore() {
		return {
			tasks: mockTasksSignal,
			sessions: mockSessionsSignal,
			activeGoals: mockActiveGoals,
			tasksByGoalId: mockTasksByGoalId,
			orphanTasksActive: mockOrphanTasksActive,
			orphanTasksReview: mockOrphanTasksReview,
			orphanTasksDone: mockOrphanTasksDone,
			createSession: mockCreateSession,
		};
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToRoom: mockNavigateToRoom,
	navigateToRoomAgent: mockNavigateToRoomAgent,
	navigateToRoomSession: mockNavigateToRoomSession,
	navigateToRoomTask: mockNavigateToRoomTask,
}));

vi.mock('../../lib/signals.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/signals.ts')>();
	return {
		...actual,
		get currentRoomSessionIdSignal() {
			return mockCurrentRoomSessionIdSignal;
		},
		get currentRoomTaskIdSignal() {
			return mockCurrentRoomTaskIdSignal;
		},
	};
});

import { RoomContextPanel } from '../RoomContextPanel';

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeTask(id: string, title: string, status: NeoTask['status'] = 'pending'): NeoTask {
	return { id, title, status, priority: 'normal', dependsOn: [] } as unknown as NeoTask;
}

function makeGoal(
	id: string,
	title: string,
	linkedTaskIds: string[] = [],
	status: RoomGoal['status'] = 'active'
): RoomGoal {
	return {
		id,
		title,
		status,
		priority: 'medium',
		linkedTaskIds,
		progress: 0,
	} as unknown as RoomGoal;
}

function makeSession(
	id: string,
	title: string,
	status = 'idle',
	lastActiveAt?: number
): SessionSummary {
	return { id, title, status, lastActiveAt: lastActiveAt ?? 0 };
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('RoomContextPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		initSignals();
		// Restore default resolved value after clearAllMocks (which clears call history
		// but not implementations). Required so reordering tests doesn't break the
		// success path after any test that overrides with mockRejectedValue.
		mockCreateSession.mockResolvedValue('new-session-id');
	});

	afterEach(() => {
		cleanup();
	});

	// -- Layout --

	it('does not render a back button', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.queryByText('All Rooms')).toBeNull();
	});

	it('renders task stats strip', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'T1', 'pending'),
			makeTask('t2', 'T2', 'in_progress'),
			makeTask('t3', 'T3', 'pending'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('2 pending')).toBeTruthy();
		expect(screen.getByText('1 active')).toBeTruthy();
	});

	it('renders "No tasks" when there are no tasks', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('No tasks')).toBeTruthy();
	});

	// -- Pinned items --

	it('renders Dashboard and Room Agent buttons', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Dashboard')).toBeTruthy();
		expect(screen.getByText('Room Agent')).toBeTruthy();
	});

	it('navigates to room dashboard and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Dashboard'));
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('navigates to room agent and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Room Agent'));
		expect(mockNavigateToRoomAgent).toHaveBeenCalledWith('room-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	// -- isDashboardSelected --

	it('highlights Dashboard only when both session and task signals are null', () => {
		mockCurrentRoomSessionIdSignal.value = null;
		mockCurrentRoomTaskIdSignal.value = null;
		render(<RoomContextPanel roomId="room-1" />);
		const dashboardBtn = screen.getByText('Dashboard').closest('button');
		expect(dashboardBtn?.className).toContain('bg-dark-700');
	});

	it('does NOT highlight Dashboard when a task is selected', () => {
		mockCurrentRoomSessionIdSignal.value = null;
		mockCurrentRoomTaskIdSignal.value = 'task-1';
		render(<RoomContextPanel roomId="room-1" />);
		const dashboardBtn = screen.getByText('Dashboard').closest('button');
		expect(dashboardBtn?.className).not.toContain('bg-dark-700');
	});

	it('does NOT highlight Dashboard when a session is selected', () => {
		mockCurrentRoomSessionIdSignal.value = 'some-session';
		mockCurrentRoomTaskIdSignal.value = null;
		render(<RoomContextPanel roomId="room-1" />);
		const dashboardBtn = screen.getByText('Dashboard').closest('button');
		expect(dashboardBtn?.className).not.toContain('bg-dark-700');
	});

	it('highlights Room Agent when its synthetic session ID is selected', () => {
		mockCurrentRoomSessionIdSignal.value = 'room:chat:room-1';
		render(<RoomContextPanel roomId="room-1" />);
		const agentBtn = screen.getByText('Room Agent').closest('button');
		expect(agentBtn?.className).toContain('bg-dark-700');
	});

	// -- Goals section --

	it('renders Goals section with count of active goals only', () => {
		mockGoalsSignal.value = [
			makeGoal('g1', 'Goal 1'),
			makeGoal('g2', 'Goal 2'),
			makeGoal('g3', 'Archived Goal', [], 'archived'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Goals')).toBeTruthy();
		// Count matches active goals (excludes archived)
		expect(screen.getByText('(2)')).toBeTruthy();
	});

	it('does not render archived goals in the list', () => {
		mockGoalsSignal.value = [
			makeGoal('g1', 'Active Goal'),
			makeGoal('g2', 'Archived Goal', [], 'archived'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Active Goal')).toBeTruthy();
		expect(screen.queryByText('Archived Goal')).toBeNull();
	});

	it('expands a goal to show linked tasks on click', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Task A', 'pending'),
			makeTask('t2', 'Task B', 'in_progress'),
		];
		mockGoalsSignal.value = [makeGoal('g1', 'My Goal', ['t1', 't2'])];
		render(<RoomContextPanel roomId="room-1" />);

		// Tasks not visible initially
		expect(screen.queryByText('Task A')).toBeNull();

		// Click the goal to expand
		fireEvent.click(screen.getByText('My Goal'));
		expect(screen.getByText('Task A')).toBeTruthy();
		expect(screen.getByText('Task B')).toBeTruthy();
	});

	it('collapses an expanded goal on second click', () => {
		mockTasksSignal.value = [makeTask('t1', 'Task A')];
		mockGoalsSignal.value = [makeGoal('g1', 'My Goal', ['t1'])];
		render(<RoomContextPanel roomId="room-1" />);

		// Expand
		fireEvent.click(screen.getByText('My Goal'));
		expect(screen.getByText('Task A')).toBeTruthy();

		// Collapse
		fireEvent.click(screen.getByText('My Goal'));
		expect(screen.queryByText('Task A')).toBeNull();
	});

	it('navigates to task when clicking a linked task and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockTasksSignal.value = [makeTask('t1', 'Linked Task')];
		mockGoalsSignal.value = [makeGoal('g1', 'My Goal', ['t1'])];
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('My Goal'));
		fireEvent.click(screen.getByText('Linked Task'));

		expect(mockNavigateToRoomTask).toHaveBeenCalledWith('room-1', 't1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights selected task inside an expanded goal', () => {
		mockTasksSignal.value = [makeTask('t1', 'Linked Task', 'in_progress')];
		mockGoalsSignal.value = [makeGoal('g1', 'My Goal', ['t1'])];
		mockCurrentRoomTaskIdSignal.value = 't1';
		render(<RoomContextPanel roomId="room-1" />);

		// Expand goal to reveal linked task
		fireEvent.click(screen.getByText('My Goal'));
		const taskBtn = screen.getByText('Linked Task').closest('button');
		expect(taskBtn?.className).toContain('bg-dark-700');
	});

	it('shows "No goals" when goal list is empty', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('No goals')).toBeTruthy();
	});

	// -- Tasks section (orphan tasks) --

	it('shows orphan tasks under Active tab by default', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Orphan Active', 'in_progress'),
			makeTask('t2', 'Orphan Done', 'completed'),
		];
		// No goals, so all tasks are orphan
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Orphan Active')).toBeTruthy();
		expect(screen.queryByText('Orphan Done')).toBeNull();
	});

	it('shows draft and pending tasks under Active tab', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Draft Task', 'draft'),
			makeTask('t2', 'Pending Task', 'pending'),
			makeTask('t3', 'Done Task', 'completed'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		// draft and pending should appear under Active tab (default)
		expect(screen.getByText('Draft Task')).toBeTruthy();
		expect(screen.getByText('Pending Task')).toBeTruthy();
		expect(screen.queryByText('Done Task')).toBeNull();
	});

	it('switches to Review tab to show review orphan tasks', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Active Task', 'in_progress'),
			makeTask('t2', 'Review Task', 'review'),
		];
		render(<RoomContextPanel roomId="room-1" />);

		// Click review tab (find by role since there are multiple "review" texts)
		const reviewTab = screen.getAllByRole('button').find((b) => b.textContent === 'review');
		fireEvent.click(reviewTab!);

		expect(screen.getByText('Review Task')).toBeTruthy();
		expect(screen.queryByText('Active Task')).toBeNull();
	});

	it('switches to Done tab to show completed/cancelled orphan tasks', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Active Task', 'in_progress'),
			makeTask('t2', 'Done Task', 'completed'),
			makeTask('t3', 'Cancelled Task', 'cancelled'),
		];
		render(<RoomContextPanel roomId="room-1" />);

		const doneTab = screen.getAllByRole('button').find((b) => b.textContent === 'done');
		fireEvent.click(doneTab!);

		expect(screen.getByText('Done Task')).toBeTruthy();
		expect(screen.getByText('Cancelled Task')).toBeTruthy();
		expect(screen.queryByText('Active Task')).toBeNull();
	});

	it('archived orphan tasks do not appear in any tab', () => {
		mockTasksSignal.value = [makeTask('t1', 'Archived Task', 'archived')];
		render(<RoomContextPanel roomId="room-1" />);

		// Not in Active tab (default)
		expect(screen.queryByText('Archived Task')).toBeNull();

		// Not in Review tab
		const reviewTab = screen.getAllByRole('button').find((b) => b.textContent === 'review');
		fireEvent.click(reviewTab!);
		expect(screen.queryByText('Archived Task')).toBeNull();

		// Not in Done tab
		const doneTab = screen.getAllByRole('button').find((b) => b.textContent === 'done');
		fireEvent.click(doneTab!);
		expect(screen.queryByText('Archived Task')).toBeNull();
	});

	it('shows "No orphan tasks" when filtered list is empty', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('No orphan tasks')).toBeTruthy();
	});

	it('navigates to orphan task on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockTasksSignal.value = [makeTask('t1', 'Click Me', 'pending')];
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('Click Me'));
		expect(mockNavigateToRoomTask).toHaveBeenCalledWith('room-1', 't1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights selected task in orphan tasks list', () => {
		mockTasksSignal.value = [makeTask('t1', 'Selected Task', 'pending')];
		mockCurrentRoomTaskIdSignal.value = 't1';
		render(<RoomContextPanel roomId="room-1" />);

		const taskBtn = screen.getByText('Selected Task').closest('button');
		expect(taskBtn?.className).toContain('bg-dark-700');
	});

	// -- Sessions section --

	it('renders Sessions section collapsed by default', () => {
		mockSessionsSignal.value = [makeSession('s1', 'Session 1')];
		render(<RoomContextPanel roomId="room-1" />);

		// The section header should show Sessions with count
		expect(screen.getByText('Sessions')).toBeTruthy();
		// But session content should not be visible (collapsed)
		expect(screen.queryByText('Session 1')).toBeNull();
	});

	it('renders Sessions section count badge excluding archived sessions', () => {
		mockSessionsSignal.value = [
			makeSession('s1', 'Active Session A', 'idle'),
			makeSession('s2', 'Archived Session', 'archived'),
			makeSession('s3', 'Active Session B', 'idle'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		// Count badge reflects only non-archived sessions (2, not 3)
		expect(screen.getByText('(2)')).toBeTruthy();
	});

	it('expands Sessions section when header is clicked', () => {
		mockSessionsSignal.value = [makeSession('s1', 'Session 1')];
		render(<RoomContextPanel roomId="room-1" />);

		// Click the Sessions header to expand
		const sessionsHeader = screen.getByLabelText('Sessions section');
		fireEvent.click(sessionsHeader);

		expect(screen.getByText('Session 1')).toBeTruthy();
	});

	it('creates a session via the [+] button, navigates to it, and calls onNavigate', async () => {
		const onNavigate = vi.fn();
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);

		const createBtn = screen.getByLabelText('Create session');
		fireEvent.click(createBtn);

		await vi.waitFor(() => {
			expect(mockCreateSession).toHaveBeenCalledOnce();
		});
		expect(mockCreateSession).toHaveBeenCalledWith();
		expect(mockNavigateToRoomSession).toHaveBeenCalledWith('room-1', 'new-session-id');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('shows toast and does not navigate when createSession fails', async () => {
		mockCreateSession.mockRejectedValue(new Error('not connected'));
		render(<RoomContextPanel roomId="room-1" />);

		const createBtn = screen.getByLabelText('Create session');
		fireEvent.click(createBtn);

		await vi.waitFor(() => {
			expect(mockToast).toHaveBeenCalledWith('Failed to create session');
		});
		expect(mockNavigateToRoomSession).not.toHaveBeenCalled();
	});

	it('navigates to session on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockSessionsSignal.value = [makeSession('s1', 'My Session')];
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);

		// Expand sessions
		fireEvent.click(screen.getByLabelText('Sessions section'));
		fireEvent.click(screen.getByText('My Session'));

		expect(mockNavigateToRoomSession).toHaveBeenCalledWith('room-1', 's1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights selected session', () => {
		mockSessionsSignal.value = [makeSession('s1', 'My Session')];
		mockCurrentRoomSessionIdSignal.value = 's1';
		render(<RoomContextPanel roomId="room-1" />);

		// Expand sessions
		fireEvent.click(screen.getByLabelText('Sessions section'));
		const sessionBtn = screen.getByText('My Session').closest('button');
		expect(sessionBtn?.className).toContain('bg-dark-700');
	});

	it('filters out archived sessions by default', () => {
		mockSessionsSignal.value = [
			makeSession('s1', 'Active Session', 'idle'),
			makeSession('s2', 'Archived Session', 'archived'),
		];
		render(<RoomContextPanel roomId="room-1" />);

		// Expand sessions
		fireEvent.click(screen.getByLabelText('Sessions section'));
		expect(screen.getByText('Active Session')).toBeTruthy();
		expect(screen.queryByText('Archived Session')).toBeNull();
	});

	it('shows archived sessions when toggle is clicked', () => {
		mockSessionsSignal.value = [
			makeSession('s1', 'Active Session', 'idle'),
			makeSession('s2', 'Archived Session', 'archived'),
		];
		render(<RoomContextPanel roomId="room-1" />);

		// Expand sessions
		fireEvent.click(screen.getByLabelText('Sessions section'));
		fireEvent.click(screen.getByText('Show archived'));
		expect(screen.getByText('Archived Session')).toBeTruthy();
	});
});
