/**
 * Tests for TaskHeader Component
 *
 * Covers:
 * - Renders task title and status badge
 * - Renders tags: task type, PR link, mission badge
 * - Renders iteration count and review indicators
 * - Renders progress indicator when task.progress > 0
 * - Renders gear button and stop button
 * - Larger tap targets on mobile (min-w/min-h for stop and gear)
 * - data-testid="task-header" on root
 * - data-testid="task-status-badge" on status
 * - data-testid="task-view-goal-badge" on mission badge
 * - data-testid="task-stop-button" when canInterrupt
 * - data-testid="task-info-panel-trigger" on gear button
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskHeader } from '../TaskHeader';
import type { TaskHeaderProps } from '../TaskHeader';
import type { NeoTask, RoomGoal } from '@neokai/shared';
import type { TaskGroupInfo } from '../../../../hooks/useTaskViewData';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockNavigateToRoom, mockCurrentRoomTabSignal } = vi.hoisted(() => ({
	mockNavigateToRoom: vi.fn(),
	mockCurrentRoomTabSignal: { value: 'chat' },
}));

vi.mock('../../../../lib/router.ts', () => ({
	get navigateToRoom() {
		return mockNavigateToRoom;
	},
	get navigateToRoomTask() {
		return vi.fn();
	},
}));

vi.mock('../../../../lib/signals.ts', () => ({
	currentRoomTabSignal: mockCurrentRoomTabSignal,
}));

vi.mock('../../../ui/CircularProgressIndicator.tsx', () => ({
	CircularProgressIndicator: (props: { progress: number; size?: number; title?: string }) => (
		<div
			data-testid="circular-progress"
			data-progress={props.progress}
			data-size={props.size}
			title={props.title}
		/>
	),
}));

vi.mock('./TaskHeaderActions', () => ({
	TaskHeaderActions: (props: {
		canInterrupt: boolean;
		interrupting: boolean;
		onInterrupt: () => void;
		canReactivate: boolean;
		reactivating: boolean;
		onReactivate: () => void;
		isInfoPanelOpen: boolean;
		onToggleInfoPanel: () => void;
	}) => (
		<div>
			<button data-testid="task-stop-button">Stop</button>
			<button data-testid="task-info-panel-trigger" onClick={props.onToggleInfoPanel}>
				Gear
			</button>
		</div>
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

function makeGroup(overrides: Partial<TaskGroupInfo> = {}): TaskGroupInfo {
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

function makeGoal(overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Test Mission',
		status: 'active',
		priority: 'medium',
		createdAt: Date.now(),
		...overrides,
	} as RoomGoal;
}

function defaultProps(overrides: Partial<TaskHeaderProps> = {}): TaskHeaderProps {
	return {
		roomId: 'room-1',
		task: makeTask(),
		group: makeGroup(),
		associatedGoal: null,
		canInterrupt: true,
		interrupting: false,
		canReactivate: false,
		reactivating: false,
		interruptSession: vi.fn(),
		reactivateTask: vi.fn(),
		isInfoPanelOpen: false,
		onToggleInfoPanel: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskHeader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders data-testid="task-header" on root container', () => {
		const { getByTestId } = render(<TaskHeader {...defaultProps()} />);
		expect(getByTestId('task-header')).toBeTruthy();
	});

	it('renders task title', () => {
		const { container } = render(<TaskHeader {...defaultProps()} />);
		expect(container.textContent).toContain('Test Task');
	});

	it('renders status badge', () => {
		const { getByTestId } = render(<TaskHeader {...defaultProps()} />);
		expect(getByTestId('task-status-badge').textContent).toContain('in progress');
	});

	// --- Tags ---

	it('renders task type badge when task.taskType is set', () => {
		const { container } = render(
			<TaskHeader {...defaultProps({ task: makeTask({ taskType: 'coding' }) })} />
		);
		expect(container.textContent).toContain('coding');
	});

	it('renders PR link when task.prUrl is set', () => {
		const { container } = render(
			<TaskHeader
				{...defaultProps({
					task: makeTask({ prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 }),
				})}
			/>
		);
		expect(container.textContent).toContain('PR #42');
		expect(container.querySelector('a[href="https://github.com/org/repo/pull/42"]')).toBeTruthy();
	});

	it('renders mission badge when associatedGoal is set', () => {
		const goal = makeGoal({ title: 'Build feature X' });
		const { getByTestId, container } = render(
			<TaskHeader {...defaultProps({ associatedGoal: goal })} />
		);
		expect(getByTestId('task-view-goal-badge')).toBeTruthy();
		expect(container.textContent).toContain('Build feature X');
	});

	it('navigates to room when mission badge is clicked', () => {
		const goal = makeGoal();
		const { getByTestId } = render(<TaskHeader {...defaultProps({ associatedGoal: goal })} />);
		fireEvent.click(getByTestId('task-view-goal-badge'));
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
	});

	// --- Sub-line info ---

	it('renders iteration count when feedbackIteration > 0', () => {
		const { container } = render(
			<TaskHeader {...defaultProps({ group: makeGroup({ feedbackIteration: 3 }) })} />
		);
		expect(container.textContent).toContain('iteration 3');
	});

	it('renders "Awaiting your review" when group.submittedForReview and no active session', () => {
		const { container } = render(
			<TaskHeader
				{...defaultProps({
					task: makeTask({ status: 'review', activeSession: undefined }),
					group: makeGroup({ submittedForReview: true }),
				})}
			/>
		);
		expect(container.textContent).toContain('Awaiting your review');
	});

	it('renders "Worker processing" when task is review and has active worker session', () => {
		const { container } = render(
			<TaskHeader
				{...defaultProps({
					task: makeTask({ status: 'review', activeSession: 'worker' as unknown as undefined }),
					group: makeGroup(),
				})}
			/>
		);
		expect(container.textContent).toContain('Worker processing your message');
	});

	// --- Progress indicator ---

	it('renders circular progress when task.progress > 0', () => {
		const { getByTestId } = render(
			<TaskHeader {...defaultProps({ task: makeTask({ progress: 65 }) })} />
		);
		expect(getByTestId('circular-progress')).toBeTruthy();
		expect(getByTestId('circular-progress').getAttribute('data-progress')).toBe('65');
	});

	it('does not render circular progress when task.progress is null', () => {
		const { queryByTestId } = render(
			<TaskHeader {...defaultProps({ task: makeTask({ progress: undefined }) })} />
		);
		expect(queryByTestId('circular-progress')).toBeNull();
	});

	it('does not render circular progress when task.progress is 0', () => {
		const { queryByTestId } = render(
			<TaskHeader {...defaultProps({ task: makeTask({ progress: 0 }) })} />
		);
		expect(queryByTestId('circular-progress')).toBeNull();
	});

	// --- Action buttons ---

	it('renders stop button', () => {
		const { getByTestId } = render(<TaskHeader {...defaultProps({ canInterrupt: true })} />);
		expect(getByTestId('task-stop-button')).toBeTruthy();
	});

	it('renders gear button', () => {
		const { getByTestId } = render(<TaskHeader {...defaultProps()} />);
		expect(getByTestId('task-info-panel-trigger')).toBeTruthy();
	});

	it('calls onToggleInfoPanel when gear is clicked', () => {
		const onToggle = vi.fn();
		const { getByTestId } = render(
			<TaskHeader {...defaultProps({ onToggleInfoPanel: onToggle })} />
		);
		fireEvent.click(getByTestId('task-info-panel-trigger'));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	// --- Back button ---

	it('navigates to room when back button is clicked', () => {
		const { container } = render(<TaskHeader {...defaultProps()} />);
		const backBtn = container.querySelector('button[title="Back to room"]');
		expect(backBtn).toBeTruthy();
		fireEvent.click(backBtn!);
		expect(mockNavigateToRoom).toHaveBeenCalledWith('room-1');
	});

	// --- No group ---

	it('renders without group (no sub-line info)', () => {
		const { container } = render(<TaskHeader {...defaultProps({ group: null })} />);
		expect(container.textContent).toContain('Test Task');
		expect(container.textContent).not.toContain('iteration');
	});

	// --- Mobile responsive classes ---

	it('has mobile-responsive padding (px-3 on mobile, px-4 on sm+)', () => {
		const { getByTestId } = render(<TaskHeader {...defaultProps()} />);
		const header = getByTestId('task-header');
		expect(header.className).toContain('px-3');
		expect(header.className).toContain('sm:px-4');
	});

	it('has responsive py (py-2.5 on mobile, py-3 on sm+)', () => {
		const { getByTestId } = render(<TaskHeader {...defaultProps()} />);
		const header = getByTestId('task-header');
		expect(header.className).toContain('py-2.5');
		expect(header.className).toContain('sm:py-3');
	});
});
