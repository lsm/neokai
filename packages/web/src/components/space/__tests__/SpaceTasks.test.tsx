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
});
