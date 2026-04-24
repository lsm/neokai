// @ts-nocheck
/**
 * Unit tests for SpaceTasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceTask } from '@neokai/shared';

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAttentionCount: ReturnType<typeof signal<number>>;

// Bridge pattern: hoisted bridge objects allow mockNavigateToSpaceTasks to update
// the real Preact signals (which are created after import).
const { filterTabBridge, filterBridge, idBridge } = vi.hoisted(() => ({
	filterTabBridge: { signal: null as ReturnType<typeof signal<string>> | null },
	filterBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
	idBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
}));

// Hoisted mock for navigateToSpaceTasks — updates the real signal at call time
const { mockNavigateToSpaceTasks } = vi.hoisted(() => ({
	mockNavigateToSpaceTasks: vi.fn((_spaceId: string, tab: string) => {
		if (filterTabBridge.signal) {
			filterTabBridge.signal.value = tab;
		}
	}),
}));

// Plain holders for non-reactive signals (only read in useEffect, not render)
const { mockCurrentSpaceTasksFilterSignal, mockCurrentSpaceIdSignal } = vi.hoisted(() => ({
	mockCurrentSpaceTasksFilterSignal: { value: null as string | null },
	mockCurrentSpaceIdSignal: { value: null as string | null },
}));

// Real Preact signal for the filter tab (read during render — needs reactivity)
const mockCurrentSpaceTasksFilterTabSignal = signal<string>('active');

// Wire bridge so mockNavigateToSpaceTasks can update the real signal
filterTabBridge.signal = mockCurrentSpaceTasksFilterTabSignal;
filterBridge.signal = mockCurrentSpaceTasksFilterSignal;
idBridge.signal = mockCurrentSpaceIdSignal;

vi.mock('../../../lib/signals', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get currentSpaceTasksFilterTabSignal() {
			return mockCurrentSpaceTasksFilterTabSignal;
		},
		get currentSpaceTasksFilterSignal() {
			return mockCurrentSpaceTasksFilterSignal;
		},
		get currentSpaceIdSignal() {
			return mockCurrentSpaceIdSignal;
		},
	};
});

vi.mock('../../../lib/router', () => ({
	navigateToSpaceTasks: mockNavigateToSpaceTasks,
}));

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return { tasks: mockTasks, attentionCount: mockAttentionCount };
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: string[]) => args.filter(Boolean).join(' '),
	getRelativeTime: (ts: number) => `${Math.floor((Date.now() - ts) / 60_000)}m ago`,
}));

mockTasks = signal<SpaceTask[]>([]);
mockAttentionCount = signal<number>(0);

import { SpaceTasks } from '../SpaceTasks';

function makeTask(
	id: string,
	status: SpaceTask['status'] = 'open',
	overrides: Partial<SpaceTask> = {}
): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		taskNumber: Number(id.replace(/\D/g, '')) || 1,
		title: `Task ${id}`,
		description: '',
		status,
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		...overrides,
	};
}

describe('SpaceTasks', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockAttentionCount.value = 0;
		mockCurrentSpaceTasksFilterTabSignal.value = 'active';
		mockCurrentSpaceTasksFilterSignal.value = null;
		mockCurrentSpaceIdSignal.value = null;
		mockNavigateToSpaceTasks.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders all four tabs', () => {
		mockTasks.value = [makeTask('t1', 'open')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		expect(getByText('Action')).toBeTruthy();
		expect(getByText('Active')).toBeTruthy();
		expect(getByText('Completed')).toBeTruthy();
		expect(getByText('Archived')).toBeTruthy();
	});

	it('shows global empty state when there are no tasks at all', () => {
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		expect(getByText('No tasks yet')).toBeTruthy();
		expect(getByText('Create a task to get started')).toBeTruthy();
	});

	it('shows empty state for action tab', () => {
		mockTasks.value = [makeTask('t1', 'open')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		fireEvent.click(getByText('Action'));
		expect(getByText('No tasks needing action')).toBeTruthy();
	});

	it('shows empty state for completed tab', () => {
		mockTasks.value = [makeTask('t1', 'open')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		fireEvent.click(getByText('Completed'));
		expect(getByText('No completed tasks')).toBeTruthy();
	});

	it('shows empty state for archived tab', () => {
		mockTasks.value = [makeTask('t1', 'open')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		fireEvent.click(getByText('Archived'));
		expect(getByText('No archived tasks')).toBeTruthy();
	});

	it('displays tasks in active tab (open + in_progress)', () => {
		mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'in_progress')];
		const { getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);
		expect(getByText('Task t1')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
		expect(queryByText('No active tasks')).toBeNull();
	});

	it('displays tasks in action tab (blocked + review)', () => {
		mockTasks.value = [makeTask('t1', 'blocked'), makeTask('t2', 'review')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		fireEvent.click(getByText('Action'));
		expect(getByText('Task t1')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
	});

	it('displays tasks in completed tab (done + cancelled)', () => {
		mockTasks.value = [makeTask('t1', 'done'), makeTask('t2', 'cancelled')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		fireEvent.click(getByText('Completed'));
		expect(getByText('Task t1')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
	});

	it('displays tasks in archived tab', () => {
		mockTasks.value = [makeTask('t1', 'archived')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		fireEvent.click(getByText('Archived'));
		expect(getByText('Task t1')).toBeTruthy();
	});

	it('shows correct tab counts', () => {
		mockTasks.value = [
			makeTask('t1', 'open'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'blocked'),
			makeTask('t4', 'review'),
			makeTask('t5', 'done'),
			makeTask('t6', 'cancelled'),
			makeTask('t7', 'archived'),
		];
		const { container } = render(<SpaceTasks spaceId="space-1" />);
		const buttons = container.querySelectorAll('button');
		const text = Array.from(buttons).map((b) => b.textContent ?? '');

		expect(text.some((t) => t?.includes('Active') && t?.includes('2'))).toBe(true);
		expect(text.some((t) => t?.includes('Action') && t?.includes('2'))).toBe(true);
		expect(text.some((t) => t?.includes('Completed') && t?.includes('2'))).toBe(true);
		expect(text.some((t) => t?.includes('Archived') && t?.includes('1'))).toBe(true);
	});

	it('sorts tasks by updatedAt descending', () => {
		const now = Date.now();
		mockTasks.value = [
			makeTask('t1', 'open', { updatedAt: now - 60_000 }),
			makeTask('t2', 'open', { updatedAt: now }),
			makeTask('t3', 'open', { updatedAt: now - 120_000 }),
		];
		const { container } = render(<SpaceTasks spaceId="space-1" />);
		// Task items are inside TaskGroup cards
		const taskItems = container.querySelectorAll('.divide-y > div');
		expect(taskItems[0].textContent).toContain('Task t2');
		expect(taskItems[1].textContent).toContain('Task t1');
		expect(taskItems[2].textContent).toContain('Task t3');
	});

	it('calls onSelectTask when a task item is clicked', () => {
		mockTasks.value = [makeTask('t1', 'open')];
		const onSelectTask = vi.fn();
		const { getByText } = render(<SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />);
		fireEvent.click(getByText('Task t1').closest('.border-l-2')!);
		expect(onSelectTask).toHaveBeenCalledWith('t1');
	});

	it('renders status label and relative time for each task', () => {
		mockTasks.value = [makeTask('t1', 'in_progress')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		expect(getByText('In Progress')).toBeTruthy();
	});

	it('renders task number badge', () => {
		mockTasks.value = [makeTask('t1', 'open', { taskNumber: 42 })];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);
		expect(getByText('#42')).toBeTruthy();
	});

	it('does not show count badge when count is 0', () => {
		mockTasks.value = [];
		const { container } = render(<SpaceTasks spaceId="space-1" />);
		// The active tab button should not have a count badge
		const activeButtons = Array.from(container.querySelectorAll('button'));
		const activeTab = activeButtons.find((b) => b.textContent?.includes('Active'));
		expect(activeTab).toBeFalsy();
	});

	it('switches tabs and shows filtered tasks', () => {
		mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'done')];
		const { getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);

		// Active tab shows t1
		expect(getByText('Task t1')).toBeTruthy();
		expect(queryByText('Task t2')).toBeNull();

		// Switch to completed
		fireEvent.click(getByText('Completed'));
		expect(queryByText('Task t1')).toBeNull();
		expect(getByText('Task t2')).toBeTruthy();
	});

	it('groups tasks by status within a tab', () => {
		mockTasks.value = [makeTask('t1', 'in_progress'), makeTask('t2', 'open')];
		const { getByText } = render(<SpaceTasks spaceId="space-1" />);

		// Active tab should show two groups: "In Progress" and "Open"
		expect(getByText(/In Progress \(1\)/)).toBeTruthy();
		expect(getByText(/Open \(1\)/)).toBeTruthy();
	});

	it('only shows non-empty groups within a tab', () => {
		mockTasks.value = [makeTask('t1', 'in_progress')];
		const { getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);

		// In Progress group shown
		expect(getByText(/In Progress \(1\)/)).toBeTruthy();
		// Open group not shown (no open tasks)
		expect(queryByText(/Open \(/)).toBeNull();
	});

	describe('Dependency badges', () => {
		it('renders no badge row when a task has no dependencies', () => {
			mockTasks.value = [makeTask('t1', 'open')];
			const { queryByTestId } = render(<SpaceTasks spaceId="space-1" />);
			expect(queryByTestId('task-dependency-badges')).toBeNull();
		});

		it('renders a gray badge when the dependency is not done', () => {
			mockTasks.value = [
				makeTask('t1', 'open', { taskNumber: 1 }),
				makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
			];
			const { getAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
			const badges = getAllByTestId('task-dependency-badge');
			expect(badges).toHaveLength(1);
			expect(badges[0].textContent).toContain('#1');
			expect(badges[0].getAttribute('data-dep-status')).toBe('open');
			// Gray color classes applied (bg-dark-700 / text-gray-300)
			expect(badges[0].className).toContain('text-gray-300');
			expect(badges[0].className).not.toContain('text-green-300');
		});

		it('renders a green badge when the dependency is done', () => {
			mockTasks.value = [
				makeTask('t1', 'done', { taskNumber: 1 }),
				makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
			];
			const { getAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
			const badges = getAllByTestId('task-dependency-badge');
			expect(badges).toHaveLength(1);
			expect(badges[0].getAttribute('data-dep-status')).toBe('done');
			expect(badges[0].className).toContain('text-green-300');
		});

		it('renders a missing-dep badge with ⚠ when the dep id is not found', () => {
			mockTasks.value = [makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['missing-id'] })];
			const { getAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
			const badges = getAllByTestId('task-dependency-badge');
			expect(badges).toHaveLength(1);
			expect(badges[0].getAttribute('data-dep-status')).toBe('missing');
			expect(badges[0].getAttribute('title')).toBe('task not found');
			expect(badges[0].textContent).toContain('⚠');
			expect(badges[0].textContent).toContain('#?');
			expect((badges[0] as HTMLButtonElement).disabled).toBe(true);
			// Disabled badges should not carry hover: classes.
			expect(badges[0].className).not.toMatch(/\bhover:/);
		});

		it('shows the dep task title as the tooltip', () => {
			mockTasks.value = [
				makeTask('t1', 'open', { taskNumber: 1, title: 'Set up auth' }),
				makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
			];
			const { getAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
			const badges = getAllByTestId('task-dependency-badge');
			expect(badges[0].getAttribute('title')).toBe('Set up auth');
		});

		it('navigates to the dependency task when a badge is clicked', () => {
			mockTasks.value = [
				makeTask('t1', 'open', { taskNumber: 1 }),
				makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
			];
			const onSelectTask = vi.fn();
			const { getAllByTestId } = render(
				<SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />
			);
			const badges = getAllByTestId('task-dependency-badge');
			fireEvent.click(badges[0]);
			expect(onSelectTask).toHaveBeenCalledWith('t1');
			// Must not also select the parent row (stopPropagation)
			expect(onSelectTask).toHaveBeenCalledTimes(1);
			// Interactive badges carry hover: classes for feedback.
			expect(badges[0].className).toMatch(/\bhover:/);
		});

		it('does not invoke onSelectTask for a missing dependency', () => {
			mockTasks.value = [makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['ghost'] })];
			const onSelectTask = vi.fn();
			const { getAllByTestId } = render(
				<SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />
			);
			const badges = getAllByTestId('task-dependency-badge');
			fireEvent.click(badges[0]);
			expect(onSelectTask).not.toHaveBeenCalled();
		});

		it('shows overflow chip when there are more than 3 deps (first 3 + "+N")', () => {
			mockTasks.value = [
				makeTask('t1', 'done', { taskNumber: 1 }),
				makeTask('t2', 'open', { taskNumber: 2 }),
				makeTask('t3', 'blocked', { taskNumber: 3 }),
				makeTask('t4', 'done', { taskNumber: 4 }),
				makeTask('t5', 'open', { taskNumber: 5 }),
				makeTask('target', 'open', {
					taskNumber: 99,
					dependsOn: ['t1', 't2', 't3', 't4', 't5'],
				}),
			];
			const { getAllByTestId, getByTestId } = render(<SpaceTasks spaceId="space-1" />);
			const badges = getAllByTestId('task-dependency-badge');
			// Only the first 3 deps render as badges
			expect(badges).toHaveLength(3);
			expect(badges.map((b) => b.textContent)).toEqual(['#1', '#2', '#3']);
			const overflow = getByTestId('task-dependency-overflow');
			expect(overflow.textContent).toBe('+2');
		});

		it('does not show an overflow chip when there are exactly 3 deps', () => {
			mockTasks.value = [
				makeTask('t1', 'done', { taskNumber: 1 }),
				makeTask('t2', 'done', { taskNumber: 2 }),
				makeTask('t3', 'done', { taskNumber: 3 }),
				makeTask('target', 'open', {
					taskNumber: 99,
					dependsOn: ['t1', 't2', 't3'],
				}),
			];
			const { getAllByTestId, queryByTestId } = render(<SpaceTasks spaceId="space-1" />);
			expect(getAllByTestId('task-dependency-badge')).toHaveLength(3);
			expect(queryByTestId('task-dependency-overflow')).toBeNull();
		});

		it('reacts when a dependency transitions to done', () => {
			mockTasks.value = [
				makeTask('t1', 'in_progress', { taskNumber: 1 }),
				makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
			];
			const { getAllByTestId, rerender } = render(<SpaceTasks spaceId="space-1" />);
			let badges = getAllByTestId('task-dependency-badge');
			expect(badges[0].getAttribute('data-dep-status')).toBe('in_progress');
			expect(badges[0].className).toContain('text-gray-300');

			// Dependency completes → the badge should flip to green
			mockTasks.value = [
				makeTask('t1', 'done', { taskNumber: 1 }),
				makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
			];
			rerender(<SpaceTasks spaceId="space-1" />);
			badges = getAllByTestId('task-dependency-badge');
			expect(badges[0].getAttribute('data-dep-status')).toBe('done');
			expect(badges[0].className).toContain('text-green-300');
		});
	});

	describe('Awaiting-approval filter chip', () => {
		it('is hidden when no tasks are paused at a completion action', () => {
			mockTasks.value = [makeTask('t1', 'review')];
			const { queryByTestId, getByText } = render(<SpaceTasks spaceId="space-1" />);
			fireEvent.click(getByText('Action'));
			expect(queryByTestId('tasks-filter-awaiting-approval')).toBeNull();
		});

		it('shows chip with count when at least one task is paused at a completion action', () => {
			mockTasks.value = [
				makeTask('t1', 'review', {
					pendingActionIndex: 0,
					pendingCheckpointType: 'completion_action',
				}),
				makeTask('t2', 'review'),
			];
			const { getByTestId, getByText } = render(<SpaceTasks spaceId="space-1" />);
			fireEvent.click(getByText('Action'));
			const chip = getByTestId('tasks-filter-awaiting-approval');
			expect(chip.textContent).toContain('Awaiting Approval');
			expect(chip.textContent).toContain('1');
		});

		it('filters the list to awaiting-approval tasks only when toggled on', () => {
			mockTasks.value = [
				makeTask('t1', 'review', {
					pendingActionIndex: 0,
					pendingCheckpointType: 'completion_action',
				}),
				makeTask('t2', 'review'),
			];
			const { getByTestId, getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);
			fireEvent.click(getByText('Action'));
			// Both tasks visible by default (action tab: blocked + review)
			expect(getByText('Task t1')).toBeTruthy();
			expect(getByText('Task t2')).toBeTruthy();

			// Toggle the filter chip on
			fireEvent.click(getByTestId('tasks-filter-awaiting-approval'));
			expect(getByText('Task t1')).toBeTruthy();
			expect(queryByText('Task t2')).toBeNull();

			// Toggle off via Clear filter
			fireEvent.click(getByTestId('tasks-filter-clear'));
			expect(getByText('Task t2')).toBeTruthy();
		});
	});
});
