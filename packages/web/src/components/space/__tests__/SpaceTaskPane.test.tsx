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
 * - Working Agents section shown when session groups exist for task
 * - Working Agents section hidden when no groups exist
 * - Member status badges rendered correctly
 * - Agent name looked up from agents signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { SpaceTask, SpaceSessionGroup, SpaceAgent } from '@neokai/shared';

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockSessionGroups: ReturnType<typeof signal<SpaceSessionGroup[]>>;
let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
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
			sessionGroups: mockSessionGroups,
			sessionGroupsByTask,
			agents: mockAgents,
			updateTask: mockUpdateTask,
		};
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Initialize signals
mockTasks = signal<SpaceTask[]>([]);
mockSessionGroups = signal<SpaceSessionGroup[]>([]);
mockAgents = signal<SpaceAgent[]>([]);

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

function makeGroup(overrides: Partial<SpaceSessionGroup> = {}): SpaceSessionGroup {
	return {
		id: 'group-1',
		spaceId: 'space-1',
		name: 'task:task-1',
		status: 'active',
		members: [],
		createdAt: 1000000,
		updatedAt: 1000000,
		taskId: 'task-1',
		...overrides,
	};
}

function makeMember(
	overrides: Partial<import('@neokai/shared').SpaceSessionGroupMember> = {}
): import('@neokai/shared').SpaceSessionGroupMember {
	return {
		id: 'member-1',
		groupId: 'group-1',
		sessionId: 'session-1',
		role: 'task-agent',
		status: 'active',
		orderIndex: 0,
		createdAt: 1000000,
		...overrides,
	};
}

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Backend Engineer',
		role: 'coder',
		instructions: '',
		createdAt: 1000000,
		updatedAt: 1000000,
		...overrides,
	};
}

describe('SpaceTaskPane', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockSessionGroups.value = [];
		mockAgents.value = [];
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

	// -----------------------------------------------------------------------
	// Working Agents section
	// -----------------------------------------------------------------------

	it('does NOT show Working Agents section when no groups exist for the task', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText('Working Agents')).toBeNull();
	});

	it('shows Working Agents section when a group exists for the task', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ taskId: 'task-1' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Working Agents')).toBeTruthy();
	});

	it('does NOT show Working Agents section when groups belong to a different task', () => {
		mockTasks.value = [makeTask({ id: 'task-1' })];
		mockSessionGroups.value = [makeGroup({ taskId: 'task-other' })];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText('Working Agents')).toBeNull();
	});

	it('renders group name inside Working Agents section', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ name: 'My Group', taskId: 'task-1' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('My Group')).toBeTruthy();
	});

	it('renders member role when no agentId is provided', () => {
		const member = makeMember({ role: 'task-agent', agentId: undefined });
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [member] })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Task Agent')).toBeTruthy();
	});

	it('renders agent name from agents signal when agentId matches', () => {
		const agent = makeAgent({ id: 'agent-1', name: 'Security Auditor', role: 'reviewer' });
		const member = makeMember({ agentId: 'agent-1', role: 'reviewer' });
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [member] })];
		mockAgents.value = [agent];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Security Auditor')).toBeTruthy();
	});

	it('shows active status badge for active member', () => {
		const member = makeMember({ status: 'active' });
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [member] })];
		const { getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText('active').length).toBeGreaterThan(0);
	});

	it('shows completed status badge for completed member', () => {
		const member = makeMember({ status: 'completed' });
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [member] })];
		const { getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText('completed').length).toBeGreaterThan(0);
	});

	it('shows failed status badge for failed member', () => {
		const member = makeMember({ status: 'failed' });
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [member] })];
		const { getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText('failed').length).toBeGreaterThan(0);
	});

	it('renders multiple groups when they share the same taskId', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeGroup({ id: 'group-1', name: 'First Group', taskId: 'task-1', createdAt: 1000000 }),
			makeGroup({ id: 'group-2', name: 'Second Group', taskId: 'task-1', createdAt: 2000000 }),
		];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('First Group')).toBeTruthy();
		expect(getByText('Second Group')).toBeTruthy();
	});

	it('renders most recent group first (sort order)', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [
			makeGroup({ id: 'group-1', name: 'Older Group', taskId: 'task-1', createdAt: 1000000 }),
			makeGroup({ id: 'group-2', name: 'Newer Group', taskId: 'task-1', createdAt: 2000000 }),
		];
		const { container } = render(<SpaceTaskPane taskId="task-1" />);
		const groupNames = Array.from(
			container.querySelectorAll('.text-gray-300.text-xs.font-medium')
		).map((el) => el.textContent);
		const newerIdx = groupNames.indexOf('Newer Group');
		const olderIdx = groupNames.indexOf('Older Group');
		expect(newerIdx).toBeGreaterThanOrEqual(0);
		expect(olderIdx).toBeGreaterThanOrEqual(0);
		expect(newerIdx).toBeLessThan(olderIdx);
	});

	it('shows "No members yet" when group has no members', () => {
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [] })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('No members yet')).toBeTruthy();
	});

	it('falls back to member.role when agentId does not match any agent and role is not task-agent', () => {
		const member = makeMember({ agentId: 'nonexistent-agent', role: 'security-auditor' });
		mockTasks.value = [makeTask()];
		mockSessionGroups.value = [makeGroup({ members: [member] })];
		mockAgents.value = []; // no agents loaded
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('security-auditor')).toBeTruthy();
	});
});

describe('SpaceTaskPane — HumanInputArea submit behavior', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockSessionGroups.value = [];
		mockAgents.value = [];
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
