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
 * - Workflow context shown when workflowRunId present
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
import type {
	SpaceTask,
	SpaceAgent,
	SpaceWorkflow,
	SpaceWorkflowRun,
	SpaceTaskActivityMember,
} from '@neokai/shared';

const { mockNavigateToSpaceSession } = vi.hoisted(() => ({
	mockNavigateToSpaceSession: vi.fn(),
}));
const { mockNavigateToSpaceAgent } = vi.hoisted(() => ({
	mockNavigateToSpaceAgent: vi.fn(),
}));
vi.mock('../../../lib/router', () => ({
	navigateToSpaceSession: mockNavigateToSpaceSession,
	navigateToSpaceAgent: mockNavigateToSpaceAgent,
}));

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockWorkflowRuns: ReturnType<typeof signal<SpaceWorkflowRun[]>>;
let mockTasksByRun: ReturnType<typeof computed<Map<string, SpaceTask[]>>>;
let mockTaskActivity: ReturnType<typeof signal<Map<string, SpaceTaskActivityMember[]>>>;
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockSubscribeTaskActivity = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribeTaskActivity = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			tasks: mockTasks,
			agents: mockAgents,
			workflows: mockWorkflows,
			workflowRuns: mockWorkflowRuns,
			tasksByRun: mockTasksByRun,
			taskActivity: mockTaskActivity,
			subscribeTaskActivity: mockSubscribeTaskActivity,
			unsubscribeTaskActivity: mockUnsubscribeTaskActivity,
			updateTask: mockUpdateTask,
		};
	},
}));

