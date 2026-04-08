/**
 * Tests for SpaceDetailPanel.
 *
 * Covers overview/agent navigation, task tab defaults, counters, and sessions behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceTask, Space } from '@neokai/shared';

const {
	mockNavigateToSpace,
	mockNavigateToSpaceAgent,
	mockNavigateToSpaceTask,
	mockNavigateToSpaceSession,
	mockNavigateToSpaceTasks,
} = vi.hoisted(() => ({
	mockNavigateToSpace: vi.fn(),
	mockNavigateToSpaceAgent: vi.fn(),
	mockNavigateToSpaceTask: vi.fn(),
	mockNavigateToSpaceSession: vi.fn(),
	mockNavigateToSpaceTasks: vi.fn(),
}));

let mockTasksSignal!: Signal<SpaceTask[]>;
let mockSpaceSignal!: Signal<Space | null>;
let mockLoadingSignal!: Signal<boolean>;
let mockSpaceIdSignal!: Signal<string | null>;
let mockSessionsSignal!: Signal<
	Array<{ id: string; title: string; status: string; lastActiveAt: number }>
>;
let mockCurrentSpaceSessionIdSignal!: Signal<string | null>;
let mockCurrentSpaceTaskIdSignal!: Signal<string | null>;
let mockSpaceOverlaySessionIdSignal!: Signal<string | null>;
let mockSpaceOverlayAgentNameSignal!: Signal<string | null>;

function initSignals() {
	mockTasksSignal = signal([]);
	mockSpaceSignal = signal(null);
	mockLoadingSignal = signal(false);
	mockSpaceIdSignal = signal('space-1');
	mockSessionsSignal = signal([]);
	mockCurrentSpaceSessionIdSignal = signal(null);
	mockCurrentSpaceTaskIdSignal = signal(null);
	mockSpaceOverlaySessionIdSignal = signal(null);
	mockSpaceOverlayAgentNameSignal = signal(null);
}

initSignals();

vi.mock('../../lib/space-store.ts', () => ({
	get spaceStore() {
		return {
			tasks: mockTasksSignal,
			space: mockSpaceSignal,
			loading: mockLoadingSignal,
			spaceId: mockSpaceIdSignal,
			sessions: mockSessionsSignal,
		};
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToSpace: mockNavigateToSpace,
	navigateToSpaceAgent: mockNavigateToSpaceAgent,
	navigateToSpaceTask: mockNavigateToSpaceTask,
	navigateToSpaceSession: mockNavigateToSpaceSession,
	navigateToSpaceTasks: mockNavigateToSpaceTasks,
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
		get spaceOverlaySessionIdSignal() {
			return mockSpaceOverlaySessionIdSignal;
		},
		get spaceOverlayAgentNameSignal() {
			return mockSpaceOverlayAgentNameSignal;
		},
	};
});

import { SpaceDetailPanel } from '../SpaceDetailPanel';

function makeTask(
	id: string,
	title: string,
	status: SpaceTask['status'] = 'open',
	overrides: Partial<SpaceTask> = {}
): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		taskNumber: 1,
		title,
		description: '',
		status,
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as SpaceTask;
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

describe('SpaceDetailPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		initSignals();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows loading state when spaceStore is loading', () => {
		mockLoadingSignal.value = true;
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Loading…')).toBeTruthy();
		expect(screen.queryByText('Overview')).toBeNull();
	});

	it('shows loading state when store spaceId does not match prop', () => {
		mockSpaceIdSignal.value = 'other-space';
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Loading…')).toBeTruthy();
	});

	it('renders Overview and Space Agent buttons', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Overview')).toBeTruthy();
		expect(screen.getByText('Space Agent')).toBeTruthy();
	});

	it('removes the old Space Activity header block', () => {
		mockSpaceSignal.value = makeSpace('space-1', { workspacePath: '/tmp/workspace' });
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.queryByText('Space Activity')).toBeNull();
		expect(screen.queryByText('/tmp/workspace')).toBeNull();
	});

	it('navigates to space overview and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Overview'));
		expect(mockNavigateToSpace).toHaveBeenCalledWith('space-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('navigates to the space agent and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Space Agent'));
		expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights Overview when neither session nor task is selected', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		const button = screen.getByText('Overview').closest('button');
		expect(button?.className).toContain('bg-dark-700');
	});

	it('highlights Space Agent when its synthetic session is selected', () => {
		mockCurrentSpaceSessionIdSignal.value = 'space:chat:space-1';
		render(<SpaceDetailPanel spaceId="space-1" />);
		const button = screen.getByText('Space Agent').closest('button');
		expect(button?.className).toContain('bg-dark-700');
	});

	it('shows Review tasks by default and includes counters on task tabs', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Queued Task', 'open'),
			makeTask('t2', 'In Progress Task', 'in_progress'),
			makeTask('t3', 'Blocked Task', 'blocked'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		expect(screen.getByText('Blocked Task')).toBeTruthy();
		expect(screen.queryByText('Queued Task')).toBeNull();
		expect(screen.getByText('Active')).toBeTruthy();
		expect(screen.getByText('Review')).toBeTruthy();
		expect(screen.getByText('2')).toBeTruthy();
		expect(screen.getByText('1')).toBeTruthy();
	});

	it('switches to Active tasks when the Active tab is clicked', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Queued Task', 'open'),
			makeTask('t2', 'Blocked Task', 'blocked'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		fireEvent.click(screen.getByRole('button', { name: /Active/i }));
		expect(screen.getByText('Queued Task')).toBeTruthy();
		expect(screen.queryByText('Blocked Task')).toBeNull();
	});

	it('keeps the selected task visible even when it does not match the current tab', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Queued Task', 'open'),
			makeTask('t2', 'Done Task', 'done'),
		];
		mockCurrentSpaceTaskIdSignal.value = 't2';
		render(<SpaceDetailPanel spaceId="space-1" />);

		expect(screen.getByText('Done Task')).toBeTruthy();
	});

	it('navigates to a task on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockTasksSignal.value = [makeTask('t1', 'Blocked Task', 'blocked')];
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('Blocked Task'));
		expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 't1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('renders Sessions expanded by default', () => {
		mockSessionsSignal.value = [
			{ id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
		];
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('manual-s')).toBeTruthy();
	});

	it('filters out system sessions from the Sessions section', () => {
		mockSessionsSignal.value = [
			{
				id: 'space:space-1:task:task-123',
				title: 'task-session',
				status: 'active',
				lastActiveAt: 0,
			},
			{
				id: 'space:space-1:workflow:run-1',
				title: 'workflow-session',
				status: 'active',
				lastActiveAt: 0,
			},
			{ id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		expect(screen.queryByText('task-session')).toBeNull();
		expect(screen.queryByText('workflow-session')).toBeNull();
		expect(screen.getByText('manual-s')).toBeTruthy();
	});

	it('opens overlay on session click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSessionsSignal.value = [
			{ id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
		];
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('manual-s'));
		expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'manual-session-abc123');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	describe('task visibility in context panel', () => {
		it('shows all tasks matching the active tab filter', () => {
			mockTasksSignal.value = [
				makeTask('t1', 'Open Task', 'open'),
				makeTask('t2', 'In Progress Task', 'in_progress'),
				makeTask('t3', 'Blocked Task', 'blocked'),
				makeTask('t4', 'Done Task', 'done'),
			];
			render(<SpaceDetailPanel spaceId="space-1" />);

			// Default tab is "review" — shows blocked tasks
			expect(screen.getByText('Blocked Task')).toBeTruthy();
			expect(screen.queryByText('Open Task')).toBeNull();
			expect(screen.queryByText('In Progress Task')).toBeNull();
			expect(screen.queryByText('Done Task')).toBeNull();

			// Switch to Active — shows open + in_progress
			fireEvent.click(screen.getByRole('button', { name: /Active/i }));
			expect(screen.getByText('Open Task')).toBeTruthy();
			expect(screen.getByText('In Progress Task')).toBeTruthy();
			expect(screen.queryByText('Blocked Task')).toBeNull();
		});

		it('tasks appear without manual refresh when signal updates', () => {
			mockTasksSignal.value = [];
			const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

			// Switch to Active tab and verify empty
			fireEvent.click(screen.getByRole('button', { name: /Active/i }));
			expect(screen.getByText('No tasks')).toBeTruthy();

			// Simulate new task arriving via event (signal update)
			mockTasksSignal.value = [makeTask('t-new', 'New Task', 'open')];
			rerender(<SpaceDetailPanel spaceId="space-1" />);

			expect(screen.getByText('New Task')).toBeTruthy();
			expect(screen.queryByText('No tasks')).toBeNull();
		});

		it('count badges update when new tasks arrive', () => {
			mockTasksSignal.value = [makeTask('t1', 'Task A', 'open')];
			const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

			// Active: 1, Review: 0
			expect(screen.getByText('1')).toBeTruthy();
			expect(screen.getByText('0')).toBeTruthy();

			// Add a blocked task
			mockTasksSignal.value = [
				makeTask('t1', 'Task A', 'open'),
				makeTask('t2', 'Task B', 'blocked'),
			];
			rerender(<SpaceDetailPanel spaceId="space-1" />);

			// Active: 1, Review: 1
			const badges = screen.getAllByText('1');
			expect(badges.length).toBe(2);
		});

		it('task status change updates tab counts and visibility', () => {
			mockTasksSignal.value = [
				makeTask('t1', 'Task One', 'in_progress'),
				makeTask('t2', 'Task Two', 'blocked'),
			];
			const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

			// Review tab (default): shows blocked task
			expect(screen.getByText('Task Two')).toBeTruthy();

			// Simulate task status change: t1 becomes blocked, t2 becomes done
			mockTasksSignal.value = [
				makeTask('t1', 'Task One', 'blocked'),
				makeTask('t2', 'Task Two', 'done'),
			];
			rerender(<SpaceDetailPanel spaceId="space-1" />);

			// Review tab should now show Task One (blocked) but not Task Two (done)
			expect(screen.getByText('Task One')).toBeTruthy();
			expect(screen.queryByText('Task Two')).toBeNull();
		});

		it('multiple tasks created via different paths all appear in panel', () => {
			// Simulate tasks created via different paths: UI dialog, agent tool, workflow run
			mockTasksSignal.value = [
				makeTask('t-ui', 'UI Dialog Task', 'open'),
				makeTask('t-agent', 'Agent Created Task', 'in_progress', {
					workflowRunId: 'run-1',
				}),
				makeTask('t-workflow', 'Workflow Task', 'in_progress', {
					workflowRunId: 'run-1',
				}),
			];
			render(<SpaceDetailPanel spaceId="space-1" />);

			// Switch to Active tab
			fireEvent.click(screen.getByRole('button', { name: /Active/i }));

			// All three tasks should appear regardless of creation path
			expect(screen.getByText('UI Dialog Task')).toBeTruthy();
			expect(screen.getByText('Agent Created Task')).toBeTruthy();
			expect(screen.getByText('Workflow Task')).toBeTruthy();
		});
	});
});
