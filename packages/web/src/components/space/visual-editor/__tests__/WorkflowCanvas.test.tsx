/**
 * Unit tests for WorkflowCanvas node selection and multi-select behaviour.
 *
 * Tests:
 * - Renders all nodes
 * - Clicking a node selects it (isSelected visual indicator)
 * - Clicking a node calls onNodeSelect with the stepId
 * - Clicking background deselects the active node
 * - Clicking background calls onNodeSelect(null)
 * - Clicking a different node switches selection
 * - Delete key on selected node calls onDeleteNode
 * - Backspace key on selected node calls onDeleteNode
 * - Delete/Backspace without selection does not call onDeleteNode
 * - Delete key clears selection after onDeleteNode
 * - Delete key inside input does not trigger onDeleteNode
 * - Stale selectedNodeId is cleared when node removed from array
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { SpaceAgent, WorkflowTransition } from '@neokai/shared';
import { WorkflowCanvas } from '../WorkflowCanvas';
import type { WorkflowNodeData, WorkflowCanvasProps } from '../WorkflowCanvas';
import type { StepDraft } from '../../WorkflowStepCard';
import type { ViewportState } from '../types';

vi.mock('../../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

afterEach(() => cleanup());

// ---- Test fixtures ----

const VP: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };

function makeAgent(id: string, name: string): SpaceAgent {
	return { id, spaceId: 'space-1', name, role: 'coder', createdAt: 0, updatedAt: 0 };
}

function makeStep(localId: string, name: string): StepDraft {
	return { localId, name, agentId: 'agent-1', instructions: '' };
}

const AGENTS: SpaceAgent[] = [makeAgent('agent-1', 'Coder')];

const NODES: WorkflowNodeData[] = [
	{
		step: makeStep('step-1', 'Step One'),
		stepIndex: 1,
		position: { x: 10, y: 10 },
		agents: AGENTS,
		isStartNode: false,
	},
	{
		step: makeStep('step-2', 'Step Two'),
		stepIndex: 2,
		position: { x: 200, y: 10 },
		agents: AGENTS,
		isStartNode: false,
	},
];

function renderCanvas(extra: Partial<WorkflowCanvasProps> = {}) {
	const onNodeSelect = vi.fn();
	const onDeleteNode = vi.fn();

	function Wrapper() {
		const [vp, setVp] = useState<ViewportState>(VP);
		return (
			<WorkflowCanvas
				nodes={NODES}
				viewportState={vp}
				onViewportChange={setVp}
				onNodeSelect={onNodeSelect}
				onDeleteNode={onDeleteNode}
				{...extra}
			/>
		);
	}

	const result = render(<Wrapper />);
	return { ...result, onNodeSelect, onDeleteNode };
}

// ---- Rendering ----

describe('WorkflowCanvas — rendering', () => {
	it('renders all provided nodes', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('workflow-node-step-1').textContent).toContain('Step One');
		expect(getByTestId('workflow-node-step-2').textContent).toContain('Step Two');
	});

	it('starts with no node selected', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
		expect(getByTestId('workflow-node-step-2').className).not.toContain('ring-2');
	});
});

// ---- Selection ----

describe('WorkflowCanvas — selection', () => {
	it('clicking a node adds selected classes', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-blue-500');
	});

	it('clicking a node calls onNodeSelect with the stepId', () => {
		const { getByTestId, onNodeSelect } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(onNodeSelect).toHaveBeenCalledWith('step-1');
	});

	it('clicking a different node switches selection', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		fireEvent.click(getByTestId('workflow-node-step-2'));
		expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
		expect(getByTestId('workflow-node-step-2').className).toContain('ring-2');
	});

	it('clicking background deselects the node', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');

		fireEvent.click(getByTestId('visual-canvas-transform'));
		expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
	});

	it('clicking background calls onNodeSelect(null)', () => {
		const { getByTestId, onNodeSelect } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		onNodeSelect.mockClear();

		fireEvent.click(getByTestId('visual-canvas-transform'));
		expect(onNodeSelect).toHaveBeenCalledWith(null);
	});

	it('clicking canvas container deselects', () => {
		const { getByTestId, onNodeSelect } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		onNodeSelect.mockClear();

		fireEvent.click(getByTestId('visual-canvas'));
		expect(onNodeSelect).toHaveBeenCalledWith(null);
	});
});

// ---- Keyboard delete ----

describe('WorkflowCanvas — keyboard delete', () => {
	it('Delete key calls onDeleteNode with selected stepId', () => {
		const { getByTestId, onDeleteNode } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onDeleteNode).toHaveBeenCalledWith('step-1');
	});

	it('Backspace key calls onDeleteNode with selected stepId', () => {
		const { getByTestId, onDeleteNode } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-2'));
		fireEvent.keyDown(document.body, { key: 'Backspace' });
		expect(onDeleteNode).toHaveBeenCalledWith('step-2');
	});

	it('Delete key without selection does not call onDeleteNode', () => {
		const { onDeleteNode } = renderCanvas();
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onDeleteNode).not.toHaveBeenCalled();
	});

	it('Delete key clears selection after calling onDeleteNode', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');

		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
	});

	it('Delete calls onNodeSelect(null) after deletion', () => {
		const { getByTestId, onNodeSelect } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		onNodeSelect.mockClear();

		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onNodeSelect).toHaveBeenCalledWith(null);
	});

	it('Delete inside an input does not trigger onDeleteNode', () => {
		const { onDeleteNode, container } = renderCanvas();
		const input = document.createElement('input');
		container.appendChild(input);
		input.focus();
		fireEvent.keyDown(input, { key: 'Delete', target: input });
		expect(onDeleteNode).not.toHaveBeenCalled();
	});

	it('Delete inside a textarea does not trigger onDeleteNode', () => {
		const { onDeleteNode, container } = renderCanvas();
		const textarea = document.createElement('textarea');
		container.appendChild(textarea);
		textarea.focus();
		fireEvent.keyDown(textarea, { key: 'Delete', target: textarea });
		expect(onDeleteNode).not.toHaveBeenCalled();
	});
});

// ---- Stale selection cleanup ----

describe('WorkflowCanvas — stale selection cleanup', () => {
	it('clears selection when the selected node is removed from the nodes array', () => {
		const onNodeSelect = vi.fn();
		const onDeleteNode = vi.fn();

		function Wrapper() {
			const [vp, setVp] = useState<ViewportState>(VP);
			const [nodes, setNodes] = useState<WorkflowNodeData[]>(NODES);
			return (
				<div>
					<button
						data-testid="remove-step-1"
						onClick={() => setNodes((prev) => prev.filter((n) => n.step.localId !== 'step-1'))}
					>
						Remove
					</button>
					<WorkflowCanvas
						nodes={nodes}
						viewportState={vp}
						onViewportChange={setVp}
						onNodeSelect={onNodeSelect}
						onDeleteNode={onDeleteNode}
					/>
				</div>
			);
		}

		const { getByTestId, queryByTestId } = render(<Wrapper />);

		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(onNodeSelect).toHaveBeenLastCalledWith('step-1');
		onNodeSelect.mockClear();

		fireEvent.click(getByTestId('remove-step-1'));

		expect(queryByTestId('workflow-node-step-1')).toBeNull();
		expect(onNodeSelect).toHaveBeenCalledWith(null);
	});
});

// ---- isSelected prop propagation ----

describe('WorkflowNode — isSelected prop via WorkflowCanvas', () => {
	it('node without selection does not have ring classes', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
	});

	it('selected node has ring-2 and ring-blue-500 classes', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-blue-500');
		expect(getByTestId('workflow-node-step-2').className).not.toContain('ring-2');
	});
});

// ---- Transitions / edge integration ----

const TRANSITIONS: WorkflowTransition[] = [
	{ id: 'tr1', from: 'step-1', to: 'step-2' },
	{ id: 'tr2', from: 'step-2', to: 'step-1', condition: { type: 'human' } },
];

function renderCanvasWithEdges(extra: Partial<WorkflowCanvasProps> = {}) {
	const onEdgeSelect = vi.fn();
	const onDeleteEdge = vi.fn();

	function Wrapper() {
		const [vp, setVp] = useState<ViewportState>(VP);
		return (
			<WorkflowCanvas
				nodes={NODES}
				viewportState={vp}
				onViewportChange={setVp}
				transitions={TRANSITIONS}
				onEdgeSelect={onEdgeSelect}
				onDeleteEdge={onDeleteEdge}
				{...extra}
			/>
		);
	}

	const result = render(<Wrapper />);
	return { ...result, onEdgeSelect, onDeleteEdge };
}

describe('WorkflowCanvas — edge rendering', () => {
	it('renders SVG edges for each transition', () => {
		const { getByTestId } = renderCanvasWithEdges();
		expect(getByTestId('edge-tr1')).toBeTruthy();
		expect(getByTestId('edge-tr2')).toBeTruthy();
	});

	it('renders SVG overlay layer', () => {
		const { getByTestId } = renderCanvasWithEdges();
		expect(getByTestId('visual-canvas-svg')).toBeTruthy();
	});
});

describe('WorkflowCanvas — edge selection mutual exclusivity', () => {
	it('clicking an edge calls onEdgeSelect', () => {
		const { getByTestId, onEdgeSelect } = renderCanvasWithEdges();
		const group = getByTestId('edge-tr1');
		const hitbox = group.querySelectorAll('path')[0];
		fireEvent.click(hitbox);
		expect(onEdgeSelect).toHaveBeenCalledWith('tr1');
	});

	it('selecting a node clears edge selection and calls onEdgeSelect(null)', () => {
		const onEdgeSelect = vi.fn();
		const onNodeSelect = vi.fn();

		function Wrapper() {
			const [vp, setVp] = useState<ViewportState>(VP);
			return (
				<WorkflowCanvas
					nodes={NODES}
					viewportState={vp}
					onViewportChange={setVp}
					transitions={TRANSITIONS}
					onEdgeSelect={onEdgeSelect}
					onNodeSelect={onNodeSelect}
				/>
			);
		}
		const { getByTestId } = render(<Wrapper />);

		// Select an edge first
		const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
		fireEvent.click(hitbox);
		expect(onEdgeSelect).toHaveBeenCalledWith('tr1');
		expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('true');
		onEdgeSelect.mockClear();

		// Now select a node — edge should be cleared
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(onEdgeSelect).toHaveBeenCalledWith(null);
		expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('false');
		cleanup();
	});

	it('selecting an edge clears node selection and calls onNodeSelect(null)', () => {
		const onEdgeSelect = vi.fn();
		const onNodeSelect = vi.fn();

		function Wrapper() {
			const [vp, setVp] = useState<ViewportState>(VP);
			return (
				<WorkflowCanvas
					nodes={NODES}
					viewportState={vp}
					onViewportChange={setVp}
					transitions={TRANSITIONS}
					onEdgeSelect={onEdgeSelect}
					onNodeSelect={onNodeSelect}
				/>
			);
		}
		const { getByTestId } = render(<Wrapper />);

		// Select a node first
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');
		onNodeSelect.mockClear();

		// Now select an edge — node should be cleared
		const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
		fireEvent.click(hitbox);
		expect(onNodeSelect).toHaveBeenCalledWith(null);
		expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
		cleanup();
	});

	it('background click clears both node and edge selection', () => {
		const onEdgeSelect = vi.fn();
		const onNodeSelect = vi.fn();

		function Wrapper() {
			const [vp, setVp] = useState<ViewportState>(VP);
			return (
				<WorkflowCanvas
					nodes={NODES}
					viewportState={vp}
					onViewportChange={setVp}
					transitions={TRANSITIONS}
					onEdgeSelect={onEdgeSelect}
					onNodeSelect={onNodeSelect}
				/>
			);
		}
		const { getByTestId } = render(<Wrapper />);

		const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
		fireEvent.click(hitbox);
		expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('true');
		onEdgeSelect.mockClear();

		fireEvent.click(getByTestId('visual-canvas-transform'));
		expect(onEdgeSelect).toHaveBeenCalledWith(null);
		expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('false');
		cleanup();
	});
});

describe('WorkflowCanvas — edge delete', () => {
	it('Delete key on selected edge calls onDeleteEdge', () => {
		const { getByTestId, onDeleteEdge } = renderCanvasWithEdges();
		const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
		fireEvent.click(hitbox);
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onDeleteEdge).toHaveBeenCalledWith('tr1');
	});

	it('Delete on selected edge does not call onDeleteNode', () => {
		const onDeleteNode = vi.fn();

		function Wrapper() {
			const [vp, setVp] = useState<ViewportState>(VP);
			return (
				<WorkflowCanvas
					nodes={NODES}
					viewportState={vp}
					onViewportChange={setVp}
					transitions={TRANSITIONS}
					onDeleteNode={onDeleteNode}
				/>
			);
		}
		const { getByTestId } = render(<Wrapper />);

		// Select edge (clears node selection)
		const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
		fireEvent.click(hitbox);
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onDeleteNode).not.toHaveBeenCalled();
		cleanup();
	});

	it('Delete on selected node does not call onDeleteEdge when edge not selected', () => {
		const { getByTestId, onDeleteEdge } = renderCanvasWithEdges();
		// Select a node (mutually exclusive — no edge selected)
		fireEvent.click(getByTestId('workflow-node-step-1'));
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onDeleteEdge).not.toHaveBeenCalled();
	});
});

// ---- Channel edges ----

import { computeChannelEdges } from '../WorkflowCanvas';
import type { WorkflowChannel } from '@neokai/shared';

describe('computeChannelEdges', () => {
	function makeAgentWithRole(id: string, role: string): SpaceAgent {
		return { id, spaceId: 'space-1', name: role, role, createdAt: 0, updatedAt: 0 };
	}

	function makeNodeWithAgentsAndChannels(
		localId: string,
		name: string,
		agents: SpaceAgent[],
		channels?: WorkflowChannel[]
	) {
		return {
			step: {
				localId,
				name,
				agentId: agents[0]?.id ?? '',
				agents: agents.map((a) => ({ agentId: a.id })),
				channels,
				instructions: '',
			},
			stepIndex: 0,
			position: { x: 0, y: 0 },
			agents,
			isStartNode: false,
		};
	}

	it('returns empty array when no nodes have channels', () => {
		const agents = [makeAgentWithRole('agent-1', 'coder')];
		const nodes = [
			makeNodeWithAgentsAndChannels('step-1', 'Step One', agents),
			makeNodeWithAgentsAndChannels('step-2', 'Step Two', agents),
		];
		const result = computeChannelEdges(nodes as any);
		expect(result).toHaveLength(0);
	});

	it('extracts task-agent bidirectional channel as edge from task-agent to node', () => {
		const agents = [makeAgentWithRole('agent-1', 'coder')];
		const channels: WorkflowChannel[] = [
			{ from: 'task-agent', to: 'coder', direction: 'bidirectional' },
		];
		const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
		const result = computeChannelEdges(nodes as any);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			fromStepId: 'task-agent',
			toStepId: 'step-1',
			direction: 'bidirectional',
		});
	});

	it('extracts task-agent one-way channel as edge from task-agent to node', () => {
		const agents = [makeAgentWithRole('agent-1', 'coder')];
		const channels: WorkflowChannel[] = [{ from: 'task-agent', to: 'coder', direction: 'one-way' }];
		const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
		const result = computeChannelEdges(nodes as any);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			fromStepId: 'task-agent',
			toStepId: 'step-1',
			direction: 'one-way',
		});
	});

	it('skips intra-node channels (same from and to node)', () => {
		const agents = [
			makeAgentWithRole('agent-1', 'coder'),
			makeAgentWithRole('agent-2', 'reviewer'),
		];
		// Channel within the same node - both coder and reviewer are in step-1
		const channels: WorkflowChannel[] = [
			{ from: 'coder', to: 'reviewer', direction: 'bidirectional' },
		];
		const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
		const result = computeChannelEdges(nodes as any);
		expect(result).toHaveLength(0);
	});

	it('handles wildcard to/from within same node as intra-node (skipped)', () => {
		const agents = [makeAgentWithRole('agent-1', 'coder')];
		const channels: WorkflowChannel[] = [{ from: '*', to: 'coder', direction: 'bidirectional' }];
		const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
		const result = computeChannelEdges(nodes as any);
		// * to a role in same node = intra-node = skipped
		expect(result).toHaveLength(0);
	});

	it('creates edge when channel.to is an array of roles', () => {
		const agents = [
			makeAgentWithRole('agent-1', 'coder'),
			makeAgentWithRole('agent-2', 'reviewer'),
		];
		const channels: WorkflowChannel[] = [
			{ from: 'task-agent', to: ['coder', 'reviewer'], direction: 'bidirectional' },
		];
		const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
		const result = computeChannelEdges(nodes as any);
		// Should create edges to both coder and reviewer roles
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({
			fromStepId: 'task-agent',
			toStepId: 'step-1',
			direction: 'bidirectional',
		});
	});

	it('returns empty array when node has agents but channel references unknown role', () => {
		const agents = [makeAgentWithRole('agent-1', 'coder')];
		const channels: WorkflowChannel[] = [
			{ from: 'task-agent', to: 'unknown-role', direction: 'bidirectional' },
		];
		const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
		const result = computeChannelEdges(nodes as any);
		// Unknown role can't be resolved, so edge is skipped
		expect(result).toHaveLength(0);
	});
});

describe('WorkflowCanvas — channel edge rendering', () => {
	it('renders no channel edges when nodes have no channels', () => {
		const { queryByTestId } = renderCanvas();
		// No channel edges should be rendered
		expect(queryByTestId('channel-edge-list')).toBeNull();
	});

	it('renders channel edges when nodes have task-agent channels', () => {
		// Create nodes with task-agent channels
		const agents = [makeAgent('agent-1', 'Coder')];
		const nodesWithChannels: WorkflowNodeData[] = [
			{
				step: {
					...makeStep('step-1', 'Step One'),
					agentId: 'agent-1',
					channels: [{ from: 'task-agent', to: 'coder', direction: 'bidirectional' }],
				},
				stepIndex: 1,
				position: { x: 10, y: 10 },
				agents,
				isStartNode: false,
			},
		];

		function WrapperWithChannels() {
			const [vp, setVp] = useState<ViewportState>(VP);
			return (
				<WorkflowCanvas
					nodes={nodesWithChannels}
					viewportState={vp}
					onViewportChange={setVp}
					onNodeSelect={() => {}}
					onDeleteNode={() => {}}
				/>
			);
		}

		const { container } = render(<WrapperWithChannels />);
		// Should have channel edge elements
		const channelEdges = container.querySelectorAll('[data-channel-edge]');
		expect(channelEdges.length).toBeGreaterThan(0);
	});
});
