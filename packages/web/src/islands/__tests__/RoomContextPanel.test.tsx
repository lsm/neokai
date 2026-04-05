/**
 * Tests for RoomContextPanel — navigation sidebar for a room.
 *
 * Covers: pinned items (Overview, Chat), missions section (pure navigation),
 * sessions section with create button, selection highlighting, and onNavigate calls.
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
	mockToast,
} = vi.hoisted(() => ({
	mockCreateSession: vi.fn().mockResolvedValue('new-session-id'),
	mockNavigateToRoomSession: vi.fn(),
	mockNavigateToRoom: vi.fn(),
	mockNavigateToRoomAgent: vi.fn(),
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
let mockCurrentRoomAgentActiveSignal!: Signal<boolean>;
let mockCurrentRoomTabSignal!: Signal<string | null>;

let mockActiveGoals!: ReadonlySignal<RoomGoal[]>;

function initSignals() {
	mockTasksSignal = signal([]);
	mockSessionsSignal = signal([]);
	mockGoalsSignal = signal([]);
	mockCurrentRoomSessionIdSignal = signal(null);
	mockCurrentRoomTaskIdSignal = signal(null);
	mockCurrentRoomAgentActiveSignal = signal(false);
	mockCurrentRoomTabSignal = signal(null);

	mockActiveGoals = computed(() => mockGoalsSignal.value.filter((g) => g.status === 'active'));
}

initSignals();

vi.mock('../../lib/room-store.ts', () => ({
	get roomStore() {
		return {
			tasks: mockTasksSignal,
			sessions: mockSessionsSignal,
			activeGoals: mockActiveGoals,
			createSession: mockCreateSession,
		};
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToRoom: mockNavigateToRoom,
	navigateToRoomAgent: mockNavigateToRoomAgent,
	navigateToRoomSession: mockNavigateToRoomSession,
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
		get currentRoomAgentActiveSignal() {
			return mockCurrentRoomAgentActiveSignal;
		},
		get currentRoomTabSignal() {
			return mockCurrentRoomTabSignal;
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
		mockCreateSession.mockResolvedValue('new-session-id');
	});

	afterEach(() => {
		cleanup();
	});

	// -- Task stats strip --

	it('renders task stats strip with counts', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'T1', 'pending'),
			makeTask('t2', 'T2', 'in_progress'),
			makeTask('t3', 'T3', 'review'),
		];
		const { container } = render(<RoomContextPanel roomId="room-1" />);
		expect(container.textContent).toContain('2 active');
		expect(container.textContent).toContain('1 review');
	});

	it('renders "No tasks" when there are no tasks', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('No tasks')).toBeTruthy();
	});

	it('stats strip navigates to Tasks tab on click', () => {
		mockTasksSignal.value = [makeTask('t1', 'T1', 'pending')];
		render(<RoomContextPanel roomId="room-1" />);

		const statsBtn = screen.getByText('1 active').closest('button');
		fireEvent.click(statsBtn!);
		expect(mockCurrentRoomTabSignal.value).toBe('tasks');
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
	});

	// -- Pinned items --

	it('renders Overview and Chat buttons', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Overview')).toBeTruthy();
		expect(screen.getByText('Coordinator')).toBeTruthy();
	});

	it('navigates to room on Overview click', () => {
		const onNavigate = vi.fn();
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Overview'));
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('navigates to room agent on Chat click', () => {
		const onNavigate = vi.fn();
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Coordinator'));
		expect(mockNavigateToRoomAgent).toHaveBeenCalledWith('room-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	// -- Selection highlighting --

	it('highlights Overview when no session, task, or agent is active', () => {
		render(<RoomContextPanel roomId="room-1" />);
		const overviewBtn = screen.getByText('Overview').closest('button');
		expect(overviewBtn?.className).toContain('bg-dark-700');
	});

	it('does NOT highlight Overview when a task is selected', () => {
		mockCurrentRoomTaskIdSignal.value = 'task-1';
		render(<RoomContextPanel roomId="room-1" />);
		const overviewBtn = screen.getByText('Overview').closest('button');
		expect(overviewBtn?.className).not.toContain('bg-dark-700');
	});

	it('does NOT highlight Overview when a session is selected', () => {
		mockCurrentRoomSessionIdSignal.value = 'some-session';
		render(<RoomContextPanel roomId="room-1" />);
		const overviewBtn = screen.getByText('Overview').closest('button');
		expect(overviewBtn?.className).not.toContain('bg-dark-700');
	});

	it('highlights Chat when agent signal is active', () => {
		mockCurrentRoomAgentActiveSignal.value = true;
		render(<RoomContextPanel roomId="room-1" />);
		const chatBtn = screen.getByText('Coordinator').closest('button');
		expect(chatBtn?.className).toContain('bg-dark-700');
	});

	it('does NOT highlight Overview when agent is active', () => {
		mockCurrentRoomAgentActiveSignal.value = true;
		render(<RoomContextPanel roomId="room-1" />);
		const overviewBtn = screen.getByText('Overview').closest('button');
		expect(overviewBtn?.className).not.toContain('bg-dark-700');
	});

	// -- Missions section --

	it('renders Missions section with active goals count', () => {
		mockGoalsSignal.value = [
			makeGoal('g1', 'Goal 1'),
			makeGoal('g2', 'Goal 2'),
			makeGoal('g3', 'Archived Goal', [], 'archived'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Missions')).toBeTruthy();
		expect(screen.getByText('(2)')).toBeTruthy();
	});

	it('does not render archived goals', () => {
		mockGoalsSignal.value = [
			makeGoal('g1', 'Active Goal'),
			makeGoal('g2', 'Archived Goal', [], 'archived'),
		];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Active Goal')).toBeTruthy();
		expect(screen.queryByText('Archived Goal')).toBeNull();
	});

	it('clicking a mission navigates to Missions tab', () => {
		const onNavigate = vi.fn();
		mockGoalsSignal.value = [makeGoal('g1', 'My Mission')];
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('My Mission'));
		expect(mockCurrentRoomTabSignal.value).toBe('goals');
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('shows "No missions" when empty', () => {
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('No missions')).toBeTruthy();
	});

	// -- Sessions section --

	it('renders Sessions section collapsed by default', () => {
		mockSessionsSignal.value = [makeSession('s1', 'Session 1')];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('Sessions')).toBeTruthy();
		expect(screen.queryByText('Session 1')).toBeNull();
	});

	it('expands Sessions section when header is clicked', () => {
		mockSessionsSignal.value = [makeSession('s1', 'Session 1')];
		render(<RoomContextPanel roomId="room-1" />);
		fireEvent.click(screen.getByLabelText('Sessions section'));
		expect(screen.getByText('Session 1')).toBeTruthy();
	});

	it('creates a session via [+] button and navigates', async () => {
		const onNavigate = vi.fn();
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByLabelText('Create session'));

		await vi.waitFor(() => {
			expect(mockCreateSession).toHaveBeenCalledOnce();
		});
		expect(mockNavigateToRoomSession).toHaveBeenCalledWith('room-1', 'new-session-id');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('shows toast when createSession fails', async () => {
		mockCreateSession.mockRejectedValue(new Error('not connected'));
		render(<RoomContextPanel roomId="room-1" />);
		fireEvent.click(screen.getByLabelText('Create session'));

		await vi.waitFor(() => {
			expect(mockToast).toHaveBeenCalledWith('Failed to create session');
		});
		expect(mockNavigateToRoomSession).not.toHaveBeenCalled();
	});

	it('navigates to session on click', () => {
		const onNavigate = vi.fn();
		mockSessionsSignal.value = [makeSession('s1', 'My Session')];
		render(<RoomContextPanel roomId="room-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByLabelText('Sessions section'));
		fireEvent.click(screen.getByText('My Session'));
		expect(mockNavigateToRoomSession).toHaveBeenCalledWith('room-1', 's1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights selected session', () => {
		mockSessionsSignal.value = [makeSession('s1', 'My Session')];
		mockCurrentRoomSessionIdSignal.value = 's1';
		render(<RoomContextPanel roomId="room-1" />);
		fireEvent.click(screen.getByLabelText('Sessions section'));
		const sessionBtn = screen.getByText('My Session').closest('button');
		expect(sessionBtn?.className).toContain('bg-dark-700');
	});

	it('renders session count badge', () => {
		mockSessionsSignal.value = [makeSession('s1', 'Session A'), makeSession('s2', 'Session B')];
		render(<RoomContextPanel roomId="room-1" />);
		expect(screen.getByText('(2)')).toBeTruthy();
	});
});
