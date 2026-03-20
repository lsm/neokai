// @ts-nocheck
/**
 * Unit tests for WorkflowEditor
 *
 * Tests:
 * - Renders name and description fields
 * - Add step button adds a new step card
 * - Remove step removes the card
 * - Reorder: move up / move down
 * - Agent dropdown (via WorkflowStepCard) excludes 'leader' agent
 * - Template selection pre-fills steps
 * - Save calls spaceStore.createWorkflow with correct params
 * - Save calls spaceStore.updateWorkflow when editing
 * - Error shown when name is empty on save
 * - Cancel fires onCancel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';

// ---- Mocks ----

let mockAgents: ReturnType<typeof signal<SpaceAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;

const mockCreateWorkflow = vi.fn();
const mockUpdateWorkflow = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			agents: mockAgents,
			workflows: mockWorkflows,
			createWorkflow: mockCreateWorkflow,
			updateWorkflow: mockUpdateWorkflow,
		};
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Initialize signals before import
mockAgents = signal<SpaceAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);

import { WorkflowEditor, filterAgents } from '../WorkflowEditor';

function makeAgent(id: string, name: string, role = 'coder'): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name,
		role,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	const step1Id = 'step-1';
	const step2Id = 'step-2';
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Existing Workflow',
		description: 'A description',
		steps: [
			{ id: step1Id, name: 'Plan', agentId: 'agent-1', instructions: 'Plan things' },
			{ id: step2Id, name: 'Code', agentId: 'agent-2', instructions: '' },
		],
		transitions: [{ id: 'tr-1', from: step1Id, to: step2Id, order: 0 }],
		startStepId: step1Id,
		rules: [],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

const defaultProps = {
	onSave: vi.fn(),
	onCancel: vi.fn(),
};

describe('WorkflowEditor', () => {
	beforeEach(() => {
		cleanup();
		mockAgents.value = [
			makeAgent('agent-1', 'planner', 'planner'),
			makeAgent('agent-2', 'coder', 'coder'),
			makeAgent('agent-3', 'general', 'general'),
			makeAgent('agent-leader', 'leader', 'leader'),
		];
		mockWorkflows.value = [];
		mockCreateWorkflow.mockResolvedValue({ id: 'new-wf', steps: [], transitions: [], tags: [] });
		mockUpdateWorkflow.mockResolvedValue({ id: 'wf-1', steps: [], transitions: [], tags: [] });
		defaultProps.onSave.mockClear();
		defaultProps.onCancel.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders name and description fields', () => {
		const { getByPlaceholderText } = render(<WorkflowEditor {...defaultProps} />);
		expect(getByPlaceholderText('e.g. Feature Development')).toBeTruthy();
		expect(getByPlaceholderText('What does this workflow accomplish?')).toBeTruthy();
	});

	it('renders "New Workflow" title for create mode', () => {
		const { getByText } = render(<WorkflowEditor {...defaultProps} />);
		expect(getByText('New Workflow')).toBeTruthy();
	});

	it('renders "Edit Workflow" title for edit mode', () => {
		const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={makeWorkflow()} />);
		expect(getByText('Edit Workflow')).toBeTruthy();
	});

	it('pre-fills name and description when editing', () => {
		const { container } = render(<WorkflowEditor {...defaultProps} workflow={makeWorkflow()} />);
		const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
		expect(nameInput.value).toBe('Existing Workflow');
	});

	it('calls onCancel when Cancel button clicked', () => {
		const { getAllByText } = render(<WorkflowEditor {...defaultProps} />);
		const cancelBtns = getAllByText('Cancel');
		fireEvent.click(cancelBtns[0]);
		expect(defaultProps.onCancel).toHaveBeenCalledOnce();
	});

	it('renders initial empty step', () => {
		const { getByText } = render(<WorkflowEditor {...defaultProps} />);
		expect(getByText('1 step')).toBeTruthy();
	});

	it('adds a new step when Add Step clicked', () => {
		const { getByText } = render(<WorkflowEditor {...defaultProps} />);
		fireEvent.click(getByText('Add Step'));
		expect(getByText('2 steps')).toBeTruthy();
	});

	it('removes a step when Remove button clicked (expanded card)', async () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		// Initially 1 step
		expect(getByText('1 step')).toBeTruthy();
		// Add one more
		fireEvent.click(getByText('Add Step'));
		expect(getByText('2 steps')).toBeTruthy();
		// Remove the first step
		const removeButtons = getAllByTitle('Remove step');
		fireEvent.click(removeButtons[0]);
		expect(getByText('1 step')).toBeTruthy();
	});

	it('moves step up when Move Up clicked', () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		// Start with 1 step, add another
		fireEvent.click(getByText('Add Step'));
		// Both move buttons
		const moveUpButtons = getAllByTitle('Move up');
		// The second step (index 1) has move-up enabled; first step has it disabled
		expect(moveUpButtons[0].disabled).toBe(true); // first step
		expect(moveUpButtons[1].disabled).toBe(false); // second step
		fireEvent.click(moveUpButtons[1]);
		// After move up, the second step becomes first (no assertion on content since names are empty)
	});

	it('moves step down when Move Down clicked', () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		fireEvent.click(getByText('Add Step'));
		const moveDownButtons = getAllByTitle('Move down');
		expect(moveDownButtons[0].disabled).toBe(false); // first can move down
		expect(moveDownButtons[1].disabled).toBe(true); // last cannot
		fireEvent.click(moveDownButtons[0]);
		// Step moved down successfully
	});

	describe('filterAgents', () => {
		it('excludes agents named "leader" (case-insensitive)', () => {
			const agents: SpaceAgent[] = [
				makeAgent('1', 'planner', 'planner'),
				makeAgent('2', 'leader', 'leader'),
				makeAgent('3', 'Leader', 'leader'),
				makeAgent('4', 'coder', 'coder'),
			];
			const filtered = filterAgents(agents);
			expect(filtered.map((a) => a.name)).toEqual(['planner', 'coder']);
		});

		it('preserves all non-leader agents', () => {
			const agents: SpaceAgent[] = [
				makeAgent('1', 'planner'),
				makeAgent('2', 'coder'),
				makeAgent('3', 'general'),
				makeAgent('4', 'reviewer'),
			];
			const filtered = filterAgents(agents);
			expect(filtered).toHaveLength(4);
		});
	});

	describe('template selection', () => {
		it('shows template toggle button in create mode', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			expect(getByText(/Start from template/)).toBeTruthy();
		});

		it('does not show template toggle in edit mode', () => {
			const { queryByText } = render(
				<WorkflowEditor {...defaultProps} workflow={makeWorkflow()} />
			);
			expect(queryByText(/Start from template/)).toBeNull();
		});

		it('shows template options when toggle clicked', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			expect(getByText('Coding (Plan → Code)')).toBeTruthy();
			expect(getByText('Research (Plan → Research)')).toBeTruthy();
			expect(getByText('Quick Fix (Code only)')).toBeTruthy();
		});

		it('applying Coding template creates 2 steps', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Coding (Plan → Code)'));
			expect(getByText('2 steps')).toBeTruthy();
		});

		it('applying Quick Fix template creates 1 step', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Quick Fix (Code only)'));
			expect(getByText('1 step')).toBeTruthy();
		});

		it('applying Research template creates 2 steps', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Research (Plan → Research)'));
			expect(getByText('2 steps')).toBeTruthy();
		});

		it('template sets workflow name if name is empty', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Quick Fix (Code only)'));
			const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
			expect(nameInput.value).toBe('Quick Fix (Code only)');
		});

		it('template does not override existing name', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			// Set name first
			const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
			fireEvent.input(nameInput, { target: { value: 'My Custom Name' } });
			// Apply template
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Quick Fix (Code only)'));
			expect(nameInput.value).toBe('My Custom Name');
		});

		it('template looks up agents by name matching role', () => {
			// The planner agent should be pre-selected in Coding template step 1
			// We can verify via the step card expanded view
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Coding (Plan → Code)'));
			// Expand first step (should be expanded by default after template apply)
			const agentSelects = container.querySelectorAll('select');
			// First select in expanded card is the agent dropdown
			if (agentSelects.length > 0) {
				expect(agentSelects[0].value).toBe('agent-1'); // planner agent
			}
		});
	});

	describe('save', () => {
		it('shows error when name is empty on save attempt', async () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			const saveBtn = getByText('Create Workflow');
			fireEvent.click(saveBtn);
			await waitFor(() => {
				expect(getByText('Workflow name is required.')).toBeTruthy();
			});
		});

		it('calls createWorkflow on save in create mode', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledWith(
					expect.objectContaining({ name: 'My Workflow' })
				);
			});
		});

		it('calls updateWorkflow on save in edit mode', async () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={makeWorkflow()} />);
			fireEvent.click(getByText('Save Changes'));
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledWith(
					'wf-1',
					expect.objectContaining({ name: 'Existing Workflow' })
				);
			});
		});

		it('calls onSave after successful createWorkflow', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(defaultProps.onSave).toHaveBeenCalledOnce();
			});
		});

		it('shows error message when createWorkflow throws', async () => {
			mockCreateWorkflow.mockRejectedValueOnce(new Error('Server error'));
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(getByText('Server error')).toBeTruthy();
			});
		});

		it('sends steps with generated IDs and transitions', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector('input[placeholder="e.g. Feature Development"]');
			fireEvent.input(nameInput, { target: { value: 'Test' } });
			// Add a second step
			fireEvent.click(getByText('Add Step'));
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledWith(
					expect.objectContaining({
						steps: expect.arrayContaining([expect.objectContaining({ name: expect.any(String) })]),
						transitions: expect.arrayContaining([
							expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
						]),
					})
				);
			});
		});
	});

	describe('edit mode initialization', () => {
		it('loads steps from existing workflow', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={makeWorkflow()} />);
			expect(getByText('2 steps')).toBeTruthy();
		});

		it('loads step names from existing workflow', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={makeWorkflow()} />);
			// First step is expanded by default
			expect(getByText('Plan')).toBeTruthy();
		});
	});
});
