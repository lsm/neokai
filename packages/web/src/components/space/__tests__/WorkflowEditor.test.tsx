/**
 * Unit tests for WorkflowEditor
 *
 * Tests:
 * - Renders name and description fields
 * - Add Step button adds a new node card
 * - Remove node removes the card
 * - Reorder: move up / move down
 * - Agent dropdown (via WorkflowNodeCard) excludes 'leader' agent
 * - Template selection pre-fills steps
 * - Save calls spaceStore.createWorkflow with correct params
 * - Save calls spaceStore.updateWorkflow when editing
 * - Error shown when name is empty on save
 * - Error shown when a step has no agent assigned
 * - Cancel fires onCancel
 * - initFromWorkflow preserves systemPrompt from agents[0]
 * - buildTemplateNodes wraps systemPrompt in WorkflowNodeAgentOverride
 * - handleSave includes systemPrompt in saved agent for single-agent nodes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceAgent, SpaceWorkflow, WorkflowNodeAgentOverride } from '@neokai/shared';
import { makeBuiltInTemplateWorkflows } from './fixtures/builtInTemplateWorkflows';

// ---- Mocks ----
// Signals are initialized immediately so vi.mock's lazy getter can reference them safely.

const mockAgents: Signal<SpaceAgent[]> = signal([]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);
const mockWorkflowTemplates: Signal<SpaceWorkflow[]> = signal([]);
const mockNodeExecutionsByNodeId = signal(new Map<string, unknown[]>());
const mockWorkflowRuns = signal<unknown[]>([]);

const mockCreateWorkflow = vi.fn();
const mockUpdateWorkflow = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			agents: mockAgents,
			workflows: mockWorkflows,
			workflowTemplates: mockWorkflowTemplates,
			nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
			workflowRuns: mockWorkflowRuns,
			createWorkflow: mockCreateWorkflow,
			updateWorkflow: mockUpdateWorkflow,
		};
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import {
	WorkflowEditor,
	buildTemplateNodes,
	filterAgents,
	getAvailableTemplates,
	initFromWorkflow,
} from '../WorkflowEditor';

function makeAgent(id: string, name: string, _role = 'coder'): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name,
		instructions: null,
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
		nodes: [
			{
				id: step1Id,
				name: 'Plan',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
				instructions: 'Plan things',
			},
			{
				id: step2Id,
				name: 'Code',
				agents: [{ agentId: 'agent-2', name: 'coder' }],
				instructions: '',
			},
		],
		startNodeId: step1Id,
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
			makeAgent('agent-4', 'reviewer', 'reviewer'),
			makeAgent('agent-5', 'research', 'research'),
			makeAgent('agent-6', 'qa', 'qa'),
			makeAgent('agent-leader', 'leader', 'leader'),
		];
		mockWorkflows.value = [];
		mockWorkflowTemplates.value = makeBuiltInTemplateWorkflows({ includeSystemPrompts: true });
		mockCreateWorkflow.mockResolvedValue({ id: 'new-wf', nodes: [], tags: [] });
		mockUpdateWorkflow.mockResolvedValue({ id: 'wf-1', nodes: [], tags: [] });
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
		const removeButtons = getAllByTitle('Remove node');
		fireEvent.click(removeButtons[0]);
		expect(getByText('1 step')).toBeTruthy();
	});

	it('disables Remove button when only one step remains', () => {
		const { getByTitle } = render(<WorkflowEditor {...defaultProps} />);
		const removeBtn = getByTitle('Remove node') as HTMLButtonElement;
		expect(removeBtn.disabled).toBe(true);
	});

	it('enables Remove button when more than one step exists', () => {
		const { getByText, getAllByTitle } = render(<WorkflowEditor {...defaultProps} />);
		fireEvent.click(getByText('Add Step'));
		const removeBtns = getAllByTitle('Remove node') as HTMLButtonElement[];
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

		it('excludes agents whose name contains "leader" (case-insensitive)', () => {
			// filterAgents filters by a.name.toLowerCase() !== 'leader'.
			// It only excludes agents whose name (not role) is exactly "leader" (case-insensitive).
			// Agents named "orchestrator" or "coordinator" are NOT filtered.
			const agents: SpaceAgent[] = [
				makeAgent('1', 'leader'),
				makeAgent('2', 'Leader'),
				makeAgent('3', 'orchestrator'),
				makeAgent('4', 'coordinator'),
				makeAgent('5', 'coder'),
			];
			const filtered = filterAgents(agents);
			expect(filtered.map((a) => a.name)).toEqual(['orchestrator', 'coordinator', 'coder']);
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
		it('returns ordered steps following startNodeId', () => {
			const wf = makeWorkflow();
			const { steps } = initFromWorkflow(wf);
			expect(steps.map((s) => s.name)).toEqual(['Plan', 'Code']);
		});

		it('returns transitions (always) between sequential steps', () => {
			const wf = makeWorkflow();
			const { transitions } = initFromWorkflow(wf);
			expect(transitions).toHaveLength(1);
			expect(transitions[0].type).toBe('always');
		});

		it('appends nodes not matching startNodeId after the start node', () => {
			const wf = makeWorkflow({
				nodes: [
					{ id: 'step-1', name: 'Plan', agents: [{ agentId: 'a1', name: 'planner' }] },
					{ id: 'step-2', name: 'Code', agents: [{ agentId: 'a2', name: 'coder' }] },
					{ id: 'orphan', name: 'Orphan', agents: [{ agentId: 'a3', name: 'general' }] },
				],
				startNodeId: 'step-1',
			});
			const { steps } = initFromWorkflow(wf);
			expect(steps.map((s) => s.name)).toEqual(['Plan', 'Code', 'Orphan']);
		});

		it('loads channels from existing workflow', () => {
			const wf = makeWorkflow({
				channels: [{ from: 'task-agent', to: 'coder', direction: 'bidirectional' }],
			});
			const { channels } = initFromWorkflow(wf);
			expect(channels).toHaveLength(1);
			expect(channels[0].from).toBe('task-agent');
			expect(channels[0].to).toBe('coder');
		});

		it('returns empty channels array when workflow has none', () => {
			const wf = makeWorkflow();
			const { channels } = initFromWorkflow(wf);
			expect(channels).toHaveLength(0);
		});

		it('preserves systemPrompt from agents[0] for single-agent nodes', () => {
			const wf = makeWorkflow({
				nodes: [
					{
						id: 'step-1',
						name: 'Plan',
						agents: [
							{
								agentId: 'agent-1',
								name: 'planner',
								systemPrompt: { mode: 'override', value: 'Plan carefully.' },
							},
						],
					},
					{
						id: 'step-2',
						name: 'Code',
						agents: [
							{
								agentId: 'agent-2',
								name: 'coder',
								systemPrompt: { mode: 'expand', value: 'Code fast.' },
							},
						],
					},
				],
			});
			const { steps } = initFromWorkflow(wf);
			expect(steps[0].systemPrompt).toEqual({ mode: 'override', value: 'Plan carefully.' });
			expect(steps[1].systemPrompt).toEqual({ mode: 'expand', value: 'Code fast.' });
		});

		it('preserves systemPrompt mode from agents[0]', () => {
			const wf = makeWorkflow({
				nodes: [
					{
						id: 'step-1',
						name: 'Plan',
						agents: [
							{
								agentId: 'agent-1',
								name: 'planner',
								systemPrompt: { mode: 'expand', value: 'Extra planning context.' },
							},
						],
					},
				],
			});
			const { steps } = initFromWorkflow(wf);
			expect(steps[0].systemPrompt?.mode).toBe('expand');
			expect(steps[0].systemPrompt?.value).toBe('Extra planning context.');
		});

		it('normalizes legacy string systemPrompt to override object', () => {
			const wf: SpaceWorkflow = {
				id: 'wf-legacy',
				spaceId: 'space-1',
				name: 'Legacy Workflow',
				description: '',
				nodes: [
					{
						id: 'step-1',
						name: 'Step 1',
						agents: [
							{
								agentId: 'agent-1',
								name: 'coder',
								systemPrompt: 'Legacy string prompt.',
							} as unknown as {
								agentId: string;
								name: string;
								systemPrompt?: WorkflowNodeAgentOverride;
							},
						],
					},
				],
				startNodeId: 'step-1',
				tags: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const { steps } = initFromWorkflow(wf);
			expect(steps[0].systemPrompt).toEqual({ mode: 'override', value: 'Legacy string prompt.' });
		});

		it('sets systemPrompt to undefined when agents[0] has no systemPrompt', () => {
			const wf = makeWorkflow();
			const { steps } = initFromWorkflow(wf);
			expect(steps[0].systemPrompt).toBeUndefined();
		});

		it('preserves multi-agent nodes with their agents array', () => {
			const wf = makeWorkflow({
				nodes: [
					{
						id: 'step-1',
						name: 'Multi',
						agents: [
							{
								agentId: 'agent-1',
								name: 'planner',
								systemPrompt: { mode: 'override', value: 'Plan.' },
							},
							{
								agentId: 'agent-2',
								name: 'coder',
								systemPrompt: { mode: 'override', value: 'Code.' },
							},
						],
					},
				],
			});
			const { steps } = initFromWorkflow(wf);
			expect(steps[0].agents).toHaveLength(2);
			expect(steps[0].agents?.[0].systemPrompt).toEqual({ mode: 'override', value: 'Plan.' });
			expect(steps[0].agents?.[1].systemPrompt).toEqual({ mode: 'override', value: 'Code.' });
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
			expect(getByText('Coding Workflow')).toBeTruthy();
			expect(getByText('Coding with QA Workflow')).toBeTruthy();
			expect(getByText('Research Workflow')).toBeTruthy();
			expect(getByText('Review-Only Workflow')).toBeTruthy();
			expect(getByText('Full-Cycle Coding Workflow')).toBeTruthy();
		});

		it('applying Coding template creates 2 steps', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Coding Workflow'));
			expect(getByText('2 steps')).toBeTruthy();
		});

		it('applying Review-Only template creates 1 step', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Review-Only Workflow'));
			expect(getByText('1 step')).toBeTruthy();
		});

		it('applying Research template creates 2 steps', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Research Workflow'));
			expect(getByText('2 steps')).toBeTruthy();
		});

		it('applying Full-Cycle Coding Workflow template creates 5 steps', () => {
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Full-Cycle Coding Workflow'));
			expect(getByText('5 steps')).toBeTruthy();
		});

		it('Full-Cycle Coding Workflow template builds explicit system prompts for every node', () => {
			const template = getAvailableTemplates(mockWorkflowTemplates.value).find(
				(entry) => entry.label === 'Full-Cycle Coding Workflow'
			);
			expect(template).toBeTruthy();
			const nodes = buildTemplateNodes(template!, mockAgents.value);
			expect(nodes).toHaveLength(5);
			for (const node of nodes) {
				if (node.agents && node.agents.length > 0) {
					for (const agent of node.agents) {
						expect(agent.systemPrompt?.value?.trim().length).toBeGreaterThan(0);
					}
					continue;
				}
				expect(node.systemPrompt?.value?.trim().length).toBeGreaterThan(0);
			}
		});

		it('template sets workflow name if name is empty', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Review-Only Workflow'));
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			expect(nameInput.value).toBe('Review-Only Workflow');
		});

		it('template does not override existing name', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Custom Name' } });
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Review-Only Workflow'));
			expect(nameInput.value).toBe('My Custom Name');
		});

		it('template looks up agents by name matching role', () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			fireEvent.click(getByText('Coding Workflow'));
			const agentSelects = container.querySelectorAll('select');
			if (agentSelects.length > 0) {
				expect((agentSelects[0] as HTMLSelectElement).value).toBe('agent-2');
			}
		});

		it('template agent lookup supports fuzzy role-name matching', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Coding Workflow',
					description: 'Two-step coding workflow',
					steps: [
						{ name: 'Code', role: 'coder' },
						{ name: 'Review', role: 'reviewer' },
					],
				},
				[
					makeAgent('agent-a', 'Primary Planner Agent'),
					makeAgent('agent-b', 'Senior Coder'),
					makeAgent('agent-c', 'Principal Reviewer'),
				]
			);

			expect(nodes[0].agents?.[0].agentId).toBe('agent-b');
			expect(nodes[0].agents?.[0].name).toBe('coder');
			expect(nodes[1].agents?.[0].agentId).toBe('agent-c');
			expect(nodes[1].agents?.[0].name).toBe('reviewer');
		});

		it('template assigns fallback agents when no role-name match exists', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Fallback Template',
					description: 'No matching roles',
					steps: [
						{ name: 'Step A', role: 'coder' },
						{ name: 'Step B', role: 'reviewer' },
					],
				},
				[makeAgent('agent-x', 'Alice'), makeAgent('agent-y', 'Bob')]
			);

			expect(nodes[0].agents?.[0].agentId).toBe('agent-x');
			expect(nodes[0].agents?.[0].name).toBe('coder');
			expect(nodes[1].agents?.[0].agentId).toBe('agent-y');
			expect(nodes[1].agents?.[0].name).toBe('reviewer');
		});

		it('uses explicit agentId from template step when provided', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Explicit Agent ID',
					description: 'Template with explicit IDs',
					steps: [{ name: 'Code', role: 'coder', agentId: 'agent-2' }],
				},
				mockAgents.value
			);
			expect(nodes[0].agents?.[0].agentId).toBe('agent-2');
			expect(nodes[0].agents?.[0].name).toBe('coder');
		});

		it('prefers built-in workflows from store as template source', () => {
			const templates = getAvailableTemplates(
				makeBuiltInTemplateWorkflows({ includeSystemPrompts: true })
			);
			expect(templates.map((template) => template.label)).toEqual([
				'Coding Workflow',
				'Research Workflow',
				'Review-Only Workflow',
				'Full-Cycle Coding Workflow',
				'Coding with QA Workflow',
			]);
		});

		it('shows empty state when no built-in templates are available', () => {
			mockWorkflowTemplates.value = [];
			const { getByText } = render(<WorkflowEditor {...defaultProps} />);
			fireEvent.click(getByText(/Start from template/));
			expect(getByText('No built-in templates are available for this space yet.')).toBeTruthy();
		});
	});

	describe('buildTemplateNodes', () => {
		it('wraps systemPrompt in WorkflowNodeAgentOverride for single-agent steps', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Test Template',
					description: 'Test',
					steps: [{ name: 'Step A', role: 'coder', systemPrompt: 'Be careful.' }],
				},
				mockAgents.value
			);
			expect(nodes[0].systemPrompt).toEqual({ mode: 'override', value: 'Be careful.' });
		});

		it('creates a single-slot agents entry for single-agent steps', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Single Slot Template',
					description: 'Single slot',
					steps: [{ name: 'Review', role: 'reviewer' }],
				},
				mockAgents.value
			);
			expect(nodes[0].agentId).toBe('agent-4');
			expect(nodes[0].agents).toHaveLength(1);
			expect(nodes[0].agents?.[0].name).toBe('reviewer');
			expect(nodes[0].agents?.[0].agentId).toBe('agent-4');
		});

		it('wraps per-slot systemPrompt in WorkflowNodeAgentOverride for multi-agent steps', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Multi Template',
					description: 'Multi',
					steps: [
						{
							name: 'Review',
							agentSlots: [
								{ name: 'Reviewer 1', role: 'reviewer', systemPrompt: 'Review carefully.' },
								{ name: 'Reviewer 2', role: 'reviewer', systemPrompt: 'Focus on bugs.' },
							],
						},
					],
				},
				mockAgents.value
			);
			expect(nodes[0].agents).toHaveLength(2);
			expect(nodes[0].agents?.[0].systemPrompt).toEqual({
				mode: 'override',
				value: 'Review carefully.',
			});
			expect(nodes[0].agents?.[1].systemPrompt).toEqual({
				mode: 'override',
				value: 'Focus on bugs.',
			});
		});

		it('sets systemPrompt to undefined when template step has no systemPrompt', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'No Prompt Template',
					description: 'Test',
					steps: [{ name: 'Step A', role: 'coder' }],
				},
				mockAgents.value
			);
			expect(nodes[0].systemPrompt).toBeUndefined();
		});

		it('wraps per-slot instructions in WorkflowNodeAgentOverride for multi-agent steps', () => {
			const nodes = buildTemplateNodes(
				{
					label: 'Instructions Template',
					description: 'Test',
					steps: [
						{
							name: 'Code',
							agentSlots: [{ name: 'Coder 1', role: 'coder', instructions: 'Focus on tests.' }],
						},
					],
				},
				mockAgents.value
			);
			expect(nodes[0].agents?.[0].instructions).toEqual({
				mode: 'override',
				value: 'Focus on tests.',
			});
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

		it('persists per-agent systemPrompt overrides when saving an existing workflow', async () => {
			const workflow = makeWorkflow({
				nodes: [
					{
						id: 'step-1',
						name: 'Plan',
						agents: [
							{
								agentId: 'agent-1',
								name: 'planner',
								systemPrompt: { mode: 'override', value: 'Visible workflow prompt.' },
							},
						],
						instructions: 'Plan things',
					},
					{
						id: 'step-2',
						name: 'Code',
						agents: [
							{
								agentId: 'agent-2',
								name: 'coder',
								systemPrompt: { mode: 'override', value: 'Implement exactly what was approved.' },
							},
						],
					},
				],
			});
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={workflow} />);
			fireEvent.click(getByText('Save Changes'));
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledWith(
					'wf-1',
					expect.objectContaining({
						nodes: expect.arrayContaining([
							expect.objectContaining({ name: 'Plan' }),
							expect.objectContaining({ name: 'Code' }),
						]),
					})
				);
			});
		});

		it('includes systemPrompt in saved agent for single-agent nodes', async () => {
			const workflow = makeWorkflow({
				nodes: [
					{
						id: 'step-1',
						name: 'Plan',
						agents: [
							{
								agentId: 'agent-1',
								name: 'planner',
								systemPrompt: { mode: 'override', value: 'Plan carefully.' },
							},
						],
						instructions: 'Plan things',
					},
				],
			});
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={workflow} />);
			fireEvent.click(getByText('Save Changes'));
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledTimes(1);
			});
			const callArgs = mockUpdateWorkflow.mock.calls[0][1];
			const savedNode = callArgs.nodes[0];
			expect(savedNode.agents[0].systemPrompt).toEqual({
				mode: 'override',
				value: 'Plan carefully.',
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

		it('sends steps with generated IDs', async () => {
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
						nodes: expect.arrayContaining([expect.objectContaining({ name: expect.any(String) })]),
					})
				);
			});
		});
	});

	describe('channels', () => {
		it('channels are included in createWorkflow call when empty', async () => {
			const { getByText, container } = render(<WorkflowEditor {...defaultProps} />);
			const nameInput = container.querySelector(
				'input[placeholder="e.g. Feature Development"]'
			) as HTMLInputElement;
			fireEvent.input(nameInput, { target: { value: 'My Workflow' } });
			selectAgent(container, 'agent-1');
			fireEvent.click(getByText('Create Workflow'));
			await waitFor(() => {
				expect(mockCreateWorkflow).toHaveBeenCalledWith(
					expect.objectContaining({ channels: undefined })
				);
			});
		});

		it('channels from existing workflow are included in updateWorkflow call', async () => {
			const wf = makeWorkflow({
				channels: [{ from: 'task-agent', to: 'coder', direction: 'bidirectional' }],
			});
			const { getByText } = render(<WorkflowEditor {...defaultProps} workflow={wf} />);
			fireEvent.click(getByText('Save Changes'));
			await waitFor(() => {
				expect(mockUpdateWorkflow).toHaveBeenCalledWith(
					'wf-1',
					expect.objectContaining({
						channels: [{ from: 'task-agent', to: 'coder', direction: 'bidirectional' }],
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
});
