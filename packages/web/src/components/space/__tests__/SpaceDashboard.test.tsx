// @ts-nocheck
/**
 * Unit tests for SpaceDashboard
 *
 * Tests:
 * - Loading state renders spinner
 * - No space renders "Space not found"
 * - Space name and workspace path rendered
 * - Description shown when present
 * - Active runs banner shown when runs are active
 * - Active tasks count in banner
 * - Quick action cards rendered
 * - onStartWorkflow called from "Start Workflow Run" card
 * - onCreateTask called from "Create Task" card
 * - Recent activity section shown when data exists
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { Space, SpaceTask, SpaceWorkflowRun } from '@neokai/shared';

// Mock signals
let mockSpace: ReturnType<typeof signal<Space | null>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockWorkflowRuns: ReturnType<typeof signal<SpaceWorkflowRun[]>>;
let mockActiveRuns: ReturnType<typeof computed<SpaceWorkflowRun[]>>;
let mockActiveTasks: ReturnType<typeof computed<SpaceTask[]>>;

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			space: mockSpace,
			loading: mockLoading,
			tasks: mockTasks,
			workflowRuns: mockWorkflowRuns,
			activeRuns: mockActiveRuns,
			activeTasks: mockActiveTasks,
		};
	},
}));

// Initialize signals before component import
mockSpace = signal<Space | null>(null);
mockLoading = signal(false);
mockTasks = signal<SpaceTask[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockActiveRuns = computed(() =>
	mockWorkflowRuns.value.filter((r) => r.status === 'pending' || r.status === 'in_progress')
);
mockActiveTasks = computed(() => mockTasks.value.filter((t) => t.status === 'in_progress'));

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

function makeTask(id: string, status: SpaceTask['status'] = 'pending'): SpaceTask {
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

function makeRun(id: string, status: SpaceWorkflowRun['status'] = 'pending'): SpaceWorkflowRun {
	return {
		id,
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: `Run ${id}`,
		status,
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
		mockWorkflowRuns.value = [];
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

	it('does not show active banner when no active runs or tasks', () => {
		mockSpace.value = makeSpace();
		const { container } = render(<SpaceDashboard spaceId="space-1" />);
		// No blue animated dot
		expect(container.querySelector('.bg-blue-400')).toBeNull();
	});

	it('shows active runs in banner', () => {
		mockSpace.value = makeSpace();
		mockWorkflowRuns.value = [makeRun('r1', 'in_progress')];
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText(/1 active run/)).toBeTruthy();
	});

	it('shows active tasks count in banner', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'in_progress'), makeTask('t2', 'in_progress')];
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText(/2 tasks in progress/)).toBeTruthy();
	});

	it('renders quick action cards', () => {
		mockSpace.value = makeSpace();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Start Workflow Run')).toBeTruthy();
		expect(getByText('Create Task')).toBeTruthy();
	});

	it('calls onStartWorkflow when "Start Workflow Run" card is clicked', () => {
		mockSpace.value = makeSpace();
		const onStartWorkflow = vi.fn();
		const { getByText } = render(
			<SpaceDashboard spaceId="space-1" onStartWorkflow={onStartWorkflow} />
		);
		fireEvent.click(getByText('Start Workflow Run').closest('button')!);
		expect(onStartWorkflow).toHaveBeenCalled();
	});

	it('calls onCreateTask when "Create Task" card is clicked', () => {
		mockSpace.value = makeSpace();
		const onCreateTask = vi.fn();
		const { getByText } = render(<SpaceDashboard spaceId="space-1" onCreateTask={onCreateTask} />);
		fireEvent.click(getByText('Create Task').closest('button')!);
		expect(onCreateTask).toHaveBeenCalled();
	});

	it('shows recent activity section when runs exist', () => {
		mockSpace.value = makeSpace();
		mockWorkflowRuns.value = [makeRun('r1', 'completed')];
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Recent Activity')).toBeTruthy();
		expect(getByText('Run r1')).toBeTruthy();
	});

	it('shows recent tasks in activity section', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'completed')];
		const { getByText } = render(<SpaceDashboard spaceId="space-1" />);
		expect(getByText('Task t1')).toBeTruthy();
	});

	it('truncates long workspace paths', () => {
		const longPath = '/very/long/path/to/some/deeply/nested/project/directory/my-project';
		mockSpace.value = makeSpace({ workspacePath: longPath });
		const { container } = render(<SpaceDashboard spaceId="space-1" />);
		const pathEl = container.querySelector('.font-mono');
		// Path should be truncated (starts with ellipsis)
		expect(pathEl?.textContent?.startsWith('…')).toBe(true);
	});
});
