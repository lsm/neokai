/**
 * Integration tests for VisualWorkflowEditor
 *
 * Tests:
 * Rendering
 * - Renders with empty workflow (create mode)
 * - Renders "New Workflow" title in create mode
 * - Renders "Edit Workflow" title in edit mode
 * - Pre-fills name and description when editing
 * - Renders existing workflow with saved layout
 * - Renders existing workflow without layout (auto-layout fallback)
 *
 * Add Step
 * - Adds a node when button clicked
 * - Adding second step does not replace first
 * - First added step becomes start node (rendered with START badge)
 *
 * Node selection → NodeConfigPanel
 * - Clicking a node opens NodeConfigPanel
 * - Close button dismisses NodeConfigPanel
 * - handleSetAsStart: clicking "Set as Start Node" updates start badge
 * - handleDeleteNode: deleting a node removes it from canvas and clears panel
 * - handleDeleteNode: edge referencing deleted node is also removed
 * - handleUpdateNode: editing step name updates node display
 *
 * Edge selection → EdgeConfigPanel
 * - Clicking an edge hitbox opens EdgeConfigPanel
 * - Close button dismisses EdgeConfigPanel
 * - handleDeleteEdge: deleting edge removes EdgeConfigPanel
 * - handleUpdateEdgeCondition: changing condition type updates panel
 *
 * handleCreateTransition
 * - Renders exactly one edge for the single transition in the workflow (port-drag dedup not testable in JSDOM)
 *
 * Save — validation
 * - Error when name is empty
 * - Error when no steps
 * - Error when a step has no agent
 * - Error when condition-type edge has empty expression
 *
 * Save — new workflow
 * - Calls createWorkflow with name and layout
 * - Layout includes a position for each step
 * - Calls onSave after successful create
 *
 * Save — existing workflow
 * - Calls updateWorkflow (not createWorkflow) when editing
 * - Passes workflow id to updateWorkflow
 * - Includes layout in update params preserving positions
 *
 * Tags
 * - Adding a tag via suggestion button
 * - Removing a tag via × button
 * - Adding tag via keyboard Enter
 *
 * Rules section
 * - Renders toggle button
 * - Shows WorkflowRulesEditor when toggled
 * - Hides WorkflowRulesEditor after second toggle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';

// ---- Mocks ----

const mockAgents: Signal<SpaceAgent[]> = signal([]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);

const mockCreateWorkflow = vi.fn();
const mockUpdateWorkflow = vi.fn();

vi.mock('../../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			agents: mockAgents,
			workflows: mockWorkflows,
			createWorkflow: mockCreateWorkflow,
			updateWorkflow: mockUpdateWorkflow,
		};
	},
}));

vi.mock('../../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { VisualWorkflowEditor } from '../VisualWorkflowEditor';
import type { VisualWorkflowEditorProps } from '../VisualWorkflowEditor';
import { TEMPLATES } from '../../WorkflowEditor';

// ============================================================================
// Fixtures
// ============================================================================

function makeAgent(id: string, name: string, role = 'coder'): SpaceAgent {
	return { id, spaceId: 'space-1', name, role, createdAt: 0, updatedAt: 0 };
}

const STEP_1_ID = 'step-1';
const STEP_2_ID = 'step-2';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'My Workflow',
		description: 'A workflow description',
		nodes: [
			{ id: STEP_1_ID, name: 'Plan', agentId: 'agent-1', instructions: 'Plan it' },
			{ id: STEP_2_ID, name: 'Code', agentId: 'agent-2', instructions: '' },
		],
		transitions: [{ id: 'tr-1', from: STEP_1_ID, to: STEP_2_ID, order: 0 }],
		startNodeId: STEP_1_ID,
		rules: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeProps(overrides: Partial<VisualWorkflowEditorProps> = {}): VisualWorkflowEditorProps {
	return {
		onSave: vi.fn(),
		onCancel: vi.fn(),
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	cleanup();
	mockAgents.value = [
		makeAgent('agent-1', 'Planner', 'planner'),
		makeAgent('agent-2', 'Coder', 'coder'),
	];
	mockWorkflows.value = [];
	mockCreateWorkflow.mockResolvedValue({ id: 'new-wf', nodes: [], transitions: [], tags: [] });
	mockUpdateWorkflow.mockResolvedValue({ id: 'wf-1', nodes: [], transitions: [], tags: [] });
	mockCreateWorkflow.mockClear();
	mockUpdateWorkflow.mockClear();
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('VisualWorkflowEditor', () => {
	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	describe('rendering — create mode', () => {
		it('renders the editor container', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
		});

		it('renders "New Workflow" title', () => {
			const { getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByText('New Workflow')).toBeTruthy();
		});

		it('renders name and description inputs', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('workflow-name-input')).toBeTruthy();
			expect(getByTestId('workflow-description-input')).toBeTruthy();
		});

		it('shows "Create Workflow" on the save button in create mode', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('save-button').textContent).toBe('Create Workflow');
		});
	});

	describe('rendering — edit mode', () => {
		it('renders "Edit Workflow" title when workflow prop is provided', () => {
			const { getByText } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect(getByText('Edit Workflow')).toBeTruthy();
		});

		it('pre-fills name field', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect((getByTestId('workflow-name-input') as HTMLInputElement).value).toBe('My Workflow');
		});

		it('pre-fills description field', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect((getByTestId('workflow-description-input') as HTMLInputElement).value).toBe(
				'A workflow description'
			);
		});

		it('shows "Save Changes" on the save button', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect(getByTestId('save-button').textContent).toBe('Save Changes');
		});

		it('renders with saved layout positions without throwing', () => {
			const layout = { [STEP_1_ID]: { x: 50, y: 50 }, [STEP_2_ID]: { x: 300, y: 200 } };
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout }) })} />
			);
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
		});

		it('renders without layout (auto-layout fallback) without throwing', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout: undefined }) })} />
			);
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
		});
	});

	// -------------------------------------------------------------------------
	// Add Step
	// -------------------------------------------------------------------------

	describe('Add Step', () => {
		it('adds a node when Add Step is clicked', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(() => getAllByTestId(/^workflow-node-/)).toThrow();

			fireEvent.click(getByTestId('add-step-button'));

			expect(getAllByTestId(/^workflow-node-/).length).toBe(1);
		});

		it('adding a second step does not replace the first', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.click(getByTestId('add-step-button'));
			expect(getAllByTestId(/^workflow-node-/).length).toBe(2);
		});

		it('first added step gets the START badge', () => {
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('add-step-button'));
			// WorkflowNode renders "START" badge for the start node
			expect(getByText('START')).toBeTruthy();
		});
	});

	// -------------------------------------------------------------------------
	// Cancel
	// -------------------------------------------------------------------------

	describe('Cancel', () => {
		it('calls onCancel when Cancel button is clicked', () => {
			const onCancel = vi.fn();
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onCancel })} />);
			fireEvent.click(getByTestId('cancel-button'));
			expect(onCancel).toHaveBeenCalledOnce();
		});

		it('calls onCancel when back arrow is clicked', () => {
			const onCancel = vi.fn();
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onCancel })} />);
			fireEvent.click(getByTestId('back-button'));
			expect(onCancel).toHaveBeenCalledOnce();
		});
	});

	// -------------------------------------------------------------------------
	// Node selection → NodeConfigPanel
	// -------------------------------------------------------------------------

	describe('Node selection — NodeConfigPanel', () => {
		it('clicking a node opens NodeConfigPanel', () => {
			const { getAllByTestId, queryByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect(queryByTestId('node-config-panel')).toBeNull();

			const [firstNode] = getAllByTestId(/^workflow-node-/);
			fireEvent.click(firstNode);

			expect(queryByTestId('node-config-panel')).toBeTruthy();
		});

		it('NodeConfigPanel close button dismisses the panel', () => {
			const { getAllByTestId, queryByTestId, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
			expect(queryByTestId('node-config-panel')).toBeTruthy();

			fireEvent.click(getByTestId('close-button'));
			expect(queryByTestId('node-config-panel')).toBeNull();
		});

		it('Set as Start Node button updates the start badge', () => {
			// Render with a two-step workflow where step-2 is not the start.
			// Find the Code (step-2) node and click it, then click Set as Start.
			const { container, getAllByTestId, queryByTestId, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);

			// Find the second node (the non-start node)
			const nodes = getAllByTestId(/^workflow-node-/);
			// Click the node that does NOT have the canvas start badge.
			// WorkflowNode renders the canvas badge as data-testid="start-badge".
			const nonStartNode = nodes.find((n) => !n.querySelector('[data-testid="start-badge"]'));
			expect(nonStartNode).toBeTruthy();
			fireEvent.click(nonStartNode!);

			// The "Set as Start Node" button should be visible in the panel
			expect(queryByTestId('set-as-start-button')).toBeTruthy();
			fireEvent.click(getByTestId('set-as-start-button'));

			// After setting as start, the canvas start-badge should now be inside this node.
			const updatedNodes = container.querySelectorAll('[data-testid^="workflow-node-"]');
			const startBadges = container.querySelectorAll('[data-testid="start-badge"]');
			expect(startBadges.length).toBe(1);
			// The badge should be inside the node we clicked
			const startNode = Array.from(updatedNodes).find((n) => n.contains(startBadges[0]));
			expect(startNode).toBe(
				nonStartNode!.closest('[data-testid^="workflow-node-"]') ?? nonStartNode
			);
		});

		it('deleting a node removes it from the canvas and closes the panel', () => {
			const { container, getAllByTestId, queryByTestId, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			const nodesBefore = getAllByTestId(/^workflow-node-/).length;
			// The workflow has one edge (step-1 → step-2); confirm it renders before deletion
			expect(container.querySelector('[data-edge-id]')).toBeTruthy();

			// Select step-2 (the non-start regular node).
			// Skip the Task Agent virtual node (data-testid="workflow-node-__task_agent__")
			// since it is always present and has no start badge.
			const nodes = getAllByTestId(/^workflow-node-/);
			const nonStartNode = nodes.find(
				(n) =>
					!n.querySelector('[data-testid="start-badge"]') &&
					n.getAttribute('data-testid') !== `workflow-node-${TASK_AGENT_NODE_ID}`
			)!;
			fireEvent.click(nonStartNode);

			// Initiate delete
			fireEvent.click(getByTestId('delete-step-button'));
			fireEvent.click(getByTestId('delete-confirm-button'));

			expect(getAllByTestId(/^workflow-node-/).length).toBe(nodesBefore - 1);
			expect(queryByTestId('node-config-panel')).toBeNull();
			// Edges referencing the deleted node must also be removed
			expect(container.querySelector('[data-edge-id]')).toBeNull();
		});

		it('Task Agent never receives the start badge after any node deletion', () => {
			// Workflow: step-1 (start), step-2 (non-start)
			// Transfer start to step-2 first, then delete step-1.
			// After deletion remaining = [taskAgent, step-2]. The Task Agent must not
			// receive the start badge (the UI disables deletion of the current start node,
			// so this test verifies the invariant via the reachable "delete non-start" path).
			const { getAllByTestId, queryByTestId, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);

			// Step 1: Set step-2 as the new start node
			const allNodes = getAllByTestId(/^workflow-node-/);
			const step2Node = allNodes.find(
				(n) =>
					!n.querySelector('[data-testid="start-badge"]') &&
					n.getAttribute('data-testid') !== `workflow-node-${TASK_AGENT_NODE_ID}`
			)!;
			fireEvent.click(step2Node);
			fireEvent.click(getByTestId('set-as-start-button'));

			// step-2 should now be the start node
			expect(step2Node.querySelector('[data-testid="start-badge"]')).toBeTruthy();

			// Step 2: Delete step-1 (no longer the start, so delete button is enabled)
			const step1Node = getAllByTestId(/^workflow-node-/).find(
				(n) =>
					!n.querySelector('[data-testid="start-badge"]') &&
					n.getAttribute('data-testid') !== `workflow-node-${TASK_AGENT_NODE_ID}`
			)!;
			fireEvent.click(step1Node);
			fireEvent.click(getByTestId('delete-step-button'));
			fireEvent.click(getByTestId('delete-confirm-button'));

			// Task Agent must never receive the start badge
			const taskAgentNode = queryByTestId(`workflow-node-${TASK_AGENT_NODE_ID}`);
			expect(taskAgentNode?.querySelector('[data-testid="start-badge"]')).toBeNull();

			// step-2 should still be the start
			const startBadges = document.querySelectorAll('[data-testid="start-badge"]');
			expect(startBadges).toHaveLength(1);
		});

		it('editing step name in NodeConfigPanel updates the node step', () => {
			const { getAllByTestId, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);

			const nameInput = getByTestId('step-name-input') as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'Updated Step Name' } });

			expect(nameInput.value).toBe('Updated Step Name');
		});
	});

	// -------------------------------------------------------------------------
	// Edge selection → EdgeConfigPanel
	// -------------------------------------------------------------------------

	describe('Edge selection — EdgeConfigPanel', () => {
		it('clicking an edge hitbox opens EdgeConfigPanel', () => {
			const { container, queryByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect(queryByTestId('edge-config-panel')).toBeNull();

			// EdgeRenderer renders a <g data-edge-id="..."> with a hitbox <path> as first child
			const hitboxPath = container.querySelector('[data-edge-id] > path');
			expect(hitboxPath).toBeTruthy();
			fireEvent.click(hitboxPath!);

			expect(queryByTestId('edge-config-panel')).toBeTruthy();
		});

		it('EdgeConfigPanel close button dismisses the panel', () => {
			const { container, queryByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			const hitboxPath = container.querySelector('[data-edge-id] > path')!;
			fireEvent.click(hitboxPath);
			expect(queryByTestId('edge-config-panel')).toBeTruthy();

			// The close button inside EdgeConfigPanel
			const closeBtn = queryByTestId('close-button');
			expect(closeBtn).toBeTruthy();
			fireEvent.click(closeBtn!);
			expect(queryByTestId('edge-config-panel')).toBeNull();
		});

		it('deleting an edge via EdgeConfigPanel removes it and hides the panel', () => {
			const { container, queryByTestId, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			const hitboxBefore = container.querySelector('[data-edge-id] > path')!;
			fireEvent.click(hitboxBefore);

			fireEvent.click(getByTestId('delete-transition-button'));

			// After deletion the edge element should be gone
			expect(container.querySelector('[data-edge-id]')).toBeNull();
			// And the panel should be dismissed
			expect(queryByTestId('edge-config-panel')).toBeNull();
		});

		it('changing edge condition type updates the panel', () => {
			const { container, getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			fireEvent.click(container.querySelector('[data-edge-id] > path')!);

			const select = getByTestId('condition-type-select') as HTMLSelectElement;
			fireEvent.change(select, { target: { value: 'human' } });

			expect(select.value).toBe('human');
		});

		it('selecting an edge clears the node selection', () => {
			const { container, getAllByTestId, queryByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);

			// First select a node
			fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
			expect(queryByTestId('node-config-panel')).toBeTruthy();

			// Then click an edge
			const hitbox = container.querySelector('[data-edge-id] > path')!;
			fireEvent.click(hitbox);

			expect(queryByTestId('node-config-panel')).toBeNull();
			expect(queryByTestId('edge-config-panel')).toBeTruthy();
		});
	});

	// -------------------------------------------------------------------------
	// handleCreateTransition
	// -------------------------------------------------------------------------

	describe('handleCreateTransition', () => {
		it('renders exactly one edge for the single transition in the workflow', () => {
			// Smoke test: makeWorkflow has one transition (step-1 → step-2); confirm
			// exactly one edge element is rendered. The port-drag dedup logic in
			// handleCreateTransition cannot be exercised in JSDOM (requires real
			// mousemove/mouseup across port elements), so this test only validates
			// the initial render state.
			const { container } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			// EdgeRenderer wraps each edge in a <g data-edge-id="..."> element
			expect(container.querySelectorAll('[data-edge-id]').length).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Save — validation
	// -------------------------------------------------------------------------

	describe('Save — validation', () => {
		it('shows error when name is empty', async () => {
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('save-button'));
			await waitFor(() => expect(getByText('Workflow name is required.')).toBeTruthy());
		});

		it('does not call createWorkflow when name is empty', async () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('save-button'));
			await waitFor(() => expect(mockCreateWorkflow).not.toHaveBeenCalled());
		});

		it('shows error when there are no steps', async () => {
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'WF' } });
			fireEvent.click(getByTestId('save-button'));
			await waitFor(() =>
				expect(getByText('A workflow must have at least one step.')).toBeTruthy()
			);
		});

		it('shows error when a step has no agent', async () => {
			// Create a step, leave agentId blank
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'WF' } });
			fireEvent.click(getByTestId('add-step-button'));

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(getByText('Step 1 requires an agent.')).toBeTruthy());
		});

		it('shows error when condition-type edge has empty expression', async () => {
			// Load a workflow that has a condition-type edge with no expression
			const wf = makeWorkflow({
				transitions: [
					{
						id: 'tr-1',
						from: STEP_1_ID,
						to: STEP_2_ID,
						order: 0,
						condition: { type: 'condition', expression: '' },
					},
				],
			});
			const { getByTestId, getByText } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: wf })} />
			);

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() =>
				expect(
					getByText('A transition using "Expression" condition requires a non-empty expression.')
				).toBeTruthy()
			);
		});
	});

	// -------------------------------------------------------------------------
	// Save — new workflow
	// -------------------------------------------------------------------------

	describe('Save — new workflow', () => {
		it('calls createWorkflow with name and layout', async () => {
			const onSave = vi.fn();
			const { getByTestId, getAllByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ onSave })} />
			);
			fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'Test WF' } });
			// Add a step and assign an agent (required by save validation)
			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
			fireEvent.change(getByTestId('agent-select'), { target: { value: 'agent-1' } });

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledOnce());

			const params = mockCreateWorkflow.mock.calls[0][0];
			expect(params.name).toBe('Test WF');
			expect(params).toHaveProperty('layout');
		});

		it('layout includes a position entry for each step', async () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			// Add 2 steps and assign agents (required by save validation)
			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'L' } });
			// Assign agent to step 1
			fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
			fireEvent.change(getByTestId('agent-select'), { target: { value: 'agent-1' } });
			fireEvent.click(getByTestId('close-button'));
			// Assign agent to step 2
			fireEvent.click(getAllByTestId(/^workflow-node-/)[1]);
			fireEvent.change(getByTestId('agent-select'), { target: { value: 'agent-2' } });

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledOnce());

			const { layout } = mockCreateWorkflow.mock.calls[0][0];
			expect(Object.keys(layout).length).toBe(2);
			for (const pos of Object.values(layout) as { x: number; y: number }[]) {
				expect(typeof pos.x).toBe('number');
				expect(typeof pos.y).toBe('number');
			}
		});

		it('calls onSave after successful create', async () => {
			const onSave = vi.fn();
			const { getByTestId, getAllByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ onSave })} />
			);
			fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'N' } });
			// Add a step and assign an agent (required by save validation)
			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.click(getAllByTestId(/^workflow-node-/)[0]);
			fireEvent.change(getByTestId('agent-select'), { target: { value: 'agent-1' } });

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		});
	});

	// -------------------------------------------------------------------------
	// Save — existing workflow
	// -------------------------------------------------------------------------

	describe('Save — existing workflow', () => {
		it('calls updateWorkflow (not createWorkflow) when editing', async () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledOnce();
				expect(mockCreateWorkflow).not.toHaveBeenCalled();
			});
		});

		it('passes the workflow id to updateWorkflow', async () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());
			expect(mockUpdateWorkflow.mock.calls[0][0]).toBe('wf-1');
		});

		it('includes layout in update params', async () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());

			const params = mockUpdateWorkflow.mock.calls[0][1];
			expect(params).toHaveProperty('layout');
			expect(Object.keys(params.layout).length).toBe(2);
		});

		it('saved layout positions are preserved through save', async () => {
			const layout = { [STEP_1_ID]: { x: 100, y: 50 }, [STEP_2_ID]: { x: 400, y: 200 } };
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout }) })} />
			);
			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});
			await waitFor(() => expect(mockUpdateWorkflow).toHaveBeenCalledOnce());

			const positions = Object.values(mockUpdateWorkflow.mock.calls[0][1].layout) as {
				x: number;
				y: number;
			}[];
			expect(positions.some((p) => p.x === 100 && p.y === 50)).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Tags
	// -------------------------------------------------------------------------

	describe('Tags', () => {
		it('adds a tag via suggestion button', () => {
			const { getByText, queryByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(queryByText('coding')).toBeNull();

			fireEvent.click(getByText('+coding'));
			expect(getByText('coding')).toBeTruthy();
		});

		it('removes a tag via × button', () => {
			// Load a workflow with an existing tag
			const wf = makeWorkflow({ tags: ['research'] });
			const { getByLabelText, queryByText } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: wf })} />
			);
			expect(queryByText('research')).toBeTruthy();

			fireEvent.click(getByLabelText('Remove tag research'));
			expect(queryByText('research')).toBeNull();
		});

		it('adds a tag by typing and pressing Enter', () => {
			const { container, queryByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			const tagInput = container.querySelector(
				'input[placeholder="Add tags…"]'
			) as HTMLInputElement;

			fireEvent.input(tagInput, { target: { value: 'mytag' } });
			fireEvent.keyDown(tagInput, { key: 'Enter' });

			expect(queryByText('mytag')).toBeTruthy();
		});
	});

	// -------------------------------------------------------------------------
	// Template picker
	// -------------------------------------------------------------------------

	describe('Template picker', () => {
		it('shows template picker button in create mode', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('template-picker-button')).toBeTruthy();
		});

		it('hides template picker button in edit mode', () => {
			const { queryByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect(queryByTestId('template-picker-button')).toBeNull();
		});

		it('shows template dropdown when button is clicked', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			expect(options.length).toBe(TEMPLATES.length);
		});

		it('hides dropdown when button clicked again', () => {
			const { getByTestId, queryAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('template-picker-button'));
			fireEvent.click(getByTestId('template-picker-button'));
			expect(queryAllByTestId('template-option').length).toBe(0);
		});

		it('selecting a template populates nodes', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('template-picker-button'));

			// Select the "Coding (Plan → Code)" template (2 steps: planner + coder)
			const options = getAllByTestId('template-option');
			const codingOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Coding (Plan → Code)'
			);
			expect(codingOption).toBeTruthy();
			fireEvent.click(codingOption!);

			// Should have 2 nodes (planner + coder)
			expect(getAllByTestId(/^workflow-node-/).length).toBe(2);
		});

		it('selecting a template creates edges between nodes', () => {
			const { getByTestId, getAllByTestId, container } = render(
				<VisualWorkflowEditor {...makeProps()} />
			);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			const codingOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Coding (Plan → Code)'
			);
			fireEvent.click(codingOption!);

			// Should have 1 edge connecting the 2 nodes (EdgeRenderer uses data-edge-id attribute)
			expect(container.querySelectorAll('[data-edge-id]').length).toBe(1);
		});

		it('selecting a template assigns autoLayout positions (non-zero for at least one node)', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			const codingOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Coding (Plan → Code)'
			);
			fireEvent.click(codingOption!);

			// Nodes use absolute positioning via `left` and `top` style properties.
			// autoLayout places the first node at START_X=50, START_Y=50, so at
			// least one node must have a non-zero left position.
			const nodes = getAllByTestId(/^workflow-node-/);
			const hasNonZeroLeft = nodes.some((n) => {
				const left = n.style.left;
				return left !== '' && left !== '0px' && left !== '0';
			});
			expect(hasNonZeroLeft).toBe(true);
		});

		it('selects first step as start node after template applied', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			const codingOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Coding (Plan → Code)'
			);
			fireEvent.click(codingOption!);

			// Exactly one node should have the START badge
			const startBadges = getAllByTestId(/^workflow-node-/).filter((n) =>
				n.textContent?.includes('START')
			);
			expect(startBadges.length).toBe(1);
		});

		it('sets workflow name from template label when name is empty', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			const codingOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Coding (Plan → Code)'
			);
			fireEvent.click(codingOption!);

			expect((getByTestId('workflow-name-input') as HTMLInputElement).value).toBe(
				'Coding (Plan → Code)'
			);
		});

		it('does not override existing name when applying template', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.input(getByTestId('workflow-name-input'), { target: { value: 'My Custom Name' } });

			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			const codingOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Coding (Plan → Code)'
			);
			fireEvent.click(codingOption!);

			expect((getByTestId('workflow-name-input') as HTMLInputElement).value).toBe('My Custom Name');
		});

		it('closes template dropdown after selecting a template', () => {
			const { getByTestId, getAllByTestId, queryAllByTestId } = render(
				<VisualWorkflowEditor {...makeProps()} />
			);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			fireEvent.click(options[0]);

			expect(queryAllByTestId('template-option').length).toBe(0);
		});

		it('hides template button once nodes have been added (overwrite protection)', () => {
			const { getByTestId, queryByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			// Button visible before any nodes
			expect(queryByTestId('template-picker-button')).toBeTruthy();

			// Add a step manually
			fireEvent.click(getByTestId('add-step-button'));

			// Button must be hidden now that the canvas has content
			expect(queryByTestId('template-picker-button')).toBeNull();
		});

		it('hides template button after a template is applied', () => {
			const { getByTestId, getAllByTestId, queryByTestId } = render(
				<VisualWorkflowEditor {...makeProps()} />
			);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			fireEvent.click(options[0]);

			// Template created nodes → button should be gone
			expect(queryByTestId('template-picker-button')).toBeNull();
		});

		it('single-step template (Quick Fix) creates one node and no edges', () => {
			const { getByTestId, getAllByTestId, container } = render(
				<VisualWorkflowEditor {...makeProps()} />
			);
			fireEvent.click(getByTestId('template-picker-button'));
			const options = getAllByTestId('template-option');
			const quickFixOption = options.find(
				(el) => el.getAttribute('data-template-label') === 'Quick Fix (Code only)'
			);
			fireEvent.click(quickFixOption!);

			expect(getAllByTestId(/^workflow-node-/).length).toBe(1);
			expect(container.querySelectorAll('[data-edge-id]').length).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Rules section
	// -------------------------------------------------------------------------

	describe('Rules section', () => {
		it('renders the toggle rules button', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('toggle-rules-button')).toBeTruthy();
		});

		it('shows WorkflowRulesEditor when toggled', () => {
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('toggle-rules-button'));
			expect(getByText('Add Rule')).toBeTruthy();
		});

		it('hides WorkflowRulesEditor after second toggle click', () => {
			const { getByTestId, queryByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('toggle-rules-button'));
			fireEvent.click(getByTestId('toggle-rules-button'));
			expect(queryByText('Add Rule')).toBeNull();
		});
	});
});
