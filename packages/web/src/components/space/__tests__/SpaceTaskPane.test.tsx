// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type {
	SpaceAgent,
	SpaceTask,
	SpaceTaskActivityMember,
	SpaceWorkflow,
	SpaceWorkflowRun,
} from '@neokai/shared';

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
let mockTaskActivity: ReturnType<typeof signal<Map<string, SpaceTaskActivityMember[]>>>;
let mockNodeExecutionsByNodeId: ReturnType<typeof signal<Map<string, unknown[]>>>;

const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockEnsureTaskAgentSession = vi.fn();
const mockSendTaskMessage = vi.fn().mockResolvedValue(undefined);
const mockSubscribeTaskActivity = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribeTaskActivity = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			tasks: mockTasks,
			agents: mockAgents,
			workflows: mockWorkflows,
			workflowRuns: mockWorkflowRuns,
			taskActivity: mockTaskActivity,
			nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
			updateTask: mockUpdateTask,
			ensureTaskAgentSession: mockEnsureTaskAgentSession,
			sendTaskMessage: mockSendTaskMessage,
			subscribeTaskActivity: mockSubscribeTaskActivity,
			unsubscribeTaskActivity: mockUnsubscribeTaskActivity,
			ensureConfigData: vi.fn().mockResolvedValue(undefined),
			ensureNodeExecutions: vi.fn().mockResolvedValue(undefined),
		};
	},
}));

function makeWorkflowRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'workflow-1',
		title: 'Test Run',
		status: 'in_progress',
		startedAt: Date.now(),
		completedAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

vi.mock('../SpaceTaskUnifiedThread', () => ({
	SpaceTaskUnifiedThread: ({ taskId }: { taskId: string }) => (
		<div data-testid="space-task-unified-thread" data-task-id={taskId} />
	),
}));

const { mockWorkflowCanvasOnNodeClick } = vi.hoisted(() => ({
	mockWorkflowCanvasOnNodeClick: vi.fn(),
}));

