// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceAgent, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';

const { mockNavigateToSpaceAgent } = vi.hoisted(() => ({ mockNavigateToSpaceAgent: vi.fn() }));
vi.mock('../../../lib/router', () => ({
	navigateToSpaceAgent: mockNavigateToSpaceAgent,
}));

// Plain signal-like holders for the overlay signals — hoisted so the mock factory can reference them
const { mockSpaceOverlaySessionIdSignal, mockSpaceOverlayAgentNameSignal } = vi.hoisted(() => ({
	mockSpaceOverlaySessionIdSignal: { value: null as string | null },
	mockSpaceOverlayAgentNameSignal: { value: null as string | null },
}));
vi.mock('../../../lib/signals', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get spaceOverlaySessionIdSignal() {
			return mockSpaceOverlaySessionIdSignal;
		},
		get spaceOverlayAgentNameSignal() {
			return mockSpaceOverlayAgentNameSignal;
		},
	};
});

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
		status: 'open',
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
		mockNavigateToSpaceAgent.mockClear();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
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

	it('shows View Agent Session button when task session exists and opens overlay on click', () => {
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		fireEvent.click(getByTestId('view-agent-session-btn'));
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-abc');
		// agentActionLabel for a task with no activeSession is "View Agent Session"
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('View Agent Session');
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

	it('disables textarea and shows Sending... button during send', async () => {
		let resolveSend: () => void;
		const sendPromise = new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		mockSendTaskMessage.mockReturnValueOnce(sendPromise);
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText(
			'Message the task agent (Enter to send, Shift+Enter for newline)'
		);
		fireEvent.input(textarea, { target: { value: 'Work in progress check' } });
		fireEvent.click(getByText('Send to Task Agent'));

		// While sending: button should say Sending... and textarea should be disabled
		await waitFor(() => expect(getByText('Sending...')).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).disabled).toBe(true);

		// Resolve and verify state normalizes
		resolveSend!();
		await waitFor(() => expect(getByText('Send to Task Agent')).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
	});

	it('clears draft after successful send', async () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText(
			'Message the task agent (Enter to send, Shift+Enter for newline)'
		) as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Approve the PR' } });
		expect(textarea.value).toBe('Approve the PR');

		fireEvent.submit(textarea.form!);

		await waitFor(() =>
			expect(mockSendTaskMessage).toHaveBeenCalledWith('task-1', 'Approve the PR')
		);
		await waitFor(() => expect(textarea.value).toBe(''));
	});

	it('submits message on Enter key (without Shift)', async () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText(
			'Message the task agent (Enter to send, Shift+Enter for newline)'
		);
		fireEvent.input(textarea, { target: { value: 'Quick approve' } });
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

		await waitFor(() =>
			expect(mockSendTaskMessage).toHaveBeenCalledWith('task-1', 'Quick approve')
		);
	});

	it('does not submit on Shift+Enter (newline insertion)', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText(
			'Message the task agent (Enter to send, Shift+Enter for newline)'
		);
		fireEvent.input(textarea, { target: { value: 'line one' } });
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

		expect(mockSendTaskMessage).not.toHaveBeenCalled();
	});

	it('calls ensureTaskAgentSession when task has no session before send', async () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
		const { getByPlaceholderText, getByText } = render(<SpaceTaskPane taskId="task-1" />);

		// Wait for the auto-ensure effect to fire and finish
		await waitFor(() => expect(mockEnsureTaskAgentSession).toHaveBeenCalled());

		const textarea = getByPlaceholderText(
			'Message the task agent (Enter to send, Shift+Enter for newline)'
		);
		fireEvent.input(textarea, { target: { value: 'Can you check this?' } });
		fireEvent.click(getByText('Send to Task Agent'));

		await waitFor(() =>
			expect(mockSendTaskMessage).toHaveBeenCalledWith('task-1', 'Can you check this?')
		);
	});

	it('clears threadSendError when a new send succeeds', async () => {
		mockSendTaskMessage.mockRejectedValueOnce(new Error('Temporary error'));
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByText, queryByText } = render(
			<SpaceTaskPane taskId="task-1" />
		);

		const textarea = getByPlaceholderText(
			'Message the task agent (Enter to send, Shift+Enter for newline)'
		);

		// First send fails
		fireEvent.input(textarea, { target: { value: 'First try' } });
		fireEvent.click(getByText('Send to Task Agent'));
		await waitFor(() => expect(getByText('Temporary error')).toBeTruthy());

		// Second send succeeds — error should be cleared
		mockSendTaskMessage.mockResolvedValueOnce(undefined);
		fireEvent.input(textarea, { target: { value: 'Second try' } });
		fireEvent.click(getByText('Send to Task Agent'));
		await waitFor(() => expect(queryByText('Temporary error')).toBeNull());
	});
});

describe('SpaceTaskPane — blocked reason banner', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockEnsureTaskAgentSession.mockReset();
		mockEnsureTaskAgentSession.mockImplementation(async () =>
			makeTask({ status: 'blocked', taskAgentSessionId: 'session-ensured' })
		);
	});

	afterEach(() => {
		cleanup();
	});

	it('shows blocked reason banner when task is blocked with result', () => {
		mockTasks.value = [
			makeTask({
				status: 'blocked',
				result: 'Waiting for API key configuration',
				taskAgentSessionId: 'session-abc',
			}),
		];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		const banner = getByTestId('task-blocked-banner');
		expect(banner).toBeTruthy();
		expect(banner.textContent).toContain('Blocked');
		expect(banner.textContent).toContain('Waiting for API key configuration');
	});

	it('does not show blocked reason banner when task is blocked without result', () => {
		mockTasks.value = [
			makeTask({ status: 'blocked', result: null, taskAgentSessionId: 'session-abc' }),
		];
		const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByTestId('task-blocked-banner')).toBeNull();
	});

	it('does not show blocked banner for non-blocked tasks', () => {
		mockTasks.value = [
			makeTask({
				status: 'in_progress',
				result: 'Some result',
				taskAgentSessionId: 'session-abc',
			}),
		];
		const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		expect(queryByTestId('task-blocked-banner')).toBeNull();
	});

	it('shows status label as Blocked in the header', () => {
		mockTasks.value = [
			makeTask({
				status: 'blocked',
				result: 'Need human input',
				taskAgentSessionId: 'session-abc',
			}),
		];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByTestId('task-status-label').textContent).toBe('Blocked');
	});
});
