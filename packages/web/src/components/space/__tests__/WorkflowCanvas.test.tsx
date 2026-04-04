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
 * - Runtime mode shows live node status (active, done)
 * - Template mode shows "+ add gate" buttons on channels without gates
 * - Template mode shows remove-gate button on gated channels
 * - Node active status shows pulsing class
 * - Completed node shows checkmark indicator
 * - Active run banner shows when run is blocked
 * - Gate data event subscription updates gate status
 * - "View Artifacts" button opens artifacts panel overlay for waiting_human gate
 * - Closing the artifacts panel overlay hides it
 * - Script-only gate (no fields) with _scriptResult.success:false shows blocked icon
 * - Script error badge rendered with data-testid="gate-script-error-badge"
 * - Script-only gate with no _scriptResult shows open icon (backward compat)
 * - Gate with fields and script: _scriptResult.success:false → blocked
 * - _scriptResult.success:true → gate follows field evaluation
 * - Script error badge has reason in title attribute
 * - Script error badge NOT shown in template mode
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
		// getHub() is the async version used by fetchGateData — resolves immediately in tests
		getHub: vi.fn(() => Promise.resolve(mockHub)),
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
		fields: [
			{ name: 'approved', type: 'boolean', writers: ['human'], check: { op: '==', value: true } },
		],
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
			{ id: 'n1', name: 'Planner', agents: [] },
			{ id: 'n2', name: 'Coder', agents: [] },
		],
		startNodeId: 'n1',
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
		startedAt: null,
		completedAt: null,
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
		status: 'open',
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		workflowRunId: 'run-1',
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

	it('renders cyclic workflows without hanging the layout pass', () => {
		mockWorkflows.value = [
			makeWorkflow({
				nodes: [
					{ id: 'n1', name: 'Plan', agents: [] },
					{ id: 'n2', name: 'Code', agents: [] },
					{ id: 'n3', name: 'Verify', agents: [] },
				],
				startNodeId: 'n1',
				channels: [
					{ id: 'ch-1', from: 'Plan', to: 'Code', direction: 'one-way' },
					{ id: 'ch-2', from: 'Code', to: 'Verify', direction: 'one-way' },
					{ id: 'ch-3', from: 'Verify', to: 'Plan', direction: 'one-way' },
				],
			}),
		];
		const { getByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(getByTestId('node-n1')).toBeTruthy();
		expect(getByTestId('node-n2')).toBeTruthy();
		expect(getByTestId('node-n3')).toBeTruthy();
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
		mockTasksByRun.value = new Map([['run-1', [makeTask({ status: 'in_progress' })]]]);
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
		mockTasksByRun.value = new Map([['run-1', [makeTask({ status: 'done' })]]]);
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
		mockWorkflowRuns.value = [makeRun({ status: 'blocked', failureReason: 'humanRejected' })];
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
			fields: [
				{
					name: 'reviews',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
			],
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
			fields: [
				{
					name: 'reviews',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
			],
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

	// ---- View Artifacts overlay ----

	it('"View Artifacts" button opens artifacts panel overlay for waiting_human gate', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		// listGateData returns empty so gate stays waiting_human;
		// getGateArtifacts is called by GateArtifactsView — keep it pending so we only test the overlay mount
		mockHub.request.mockImplementation((method: string) => {
			if (method === 'spaceWorkflowRun.listGateData') return Promise.resolve({ gateData: [] });
			return new Promise(() => {});
		});

		const { findByText, getByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);

		// Open the gate icon action popup
		fireEvent.click(getByTestId('gate-icon-waiting_human'));
		// Click "View Artifacts"
		const viewBtn = await findByText('View Artifacts');
		fireEvent.click(viewBtn);

		// Overlay must be visible
		await waitFor(() => expect(getByTestId('artifacts-panel-overlay')).toBeTruthy());
	});

	it('closing the artifacts panel overlay hides it', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockImplementation((method: string) => {
			if (method === 'spaceWorkflowRun.listGateData') return Promise.resolve({ gateData: [] });
			return new Promise(() => {});
		});

		const { findByText, getByTestId, queryByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);

		// Open overlay
		fireEvent.click(getByTestId('gate-icon-waiting_human'));
		fireEvent.click(await findByText('View Artifacts'));
		await waitFor(() => expect(getByTestId('artifacts-panel-overlay')).toBeTruthy());

		// Close via the × button inside GateArtifactsView
		fireEvent.click(getByTestId('artifacts-close'));
		await waitFor(() => expect(queryByTestId('artifacts-panel-overlay')).toBeNull());
	});

	// ---- Vote count badge (count-type gates) ----

	it('shows vote count badge "N/M" for a count gate with partial votes in runtime mode', async () => {
		const gate = makeGate({
			id: 'vote-gate',
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 3 },
				},
			],
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'vote-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'vote-gate',
					data: { votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		const badge = await findByTestId('gate-vote-count');
		expect(badge.textContent).toBe('2/3');
	});

	it('shows vote count badge "0/3" when no votes written yet', async () => {
		const gate = makeGate({
			id: 'vote-gate',
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 3 },
				},
			],
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'vote-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		const badge = await findByTestId('gate-vote-count');
		expect(badge.textContent).toBe('0/3');
	});

	it('shows vote count badge "3/3" when all votes approve (gate open)', async () => {
		const gate = makeGate({
			id: 'vote-gate',
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 3 },
				},
			],
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'vote-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'vote-gate',
					data: {
						votes: {
							'Reviewer 1': 'approved',
							'Reviewer 2': 'approved',
							'Reviewer 3': 'approved',
						},
					},
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-open');
		const badge = await findByTestId('gate-vote-count');
		expect(badge.textContent).toBe('3/3');
	});

	it('does NOT show vote count badge in template mode', () => {
		const gate = makeGate({
			id: 'vote-gate',
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 3 },
				},
			],
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'vote-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		// No runId → template mode

		const { queryByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(queryByTestId('gate-vote-count')).toBeNull();
	});

	it('does NOT show vote count badge for non-count gate types', async () => {
		const gate = makeGate({
			id: 'check-gate',
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['human'], check: { op: '==', value: true } },
			],
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'check-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { queryByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await waitFor(() => expect(mockHub.request).toHaveBeenCalled());
		expect(queryByTestId('gate-vote-count')).toBeNull();
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

	// ---- Script error gate status ----

	function makeScriptGate(overrides: Partial<Gate> = {}): Gate {
		return {
			id: 'script-gate',
			fields: [],
			script: { interpreter: 'bash', source: 'exit 1' },
			resetOnCycle: false,
			...overrides,
		};
	}

	it('script-only gate (no fields) with _scriptResult.success:false shows blocked gate icon in runtime mode', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'script-gate',
					data: { _scriptResult: { success: false, reason: 'timeout' } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-blocked');
	});

	it('script-only gate with _scriptResult.success:false renders gate-script-error-badge', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'script-gate',
					data: { _scriptResult: { success: false, reason: 'connection refused' } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		const badge = await findByTestId('gate-script-error-badge');
		expect(badge.textContent).toContain('Script failed');
	});

	it('script-only gate with no _scriptResult shows open gate icon (backward compat)', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'script-gate',
					data: {},
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-open');
	});

	it('gate with both fields and script: _scriptResult.success:false shows blocked regardless of field status', async () => {
		const gate = makeScriptGate({
			id: 'combo-gate',
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['human'], check: { op: '==', value: true } },
			],
		});
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'combo-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		// Fields say approved=true (open), but script says failed
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'combo-gate',
					data: {
						approved: true,
						_scriptResult: { success: false, reason: 'lint errors found' },
					},
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-blocked');
	});

	it('field-only gate failure (approved=false, no _scriptResult) shows blocked (existing behavior)', async () => {
		const gate = makeGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'gate-1' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [{ runId: 'run-1', gateId: 'gate-1', data: { approved: false }, updatedAt: 2000 }],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		await findByTestId('gate-icon-blocked');
	});

	it('_scriptResult.success:true does not override field evaluation (gate follows fields)', async () => {
		const gate = makeScriptGate({
			id: 'combo-gate-2',
			fields: [
				{ name: 'approved', type: 'boolean', writers: ['human'], check: { op: '==', value: true } },
			],
		});
		const wf = makeWorkflow({
			channels: [
				{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'combo-gate-2' },
			],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		// Script passed, but fields not yet approved -> waiting_human
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'combo-gate-2',
					data: {
						_scriptResult: { success: true },
					},
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		// Script passed (no override), fields pending -> waiting_human
		await findByTestId('gate-icon-waiting_human');
	});

	it('script error badge has the reason in its title attribute', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'script-gate',
					data: { _scriptResult: { success: false, reason: 'Script timed out after 30s' } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		const badge = await findByTestId('gate-script-error-badge');
		// The title is on the inner div inside the foreignObject
		const innerDiv = badge.querySelector('div');
		expect(innerDiv?.getAttribute('title')).toBe('Script timed out after 30s');
	});

	it('script error badge is NOT shown in template mode', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		// No runId -> template mode

		const { queryByTestId } = render(<WorkflowCanvas workflowId="wf-1" spaceId="sp-1" />);
		expect(queryByTestId('gate-script-error-badge')).toBeNull();
	});

	it('script-only gate with _scriptResult.success:false but no reason still blocks (no badge shown)', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({
			gateData: [
				{
					runId: 'run-1',
					gateId: 'script-gate',
					data: { _scriptResult: { success: false } },
					updatedAt: 2000,
				},
			],
		});

		const { findByTestId, queryByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);
		// P0 fix: success === false blocks even without a reason string
		await findByTestId('gate-icon-blocked');
		// No badge since reason is missing (badge only shows when reason is truthy)
		expect(queryByTestId('gate-script-error-badge')).toBeNull();
	});

	it('gate data event with script error updates gate to blocked', async () => {
		const gate = makeScriptGate();
		const wf = makeWorkflow({
			channels: [{ id: 'ch-1', from: 'n1', to: 'n2', direction: 'one-way', gateId: 'script-gate' }],
			gates: [gate],
		});
		mockWorkflows.value = [wf];
		mockWorkflowRuns.value = [makeRun()];
		mockHub.request.mockResolvedValue({ gateData: [] });

		const { findByTestId, queryByTestId } = render(
			<WorkflowCanvas workflowId="wf-1" runId="run-1" spaceId="sp-1" />
		);

		// Initially open (no data, script gate with no fields)
		await findByTestId('gate-icon-open');
		expect(queryByTestId('gate-script-error-badge')).toBeNull();

		// Fire gate data update event with script error
		const handlers = mockEventListeners.get('space.gateData.updated') ?? [];
		for (const h of handlers) {
			h({
				spaceId: 'sp-1',
				runId: 'run-1',
				gateId: 'script-gate',
				data: { _scriptResult: { success: false, reason: 'disk full' } },
			});
		}

		// Should now show blocked with error badge
		await findByTestId('gate-icon-blocked');
		const badge = await findByTestId('gate-script-error-badge');
		// The title is on the inner div inside the foreignObject
		const innerDiv = badge.querySelector('div');
		expect(innerDiv?.getAttribute('title')).toBe('disk full');
	});
});