vi.mock('../WorkflowCanvas', () => ({
	WorkflowCanvas: (props: {
		workflowId: string;
		runId?: string | null;
		spaceId: string;
		class?: string;
	}) => (
		<div
			data-testid="workflow-canvas"
			data-workflow-id={props.workflowId}
			data-run-id={props.runId ?? ''}
			data-space-id={props.spaceId}
		/>
	),
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Initialize signals
mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockTaskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());
mockTasksByRun = computed(() => {
	const grouped = new Map<string, SpaceTask[]>();
	for (const task of mockTasks.value) {
		if (!task.workflowRunId) continue;
		const existing = grouped.get(task.workflowRunId) ?? [];
		grouped.set(task.workflowRunId, [...existing, task]);
	}
	return grouped;
});

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
		instructions: '',
		createdAt: 1000000,
		updatedAt: 1000000,
		...overrides,
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Coding Workflow',
		description: 'Workflow description',
		nodes: [
			{ id: 'step-abc123', name: 'Plan', agentId: 'agent-1' },
			{ id: 'step-def456', name: 'Code', agentId: 'agent-1' },
		],
		startNodeId: 'step-abc123',
		rules: [],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeWorkflowRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: 'Fix auth flow',
		status: 'in_progress',
		iterationCount: 1,
		maxIterations: 10,
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
		mockWorkflows.value = [];
		mockWorkflowRuns.value = [];
		mockTaskActivity.value = new Map();
		mockUpdateTask.mockClear();
		mockSubscribeTaskActivity.mockClear();
		mockUnsubscribeTaskActivity.mockClear();
		mockNavigateToSpaceSession.mockClear();
		mockNavigateToSpaceAgent.mockClear();
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

	it('subscribes to live task activity and renders agent roster rows', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		mockTaskActivity.value = new Map([
			[
				'task-1',
				[
					{
						id: 'session-abc',
						sessionId: 'session-abc',
						kind: 'task_agent',
						label: 'Task Agent',
						role: 'task-agent',
						state: 'active',
						processingStatus: 'processing',
						processingPhase: 'thinking',
						messageCount: 3,
						taskId: 'task-1',
						taskTitle: 'Fix the bug',
						taskStatus: 'in_progress',
						currentStep: 'Reviewing the latest direction',
						updatedAt: Date.now(),
					},
				],
			],
		]);

		const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(mockSubscribeTaskActivity).toHaveBeenCalledWith('task-1');
		expect(getByText('Agent Activity')).toBeTruthy();
		expect(getAllByText('Task Agent').length).toBeGreaterThan(0);
		expect(getAllByText('Reviewing the latest direction').length).toBeGreaterThan(0);
		expect(getByText('Messages')).toBeTruthy();
		expect(getByText('3')).toBeTruthy();
	});

	it('renders status badge', () => {
		mockTasks.value = [makeTask({ status: 'in_progress' })];
		const { getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText('In Progress').length).toBeGreaterThan(0);
	});

	it('renders priority indicator', () => {
		mockTasks.value = [makeTask({ priority: 'high' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('High Priority')).toBeTruthy();
	});

	it('shows workflow context and canvas when workflowRunId is present', () => {
		mockWorkflows.value = [makeWorkflow()];
		mockWorkflowRuns.value = [makeWorkflowRun()];
		mockTasks.value = [
			makeTask({ workflowRunId: 'run-1', workflowNodeId: 'step-abc123' }),
			makeTask({
				id: 'task-2',
				title: 'Sibling Task',
				workflowRunId: 'run-1',
				workflowNodeId: 'step-def456',
				status: 'review',
			}),
		];
		const { getByText, getByTestId, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Workflow Context')).toBeTruthy();
		expect(getByText('Coding Workflow')).toBeTruthy();
		expect(getByText('Fix auth flow')).toBeTruthy();
		expect(getAllByText('Plan').length).toBeGreaterThan(0);
		expect(getByText('Agent Activity')).toBeTruthy();
		expect(getByText('Sibling Task')).toBeTruthy();
		expect(getByTestId('workflow-canvas')).toBeTruthy();
	});

	it('does NOT show workflow context without workflowRunId', () => {
		mockTasks.value = [makeTask()];
		const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByText(/Workflow Context/)).toBeNull();
	});

	it('renders description', () => {
		mockTasks.value = [makeTask({ description: 'Detailed description here' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Detailed description here')).toBeTruthy();
	});

	it('renders current step when present', () => {
		mockTasks.value = [makeTask({ currentStep: 'Running linter' })];
		const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Conversation')).toBeTruthy();
		expect(getAllByText('Running linter').length).toBeGreaterThan(0);
	});

	it('renders progress bar when progress > 0', () => {
		mockTasks.value = [makeTask({ progress: 75 })];
		const { getByText, getAllByText, container } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText('Progress').length).toBeGreaterThan(0);
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
		const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Result')).toBeTruthy();
		expect(getAllByText('Build succeeded').length).toBeGreaterThan(0);
	});

	it('renders error section when error exists', () => {
		mockTasks.value = [makeTask({ error: 'Build failed: syntax error' })];
		const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Error')).toBeTruthy();
		expect(getAllByText('Build failed: syntax error').length).toBeGreaterThan(0);
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

	it('calls onClose when back button is clicked', () => {
		mockTasks.value = [makeTask()];
		const onClose = vi.fn();
		const { container } = render(<SpaceTaskPane taskId="task-1" onClose={onClose} />);
		const backBtn = container.querySelector('[data-testid="task-back-button"]');
		expect(backBtn).toBeTruthy();
		fireEvent.click(backBtn!);
		expect(onClose).toHaveBeenCalled();
	});

	it('does not render back button when onClose is not provided', () => {
		mockTasks.value = [makeTask()];
		const { container } = render(<SpaceTaskPane taskId="task-1" />);
		expect(container.querySelector('[data-testid="task-back-button"]')).toBeNull();
	});

	it('shows "View Agent Session" button when taskAgentSessionId is set and spaceId is provided', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { container } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(container.querySelector('[data-testid="view-agent-session-btn"]')).toBeTruthy();
	});

	it('hides "View Agent Session" button when taskAgentSessionId is null', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: null })];
		const { container } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(container.querySelector('[data-testid="view-agent-session-btn"]')).toBeNull();
		expect(container.querySelector('[data-testid="open-space-agent-btn"]')).toBeTruthy();
	});

	it('shows "View Agent Session" button when task provides its own spaceId', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByTestId('view-agent-session-btn')).toBeTruthy();
	});

	it('shows "View Worker Session" when activeSession is "worker"', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc', activeSession: 'worker' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('view-agent-session-btn').textContent).toBe('View Worker Session');
	});

	it('shows "View Leader Session" when activeSession is "leader"', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc', activeSession: 'leader' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('view-agent-session-btn').textContent).toBe('View Leader Session');
	});

	it('shows "View Agent Session" when activeSession is null', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc', activeSession: null })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('view-agent-session-btn').textContent).toBe('View Agent Session');
	});

	it('calls navigateToSpaceSession when "View Agent Session" button is clicked', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		fireEvent.click(getByTestId('view-agent-session-btn'));
		expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'session-abc');
	});

	it('shows "Open Space Agent" button when task has no linked agent session', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: null })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('open-space-agent-btn').textContent).toBe('Open Space Agent');
	});

	it('calls navigateToSpaceAgent when "Open Space Agent" button is clicked', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: null })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		fireEvent.click(getByTestId('open-space-agent-btn'));
		expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
	});

	it('keeps the latest human handoff visible after submission', () => {
		mockTasks.value = [
			makeTask({
				status: 'in_progress',
				inputDraft: 'Shift the dashboard toward tasks and make the next action obvious.',
			}),
		];
		const { getByText, getAllByText, getByTestId } = render(
			<SpaceTaskPane taskId="task-1" spaceId="space-1" />
		);
		expect(getByText('Conversation')).toBeTruthy();
		expect(
			getByText('Shift the dashboard toward tasks and make the next action obvious.')
		).toBeTruthy();
		expect(getByText('Your response was sent. Waiting for agent follow-up.')).toBeTruthy();
		expect(getByText('This task is currently handled through Space Agent.')).toBeTruthy();
		expect(getByTestId('open-space-agent-btn')).toBeTruthy();
		expect(
			getAllByText(
				'Your response was saved. Open the space agent to continue the conversation while this task resumes.'
			).length
		).toBeGreaterThan(0);
	});
});

describe('SpaceTaskPane — HumanInputArea submit behavior', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockAgents.value = [];
		mockTaskActivity.value = new Map();
		mockUpdateTask.mockClear();
		mockSubscribeTaskActivity.mockClear();
		mockUnsubscribeTaskActivity.mockClear();
		mockNavigateToSpaceSession.mockClear();
		mockNavigateToSpaceAgent.mockClear();
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
