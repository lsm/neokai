/**
 * Tests for TaskHeader Component
 *
 * Covers:
 * - Renders task title and status badge
 * - Renders tags: task type, PR link, mission badge
 * - Renders progress indicator (arc only, no percentage) when task.progress > 0
 * - Renders gear button
 * - Larger tap targets on mobile (min-w/min-h for gear)
 * - data-testid="task-header" on root
 * - data-testid="task-status-badge" on status
 * - data-testid="task-view-goal-badge" on mission badge
 * - data-testid="task-info-panel-trigger" on gear button
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskHeader } from '../TaskHeader';
import type { TaskHeaderProps } from '../TaskHeader';
import type { NeoTask, RoomGoal } from '@neokai/shared';

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
	CircularProgressIndicator: (props: {
		progress: number;
		size?: number;
		showPercentage?: boolean;
		title?: string;
	}) => (
		<div
			data-testid="circular-progress"
			data-progress={props.progress}
			data-size={props.size}
			data-show-percentage={String(props.showPercentage)}
			title={props.title}
		/>
	),
}));

vi.mock('./TaskHeaderActions', () => ({
	TaskHeaderActions: (props: {
		canReactivate: boolean;
		reactivating: boolean;
		onReactivate: () => void;
		isInfoPanelOpen: boolean;
		onToggleInfoPanel: () => void;
	}) => (
		<div>
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
		associatedGoal: null,
		canReactivate: false,
		reactivating: false,
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

	// --- Progress indicator removed from header (shown in task list / info panel instead) ---

	it('does not render circular progress indicator in header', () => {
		const { queryByTestId } = render(
			<TaskHeader {...defaultProps({ task: makeTask({ progress: 65 }) })} />
		);
		expect(queryByTestId('circular-progress')).toBeNull();
	});

	// --- Action buttons ---

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

	// --- No stop button in header ---

	it('does not render stop button in header', () => {
		const { queryByTestId } = render(<TaskHeader {...defaultProps()} />);
		expect(queryByTestId('task-stop-button')).toBeNull();
	});

	// --- No iteration count in header ---

	it('does not render iteration count in header', () => {
		const { container } = render(<TaskHeader {...defaultProps()} />);
		expect(container.textContent).not.toContain('iteration 3');
	});

	// --- No "Awaiting your review" badge in header ---

	it('does not render "Awaiting your review" badge in header', () => {
		const { container } = render(
			<TaskHeader
				{...defaultProps({
					task: makeTask({ status: 'review', activeSession: undefined }),
				})}
			/>
		);
		expect(container.textContent).not.toContain('Awaiting your review');
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
		const { container } = render(<TaskHeader {...defaultProps()} />);
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

	// --- Desktop layout: tags row has no top margin on sm+ ---

	it('tags row has mt-1.5 on mobile and sm:mt-0 on desktop', () => {
		const { container } = render(<TaskHeader {...defaultProps()} />);
		const tagsRow = container.querySelector('.mt-1\\.5');
		expect(tagsRow).toBeTruthy();
		expect(tagsRow!.className).toContain('sm:mt-0');
	});

	it('tags row uses a flex spacer (w-7) for desktop alignment, hidden on mobile', () => {
		const { container } = render(<TaskHeader {...defaultProps()} />);
		const spacer = container.querySelector('.hidden');
		expect(spacer).toBeTruthy();
		expect(spacer!.className).toContain('sm:block');
		expect(spacer!.className).toContain('w-7');
	});

	// --- PR fallback edge cases ---

	it('renders "PR #?" when prUrl is set but prNumber is null', () => {
		const { container } = render(
			<TaskHeader
				{...defaultProps({
					task: makeTask({ prUrl: 'https://github.com/org/repo/pull/42', prNumber: null }),
				})}
			/>
		);
		expect(container.textContent).toContain('PR #?');
	});

	it('renders "PR #?" when prUrl is set but prNumber is undefined', () => {
		const { container } = render(
			<TaskHeader
				{...defaultProps({
					task: makeTask({ prUrl: 'https://github.com/org/repo/pull/42', prNumber: undefined }),
				})}
			/>
		);
		expect(container.textContent).toContain('PR #?');
	});
});