vi.mock('../ReadOnlyWorkflowCanvas', () => ({
	ReadOnlyWorkflowCanvas: ({
		workflowId,
		runId,
		spaceId,
		onNodeClick,
		class: className,
	}: {
		workflowId: string;
		runId?: string | null;
		spaceId: string;
		onNodeClick?: (nodeId: string) => void;
		class?: string;
	}) => {
		// Expose the onNodeClick for testing
		mockWorkflowCanvasOnNodeClick.mockImplementation(onNodeClick);
		return (
			<div
				data-testid="workflow-canvas"
				data-workflow-id={workflowId}
				data-run-id={runId}
				data-space-id={spaceId}
				class={className}
			/>
		);
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockTaskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());
mockNodeExecutionsByNodeId = signal<Map<string, unknown[]>>(new Map());

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
		mockTaskActivity.value = new Map();
		mockUpdateTask.mockClear();
		mockEnsureTaskAgentSession.mockReset();
		mockEnsureTaskAgentSession.mockImplementation(async () =>
			makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
		);
		mockSendTaskMessage.mockClear();
		mockNavigateToSpaceAgent.mockClear();
		mockSubscribeTaskActivity.mockClear();
		mockUnsubscribeTaskActivity.mockClear();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
		mockWorkflowCanvasOnNodeClick.mockClear();
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

	it('shows unavailable-thread copy when no task session exists', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
		const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
		expect(getByText('Task thread is not available yet.')).toBeTruthy();
		expect(getByText('Keep this view open while the task thread starts.')).toBeTruthy();
	});

	it('opens Space Agent from task actions dropdown when no task session exists', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: null })];
		const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		fireEvent.click(getByTestId('task-actions-menu-trigger'));
		fireEvent.click(getByText('Open Space Agent'));
		expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
	});

	it('opens overlay from task actions dropdown when task session exists', () => {
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		fireEvent.click(getByTestId('task-actions-menu-trigger'));
		fireEvent.click(getByText('View Agent Session'));
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-abc');
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
		const { getByPlaceholderText, getByTestId } = render(<SpaceTaskPane taskId="task-1" />);

		fireEvent.input(getByPlaceholderText('Message task agent...'), {
			target: { value: 'Looks good to me' },
		});
		fireEvent.click(getByTestId('send-button'));

		await waitFor(() =>
			expect(mockSendTaskMessage).toHaveBeenCalledWith('task-1', 'Looks good to me')
		);
		expect(mockEnsureTaskAgentSession).not.toHaveBeenCalled();
	});

	it('shows send error text when sending fails', async () => {
		mockSendTaskMessage.mockRejectedValueOnce(new Error('Invalid transition'));
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByText, getByTestId } = render(
			<SpaceTaskPane taskId="task-1" />
		);

		fireEvent.input(getByPlaceholderText('Message task agent...'), {
			target: { value: 'Approved' },
		});
		fireEvent.click(getByTestId('send-button'));

		await waitFor(() => expect(getByText('Invalid transition')).toBeTruthy());
	});

	it('does not submit empty message', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
		fireEvent.click(getByTestId('send-button'));
		expect(mockSendTaskMessage).not.toHaveBeenCalled();
	});

	it('disables textarea while send is in flight and re-enables after completion', async () => {
		let resolveSend: () => void;
		const sendPromise = new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		mockSendTaskMessage.mockReturnValueOnce(sendPromise);
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByTestId } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText('Message task agent...') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Work in progress check' } });
		fireEvent.click(getByTestId('send-button'));

		await waitFor(() => expect(textarea.disabled).toBe(true));

		resolveSend!();
		await waitFor(() => expect(textarea.disabled).toBe(false));
	});

	it('clears draft after successful send', async () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText('Message task agent...') as HTMLTextAreaElement;
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

		const textarea = getByPlaceholderText('Message task agent...');
		fireEvent.input(textarea, { target: { value: 'Quick approve' } });
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

		await waitFor(() =>
			expect(mockSendTaskMessage).toHaveBeenCalledWith('task-1', 'Quick approve')
		);
	});

	it('does not submit on Shift+Enter (newline insertion)', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

		const textarea = getByPlaceholderText('Message task agent...');
		fireEvent.input(textarea, { target: { value: 'line one' } });
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

		expect(mockSendTaskMessage).not.toHaveBeenCalled();
	});

	it('renders composer with auto-ensure placeholder when task has no session yet', () => {
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
		const { getByPlaceholderText, getByTestId } = render(<SpaceTaskPane taskId="task-1" />);

		expect(getByPlaceholderText('Message task agent (auto-start)...')).toBeTruthy();
		expect(getByTestId('send-button')).toBeTruthy();
		expect(mockEnsureTaskAgentSession).not.toHaveBeenCalled();
	});

	it('clears threadSendError when a new send succeeds', async () => {
		mockSendTaskMessage.mockRejectedValueOnce(new Error('Temporary error'));
		mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
		const { getByPlaceholderText, getByText, queryByText, getByTestId } = render(
			<SpaceTaskPane taskId="task-1" />
		);

		const textarea = getByPlaceholderText('Message task agent...');

		// First send fails
		fireEvent.input(textarea, { target: { value: 'First try' } });
		fireEvent.click(getByTestId('send-button'));
		await waitFor(() => expect(getByText('Temporary error')).toBeTruthy());

		// Second send succeeds — error should be cleared
		mockSendTaskMessage.mockResolvedValueOnce(undefined);
		fireEvent.input(textarea, { target: { value: 'Second try' } });
		fireEvent.click(getByTestId('send-button'));
		await waitFor(() => expect(queryByText('Temporary error')).toBeNull());
	});
});

