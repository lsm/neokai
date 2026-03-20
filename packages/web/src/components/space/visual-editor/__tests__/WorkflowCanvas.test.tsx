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
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { WorkflowCanvas } from '../WorkflowCanvas';
import type { WorkflowNodeData, WorkflowCanvasProps } from '../WorkflowCanvas';
import type { ViewportState } from '../types';

afterEach(() => cleanup());

const VP: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };

const NODES: WorkflowNodeData[] = [
	{ stepId: 'step-1', name: 'Step One', x: 10, y: 10 },
	{ stepId: 'step-2', name: 'Step Two', x: 200, y: 10 },
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

describe('WorkflowCanvas — rendering', () => {
	it('renders all provided nodes', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('workflow-node-step-1').textContent).toContain('Step One');
		expect(getByTestId('workflow-node-step-2').textContent).toContain('Step Two');
	});

	it('starts with no node selected', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('workflow-node-step-1').className).not.toContain('workflow-node--selected');
		expect(getByTestId('workflow-node-step-2').className).not.toContain('workflow-node--selected');
	});
});

describe('WorkflowCanvas — selection', () => {
	it('clicking a node adds selected class', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('workflow-node--selected');
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
		expect(getByTestId('workflow-node-step-1').className).not.toContain('workflow-node--selected');
		expect(getByTestId('workflow-node-step-2').className).toContain('workflow-node--selected');
	});

	it('clicking background deselects the node', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('workflow-node--selected');

		// Click the transform layer (canvas background)
		fireEvent.click(getByTestId('visual-canvas-transform'));
		expect(getByTestId('workflow-node-step-1').className).not.toContain('workflow-node--selected');
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
		expect(getByTestId('workflow-node-step-1').className).toContain('workflow-node--selected');

		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(getByTestId('workflow-node-step-1').className).not.toContain('workflow-node--selected');
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
		// Simulate focused input by dispatching from an INPUT element
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
						onClick={() => setNodes((prev) => prev.filter((n) => n.stepId !== 'step-1'))}
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

		// Select step-1
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(onNodeSelect).toHaveBeenLastCalledWith('step-1');
		onNodeSelect.mockClear();

		// Remove step-1 from the nodes array externally
		fireEvent.click(getByTestId('remove-step-1'));

		// Node element is gone and onNodeSelect(null) was called to clear selection
		expect(queryByTestId('workflow-node-step-1')).toBeNull();
		expect(onNodeSelect).toHaveBeenCalledWith(null);
	});
});

describe('WorkflowNode — isSelected prop', () => {
	it('node without selection does not have selected class', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('workflow-node-step-1').className).not.toContain('workflow-node--selected');
	});

	it('selected node has workflow-node--selected class', () => {
		const { getByTestId } = renderCanvas();
		fireEvent.click(getByTestId('workflow-node-step-1'));
		expect(getByTestId('workflow-node-step-1').className).toContain('workflow-node--selected');
		expect(getByTestId('workflow-node-step-2').className).not.toContain('workflow-node--selected');
	});
});
