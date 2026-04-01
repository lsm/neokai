// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceAgent, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';

const { mockNavigateToSpaceSession } = vi.hoisted(() => ({ mockNavigateToSpaceSession: vi.fn() }));
const { mockNavigateToSpaceAgent } = vi.hoisted(() => ({ mockNavigateToSpaceAgent: vi.fn() }));
vi.mock('../../../lib/router', () => ({
	navigateToSpaceSession: mockNavigateToSpaceSession,
	navigateToSpaceAgent: mockNavigateToSpaceAgent,
}));

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockWorkflowRuns: ReturnType<typeof signal<SpaceWorkflowRun[]>>;

const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockEnsureTaskAgentSession = vi.fn();
const mockSendTaskMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			tasks: mockTasks,
			agents: mockAgents,
			workflows: mockWorkflows,
			workflowRuns: mockWorkflowRuns,
			updateTask: mockUpdateTask,
			ensureTaskAgentSession: mockEnsureTaskAgentSession,
			sendTaskMessage: mockSendTaskMessage,
		};
	},
}));

vi.mock('../SpaceTaskUnifiedThread', () => ({
	SpaceTaskUnifiedThread: ({ taskId }: { taskId: string }) => (
		<div data-testid="space-task-unified-thread" data-task-id={taskId} />
	),
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);

import { SpaceTaskPane } from '../SpaceTaskPane';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		title: 'Fix the bug',
		description: 'Task description',
		status: 'pending',
		priority: 'normal',
		dependsOn: [],
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
		mockUpdateTask.mockClear();
		mockEnsureTaskAgentSession.mockReset();
		mockEnsureTaskAgentSession.mockImplementation(async () =>
			makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
		);
		mockSendTaskMessage.mockClear();
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

	it('shows task not found when taskId is missing', () => {
		mockTasks.value = [makeTask()];
		const { getByText } = render(<SpaceTaskPane taskId="missing" />);
		expect(getByText('Task not found')).toBeTruthy();
	});

	it('renders title, status, and high priority badge', () => {
		mockTasks.value = [makeTask({ title: 'My Task', status: 'in_progress', priority: 'high' })];
		const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('My Task')).toBeTruthy();
		expect(getAllByText('In Progress').length).toBeGreaterThan(0);
		expect(getByText('High Priority')).toBeTruthy();
	});

	it('renders unified task thread component when session exists', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByTestId('task-thread-panel')).toBeTruthy();
		expect(getByTestId('space-task-unified-thread')).toBeTruthy();
	});

	it('shows startup copy while session is being ensured', () => {
		mockEnsureTaskAgentSession.mockImplementation(async () => {
			await new Promise(() => {});
			return makeTask({ status: 'in_progress', taskAgentSessionId: null });
		});
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Starting task thread...')).toBeTruthy();
	});

	it('shows Open Space Agent button when no task session exists', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: null })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('open-space-agent-btn').textContent).toBe('Open Space Agent');
		fireEvent.click(getByTestId('open-space-agent-btn'));
		expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
	});

	it('shows View Agent Session button when task session exists', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		fireEvent.click(getByTestId('view-agent-session-btn'));
		expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'session-abc');
	});

	it('calls onClose when back button is clicked', () => {
		mockTasks.value = [makeTask()];
		const onClose = vi.fn();
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" onClose={onClose} />);
		fireEvent.click(getByTestId('task-back-button'));
		expect(onClose).toHaveBeenCalled();
	});
});

describe('SpaceTaskPane — composer', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockSendTaskMessage.mockClear();
		mockEnsureTaskAgentSession.mockReset();
		mockEnsureTaskAgentSession.mockImplementation(async () =>
			makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
		);
	});

	afterEach(() => {
		cleanup();
	});

	it('sends a message when a task session exists', async () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		fireEvent.input(
			getByPlaceholderText('Message the task agent (Enter to send, Shift+Enter for newline)'),
			{
				target: { value: 'Looks good to me' },
			}
		);
		fireEvent.click(getByText('Send to Task Agent'));

		await waitFor(() =>
			expect(mockSendTaskMessage).toHaveBeenCalledWith('task-1', 'Looks good to me')
		);
		expect(mockEnsureTaskAgentSession).toHaveBeenCalledWith('task-1');
	});

	it('shows send error text when sending fails', async () => {
		mockSendTaskMessage.mockRejectedValueOnce(new Error('Invalid transition'));
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		fireEvent.input(
			getByPlaceholderText('Message the task agent (Enter to send, Shift+Enter for newline)'),
			{
				target: { value: 'Approved' },
			}
		);
		fireEvent.click(getByText('Send to Task Agent'));

		await waitFor(() => expect(getByText('Invalid transition')).toBeTruthy());
	});

	it('does not submit empty message', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		fireEvent.click(getByText('Send to Task Agent'));
		expect(mockSendTaskMessage).not.toHaveBeenCalled();
	});
});
