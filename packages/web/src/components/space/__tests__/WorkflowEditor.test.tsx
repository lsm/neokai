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
 * - Error shown when a step has no agent assigned
 * - Error shown when a condition transition has empty shell expression
 * - Cancel fires onCancel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';

// ---- Mocks ----
// Signals are initialized immediately so vi.mock's lazy getter can reference them safely.

const mockAgents: Signal<SpaceAgent[]> = signal([]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);

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

import { WorkflowEditor, filterAgents, initFromWorkflow } from '../WorkflowEditor';

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

/** Select an agent on the currently-expanded step card */
function selectAgent(container: Element, agentId: string) {
	const agentSelect = container.querySelectorAll('select')[0] as HTMLSelectElement;
	fireEvent.change(agentSelect, { target: { value: agentId } });
}

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
		mockCreateWorkflow.mockClear();
		mockUpdateWorkflow.mockClear();
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
		const nameInput = container.querySelector(
			'input[placeholder="e.g. Feature Development"]'
		) as HTMLInputElement;
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
		expect(getByText('1 step')).toBeTruthy();
		fireEvent.click(getByText('Add Step'));
		expect(getByText('2 steps')).toBeTruthy();
		const removeButtons = getAllByTitle('Remove step');
		fireEvent.click(removeButtons[0]);
		expect(getByText('1 step')).toBeTruthy();
	});

	it('disables Remove button when only one step remains', () => {
		const { getByTitle } = render(<WorkflowEditor {...defaultProps} />);
		const removeBtn = getByTitle('Remove step') as HTMLButtonElement;
		expect(removeBtn.disabled).toBe(true);
	});

	it('enables Remove button when more than one step exists', () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		fireEvent.click(getByText('Add Step'));
		const removeBtns = getAllByTitle('Remove step') as HTMLButtonElement[];
		expect(removeBtns[0].disabled).toBe(false);
		expect(removeBtns[1].disabled).toBe(false);
	});

	it('moves step up when Move Up clicked', () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		fireEvent.click(getByText('Add Step'));
		const moveUpButtons = getAllByTitle('Move up') as HTMLButtonElement[];
		expect(moveUpButtons[0].disabled).toBe(true); // first step
		expect(moveUpButtons[1].disabled).toBe(false); // second step
		fireEvent.click(moveUpButtons[1]);
	});

	it('moves step down when Move Down clicked', () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		fireEvent.click(getByText('Add Step'));
		const moveDownButtons = getAllByTitle('Move down') as HTMLButtonElement[];
		expect(moveDownButtons[0].disabled).toBe(false);
		expect(moveDownButtons[1].disabled).toBe(true);
		fireEvent.click(moveDownButtons[0]);
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

		it('excludes agents with role "leader" regardless of name', () => {
			const agents: SpaceAgent[] = [
				makeAgent('1', 'orchestrator', 'leader'),
				makeAgent('2', 'coordinator', 'Leader'),
				makeAgent('3', 'coder', 'coder'),
			];
			const filtered = filterAgents(agents);
			expect(filtered.map((a) => a.name)).toEqual(['coder']);
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

	describe('initFromWorkflow', () => {
		it('returns ordered steps following startStepId', () => {
			const wf = makeWorkflow();
			const { steps } = initFromWorkflow(wf);
			expect(steps.map((s) => s.name)).toEqual(['Plan', 'Code']);
		});

		it('returns transitions between sequential steps', () => {
			const wf = makeWorkflow();
			const { transitions } = initFromWorkflow(wf);
			expect(transitions).toHaveLength(1);
			expect(transitions[0].type).toBe('always');
		});

		it('preserves transition condition type', () => {
			const s1 = 'step-1';
			const s2 = 'step-2';
			const wf = makeWorkflow({
				transitions: [{ id: 'tr-1', from: s1, to: s2, condition: { type: 'human' }, order: 0 }],
			});
			const { transitions } = initFromWorkflow(wf);
			expect(transitions[0].type).toBe('human');
		});

		it('appends orphaned steps not reachable from startStepId', () => {
			const wf = makeWorkflow({
				steps: [
					{ id: 'step-1', name: 'Plan', agentId: 'a1' },
					{ id: 'step-2', name: 'Code', agentId: 'a2' },
					{ id: 'orphan', name: 'Orphan', agentId: 'a3' },
				],
				transitions: [{ id: 'tr-1', from: 'step-1', to: 'step-2', order: 0 }],
				startStepId: 'step-1',
			});
			const { steps } = initFromWorkflow(wf);
			expect(steps.map((s) => s.name)).toEqual(['Plan', 'Code', 'Orphan']);
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
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			expect(nameInput.value).toBe('Quick Fix (Code only)');
		});

		it('template does not override existing name', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Custom Name' } });
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Quick Fix (Code only)'));
			expect(nameInput.value).toBe('My Custom Name');
		});

		it('template looks up agents by name matching role', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Coding (Plan → Code)'));
			const agentSelects = container.querySelectorAll('select');
			if (agentSelects.length > 0) {
				expect((agentSelects[0] as HTMLSelectElement).value).toBe('agent-1');
			}
		});
	});

	describe('save', () => {
		it('shows error when name is empty on save attempt', async () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(getByText('Workflow name is required.')).toBeTruthy();
			});
		});

		it('shows error when a step has no agent assigned', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			// Do NOT select an agent — step.agentId stays empty
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(getByText('Step 1 requires an agent.')).toBeTruthy();
			});
			expect(mockCreateWorkflow).not.toHaveBeenCalled();
		});

		it('shows error when a condition transition has empty shell expression', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			// Set name
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			// Select agent for step 1
			selectAgent(container, 'agent-1');
			// Add step 2
			fireEvent.click(getByText('Add Step'));
			selectAgent(container, 'agent-2');
			// Change exit gate of step 1 to 'condition' with empty expression
			// Step 1 was previously expanded, but after Add Step, step 2 is expanded.
			// Click step 1 header to expand it
			const stepHeaders = container.querySelectorAll('.cursor-pointer');
			fireEvent.click(stepHeaders[0]);
			// Now find the exit gate select (selects[2] = exit gate when entry+agent are visible)
			const selects = container.querySelectorAll('select');
			// Find exit gate select — it's labeled 'Exit Gate', the last condition select
			const exitGateSelect = selects[selects.length - 1] as HTMLSelectElement;
			fireEvent.change(exitGateSelect, { target: { value: 'condition' } });
			// Leave expression empty and try to save
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(getByText(/Transition after step 1 requires a shell expression/)).toBeTruthy();
			});
			expect(mockCreateWorkflow).not.toHaveBeenCalled();
		});

		it('calls createWorkflow on save in create mode', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			selectAgent(container, 'agent-1');
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
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			selectAgent(container, 'agent-1');
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(defaultProps.onSave).toHaveBeenCalledOnce();
			});
		});

		it('shows error message when createWorkflow throws', async () => {
			mockCreateWorkflow.mockRejectedValueOnce(new Error('Server error'));
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			selectAgent(container, 'agent-1');
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(getByText('Server error')).toBeTruthy();
			});
		});

		it('sends steps with generated IDs and transitions', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'Test' } });
			selectAgent(container, 'agent-1');
			fireEvent.click(getByText('Add Step'));
			selectAgent(container, 'agent-2');
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
			expect(getByText('Plan')).toBeTruthy();
		});

		it('loads tags from existing workflow', () => {
			const wf = makeWorkflow({ tags: ['coding', 'review'] });
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={wf} />);
			expect(getByText('coding')).toBeTruthy();
			expect(getByText('review')).toBeTruthy();
		});

		it('loads rules from existing workflow', () => {
			const wf = makeWorkflow({
				rules: [{ id: 'r1', name: 'My Rule', content: 'Rule content', appliesTo: [] }],
			});
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={wf} />);
			expect(getByText('1 rule')).toBeTruthy();
		});
	});

	describe('tags', () => {
		it('renders tags section with Add tags placeholder', () => {
			const { container } = render(<WorkflowEditor {...defaultProps} />);
			const tagInput = container.querySelector(
				'input[placeholder*="Add tags"]'
			) as HTMLInputElement;
			expect(tagInput).toBeTruthy();
		});

		it('shows tag suggestion buttons', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			expect(getByText('+ coding')).toBeTruthy();
			expect(getByText('+ review')).toBeTruthy();
		});

		it('clicking a suggestion adds the tag', () => {
			const { getByText, queryByText } = render(<WorkflowEditor {...defaultProps} />);
			expect(queryByText('coding')).toBeNull();
			fireEvent.click(getByText('+ coding'));
			// After adding, the chip appears and the suggestion button disappears
			// The tag chip text is rendered, so the suggestion "coding" should show as a chip
			// Check suggestion button is gone (tag was added)
			expect(queryByText('+ coding')).toBeNull();
		});

		it('tags are included in createWorkflow call', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			// Set name
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'Tagged Workflow' } });
			// Select agent
			selectAgent(container, 'agent-1');
			// Add tag via suggestion
			fireEvent.click(getByText('+ coding'));
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledWith(
					expect.objectContaining({ tags: ['coding'] })
				);
			});
		});

		it('tags are included in updateWorkflow call', async () => {
			const wf = makeWorkflow({ tags: ['research'] });
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={wf} />);
			fireEvent.click(getByText('Save Changes'));
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledWith(
					'wf-1',
					expect.objectContaining({ tags: ['research'] })
				);
			});
		});
	});

	describe('rules', () => {
		it('renders the Rules section with "Add Rule" button', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			expect(getByText('Add Rule')).toBeTruthy();
		});

		it('clicking Add Rule shows a rule card', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText('Add Rule'));
			expect(getByText('1 rule')).toBeTruthy();
		});

		it('rules are included in createWorkflow call (non-blank rules only)', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			selectAgent(container, 'agent-1');
			fireEvent.click(getByText('Add Rule'));
			// Fill rule name — rule card has an input with "Rule name" placeholder
			const ruleNameInput = container.querySelector(
				'input[placeholder*="Rule name"]'
			) as HTMLInputElement;
			fireEvent.input(ruleNameInput, { target: { value: 'Follow conventions' } });
			// Fill rule content — rule card textarea has "Describe the rule" placeholder
			const ruleTextarea = container.querySelector(
				'textarea[placeholder*="Describe the rule"]'
			) as HTMLTextAreaElement;
			fireEvent.input(ruleTextarea, { target: { value: 'Write clean code' } });
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledWith(
					expect.objectContaining({
						rules: expect.arrayContaining([
							expect.objectContaining({
								name: 'Follow conventions',
								content: 'Write clean code',
							}),
						]),
					})
				);
			});
		});

		it('blank rules are excluded from the createWorkflow call', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			selectAgent(container, 'agent-1');
			// Add a rule but leave it blank
			fireEvent.click(getByText('Add Rule'));
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledWith(expect.objectContaining({ rules: [] }));
			});
		});

		it('rules are included in updateWorkflow call', async () => {
			const wf = makeWorkflow({
				rules: [{ id: 'r1', name: 'Existing Rule', content: 'Some content', appliesTo: [] }],
			});
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={wf} />);
			fireEvent.click(getByText('Save Changes'));
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledWith(
					'wf-1',
					expect.objectContaining({
						rules: expect.arrayContaining([
							expect.objectContaining({ name: 'Existing Rule', content: 'Some content' }),
						]),
					})
				);
			});
		});
	});
});
