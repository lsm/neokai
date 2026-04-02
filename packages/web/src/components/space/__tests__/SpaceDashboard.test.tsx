// @ts-nocheck
/**
 * Unit tests for SpaceDashboard
 *
 * Tests:
 * - Loading state renders spinner
 * - No space renders "Space not found"
 * - Space name and workspace path rendered
 * - Description shown when present
 * - Primary dashboard action renders
 * - onOpenSpaceAgent callback fires
 * - Overview stats render for active/review/completed tasks
 * - Attention, in-progress, and recent sections render task rows
 * - Empty state renders when there are no tasks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { Space, SpaceTask } from '@neokai/shared';

// Mock signals
let mockSpace: ReturnType<typeof signal<Space | null>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockActiveRuns: ReturnType<typeof computed<unknown[]>>;

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			space: mockSpace,
			loading: mockLoading,
			tasks: mockTasks,
			activeRuns: mockActiveRuns,
		};
	},
}));

// Initialize signals before component import
mockSpace = signal<Space | null>(null);
mockLoading = signal(false);
mockTasks = signal<SpaceTask[]>([]);
mockActiveRuns = computed(() => []);

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

function makeTask(id: string, status: SpaceTask['status'] = 'open'): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		title: `Task ${id}`,
		description: '',
		status,
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
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

	it('renders space name', () => {
		mockSpace.value = makeSpace({ name: 'Awesome Project' });
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Awesome Project')).toBeTruthy();
	});

	it('renders workspace path', () => {
		mockSpace.value = makeSpace({ workspacePath: '/home/user/projects/test' });
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('/home/user/projects/test')).toBeTruthy();
	});

	it('renders description when provided', () => {
		mockSpace.value = makeSpace({ description: 'A cool project description' });
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('A cool project description')).toBeTruthy();
	});

	it('renders the primary dashboard action', () => {
		mockSpace.value = makeSpace();
		const { getByText, queryByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Ask Space Agent')).toBeTruthy();
		expect(queryByText('Create Task')).toBeNull();
		expect(queryByText('Run Workflow')).toBeNull();
	});

	it('calls onOpenSpaceAgent when "Ask Space Agent" is clicked', () => {
		mockSpace.value = makeSpace();
		const onOpenSpaceAgent = vi.fn();
		const { getByText } = render(
			<SpaceDashboard spaceId="space-1" onOpenSpaceAgent={onOpenSpaceAgent} />
		);
		fireEvent.click(getByText('Ask Space Agent').closest('button')!);
		expect(onOpenSpaceAgent).toHaveBeenCalled();
	});

	it('shows active, attention, and completed stats', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [
			makeTask('t1', 'in_progress'),
			makeTask('t2', 'blocked'),
			makeTask('t3', 'done'),
		];
		const { getByText, getAllByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getAllByText('Active').length).toBeGreaterThanOrEqual(1);
		expect(getAllByText('Needs Attention').length).toBeGreaterThanOrEqual(1);
		expect(getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
		expect(getAllByText('1').length).toBeGreaterThanOrEqual(3);
	});

	it('shows attention, in-progress, and recent sections for tasks', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [
			makeTask('attention', 'blocked'),
			makeTask('active', 'in_progress'),
			makeTask('done', 'done'),
		];
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Attention Queue')).toBeTruthy();
		expect(getByText('Active Queue')).toBeTruthy();
		expect(getByText('Recent Activity')).toBeTruthy();
		expect(getByText('Task attention')).toBeTruthy();
		expect(getByText('Task active')).toBeTruthy();
		expect(getByText('Task done')).toBeTruthy();
	});

	it('shows empty-state guidance when there are no tasks', () => {
		mockSpace.value = makeSpace();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('This space has no tasks yet.')).toBeTruthy();
		expect(
			getByText(
				'Create the first task or ask the space agent to help you shape the work before reaching for a workflow.'
			)
		).toBeTruthy();
	});

	it('truncates long workspace paths', () => {
		const longPath = '/very/long/path/to/some/deeply/nested/project/directory/my-project';
		mockSpace.value = makeSpace({ workspacePath: longPath });
		const { container } = render(<SpaceDashboard spaceId="space-1" />);
		const pathEl = container.querySelector('.font-mono');
		// Path should be truncated (starts with ellipsis)
		expect(pathEl?.textContent?.startsWith('…')).toBe(true);
	});

	it('calls onSelectTask when a recent task row is clicked', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'done')];
		const onSelectTask = vi.fn();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" onSelectTask={onSelectTask} />);
		fireEvent.click(getByText('Task t1').closest('button')!);
		expect(onSelectTask).toHaveBeenCalledWith('t1');
	});
});