describe('SpaceTaskPane — canvas toggle', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockWorkflowRuns.value = [];
		mockWorkflows.value = [];
		mockNodeExecutionsByNodeId.value = new Map();
		mockEnsureTaskAgentSession.mockReset();
		mockEnsureTaskAgentSession.mockImplementation(async () =>
			makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
		);
		mockWorkflowCanvasOnNodeClick.mockClear();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
	});

	afterEach(() => {
		cleanup();
	});

	it('does not show canvas toggle for tasks without workflowRunId', () => {
		mockTasks.value = [makeTask({ workflowRunId: null })];
		const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(queryByTestId('canvas-toggle')).toBeNull();
	});

	it('does not show canvas toggle for workflow tasks without a matching run in the store', () => {
		// task has workflowRunId but no run in the store → canvasWorkflowId is null
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = []; // no matching run
		const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(queryByTestId('canvas-toggle')).toBeNull();
	});

	it('shows canvas toggle for tasks with workflowRunId and a matching run', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('canvas-toggle')).toBeTruthy();
	});

	it('clicking canvas toggle switches to canvas view', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		const { getByTestId, queryByTestId } = render(
			<SpaceTaskPane taskId="task-1" spaceId="space-1" />
		);
		// Thread view is shown initially
		expect(queryByTestId('canvas-view')).toBeNull();
		expect(queryByTestId('task-thread-panel')).toBeTruthy();

		fireEvent.click(getByTestId('canvas-toggle'));

		// Canvas view is now shown
		expect(getByTestId('canvas-view')).toBeTruthy();
		expect(getByTestId('workflow-canvas')).toBeTruthy();
		expect(queryByTestId('task-thread-panel')).toBeNull();
	});

	it('clicking canvas toggle again switches back to thread view', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		const { getByTestId, queryByTestId } = render(
			<SpaceTaskPane taskId="task-1" spaceId="space-1" />
		);

		fireEvent.click(getByTestId('canvas-toggle'));
		expect(getByTestId('canvas-view')).toBeTruthy();

		fireEvent.click(getByTestId('canvas-toggle'));
		expect(queryByTestId('canvas-view')).toBeNull();
		expect(getByTestId('task-thread-panel')).toBeTruthy();
	});

	it('canvas view renders WorkflowCanvas with correct run and workflow IDs', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1', spaceId: 'space-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'wf-abc' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

		fireEvent.click(getByTestId('canvas-toggle'));

		const canvas = getByTestId('workflow-canvas');
		expect(canvas.getAttribute('data-workflow-id')).toBe('wf-abc');
		expect(canvas.getAttribute('data-run-id')).toBe('run-1');
	});

	it('switching to artifacts view closes canvas view', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		const { getByTestId, queryByTestId } = render(
			<SpaceTaskPane taskId="task-1" spaceId="space-1" />
		);

		// Open canvas first
		fireEvent.click(getByTestId('canvas-toggle'));
		expect(getByTestId('canvas-view')).toBeTruthy();

		// Open artifacts — should close canvas
		fireEvent.click(getByTestId('artifacts-toggle'));
		expect(queryByTestId('canvas-view')).toBeNull();
	});

	it('canvas toggle aria-pressed reflects current state', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

		const btn = getByTestId('canvas-toggle');
		expect(btn.getAttribute('aria-pressed')).toBe('false');

		fireEvent.click(btn);
		expect(btn.getAttribute('aria-pressed')).toBe('true');
	});

	it('canvas node click opens overlay with the task agent session (fallback when no node execution)', () => {
		mockTasks.value = [
			makeTask({
				workflowRunId: 'run-1',
				taskAgentSessionId: 'session-task',
				activeSession: null,
			}),
		];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		// No node executions → falls back to task agent session
		mockNodeExecutionsByNodeId.value = new Map();
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

		fireEvent.click(getByTestId('canvas-toggle'));
		expect(getByTestId('workflow-canvas')).toBeTruthy();

		// Simulate a node click — no node execution exists, falls back to task session
		mockWorkflowCanvasOnNodeClick('node-1', 'Coder Node', ['coder']);

		expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-task');
	});

	it('canvas node click opens overlay with the node-specific agent session (primary path)', () => {
		mockTasks.value = [
			makeTask({
				id: 'task-1',
				workflowRunId: 'run-1',
				taskAgentSessionId: 'session-task',
				activeSession: null,
			}),
		];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		mockAgents.value = [
			{
				id: 'agent-1',
				spaceId: 'space-1',
				name: 'Coder Node',
				instructions: null,
				createdAt: 1000,
				updatedAt: 1000,
			},
		];
		mockWorkflows.value = [
			{
				id: 'workflow-1',
				spaceId: 'space-1',
				name: 'Wf',
				description: '',
				nodes: [
					{ id: 'node-1', name: 'Coder Node', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: 'node-1',
				channels: [],
				gates: [],
				tags: [],
				createdAt: 1000,
				updatedAt: 1000,
			},
		];
		// node-1 has an activity member (node_agent) with a sessionId — mirrors the
		// "Agents" buttons which use taskActivity as their data source.
		mockTaskActivity.value = new Map([
			[
				'task-1',
				[
					{
						id: 'session-node-agent',
						sessionId: 'session-node-agent',
						kind: 'node_agent' as const,
						label: 'Coder Node',
						role: 'coder',
						state: 'active' as const,
						messageCount: 0,
						nodeExecution: {
							nodeId: 'node-1',
							agentName: 'coder',
							status: 'in_progress' as const,
						},
					},
				],
			],
		]);
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

		fireEvent.click(getByTestId('canvas-toggle'));
		expect(getByTestId('workflow-canvas')).toBeTruthy();

		// Simulate a node click — activity member exists with sessionId
		mockWorkflowCanvasOnNodeClick('node-1', 'Coder Node', ['coder']);

		// Should use the activity member's session, NOT the parent task's session
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-node-agent');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Node');
	});

	it('switching to canvas view closes the artifacts panel', () => {
		mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
		const { getByTestId, queryByTestId } = render(
			<SpaceTaskPane taskId="task-1" spaceId="space-1" />
		);

		// Open artifacts first
		fireEvent.click(getByTestId('artifacts-toggle'));
		// Artifacts panel replaces the thread — canvas-view is not shown
		expect(queryByTestId('canvas-view')).toBeNull();

		// Open canvas — should close artifacts and show canvas
		fireEvent.click(getByTestId('canvas-toggle'));
		expect(getByTestId('canvas-view')).toBeTruthy();
		// thread panel is not shown when canvas is active
		expect(queryByTestId('task-thread-panel')).toBeNull();
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

function makeActivityMember(
	overrides: Partial<SpaceTaskActivityMember> = {}
): SpaceTaskActivityMember {
	return {
		id: 'member-1',
		sessionId: 'session-member-1',
		kind: 'task_agent',
		label: 'Task Agent',
		role: 'task-agent',
		state: 'active',
		messageCount: 3,
		...overrides,
	};
}

describe('SpaceTaskPane — activity members actions', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockTaskActivity.value = new Map();
		mockEnsureTaskAgentSession.mockReset();
		mockEnsureTaskAgentSession.mockImplementation(async () =>
			makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
		);
		mockSubscribeTaskActivity.mockClear();
		mockUnsubscribeTaskActivity.mockClear();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
	});

	afterEach(() => {
		cleanup();
	});

	it('does not show activity member actions when no activity members exist', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { getByTestId, queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		fireEvent.click(getByTestId('task-actions-menu-trigger'));
		expect(queryByText('Open Task Agent (Active)')).toBeNull();
	});

	it('shows activity members as task action menu items with state', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		mockTaskActivity.value = new Map([
			[
				'task-1',
				[
					makeActivityMember({
						id: 'm1',
						sessionId: 'sess-1',
						label: 'Task Agent',
						state: 'active',
					}),
					makeActivityMember({ id: 'm2', sessionId: 'sess-2', label: 'Coder', state: 'queued' }),
				],
			],
		]);
		const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
		fireEvent.click(getByTestId('task-actions-menu-trigger'));
		expect(getByText('Open Task Agent (Active)')).toBeTruthy();
		expect(getByText('Open Coder (Queued)')).toBeTruthy();
	});

	it('clicking an activity member action opens overlay with correct session and label', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		mockTaskActivity.value = new Map([
			[
				'task-1',
				[
					makeActivityMember({
						id: 'm1',
						sessionId: 'sess-coder',
						label: 'Coder Agent',
						state: 'active',
					}),
				],
			],
		]);
		const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
		fireEvent.click(getByTestId('task-actions-menu-trigger'));
		fireEvent.click(getByText('Open Coder Agent (Active)'));
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-coder');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Agent');
	});

	it('shows only members for the current task (not other tasks)', () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		mockTaskActivity.value = new Map([
			['task-1', [makeActivityMember({ id: 'm1', label: 'Task 1 Agent', state: 'active' })]],
			['task-2', [makeActivityMember({ id: 'm2', label: 'Task 2 Agent', state: 'idle' })]],
		]);
		const { getByTestId, getByText, queryByText } = render(<SpaceTaskPane taskId="task-1" />);
		fireEvent.click(getByTestId('task-actions-menu-trigger'));
		expect(getByText('Open Task 1 Agent (Active)')).toBeTruthy();
		expect(queryByText('Open Task 2 Agent (Idle)')).toBeNull();
	});

	it('calls subscribeTaskActivity when a taskId is provided', async () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		render(<SpaceTaskPane taskId="task-1" />);
		await waitFor(() => expect(mockSubscribeTaskActivity).toHaveBeenCalledWith('task-1'));
	});

	it('does not call subscribeTaskActivity when taskId is null', () => {
		render(<SpaceTaskPane taskId={null} />);
		expect(mockSubscribeTaskActivity).not.toHaveBeenCalled();
	});

	it('calls unsubscribeTaskActivity on unmount', async () => {
		mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
		const { unmount } = render(<SpaceTaskPane taskId="task-1" />);
		await waitFor(() => expect(mockSubscribeTaskActivity).toHaveBeenCalledWith('task-1'));
		unmount();
		expect(mockUnsubscribeTaskActivity).toHaveBeenCalledWith('task-1');
	});
});
