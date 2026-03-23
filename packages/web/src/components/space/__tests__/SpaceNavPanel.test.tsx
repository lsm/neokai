// @ts-nocheck
/**
 * Unit tests for SpaceNavPanel
 *
 * Tests:
 * - Loading state renders skeleton text
 * - Empty state when no runs or tasks
 * - Workflow runs section renders runs
 * - Task count per run displayed
 * - Standalone tasks section renders tasks
 * - Status dots render for various statuses
 * - Active item highlighted
 * - onRunSelect called when run clicked
 * - onTaskSelect called when task clicked
 * - Navigation links rendered
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { SpaceWorkflowRun, SpaceTask } from '@neokai/shared';

// Mock signals — define before vi.mock
let mockWorkflowRuns: ReturnType<typeof signal<SpaceWorkflowRun[]>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockStandaloneTasks: ReturnType<typeof computed<SpaceTask[]>>;
let mockTasksByRun: ReturnType<typeof computed<Map<string, SpaceTask[]>>>;

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			workflowRuns: mockWorkflowRuns,
			standaloneTasks: mockStandaloneTasks,
			tasksByRun: mockTasksByRun,
			loading: mockLoading,
		};
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Initialize signals
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockTasks = signal<SpaceTask[]>([]);
mockLoading = signal(false);
mockStandaloneTasks = computed(() => mockTasks.value.filter((t) => !t.workflowRunId));
mockTasksByRun = computed(() => {
	const map = new Map<string, SpaceTask[]>();
	for (const task of mockTasks.value) {
		if (task.workflowRunId) {
			const existing = map.get(task.workflowRunId) ?? [];
			map.set(task.workflowRunId, [...existing, task]);
		}
	}
	return map;
});

import { SpaceNavPanel } from '../SpaceNavPanel';

function makeRun(
	id: string,
	status: SpaceWorkflowRun['status'] = 'pending',
	title = `Run ${id}`
): SpaceWorkflowRun {
	return {
		id,
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title,
		status,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeTask(
	id: string,
	status: SpaceTask['status'] = 'pending',
	workflowRunId?: string
): SpaceTask {
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
		...(workflowRunId ? { workflowRunId } : {}),
	};
}

const defaultProps = {
	spaceId: 'space-1',
	activeTaskId: null,
	activeRunId: null,
	onRunSelect: vi.fn(),
	onTaskSelect: vi.fn(),
};

describe('SpaceNavPanel', () => {
	beforeEach(() => {
		cleanup();
		mockWorkflowRuns.value = [];
		mockTasks.value = [];
		mockLoading.value = false;
		defaultProps.onRunSelect.mockClear();
		defaultProps.onTaskSelect.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders loading state when loading is true', () => {
		mockLoading.value = true;
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('Loading...')).toBeTruthy();
	});

	it('renders empty state when no runs or tasks', () => {
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('No runs or tasks yet')).toBeTruthy();
	});

	it('renders workflow runs section when runs exist', () => {
		mockWorkflowRuns.value = [makeRun('r1', 'pending', 'My Run')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('Workflow Runs')).toBeTruthy();
		expect(getByText('My Run')).toBeTruthy();
	});

	it('shows task count per run', () => {
		mockWorkflowRuns.value = [makeRun('r1')];
		mockTasks.value = [makeTask('t1', 'pending', 'r1'), makeTask('t2', 'in_progress', 'r1')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('2 tasks')).toBeTruthy();
	});

	it('shows singular task when count is 1', () => {
		mockWorkflowRuns.value = [makeRun('r1')];
		mockTasks.value = [makeTask('t1', 'pending', 'r1')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('1 task')).toBeTruthy();
	});

	it('renders standalone tasks section when tasks exist', () => {
		mockTasks.value = [makeTask('t1')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('Tasks')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
	});

	it('calls onRunSelect when a run is clicked', () => {
		mockWorkflowRuns.value = [makeRun('r1', 'pending', 'Run 1')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		fireEvent.click(getByText('Run 1'));
		expect(defaultProps.onRunSelect).toHaveBeenCalledWith('r1');
	});

	it('calls onTaskSelect when a task is clicked', () => {
		mockTasks.value = [makeTask('t1')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		fireEvent.click(getByText('Task t1'));
		expect(defaultProps.onTaskSelect).toHaveBeenCalledWith('t1');
	});

	it('highlights active run', () => {
		mockWorkflowRuns.value = [makeRun('r1', 'pending', 'Active Run')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} activeRunId="r1" />);
		const runButton = getByText('Active Run').closest('button');
		expect(runButton?.className).toContain('bg-dark-700');
	});

	it('highlights active task', () => {
		mockTasks.value = [makeTask('t1')];
		const { getByText } = render(<SpaceNavPanel {...defaultProps} activeTaskId="t1" />);
		const taskButton = getByText('Task t1').closest('button');
		expect(taskButton?.className).toContain('bg-dark-700');
	});

	it('renders navigation links', () => {
		const { getByText } = render(<SpaceNavPanel {...defaultProps} />);
		expect(getByText('Agents')).toBeTruthy();
		expect(getByText('Workflows')).toBeTruthy();
		expect(getByText('Settings')).toBeTruthy();
	});

	it('renders in_progress status dot with animation', () => {
		mockWorkflowRuns.value = [makeRun('r1', 'in_progress', 'Active Run')];
		const { container } = render(<SpaceNavPanel {...defaultProps} />);
		const dot = container.querySelector('.bg-blue-400');
		expect(dot).toBeTruthy();
		expect(dot?.className).toContain('animate-pulse');
	});

	it('renders completed status dot in green', () => {
		mockWorkflowRuns.value = [makeRun('r1', 'completed', 'Done Run')];
		const { container } = render(<SpaceNavPanel {...defaultProps} />);
		expect(container.querySelector('.bg-green-500')).toBeTruthy();
	});

	it('renders needs_attention status dot in yellow', () => {
		mockWorkflowRuns.value = [makeRun('r1', 'needs_attention', 'Blocked Run')];
		const { container } = render(<SpaceNavPanel {...defaultProps} />);
		expect(container.querySelector('.bg-yellow-400')).toBeTruthy();
	});
});
