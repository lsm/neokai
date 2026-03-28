/**
 * Tests for SpaceDetailPanel component.
 *
 * Covers: stats strip counts, pinned item highlighting, workflow run expansion,
 * task tab filtering, click navigation, sessions section, and empty states.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal, computed, type Signal, type ReadonlySignal } from '@preact/signals';
import type { SpaceTask, SpaceWorkflowRun, Space } from '@neokai/shared';

// -------------------------------------------------------
// Hoisted mocks
// -------------------------------------------------------

const { mockNavigateToSpace, mockNavigateToSpaceSession, mockNavigateToSpaceTask } = vi.hoisted(
	() => ({
		mockNavigateToSpace: vi.fn(),
		mockNavigateToSpaceSession: vi.fn(),
		mockNavigateToSpaceTask: vi.fn(),
	})
);

// -------------------------------------------------------
// Signals used in mocks
// -------------------------------------------------------

let mockTasksSignal!: Signal<SpaceTask[]>;
let mockWorkflowRunsSignal!: Signal<SpaceWorkflowRun[]>;
let mockSpaceSignal!: Signal<Space | null>;
let mockLoadingSignal!: Signal<boolean>;
let mockSpaceIdSignal!: Signal<string | null>;
let mockCurrentSpaceSessionIdSignal!: Signal<string | null>;
let mockCurrentSpaceTaskIdSignal!: Signal<string | null>;

let mockActiveRuns!: ReadonlySignal<SpaceWorkflowRun[]>;
let mockTasksByRun!: ReadonlySignal<Map<string, SpaceTask[]>>;
let mockStandaloneTasks!: ReadonlySignal<SpaceTask[]>;

function initSignals() {
	mockTasksSignal = signal([]);
	mockWorkflowRunsSignal = signal([]);
	mockSpaceSignal = signal(null);
	// By default simulate loaded state: not loading, spaceId matches
	mockLoadingSignal = signal(false);
	mockSpaceIdSignal = signal('space-1');
	mockCurrentSpaceSessionIdSignal = signal(null);
	mockCurrentSpaceTaskIdSignal = signal(null);

	mockActiveRuns = computed(() =>
		mockWorkflowRunsSignal.value.filter((r) => r.status === 'pending' || r.status === 'in_progress')
	);

	mockTasksByRun = computed(() => {
		const map = new Map<string, SpaceTask[]>();
		for (const task of mockTasksSignal.value) {
			if (task.workflowRunId) {
				const existing = map.get(task.workflowRunId) ?? [];
				map.set(task.workflowRunId, [...existing, task]);
			}
		}
		return map;
	});

	mockStandaloneTasks = computed(() => mockTasksSignal.value.filter((t) => !t.workflowRunId));
}

initSignals();

vi.mock('../../lib/space-store.ts', () => ({
	get spaceStore() {
		return {
			tasks: mockTasksSignal,
			workflowRuns: mockWorkflowRunsSignal,
			space: mockSpaceSignal,
			loading: mockLoadingSignal,
			spaceId: mockSpaceIdSignal,
			activeRuns: mockActiveRuns,
			tasksByRun: mockTasksByRun,
			standaloneTasks: mockStandaloneTasks,
		};
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToSpace: mockNavigateToSpace,
	navigateToSpaceSession: mockNavigateToSpaceSession,
	navigateToSpaceTask: mockNavigateToSpaceTask,
}));

vi.mock('../../lib/signals.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/signals.ts')>();
	return {
		...actual,
		get currentSpaceSessionIdSignal() {
			return mockCurrentSpaceSessionIdSignal;
		},
		get currentSpaceTaskIdSignal() {
			return mockCurrentSpaceTaskIdSignal;
		},
	};
});

import { SpaceDetailPanel } from '../SpaceDetailPanel';

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeTask(
	id: string,
	title: string,
	status: SpaceTask['status'] = 'pending',
	overrides: Partial<SpaceTask> = {}
): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		title,
		status,
		priority: 'normal',
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as SpaceTask;
}

function makeRun(
	id: string,
	title: string,
	status: SpaceWorkflowRun['status'] = 'in_progress'
): SpaceWorkflowRun {
	return {
		id,
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title,
		status,
		iterationCount: 0,
		maxIterations: 10,
		createdAt: 0,
		updatedAt: 0,
	} as SpaceWorkflowRun;
}

function makeSpace(id: string, overrides: Partial<Space> = {}): Space {
	return {
		id,
		name: `Space ${id}`,
		status: 'active',
		workspacePath: '/workspace',
		sessionIds: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as unknown as Space;
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('SpaceDetailPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		initSignals();
	});

	afterEach(() => {
		cleanup();
	});

	// -- Loading guard --

	it('shows loading state when spaceStore is loading', () => {
		mockLoadingSignal.value = true;
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Loading…')).toBeTruthy();
		expect(screen.queryByText('Dashboard')).toBeNull();
	});

	it('shows loading state when store spaceId does not match prop', () => {
		mockLoadingSignal.value = false;
		mockSpaceIdSignal.value = 'other-space';
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Loading…')).toBeTruthy();
	});

	it('renders panel content when store is loaded for this space', () => {
		mockLoadingSignal.value = false;
		mockSpaceIdSignal.value = 'space-1';
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.queryByText('Loading…')).toBeNull();
		expect(screen.getByText('Dashboard')).toBeTruthy();
	});

	// -- Stats strip --

	it('renders "No tasks" in the stats strip when there are no tasks', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		// Both the stats strip and Tasks section show "No tasks" when there are no tasks
		const noTasksEls = screen.getAllByText('No tasks');
		expect(noTasksEls.length).toBeGreaterThanOrEqual(1);
	});

	it('counts active tasks (draft, pending, in_progress)', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'T1', 'draft'),
			makeTask('t2', 'T2', 'pending'),
			makeTask('t3', 'T3', 'in_progress'),
		];
		const { container } = render(<SpaceDetailPanel spaceId="space-1" />);
		expect(container.textContent).toContain('3 active');
	});

	it('counts rate_limited and usage_limited as active (transient throttle states)', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'T1', 'rate_limited'),
			makeTask('t2', 'T2', 'usage_limited'),
			makeTask('t3', 'T3', 'in_progress'),
		];
		const { container } = render(<SpaceDetailPanel spaceId="space-1" />);
		expect(container.textContent).toContain('3 active');
	});

	it('counts review tasks (review, needs_attention)', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'T1', 'review'),
			makeTask('t2', 'T2', 'needs_attention'),
		];
		const { container } = render(<SpaceDetailPanel spaceId="space-1" />);
		expect(container.textContent).toContain('2 review');
	});

	it('counts done tasks (completed, cancelled)', () => {
		mockTasksSignal.value = [makeTask('t1', 'T1', 'completed'), makeTask('t2', 'T2', 'cancelled')];
		const { container } = render(<SpaceDetailPanel spaceId="space-1" />);
		expect(container.textContent).toContain('2 done');
	});

	it('counts archived tasks as done', () => {
		mockTasksSignal.value = [makeTask('t1', 'T1', 'completed'), makeTask('t2', 'T2', 'archived')];
		const { container } = render(<SpaceDetailPanel spaceId="space-1" />);
		expect(container.textContent).toContain('2 done');
	});

	it('renders all three stats together', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'T1', 'in_progress'),
			makeTask('t2', 'T2', 'review'),
			makeTask('t3', 'T3', 'completed'),
		];
		const { container } = render(<SpaceDetailPanel spaceId="space-1" />);
		expect(container.textContent).toContain('1 active');
		expect(container.textContent).toContain('1 review');
		expect(container.textContent).toContain('1 done');
	});

	// -- Pinned items --

	it('renders Dashboard and Space Agent buttons', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Dashboard')).toBeTruthy();
		expect(screen.getByText('Space Agent')).toBeTruthy();
	});

	it('navigates to space dashboard and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Dashboard'));
		expect(mockNavigateToSpace).toHaveBeenCalledWith('space-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('navigates to space agent session and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Space Agent'));
		expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'space:chat:space-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	// -- Dashboard highlighting --

	it('highlights Dashboard when both session and task signals are null', () => {
		mockCurrentSpaceSessionIdSignal.value = null;
		mockCurrentSpaceTaskIdSignal.value = null;
		render(<SpaceDetailPanel spaceId="space-1" />);
		const dashboardBtn = screen.getByText('Dashboard').closest('button');
		expect(dashboardBtn?.className).toContain('bg-dark-700');
	});

	it('does NOT highlight Dashboard when a task is selected', () => {
		mockCurrentSpaceSessionIdSignal.value = null;
		mockCurrentSpaceTaskIdSignal.value = 'task-1';
		render(<SpaceDetailPanel spaceId="space-1" />);
		const dashboardBtn = screen.getByText('Dashboard').closest('button');
		expect(dashboardBtn?.className).not.toContain('bg-dark-700');
	});

	it('does NOT highlight Dashboard when a session is selected', () => {
		mockCurrentSpaceSessionIdSignal.value = 'some-session';
		mockCurrentSpaceTaskIdSignal.value = null;
		render(<SpaceDetailPanel spaceId="space-1" />);
		const dashboardBtn = screen.getByText('Dashboard').closest('button');
		expect(dashboardBtn?.className).not.toContain('bg-dark-700');
	});

	// -- Space Agent highlighting --

	it('highlights Space Agent when its synthetic session ID is selected', () => {
		mockCurrentSpaceSessionIdSignal.value = 'space:chat:space-1';
		render(<SpaceDetailPanel spaceId="space-1" />);
		const agentBtn = screen.getByText('Space Agent').closest('button');
		expect(agentBtn?.className).toContain('bg-dark-700');
	});

	it('does NOT highlight Space Agent when a different session is selected', () => {
		mockCurrentSpaceSessionIdSignal.value = 'some-other-session';
		render(<SpaceDetailPanel spaceId="space-1" />);
		const agentBtn = screen.getByText('Space Agent').closest('button');
		expect(agentBtn?.className).not.toContain('bg-dark-700');
	});

	// -- Workflow Runs section --

	it('shows "No active runs" when there are no active workflow runs', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('No active runs')).toBeTruthy();
	});

	it('renders active workflow runs with title', () => {
		mockWorkflowRunsSignal.value = [makeRun('r1', 'Deploy Run')];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Deploy Run')).toBeTruthy();
	});

	it('does not render completed workflow runs in the active runs section', () => {
		mockWorkflowRunsSignal.value = [
			makeRun('r1', 'Active Run', 'in_progress'),
			makeRun('r2', 'Done Run', 'completed'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Active Run')).toBeTruthy();
		expect(screen.queryByText('Done Run')).toBeNull();
	});

	it('expands a workflow run to show its tasks on click', () => {
		mockWorkflowRunsSignal.value = [makeRun('r1', 'My Run')];
		mockTasksSignal.value = [
			makeTask('t1', 'Run Task A', 'in_progress', { workflowRunId: 'r1' }),
			makeTask('t2', 'Run Task B', 'pending', { workflowRunId: 'r1' }),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		// Tasks not visible initially
		expect(screen.queryByText('Run Task A')).toBeNull();

		// Click the run to expand
		fireEvent.click(screen.getByText('My Run'));
		expect(screen.getByText('Run Task A')).toBeTruthy();
		expect(screen.getByText('Run Task B')).toBeTruthy();
	});

	it('collapses an expanded workflow run on second click', () => {
		mockWorkflowRunsSignal.value = [makeRun('r1', 'My Run')];
		mockTasksSignal.value = [makeTask('t1', 'Run Task', 'in_progress', { workflowRunId: 'r1' })];
		render(<SpaceDetailPanel spaceId="space-1" />);

		fireEvent.click(screen.getByText('My Run'));
		expect(screen.getByText('Run Task')).toBeTruthy();

		fireEvent.click(screen.getByText('My Run'));
		expect(screen.queryByText('Run Task')).toBeNull();
	});

	it('shows "No tasks" inside expanded run when run has no tasks', () => {
		mockWorkflowRunsSignal.value = [makeRun('r1', 'Empty Run')];
		render(<SpaceDetailPanel spaceId="space-1" />);
		fireEvent.click(screen.getByText('Empty Run'));
		// The "No tasks" text inside the run expansion
		expect(screen.getAllByText('No tasks').length).toBeGreaterThanOrEqual(1);
	});

	it('navigates to task when clicking a run task and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockWorkflowRunsSignal.value = [makeRun('r1', 'My Run')];
		mockTasksSignal.value = [makeTask('t1', 'Run Task', 'pending', { workflowRunId: 'r1' })];
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('My Run'));
		fireEvent.click(screen.getByText('Run Task'));

		expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 't1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights selected task inside an expanded run', () => {
		mockWorkflowRunsSignal.value = [makeRun('r1', 'My Run')];
		mockTasksSignal.value = [makeTask('t1', 'Run Task', 'in_progress', { workflowRunId: 'r1' })];
		mockCurrentSpaceTaskIdSignal.value = 't1';
		render(<SpaceDetailPanel spaceId="space-1" />);

		fireEvent.click(screen.getByText('My Run'));
		const taskBtn = screen.getByText('Run Task').closest('button');
		expect(taskBtn?.className).toContain('bg-dark-700');
	});

	// -- Tasks section (standalone tasks) --

	it('shows standalone tasks under Active tab by default', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Active Task', 'in_progress'),
			makeTask('t2', 'Done Task', 'completed'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Active Task')).toBeTruthy();
		expect(screen.queryByText('Done Task')).toBeNull();
	});

	it('does not show workflow-run tasks in standalone Tasks section', () => {
		mockWorkflowRunsSignal.value = [makeRun('r1', 'Run')];
		mockTasksSignal.value = [
			makeTask('t1', 'Run Task', 'in_progress', { workflowRunId: 'r1' }),
			makeTask('t2', 'Standalone Task', 'pending'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Standalone Task')).toBeTruthy();
		// Run Task only appears when the run is expanded
		expect(screen.queryByText('Run Task')).toBeNull();
	});

	it('shows draft and pending tasks under Active tab', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Draft Task', 'draft'),
			makeTask('t2', 'Pending Task', 'pending'),
			makeTask('t3', 'Done Task', 'completed'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Draft Task')).toBeTruthy();
		expect(screen.getByText('Pending Task')).toBeTruthy();
		expect(screen.queryByText('Done Task')).toBeNull();
	});

	it('switches to Review tab to show review tasks', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Active Task', 'in_progress'),
			makeTask('t2', 'Review Task', 'review'),
			makeTask('t3', 'Attention Task', 'needs_attention'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		const reviewTab = screen.getAllByRole('button').find((b) => b.textContent === 'review');
		fireEvent.click(reviewTab!);

		expect(screen.getByText('Review Task')).toBeTruthy();
		expect(screen.getByText('Attention Task')).toBeTruthy();
		expect(screen.queryByText('Active Task')).toBeNull();
	});

	it('switches to Done tab to show completed and cancelled tasks', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Active Task', 'in_progress'),
			makeTask('t2', 'Done Task', 'completed'),
			makeTask('t3', 'Cancelled Task', 'cancelled'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		const doneTab = screen.getAllByRole('button').find((b) => b.textContent === 'done');
		fireEvent.click(doneTab!);

		expect(screen.getByText('Done Task')).toBeTruthy();
		expect(screen.getByText('Cancelled Task')).toBeTruthy();
		expect(screen.queryByText('Active Task')).toBeNull();
	});

	it('shows rate_limited tasks under Active tab', () => {
		mockTasksSignal.value = [makeTask('t1', 'Throttled Task', 'rate_limited')];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Throttled Task')).toBeTruthy();
	});

	it('shows usage_limited tasks under Active tab', () => {
		mockTasksSignal.value = [makeTask('t1', 'Limited Task', 'usage_limited')];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Limited Task')).toBeTruthy();
	});

	it('shows archived tasks under Done tab', () => {
		mockTasksSignal.value = [makeTask('t1', 'Archived Task', 'archived')];
		render(<SpaceDetailPanel spaceId="space-1" />);

		const doneTab = screen.getAllByRole('button').find((b) => b.textContent === 'done');
		fireEvent.click(doneTab!);

		expect(screen.getByText('Archived Task')).toBeTruthy();
	});

	it('shows "No tasks" in Tasks section when filtered list is empty', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		// "No active runs" + "No tasks" (Tasks section)
		const noTasksEls = screen.getAllByText('No tasks');
		expect(noTasksEls.length).toBeGreaterThanOrEqual(1);
	});

	it('navigates to standalone task on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockTasksSignal.value = [makeTask('t1', 'Click Me', 'pending')];
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('Click Me'));
		expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 't1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights selected task in standalone tasks list', () => {
		mockTasksSignal.value = [makeTask('t1', 'Selected Task', 'pending')];
		mockCurrentSpaceTaskIdSignal.value = 't1';
		render(<SpaceDetailPanel spaceId="space-1" />);

		const taskBtn = screen.getByText('Selected Task').closest('button');
		expect(taskBtn?.className).toContain('bg-dark-700');
	});

	// -- Sessions section --

	it('renders Sessions section collapsed by default', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Sessions')).toBeTruthy();
		// Space Agent session is always listed but section is collapsed — content hidden
		expect(screen.queryByText('Space Agent (session)')).toBeNull();
	});

	it('always shows space agent session when expanded', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		fireEvent.click(screen.getByLabelText('Sessions section'));
		// "Space Agent" appears in pinned items and in sessions list
		const spaceAgentEls = screen.getAllByText('Space Agent');
		expect(spaceAgentEls.length).toBeGreaterThanOrEqual(2);
	});

	it('shows task agent sessions when tasks have taskAgentSessionId', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'My Task', 'in_progress', { taskAgentSessionId: 'agent-session-1' }),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);
		fireEvent.click(screen.getByLabelText('Sessions section'));
		expect(screen.getByText('My Task (agent)')).toBeTruthy();
	});

	it('shows manually created sessions from space.sessionIds', () => {
		mockSpaceSignal.value = makeSpace('space-1', { sessionIds: ['manual-session-abc123'] });
		render(<SpaceDetailPanel spaceId="space-1" />);
		fireEvent.click(screen.getByLabelText('Sessions section'));
		// Manually created sessions show first 8 chars of ID
		expect(screen.getByText('manual-s')).toBeTruthy();
	});

	it('navigates to session on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByLabelText('Sessions section'));
		// Click the "Space Agent" session entry in the sessions list
		const spaceAgentEls = screen.getAllByText('Space Agent');
		// The one in the sessions list (second occurrence after pinned button)
		fireEvent.click(spaceAgentEls[spaceAgentEls.length - 1]);

		expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'space:chat:space-1');
		expect(onNavigate).toHaveBeenCalled();
	});

	it('highlights selected session in the sessions list', () => {
		mockCurrentSpaceSessionIdSignal.value = 'space:chat:space-1';
		render(<SpaceDetailPanel spaceId="space-1" />);

		fireEvent.click(screen.getByLabelText('Sessions section'));
		const spaceAgentEls = screen.getAllByText('Space Agent');
		// The one inside the sessions list (last occurrence)
		const sessionBtn = spaceAgentEls[spaceAgentEls.length - 1].closest('button');
		expect(sessionBtn?.className).toContain('bg-dark-700');
	});

	it('deduplicates sessions — space agent not listed twice even if in sessionIds', () => {
		// Include the space agent session ID in sessionIds — should not appear twice
		mockSpaceSignal.value = makeSpace('space-1', {
			sessionIds: ['space:chat:space-1', 'other-session'],
		});
		render(<SpaceDetailPanel spaceId="space-1" />);
		fireEvent.click(screen.getByLabelText('Sessions section'));

		// Only one "Space Agent" entry inside the sessions list
		const spaceAgentEls = screen.getAllByText('Space Agent');
		// One in pinned items (button), one in sessions list = 2 total
		expect(spaceAgentEls.length).toBe(2);
	});

	it('renders session count badge in section header', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		// Minimum 1 session (space agent always listed)
		expect(screen.getByText('(1)')).toBeTruthy();
	});

	it('renders "Create session" button in sessions header', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByLabelText('Create session')).toBeTruthy();
	});
});
