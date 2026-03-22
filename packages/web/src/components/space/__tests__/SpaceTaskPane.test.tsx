// @ts-nocheck
/**
 * Unit tests for SpaceTaskPane
 *
 * Tests:
 * - Empty state when no taskId
 * - "Task not found" when taskId doesn't match
 * - Task title rendered
 * - Status badge rendered
 * - Priority indicator rendered
 * - Workflow step indicator shown when workflowRunId present
 * - Description rendered
 * - Current step rendered
 * - Progress bar rendered
 * - Result section rendered
 * - Error section rendered
 * - PR link rendered
 * - Human input area shown for needs_attention status
 * - Human input area NOT shown for other statuses
 * - Close button calls onClose
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { SpaceTask, SpaceAgent, SpaceSessionGroup } from '@neokai/shared';

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
let mockSessionGroups: ReturnType<typeof signal<SpaceSessionGroup[]>>;
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		const sessionGroupsByTask = computed(() => {
			const map = new Map<string, SpaceSessionGroup[]>();
			for (const group of mockSessionGroups.value) {
				if (group.taskId) {
					const existing = map.get(group.taskId) ?? [];
					map.set(group.taskId, [...existing, group]);
				}
			}
			return map;
		});
		return {
			tasks: mockTasks,
			agents: mockAgents,
			sessionGroups: mockSessionGroups,
			sessionGroupsByTask,
			updateTask: mockUpdateTask,
		};
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Initialize signals
mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceAgent[]>([]);
mockSessionGroups = signal<SpaceSessionGroup[]>([]);

import { SpaceTaskPane } from '../SpaceTaskPane';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		title: 'Fix the bug',
		description: 'This is the description',
		status: 'pending',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Backend Engineer',
		role: 'coder',
		description: '',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeSessionGroup(overrides: Partial<SpaceSessionGroup> = {}): SpaceSessionGroup {
	return {
		id: 'group-1',
		spaceId: 'space-1',
		name: 'task:task-1',
		taskId: 'task-1',
		status: 'active',
		members: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

describe('SpaceTaskPane', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockAgents.value = [];
		mockSessionGroups.value = [];
		mockUpdateTask.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows empty state when taskId is null', () => {
		const { getByText } = render(<SpaceTaskPane taskId={null} />);
		expect(getByText('Select a task to view details')).toBeTruthy();
	});

	it('shows "Task not found" when taskId does not match any task', () => {
		mockTasks.value = [makeTask()];
		const { getByText } = render(<SpaceTaskPane taskId="nonexistent" />);
		expect(getByText('Task not found')).toBeTruthy();
	});

	it('renders task title', () => {
		mockTasks.value = [makeTask({ title: 'My Awesome Task' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('My Awesome Task')).toBeTruthy();
	});

	it('renders status badge', () => {
		mockTasks.value = [makeTask({ status: 'in_progress' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('In Progress')).toBeTruthy();
	});

	it('renders priority indicator', () => {
		mockTasks.value = [makeTask({ priority: 'high' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('High priority')).toBeTruthy();
	});

	it('shows workflow step indicator when workflowRunId is present', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1', workflowStepId: 'step-abc123' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText(/Workflow Step/)).toBeTruthy();
		// Should show truncated step ID
		expect(getByText(/step-ab/)).toBeTruthy();
	});

	it('does NOT show workflow step indicator without workflowRunId', () => {
		mockTasks.value = [makeTask()];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText(/Workflow Step/)).toBeNull();
	});

	it('renders description', () => {
		mockTasks.value = [makeTask({ description: 'Detailed description here' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Detailed description here')).toBeTruthy();
	});

	it('renders current step when present', () => {
		mockTasks.value = [makeTask({ currentStep: 'Running linter' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Current Step')).toBeTruthy();
		expect(getByText('Running linter')).toBeTruthy();
	});

	it('renders progress bar when progress > 0', () => {
		mockTasks.value = [makeTask({ progress: 75 })];
		const { getByText, container } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Progress')).toBeTruthy();
		expect(getByText('75%')).toBeTruthy();
		const progressBar = container.querySelector('.bg-blue-500');
		expect(progressBar).toBeTruthy();
	});

	it('does NOT render progress bar when progress is null', () => {
		mockTasks.value = [makeTask({ progress: null })];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText('Progress')).toBeNull();
	});

	it('renders result section when result exists', () => {
		mockTasks.value = [makeTask({ result: 'Build succeeded' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Result')).toBeTruthy();
		expect(getByText('Build succeeded')).toBeTruthy();
	});

	it('renders error section when error exists', () => {
		mockTasks.value = [makeTask({ error: 'Build failed: syntax error' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Error')).toBeTruthy();
		expect(getByText('Build failed: syntax error')).toBeTruthy();
	});

	it('renders PR link when prUrl is set', () => {
		mockTasks.value = [makeTask({ prUrl: 'https://github.com/owner/repo/pull/42', prNumber: 42 })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('PR #42')).toBeTruthy();
	});

	it('shows human input area for needs_attention status', () => {
		mockTasks.value = [makeTask({ status: 'needs_attention' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Human Input Required')).toBeTruthy();
		expect(getByText('Submit Response')).toBeTruthy();
	});

	it('does NOT show human input area for non-needs_attention status', () => {
		mockTasks.value = [makeTask({ status: 'in_progress' })];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText('Human Input Required')).toBeNull();
	});

	it('calls onClose when close button is clicked', () => {
		mockTasks.value = [makeTask()];
		const onClose = vi.fn();
		const { container } = render(<SpaceTaskPane taskId="task-1" onClose={onClose} />);
		const closeBtn = container.querySelector('[aria-label="Close task pane"]');
		expect(closeBtn).toBeTruthy();
		fireEvent.click(closeBtn!);
		expect(onClose).toHaveBeenCalled();
	});

	it('does not render close button when onClose is not provided', () => {
		mockTasks.value = [makeTask()];
		const { container } = render(<SpaceTaskPane taskId="task-1" />);
		expect(container.querySelector('[aria-label="Close task pane"]')).toBeNull();
	});

	it('does NOT render Working Agents section when no session groups exist for task', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText('Working Agents')).toBeNull();
	});

	it('renders Working Agents section when a session group exists for the task', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({
				members: [
					{
						id: 'mem-1',
						groupId: 'group-1',
						sessionId: 'session-1',
						role: 'coder',
						status: 'active',
						orderIndex: 0,
						createdAt: Date.now(),
					},
				],
			}),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Working Agents')).toBeTruthy();
	});

	it('renders member role as name when no agentId is set', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({
				members: [
					{
						id: 'mem-1',
						groupId: 'group-1',
						sessionId: 'session-1',
						role: 'task-agent',
						status: 'active',
						orderIndex: 0,
						createdAt: Date.now(),
					},
				],
			}),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('task-agent')).toBeTruthy();
	});

	it('resolves agent name from agents signal when agentId is set', () => {
		mockTasks.value = [makeTask()];
		mockAgents.value = [makeAgent({ id: 'agent-1', name: 'Backend Engineer', role: 'coder' })];
		mockSessionGroups.value = [
			makeSessionGroup({
				members: [
					{
						id: 'mem-1',
						groupId: 'group-1',
						sessionId: 'session-1',
						role: 'coder',
						agentId: 'agent-1',
						status: 'active',
						orderIndex: 0,
						createdAt: Date.now(),
					},
				],
			}),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Backend Engineer')).toBeTruthy();
		// role shown in parens next to agent name
		expect(getByText('(coder)')).toBeTruthy();
	});

	it('shows active pulse indicator for active member status', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({
				members: [
					{
						id: 'mem-1',
						groupId: 'group-1',
						sessionId: 'session-1',
						role: 'coder',
						status: 'active',
						orderIndex: 0,
						createdAt: Date.now(),
					},
				],
			}),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Active')).toBeTruthy();
	});

	it('shows done indicator for completed member status', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({
				members: [
					{
						id: 'mem-1',
						groupId: 'group-1',
						sessionId: 'session-1',
						role: 'coder',
						status: 'completed',
						orderIndex: 0,
						createdAt: Date.now(),
					},
				],
			}),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Done')).toBeTruthy();
	});

	it('shows failed indicator for failed member status', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({
				members: [
					{
						id: 'mem-1',
						groupId: 'group-1',
						sessionId: 'session-1',
						role: 'coder',
						status: 'failed',
						orderIndex: 0,
						createdAt: Date.now(),
					},
				],
			}),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Failed')).toBeTruthy();
	});

	it('renders multiple groups for the same task', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({ id: 'group-1', name: 'Step 1 Group', taskId: 'task-1', members: [] }),
			makeSessionGroup({ id: 'group-2', name: 'Step 2 Group', taskId: 'task-1', members: [] }),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Step 1 Group')).toBeTruthy();
		expect(getByText('Step 2 Group')).toBeTruthy();
	});

	it('renders groups newest-first by createdAt', () => {
		const now = Date.now();
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeSessionGroup({
				id: 'group-old',
				name: 'Older Group',
				taskId: 'task-1',
				createdAt: now - 10000,
				members: [],
			}),
			makeSessionGroup({
				id: 'group-new',
				name: 'Newer Group',
				taskId: 'task-1',
				createdAt: now,
				members: [],
			}),
		];
		const { container } = render(<SpaceTaskPane taskId="task-1" />);
		const groupNames = Array.from(
			container.querySelectorAll('.text-xs.font-medium.text-gray-300.truncate')
		).map((el) => el.textContent);
		expect(groupNames.indexOf('Newer Group')).toBeLessThan(groupNames.indexOf('Older Group'));
	});

	it('does NOT show groups from a different task', () => {
		mockTasks.value = [makeTask({ id: 'task-1' })];
		mockSessionGroups.value = [
			makeSessionGroup({ id: 'group-other', name: 'Other Task Group', taskId: 'task-other' }),
		];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText('Working Agents')).toBeNull();
		expect(queryByText('Other Task Group')).toBeNull();
	});

	it('shows "No members yet" for a group with empty members', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeSessionGroup({ members: [] })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('No members yet')).toBeTruthy();
	});
});

describe('SpaceTaskPane — HumanInputArea submit behavior', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockAgents.value = [];
		mockSessionGroups.value = [];
		mockUpdateTask.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('calls updateTask with inputDraft first, then status second', async () => {
		mockTasks.value = [makeTask({ status: 'needs_attention' })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		fireEvent.input(getByPlaceholderText('Type your response or approval...'), {
			target: { value: 'Looks good to me' },
		});
		fireEvent.click(getByText('Submit Response'));

		await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledTimes(2));

		const [firstCall, secondCall] = mockUpdateTask.mock.calls;
		expect(firstCall).toEqual(['task-1', { inputDraft: 'Looks good to me' }]);
		expect(secondCall).toEqual(['task-1', { status: 'in_progress' }]);
	});

	it('does not attempt status transition if inputDraft persistence fails', async () => {
		mockUpdateTask.mockRejectedValueOnce(new Error('Server error'));
		mockTasks.value = [makeTask({ status: 'needs_attention' })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		fireEvent.input(getByPlaceholderText('Type your response or approval...'), {
			target: { value: 'My response' },
		});
		fireEvent.click(getByText('Submit Response'));

		await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledTimes(1));
		// Only the draft call was attempted — status transition was skipped
		expect(mockUpdateTask.mock.calls[0]).toEqual(['task-1', { inputDraft: 'My response' }]);
	});

	it('shows error message when status transition fails', async () => {
		mockUpdateTask
			.mockResolvedValueOnce(undefined) // inputDraft succeeds
			.mockRejectedValueOnce(new Error('Invalid transition')); // status fails
		mockTasks.value = [makeTask({ status: 'needs_attention' })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		fireEvent.input(getByPlaceholderText('Type your response or approval...'), {
			target: { value: 'Approved' },
		});
		fireEvent.click(getByText('Submit Response'));

		await waitFor(() => expect(getByText('Invalid transition')).toBeTruthy());
		// Both calls were made (draft + failed status)
		expect(mockUpdateTask).toHaveBeenCalledTimes(2);
	});

	it('does not submit when input text is empty', () => {
		mockTasks.value = [makeTask({ status: 'needs_attention' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);

		// Submit button is disabled when input is empty — click is a no-op
		fireEvent.click(getByText('Submit Response'));

		expect(mockUpdateTask).not.toHaveBeenCalled();
	});
});
