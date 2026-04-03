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

	it('renders the space name, description, and workspace path', () => {
		mockSpace.value = makeSpace({
			name: 'UI Review Space',
			description: 'Space created for UI review.',
			workspacePath: '/tmp/workspace',
		});
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('UI Review Space')).toBeTruthy();
		expect(getByText('Space created for UI review.')).toBeTruthy();
		expect(getByText('/tmp/workspace')).toBeTruthy();
	});

	it('renders the primary overview action', () => {
		mockSpace.value = makeSpace();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Ask Space Agent')).toBeTruthy();
	});

	it('calls onOpenSpaceAgent when Ask Space Agent is clicked', () => {
		mockSpace.value = makeSpace();
		const onOpenSpaceAgent = vi.fn();
		const { getByText } = render(
			<SpaceDashboard spaceId="space-1" onOpenSpaceAgent={onOpenSpaceAgent} />
		);
		fireEvent.click(getByText('Ask Space Agent').closest('button')!);
		expect(onOpenSpaceAgent).toHaveBeenCalledOnce();
	});

	it('renders summary chips and grouped active tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [
			makeTask('t1', 'open'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'blocked'),
			makeTask('t4', 'done'),
		];

		const { getAllByText, getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getAllByText('Active').length).toBeGreaterThanOrEqual(2);
		expect(getAllByText('Review').length).toBeGreaterThanOrEqual(2);
		expect(getAllByText('Done').length).toBeGreaterThanOrEqual(2);
		expect(getByText('In Progress')).toBeTruthy();
		expect(getByText('Queued')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
	});

	it('switches to the Review tab and shows blocked tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'blocked'), makeTask('t2', 'open')];

		const { getAllByText, getByText, queryByText } = render(<SpaceDashboard spaceId="space-1" />);
		fireEvent.click(getAllByText('Review')[1].closest('button')!);
		expect(getByText('Needs Review')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
		expect(queryByText('Task t2')).toBeNull();
	});

	it('switches to the Done tab and shows terminal tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'done'), makeTask('t2', 'cancelled')];

		const { getAllByText, getByText } = render(<SpaceDashboard spaceId="space-1" />);
		fireEvent.click(getAllByText('Done')[1].closest('button')!);
		expect(getByText('Completed')).toBeTruthy();
		expect(getByText('Cancelled')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
	});

	it('shows the empty-state guidance when there are no tasks', () => {
		mockSpace.value = makeSpace();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('This space has no tasks yet.')).toBeTruthy();
	});

	it('shows the empty state for a tab with no tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'open')];
		const { getAllByText, getByText } = render(<SpaceDashboard spaceId="space-1" />);
		fireEvent.click(getAllByText('Review')[1].closest('button')!);
		expect(getByText('No tasks need attention right now.')).toBeTruthy();
	});

	it('calls onSelectTask when a task row is clicked', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'done')];
		const onSelectTask = vi.fn();
		const { getAllByText } = render(<SpaceDashboard spaceId="space-1" onSelectTask={onSelectTask} />);
		fireEvent.click(getAllByText('Done')[1].closest('button')!);
		fireEvent.click(getAllByText('Task t1')[0].closest('button')!);
		expect(onSelectTask).toHaveBeenCalledWith('t1');
	});
});
