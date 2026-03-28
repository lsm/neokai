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
import { signal } from '@preact/signals';
import type { SpaceTask, SpaceAgent } from '@neokai/shared';

const { mockNavigateToSpaceSession } = vi.hoisted(() => ({
	mockNavigateToSpaceSession: vi.fn(),
}));
vi.mock('../../../lib/router', () => ({
	navigateToSpaceSession: mockNavigateToSpaceSession,
}));

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			tasks: mockTasks,
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
		mockAgents.value = [];
		mockUpdateTask.mockClear();
		mockNavigateToSpaceSession.mockClear();
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
		const { getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText('In Progress').length).toBeGreaterThan(0);
	});

	it('renders priority indicator', () => {
		mockTasks.value = [makeTask({ priority: 'high' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('High priority')).toBeTruthy();
	});

	it('shows workflow step indicator when workflowRunId is present', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1', workflowNodeId: 'step-abc123' })];
		const { getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getAllByText(/Workflow Step/).length).toBeGreaterThan(0);
		// Should show truncated step ID
		expect(getAllByText(/step-ab/).length).toBeGreaterThan(0);
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
		const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Current Step')).toBeTruthy();
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
	});

	it('hides "View Agent Session" button when spaceId is not provided', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { container } = render(<SpaceTaskPane taskId="task-1" />);
		expect(container.querySelector('[data-testid="view-agent-session-btn"]')).toBeNull();
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
});

describe('SpaceTaskPane — HumanInputArea submit behavior', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockAgents.value = [];
		mockUpdateTask.mockClear();
		mockNavigateToSpaceSession.mockClear();
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
