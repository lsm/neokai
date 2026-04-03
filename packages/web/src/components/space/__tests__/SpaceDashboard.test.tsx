// @ts-nocheck
/**
 * Unit tests for SpaceDashboard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Space, SpaceTask } from '@neokai/shared';

let mockSpace: ReturnType<typeof signal<Space | null>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			space: mockSpace,
			loading: mockLoading,
			tasks: mockTasks,
		};
	},
}));

mockSpace = signal<Space | null>(null);
mockLoading = signal(false);
mockTasks = signal<SpaceTask[]>([]);

import { SpaceDashboard } from '../SpaceDashboard';

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		name: 'My Space',
		workspacePath: '/projects/my-space',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

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

describe('SpaceDashboard', () => {
	beforeEach(() => {
		cleanup();
		mockSpace.value = null;
		mockLoading.value = false;
		mockTasks.value = [];
	});

	afterEach(() => {
		cleanup();
	});

	it('renders loading spinner when loading', () => {
		mockLoading.value = true;
		const { container } = render(<SpaceDashboard spaceId="space-1" />);
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('renders "Space not found" when no space', () => {
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Space not found')).toBeTruthy();
	});

	it('renders the task tabs without the removed overview hero', () => {
		mockSpace.value = makeSpace({
			name: 'UI Review Space',
			description: 'Space created for UI review.',
			workspacePath: '/tmp/workspace',
		});
		const { getByText, queryByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Active')).toBeTruthy();
		expect(getByText('Review')).toBeTruthy();
		expect(getByText('Done')).toBeTruthy();
		expect(queryByText('UI Review Space')).toBeNull();
		expect(queryByText('Space created for UI review.')).toBeNull();
		expect(queryByText('/tmp/workspace')).toBeNull();
		expect(queryByText('Ask Space Agent')).toBeNull();
	});

	it('renders the task tabs and grouped active tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [
			makeTask('t1', 'open'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'blocked'),
			makeTask('t4', 'done'),
		];

		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Active')).toBeTruthy();
		expect(getByText('Review')).toBeTruthy();
		expect(getByText('Done')).toBeTruthy();
		expect(getByText('In Progress')).toBeTruthy();
		expect(getByText('Queued')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
	});

	it('switches to the Review tab and shows blocked tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'blocked'), makeTask('t2', 'open')];

		const { getByText, queryByText } = render(<SpaceDashboard spaceId="space-1" />);
		fireEvent.click(getByText('Review').closest('button')!);
		expect(getByText('Needs Review')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
		expect(queryByText('Task t2')).toBeNull();
	});

	it('switches to the Done tab and shows terminal tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'done'), makeTask('t2', 'cancelled')];

		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		fireEvent.click(getByText('Done').closest('button')!);
		expect(getByText('Completed')).toBeTruthy();
		expect(getByText('Cancelled')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
	});

	it('shows the empty-state guidance when there are no tasks', () => {
		mockSpace.value = makeSpace();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('This space has no tasks yet.')).toBeTruthy();
		expect(getByText('Create the first task to start the space.')).toBeTruthy();
	});

	it('shows the empty state for a tab with no tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'open')];
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		fireEvent.click(getByText('Review').closest('button')!);
		expect(getByText('No tasks need attention right now.')).toBeTruthy();
	});

	it('calls onSelectTask when a task row is clicked', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'done')];
		const onSelectTask = vi.fn();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" onSelectTask={onSelectTask} />);
		fireEvent.click(getByText('Done').closest('button')!);
		fireEvent.click(getByText('Task t1').closest('button')!);
		expect(onSelectTask).toHaveBeenCalledWith('t1');
	});
});
