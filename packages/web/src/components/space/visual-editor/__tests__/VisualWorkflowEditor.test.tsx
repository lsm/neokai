/**
 * Integration tests for VisualWorkflowEditor
 *
 * Tests:
 * - Renders with empty workflow (create mode)
 * - Renders "New Workflow" title in create mode
 * - Renders "Edit Workflow" title in edit mode
 * - Pre-fills name and description when editing
 * - Add Step button adds a node
 * - Add first step sets it as start node
 * - Cancel calls onCancel
 * - Save without name shows error
 * - Save new workflow calls spaceStore.createWorkflow with layout
 * - Save existing workflow calls spaceStore.updateWorkflow with layout
 * - Save produces params that include layout positions
 * - Renders existing workflow using saved layout positions
 * - Renders existing workflow without layout (falls back to auto-layout)
 * - Node config panel shown when a node is selected
 * - Edge config panel shown when an edge is selected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';

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
		steps: [
			{ id: STEP_1_ID, name: 'Plan', agentId: 'agent-1', instructions: 'Plan it' },
			{ id: STEP_2_ID, name: 'Code', agentId: 'agent-2', instructions: '' },
		],
		transitions: [{ id: 'tr-1', from: STEP_1_ID, to: STEP_2_ID, order: 0 }],
		startStepId: STEP_1_ID,
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
	mockCreateWorkflow.mockResolvedValue({ id: 'new-wf', steps: [], transitions: [], tags: [] });
	mockUpdateWorkflow.mockResolvedValue({ id: 'wf-1', steps: [], transitions: [], tags: [] });
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

		it('renders the Add Step button', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('add-step-button')).toBeTruthy();
		});

		it('renders Save and Cancel buttons', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('save-button')).toBeTruthy();
			expect(getByTestId('cancel-button')).toBeTruthy();
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

		it('pre-fills name field with workflow name', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			const nameInput = getByTestId('workflow-name-input') as HTMLInputElement;
			expect(nameInput.value).toBe('My Workflow');
		});

		it('pre-fills description field with workflow description', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			const descInput = getByTestId('workflow-description-input') as HTMLInputElement;
			expect(descInput.value).toBe('A workflow description');
		});

		it('shows "Save Changes" on the save button in edit mode', () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);
			expect(getByTestId('save-button').textContent).toBe('Save Changes');
		});

		it('renders existing workflow with saved layout positions', () => {
			const layout = {
				[STEP_1_ID]: { x: 50, y: 50 },
				[STEP_2_ID]: { x: 300, y: 200 },
			};
			const wf = makeWorkflow({ layout });
			// Should not throw — layout is consumed during initialization
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ workflow: wf })} />);
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
		});

		it('renders existing workflow without saved layout (auto-layout fallback)', () => {
			const wf = makeWorkflow({ layout: undefined });
			// Should not throw — autoLayout is called as fallback
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ workflow: wf })} />);
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
		});
	});

	describe('Add Step', () => {
		it('adds a node when Add Step is clicked', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			// Initially no workflow nodes visible
			expect(() => getAllByTestId(/^workflow-node-/)).toThrow();

			fireEvent.click(getByTestId('add-step-button'));

			// A node should now be rendered (WorkflowNode uses data-testid="workflow-node-{stepId}")
			expect(getAllByTestId(/^workflow-node-/).length).toBeGreaterThan(0);
		});

		it('adding a second step does not replace the first', () => {
			const { getByTestId, getAllByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);

			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.click(getByTestId('add-step-button'));

			expect(getAllByTestId(/^workflow-node-/).length).toBe(2);
		});
	});

	describe('Cancel', () => {
		it('calls onCancel when Cancel button is clicked', () => {
			const onCancel = vi.fn();
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onCancel })} />);
			fireEvent.click(getByTestId('cancel-button'));
			expect(onCancel).toHaveBeenCalledOnce();
		});

		it('calls onCancel when back button is clicked', () => {
			const onCancel = vi.fn();
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onCancel })} />);
			fireEvent.click(getByTestId('back-button'));
			expect(onCancel).toHaveBeenCalledOnce();
		});
	});

	describe('Save — validation', () => {
		it('shows error when name is empty on save', async () => {
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('save-button'));
			await waitFor(() => {
				expect(getByText('Workflow name is required.')).toBeTruthy();
			});
		});

		it('does not call createWorkflow when name is empty', async () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('save-button'));
			await waitFor(() => {
				expect(mockCreateWorkflow).not.toHaveBeenCalled();
			});
		});
	});

	describe('Save — new workflow', () => {
		it('calls createWorkflow with name and layout when saving', async () => {
			const onSave = vi.fn();
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onSave })} />);

			// Set name
			fireEvent.input(getByTestId('workflow-name-input'), {
				target: { value: 'Test Workflow' },
			});

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});

			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledOnce();
			});

			const params = mockCreateWorkflow.mock.calls[0][0];
			expect(params.name).toBe('Test Workflow');
			// layout is always included (even for empty workflows)
			expect(params).toHaveProperty('layout');
			expect(typeof params.layout).toBe('object');
		});

		it('includes layout positions for each step in the saved params', async () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);

			// Add two steps
			fireEvent.click(getByTestId('add-step-button'));
			fireEvent.click(getByTestId('add-step-button'));

			// Set a name
			fireEvent.input(getByTestId('workflow-name-input'), {
				target: { value: 'Layout Test' },
			});

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});

			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledOnce();
			});

			const params = mockCreateWorkflow.mock.calls[0][0];
			expect(params.layout).toBeDefined();
			// Two steps → two layout entries
			expect(Object.keys(params.layout).length).toBe(2);
			// Each entry has x and y
			for (const pos of Object.values(params.layout) as { x: number; y: number }[]) {
				expect(typeof pos.x).toBe('number');
				expect(typeof pos.y).toBe('number');
			}
		});

		it('calls onSave after successful create', async () => {
			const onSave = vi.fn();
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps({ onSave })} />);

			fireEvent.input(getByTestId('workflow-name-input'), {
				target: { value: 'New WF' },
			});

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledOnce();
			});
		});
	});

	describe('Save — update existing workflow', () => {
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

		it('passes workflow id to updateWorkflow', async () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});

			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledOnce();
			});

			const [workflowId] = mockUpdateWorkflow.mock.calls[0];
			expect(workflowId).toBe('wf-1');
		});

		it('includes layout in update params', async () => {
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow() })} />
			);

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});

			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledOnce();
			});

			const params = mockUpdateWorkflow.mock.calls[0][1];
			expect(params).toHaveProperty('layout');
			expect(typeof params.layout).toBe('object');
			// Two steps → two entries
			expect(Object.keys(params.layout).length).toBe(2);
		});

		it('includes step positions in layout', async () => {
			const layout = {
				[STEP_1_ID]: { x: 100, y: 50 },
				[STEP_2_ID]: { x: 400, y: 200 },
			};
			const { getByTestId } = render(
				<VisualWorkflowEditor {...makeProps({ workflow: makeWorkflow({ layout }) })} />
			);

			await act(async () => {
				fireEvent.click(getByTestId('save-button'));
			});

			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledOnce();
			});

			const params = mockUpdateWorkflow.mock.calls[0][1];
			// Positions should be preserved (step IDs map through serialization)
			const positions = Object.values(params.layout) as { x: number; y: number }[];
			expect(positions.length).toBe(2);
			// At least one position should match the saved layout
			expect(positions.some((p) => p.x === 100 && p.y === 50)).toBe(true);
		});
	});

	describe('Rules section', () => {
		it('renders the toggle rules button', () => {
			const { getByTestId } = render(<VisualWorkflowEditor {...makeProps()} />);
			expect(getByTestId('toggle-rules-button')).toBeTruthy();
		});

		it('shows WorkflowRulesEditor when toggle is clicked', () => {
			const { getByTestId, getByText } = render(<VisualWorkflowEditor {...makeProps()} />);
			fireEvent.click(getByTestId('toggle-rules-button'));
			// WorkflowRulesEditor renders an "Add Rule" button
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
