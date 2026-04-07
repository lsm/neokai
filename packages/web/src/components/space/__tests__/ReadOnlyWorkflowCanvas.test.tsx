// @ts-nocheck
/**
 * Unit tests for ReadOnlyWorkflowCanvas
 *
 * Tests:
 * 1. Renders without crashing when workflow is found
 * 2. Renders empty/loading state when workflowId is not found in store
 * 3. Calls onNodeClick when a node is selected
 * 4. Passes readOnly=true to WorkflowCanvas so WorkflowNode gets draggable={false}
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceAgent, SpaceTask, SpaceWorkflow } from '@neokai/shared';

// ---- Signals for mocking ----

let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);
let mockTasks = signal<SpaceTask[]>([]);
let mockNodeExecutionsByNodeId = signal(new Map());

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			workflows: mockWorkflows,
			agents: mockAgents,
			tasks: mockTasks,
			nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
		};
	},
}));

const mockHub = {
	request: vi.fn().mockResolvedValue({ gateData: [] }),
	onEvent: vi.fn().mockReturnValue(() => {}),
};

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(() => mockHub),
		getHub: vi.fn(() => Promise.resolve(mockHub)),
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Capture readOnly prop passed to WorkflowCanvas by ReadOnlyWorkflowCanvas.
// The actual draggable={false} behavior is a consequence of readOnly=true being
// forwarded to WorkflowCanvas, which is tested in WorkflowCanvas's own tests.
const capturedReadOnly: { value?: boolean } = {};

vi.mock('../visual-editor/WorkflowCanvas', () => ({
	WorkflowCanvas: ({
		nodes,
		onNodeSelect,
		readOnly,
	}: {
		nodes: Array<{ step: { localId: string; id?: string } }>;
		readOnly?: boolean;
		onNodeSelect?: (id: string | null) => void;
	}) => {
		capturedReadOnly.value = readOnly;
		return (
			<div data-testid="visual-workflow-canvas" data-node-count={nodes.length}>
				{nodes.map((n) => (
					<button
						key={n.step.localId}
						data-testid={`node-btn-${n.step.localId}`}
						data-step-id={n.step.id ?? n.step.localId}
						onClick={() => onNodeSelect?.(n.step.localId)}
					>
						{n.step.localId}
					</button>
				))}
			</div>
		);
	},
}));

vi.mock('../visual-editor/CanvasToolbar', () => ({
	CanvasToolbar: () => <div data-testid="canvas-toolbar" />,
}));

// Re-initialize signals after hoisting
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockAgents = signal<SpaceAgent[]>([]);
mockTasks = signal<SpaceTask[]>([]);
mockNodeExecutionsByNodeId = signal(new Map());

import { ReadOnlyWorkflowCanvas } from '../ReadOnlyWorkflowCanvas';

// ---- Helpers ----

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
		channels: [],
		gates: [],
		tags: [],
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

// ---- Tests ----

describe('ReadOnlyWorkflowCanvas', () => {
	beforeEach(() => {
		mockWorkflows.value = [];
		mockAgents.value = [];
		mockTasks.value = [];
		mockNodeExecutionsByNodeId.value = new Map();
		capturedReadOnly.value = undefined;
		mockHub.request.mockClear();
		mockHub.request.mockResolvedValue({ gateData: [] });
	});

	afterEach(() => {
		cleanup();
	});

	it('renders without crashing when workflow is found', () => {
		mockWorkflows.value = [makeWorkflow()];
		const { getByTestId } = render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
		expect(getByTestId('visual-workflow-canvas')).toBeTruthy();
	});

	it('renders with empty nodes when workflowId is not found in store', () => {
		mockWorkflows.value = [];
		const { getByTestId } = render(<ReadOnlyWorkflowCanvas workflowId="non-existent" />);
		const canvas = getByTestId('visual-workflow-canvas');
		expect(canvas).toBeTruthy();
		expect(canvas.getAttribute('data-node-count')).toBe('0');
	});

	it('calls onNodeClick when a node is selected, passing the persisted node ID', () => {
		mockWorkflows.value = [makeWorkflow()];
		const onNodeClick = vi.fn();
		const { getByTestId } = render(
			<ReadOnlyWorkflowCanvas workflowId="wf-1" onNodeClick={onNodeClick} />
		);
		// Find the button whose data-step-id is the persisted ID 'n1'
		const canvas = getByTestId('visual-workflow-canvas');
		const nodeBtn = canvas.querySelector('[data-step-id="n1"]') as HTMLElement;
		expect(nodeBtn).not.toBeNull();
		nodeBtn.click();
		expect(onNodeClick).toHaveBeenCalledTimes(1);
		// Called with the persisted node ID (n1) and tasks array
		expect(onNodeClick).toHaveBeenCalledWith('n1', expect.any(Array));
	});

	it('passes readOnly=true to WorkflowCanvas so WorkflowNode gets draggable={false}', () => {
		mockWorkflows.value = [makeWorkflow()];
		render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
		expect(capturedReadOnly.value).toBe(true);
	});
});
