/**
 * Unit tests for WorkflowCanvas
 *
 * Tests:
 * - Renders "Workflow not found" when workflow missing
 * - Renders "No nodes in workflow" when workflow has no nodes
 * - Renders node boxes for each workflow node
 * - Renders channel paths between nodes
 * - Gate icon rendered ON channel line (not as separate node)
 * - Gate status: open (green), blocked (gray lock), waiting_human (amber)
 * - Human approval gate shows waiting_human when no data
 * - Runtime mode shows live node status (active, completed)
 * - Template mode shows "+ add gate" buttons on channels without gates
 * - Template mode shows remove-gate button on gated channels
 * - Node active status shows pulsing class
 * - Completed node shows checkmark indicator
 * - Active run banner shows when run is needs_attention
 * - Gate data event subscription updates gate status
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceWorkflow, SpaceWorkflowRun, SpaceTask, Gate } from '@neokai/shared';

// ---- Signals for mocking ----
let mockWorkflows: Signal<SpaceWorkflow[]>;
let mockWorkflowRuns: Signal<SpaceWorkflowRun[]>;
let mockTasks: Signal<SpaceTask[]>;
let mockTasksByRun: Signal<Map<string, SpaceTask[]>>;

const mockEventListeners = new Map<string, Array<(data: unknown) => void>>();
const mockHub: { request: Mock; onEvent: Mock } = {
	request: vi.fn(),
	onEvent: vi.fn((event: string, handler: (data: unknown) => void) => {
		if (!mockEventListeners.has(event)) mockEventListeners.set(event, []);
		mockEventListeners.get(event)!.push(handler);
		return () => {
			const handlers = mockEventListeners.get(event) ?? [];
			const idx = handlers.indexOf(handler);
			if (idx >= 0) handlers.splice(idx, 1);
		};
	}),
};

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			workflows: mockWorkflows,
			workflowRuns: mockWorkflowRuns,
			tasks: mockTasks,
			tasksByRun: mockTasksByRun,
		};
	},
}));

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(() => mockHub),
	},
}));

// Initialize signals before component import
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockTasks = signal<SpaceTask[]>([]);
mockTasksByRun = signal<Map<string, SpaceTask[]>>(new Map());

import { WorkflowCanvas } from '../WorkflowCanvas';

// ============================================================================
// Test helpers
// ============================================================================

function makeGate(overrides: Partial<Gate> = {}): Gate {
	return {
		id: 'gate-1',
		condition: { type: 'check', field: 'approved', op: '==', value: true },
		data: {},
		allowedWriterRoles: ['*'],
		description: 'Human approval',
		resetOnCycle: false,
		...overrides,
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'sp-1',
		name: 'Test Workflow',
		description: '',
		nodes: [
			{ id: 'n1', name: 'Planner' },
			{ id: 'n2', name: 'Coder' },
		],
		startNodeId: 'n1',
		rules: [],
		channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way' }],
		gates: [],
		tags: [],
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

function makeRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'sp-1',
		workflowId: 'wf-1',
		title: 'Run 1',
		status: 'in_progress',
		iterationCount: 0,
		maxIterations: 10,
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'sp-1',
		taskNumber: 1,
		title: 'Task 1',
		description: '',
		status: 'pending',
		priority: 'normal',
		dependsOn: [],
		workflowRunId: 'run-1',
		workflowNodeId: 'n1',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('WorkflowCanvas', () => {
	beforeEach(() => {
		mockWorkflows.value = [];
		mockWorkflowRuns.value = [];
		mockTasks.value = [];
		mockTasksByRun.value = new Map();
		mockEventListeners.clear();
		mockHub.request.mockReset();
		mockHub.request.mockResolvedValue({ gateData: [] });
	});

	afterEach(() => {
		cleanup();
	});

	// ---- Empty/error states ----

	it('renders "Workflow not found" when workflow is missing', () => {
		const { getByText } = render(<WorkflowCanvas workflowId="missing" spaceId="sp-1" />);
		expect(getByText('Workflow not found')).toBeTruthy();
	});

	it('renders "No nodes in workflow" when workflow has no nodes', () => {
		mockWorkflows.value = [makeWorkflow({ nodes: [] })];
		const { getByText } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(getByText('No nodes in workflow')).toBeTruthy();
	});

	// ---- Basic rendering ----

	it('renders canvas SVG with correct mode attribute', () => {
		mockWorkflows.value = [makeWorkflow()];
		const { getByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		const canvas = getByTestId('workflow-canvas');
		expect(canvas.getAttribute('data-mode')).toBe('template');
	});

	it('sets data-mode to runtime when runId is provided', () => {
		mockWorkflows.value = [makeWorkflow()];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });
		const { getByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		expect(getByTestId('workflow-canvas').getAttribute('data-mode')).toBe('runtime');
	});

	it('renders a node box for each workflow node', () => {
		mockWorkflows.value = [makeWorkflow()];
		const { getByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(getByTestId('node-n1')).toBeTruthy();
		expect(getByTestId('node-n2')).toBeTruthy();
	});

	it('renders channel path between nodes', () => {
		mockWorkflows.value = [makeWorkflow()];
		const { getByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(getByTestId('channel-ch-1')).toBeTruthy();
	});

	// ---- Gate rendering on channel lines ----

	it('renders gate icon ON the channel line (not as separate node)', () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		const { getAllByTestId, queryAllByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />
		);
		// Gate icon should exist
		const gateIcons = getAllByTestId(/^gate-icon-/);
		expect(gateIcons.length).toBeGreaterThan(0);
		// Should only be 2 nodes, not 3 (gate is not a separate node)
		expect(queryAllByTestId(/^node-/).length).toBe(2);
	});

	it('shows waiting_human gate status for human approval gate with no data', () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockHub.request.mockResolvedValue({ gateData: [] });
		const { getByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		// Initial state (no gate data loaded yet) - gate status should be waiting_human
		expect(getByTestId('gate-icon-waiting_human')).toBeTruthy();
	});

	it('shows open gate status when approved=true in gate data', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockHub.request.mockResolvedValue({
			gateData: [{ runId: 'run-1', gateId: 'gate-1', data: { approved: true }, updatedAt: 2000 }],
		});
		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-open');
	});

	it('shows blocked gate status when approved=false', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockHub.request.mockResolvedValue({
			gateData: [{ runId: 'run-1', gateId: 'gate-1', data: { approved: false }, updatedAt: 2000 }],
		});
		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-blocked');
	});

	it('updates gate status on space.gateData.updated event', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);

		// Initially waiting_human (no data)
		await findByTestId('gate-icon-waiting_human');

		// Fire gate data update event
		const handlers = mockEventListeners.get('space.gateData.updated') ?? [];
		for (const h of handlers) {
			h({ spaceId: 'sp-1', runId: 'run-1', gateId: 'gate-1', data: { approved: true } });
		}

		// Should now show open
		await findByTestId('gate-icon-open');
	});

	// ---- Node status ----

	it('renders active node with animate-pulse class when task is in_progress', () => {
		const wf = makeWorkflow();
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockTasksByRun.value = new Map([
			['run-1', [makeTask({ workflowNodeId: 'n1', status: 'in_progress' })]],
		]);
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { getByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		const node = getByTestId('node-n1');
		expect(node.getAttribute('class')).toContain('animate-pulse');
	});

	it('completed node does not have animate-pulse', () => {
		const wf = makeWorkflow();
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockTasksByRun.value = new Map([
			['run-1', [makeTask({ workflowNodeId: 'n2', status: 'completed' })]],
		]);
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { getByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		const node = getByTestId('node-n2');
		expect(node.getAttribute('class') ?? '').not.toContain('animate-pulse');
	});

	// ---- Run status banner ----

	it('shows needs_attention banner for needs_attention run', () => {
		const wf = makeWorkflow();
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [
			makeRun({ status: 'needs_attention', failureReason: 'humanRejected' }),
		];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { getByText } = render(<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />);
		expect(getByText('Workflow paused — awaiting approval')).toBeTruthy();
	});

	it('does not show banner for in_progress run', () => {
		const wf = makeWorkflow();
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun({ status: 'in_progress' })];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { queryByText } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		expect(queryByText('Workflow paused — awaiting approval')).toBeNull();
	});

	// ---- Template mode ----

	it('shows gate-add-btn on channels without gates in template mode', () => {
		const wf = makeWorkflow({
			gates: [makeGate()], // available gates exist
		});
		mockWorkflows.value = [wf];

		const { getByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(getByTestId('gate-add-btn-ch-1')).toBeTruthy();
	});

	it('shows remove-gate button on gated channels in template mode', () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];

		const { getByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(getByTestId('gate-remove-ch-1')).toBeTruthy();
	});

	it('does not show gate-add-btn in runtime mode', () => {
		const wf = makeWorkflow({ gates: [makeGate()] });
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { queryByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		expect(queryByTestId('gate-add-btn-ch-1')).toBeNull();
	});

	// ---- Gate status evaluation ----

	it('evaluates count gate as open when min is met', async () => {
		const gate = makeGate({
			id: 'vote-gate',
			condition: {
				type: 'count',
				field: 'reviews',
				matchValue: 'approved',
				min: 2,
			},
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'vote-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'vote-gate',
					data: { reviews: { alice: 'approved', bob: 'approved' } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-open');
	});

	it('evaluates count gate as blocked when min not met', async () => {
		const gate = makeGate({
			id: 'vote-gate',
			condition: {
				type: 'count',
				field: 'reviews',
				matchValue: 'approved',
				min: 2,
			},
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'vote-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'vote-gate',
					data: { reviews: { alice: 'approved' } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-blocked');
	});

	// ---- listGateData RPC called on mount ----

	it('calls spaceWorkflowRun.listGateData on mount in runtime mode', async () => {
		const wf = makeWorkflow();
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });

		render(<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />);

		await waitFor(() => {
			expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflowRun.listGateData', {
				runId: 'run-1',
			});
		});
	});

	it('does NOT call spaceWorkflowRun.listGateData in template mode', () => {
		const wf = makeWorkflow();
		mockWorkflows.value = [wf];

		render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);

		expect(mockHub.request).not.toHaveBeenCalledWith(
			'spaceWorkflowRun.listGateData',
			expect.anything()
		);
	});

	// ---- Gate approval action ----

	it('clicking Approve on waiting_human gate calls approveGate RPC', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { findByText, getByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);

		// Click the gate icon to show approve/reject buttons
		const gateIcon = getByTestId('gate-icon-waiting_human');
		fireEvent.click(gateIcon);

		const approveBtn = await findByText('Approve');
		fireEvent.click(approveBtn);

		await waitFor(() => {
			expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
				runId: 'run-1',
				gateId: 'gate-1',
				approved: true,
			});
		});
	});
});
