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
import type { SpaceAgent } from '@neokai/shared';
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
		stepNumber: 1,
		position: { x: 10, y: 10 },
		agents: AGENTS,
		isStartNode: false,
		onPortMouseDown: vi.fn(),
	},
	{
		step: makeStep('step-2', 'Step Two'),
		stepNumber: 2,
		position: { x: 200, y: 10 },
		agents: AGENTS,
		isStartNode: false,
		onPortMouseDown: vi.fn(),
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
