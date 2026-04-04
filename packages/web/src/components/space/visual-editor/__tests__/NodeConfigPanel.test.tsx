/**
 * Unit tests for NodeConfigPanel
 *
 * Tests:
 * - Renders all primary fields (step name, agent dropdown, model override, instructions)
 * - Header shows step name and close button
 * - Step name in header updates when step changes
 * - "Set as Start" button visible for non-start nodes, hidden for start node
 * - "Set as End" button visible for non-end nodes, "Unset End Node" for end node
 * - "Set as Start" calls onSetAsStart with the step localId
 * - "Set as End" calls onSetAsEnd with the step localId
 * - onClose fires when close button clicked
 * - onUpdate fires with updated step when fields change
 * - Delete button is disabled for start node with tooltip hint
 * - Delete button shows confirmation dialog when clicked
 * - Confirming delete calls onDelete; cancelling dismisses dialog
 * - Start node badge shown in header when isStartNode=true
 * - End node badge shown in header when isEndNode=true
 * - System prompt field with OverrideModeSelector for single-agent mode
 * - Per-slot instructions and system prompt fields with OverrideModeSelector for multi-agent mode
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { SpaceAgent } from '@neokai/shared';

const mockModelsResponse = {
	models: [
		{
			id: 'claude-sonnet-4-6',
			display_name: 'Claude Sonnet 4.6',
			description: '',
			provider: 'anthropic',
		},
		{
			id: 'gpt-5.4',
			display_name: 'GPT-5.4',
			description: '',
			provider: 'openai',
		},
	],
};

const mockHub = {
	request: vi.fn(async (method: string) => {
		if (method === 'models.list') {
			return mockModelsResponse;
		}
		return {};
	}),
};

vi.mock('../../../../lib/connection-manager', () => ({
	connectionManager: {
		getHub: () => Promise.resolve(mockHub),
		getHubIfConnected: () => mockHub,
	},
}));

import { NodeConfigPanel } from '../NodeConfigPanel';
import type { NodeConfigPanelProps } from '../NodeConfigPanel';
import type { NodeDraft } from '../../WorkflowNodeCard';

afterEach(() => cleanup());

// ============================================================================
// Fixtures
// ============================================================================

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

function makeStep(overrides: Partial<NodeDraft> = {}): NodeDraft {
	return {
		localId: 'step-local-1',
		name: 'My Step',
		agentId: 'agent-1',
		instructions: 'Do stuff.',
		...overrides,
	};
}

const defaultAgents: SpaceAgent[] = [
	makeAgent('agent-1', 'Planner', 'planner'),
	makeAgent('agent-2', 'Coder', 'coder'),
];

function makeProps(overrides: Partial<NodeConfigPanelProps> = {}): NodeConfigPanelProps {
	return {
		step: makeStep(),
		agents: defaultAgents,
		isStartNode: false,
		isEndNode: false,
		onUpdate: vi.fn(),
		onSetAsStart: vi.fn(),
		onSetAsEnd: vi.fn(),
		onClose: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('NodeConfigPanel', () => {
	describe('rendering', () => {
		it('renders the panel element', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('node-config-panel')).toBeTruthy();
		});

		it('shows the step name in the header', () => {
			const { getByText } = render(
				<NodeConfigPanel {...makeProps({ step: makeStep({ name: 'Parse Data' }) })} />
			);
			expect(getByText('Parse Data')).toBeTruthy();
		});

		it('shows "Unnamed Node" when name is empty', () => {
			const { getByText } = render(
				<NodeConfigPanel {...makeProps({ step: makeStep({ name: '' }) })} />
			);
			expect(getByText('Unnamed Node')).toBeTruthy();
		});

		it('renders the step name input with current value', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			const input = getByTestId('step-name-input') as HTMLInputElement;
			expect(input.value).toBe('My Step');
		});

		it('renders the agent dropdown with all agents', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			const select = getByTestId('agent-select') as HTMLSelectElement;
			const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
			expect(options).toContain('Planner');
			expect(options).toContain('Coder');
		});

		it('shows currently selected agent in dropdown', () => {
			const { getByTestId } = render(
				<NodeConfigPanel {...makeProps({ step: makeStep({ agentId: 'agent-2' }) })} />
			);
			const select = getByTestId('agent-select') as HTMLSelectElement;
			expect(select.value).toBe('agent-2');
		});

		it('renders the inline instructions textarea with current value', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			const textarea = getByTestId('instructions-textarea') as HTMLTextAreaElement;
			expect(textarea.value).toBe('Do stuff.');
		});

		it('renders the single-agent model selector', async () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			const input = getByTestId('single-agent-model-input') as HTMLSelectElement;
			await waitFor(() => expect(input.options.length).toBeGreaterThan(1));
			expect(input.value).toBe('');
		});

		it('renders close button', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('close-button')).toBeTruthy();
		});

		it('renders delete node button', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('delete-step-button')).toBeTruthy();
		});
	});

	describe('start node badge', () => {
		it('shows START badge in header when isStartNode=true', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
			expect(getByTestId('start-node-badge')).toBeTruthy();
		});

		it('does not show START badge when isStartNode=false', () => {
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: false })} />);
			expect(queryByTestId('start-node-badge')).toBeNull();
		});
	});

	describe('end node badge', () => {
		it('shows END badge in header when isEndNode=true', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: true })} />);
			expect(getByTestId('end-node-badge')).toBeTruthy();
		});

		it('does not show END badge when isEndNode=false', () => {
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: false })} />);
			expect(queryByTestId('end-node-badge')).toBeNull();
		});
	});

	describe('"Set as Start" button', () => {
		it('is visible when node is not the start node', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: false })} />);
			expect(getByTestId('set-as-start-button')).toBeTruthy();
		});

		it('is hidden when node is already the start node', () => {
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
			expect(queryByTestId('set-as-start-button')).toBeNull();
		});

		it('calls onSetAsStart with the step localId when clicked', () => {
			const onSetAsStart = vi.fn();
			const { getByTestId } = render(
				<NodeConfigPanel {...makeProps({ onSetAsStart, step: makeStep({ localId: 'my-step' }) })} />
			);
			fireEvent.click(getByTestId('set-as-start-button'));
			expect(onSetAsStart).toHaveBeenCalledWith('my-step');
		});
	});

	describe('"Set as End" button', () => {
		it('is visible when node is not the end node', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: false })} />);
			expect(getByTestId('set-as-end-button')).toBeTruthy();
		});

		it('is hidden when node is already the end node', () => {
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: true })} />);
			expect(queryByTestId('set-as-end-button')).toBeNull();
		});

		it('shows "Unset End Node" button when node is the end node', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isEndNode: true })} />);
			expect(getByTestId('unset-as-end-button')).toBeTruthy();
		});

		it('calls onSetAsEnd with the step localId when clicked', () => {
			const onSetAsEnd = vi.fn();
			const { getByTestId } = render(
				<NodeConfigPanel {...makeProps({ onSetAsEnd, step: makeStep({ localId: 'my-step' }) })} />
			);
			fireEvent.click(getByTestId('set-as-end-button'));
			expect(onSetAsEnd).toHaveBeenCalledWith('my-step');
		});

		it('"Unset End Node" button calls onSetAsEnd with the step localId', () => {
			const onSetAsEnd = vi.fn();
			const { getByTestId } = render(
				<NodeConfigPanel
					{...makeProps({ onSetAsEnd, isEndNode: true, step: makeStep({ localId: 'my-step' }) })}
				/>
			);
			fireEvent.click(getByTestId('unset-as-end-button'));
			expect(onSetAsEnd).toHaveBeenCalledWith('my-step');
		});
	});

	describe('close button', () => {
		it('calls onClose when close button clicked', () => {
			const onClose = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onClose })} />);
			fireEvent.click(getByTestId('close-button'));
			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	describe('field updates', () => {
		it('calls onUpdate with new name when step name changes', () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
			fireEvent.input(getByTestId('step-name-input'), { target: { value: 'New Name' } });
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name' }));
		});

		it('calls onUpdate with new agentId when agent selection changes', () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
			fireEvent.change(getByTestId('agent-select'), { target: { value: 'agent-2' } });
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-2' }));
		});

		it('calls onUpdate with new instructions when textarea changes', () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
			fireEvent.input(getByTestId('instructions-textarea'), {
				target: { value: 'New instructions.' },
			});
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({ instructions: 'New instructions.' })
			);
		});

		it('calls onUpdate with new system prompt as WorkflowNodeAgentOverride when textarea changes', () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
			fireEvent.input(getByTestId('node-system-prompt-input'), {
				target: { value: 'Custom system prompt.' },
			});
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: { mode: 'override', value: 'Custom system prompt.' },
				})
			);
		});

		it('calls onUpdate with new single-agent model when model selector changes', async () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
			await waitFor(() =>
				expect(
					(getByTestId('single-agent-model-input') as HTMLSelectElement).options.length
				).toBeGreaterThan(1)
			);
			fireEvent.change(getByTestId('single-agent-model-input'), {
				target: { value: 'gpt-5.4' },
			});
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' }));
		});

		it('clearing single-agent model sets model to undefined', async () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(
				<NodeConfigPanel {...makeProps({ onUpdate, step: makeStep({ model: 'gpt-5.4' }) })} />
			);
			await waitFor(() =>
				expect(
					(getByTestId('single-agent-model-input') as HTMLSelectElement).options.length
				).toBeGreaterThan(1)
			);
			fireEvent.change(getByTestId('single-agent-model-input'), {
				target: { value: '' },
			});
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
		});

		it('renders the inline system prompt input', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('node-system-prompt-input')).toBeTruthy();
		});

		it('renders the inline instructions textarea', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('instructions-textarea')).toBeTruthy();
		});
	});

	describe('delete node', () => {
		it('delete button is disabled for start node', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
			const btn = getByTestId('delete-step-button') as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		});

		it('delete button is enabled for non-start node', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ isStartNode: false })} />);
			const btn = getByTestId('delete-step-button') as HTMLButtonElement;
			expect(btn.disabled).toBe(false);
		});

		it('shows hint about designating another start node when start node is selected', () => {
			const { getByText } = render(<NodeConfigPanel {...makeProps({ isStartNode: true })} />);
			expect(getByText('Designate another node as start before deleting.')).toBeTruthy();
		});

		it('clicking delete shows confirmation dialog', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			fireEvent.click(getByTestId('delete-step-button'));
			expect(getByTestId('delete-confirm-button')).toBeTruthy();
			expect(getByTestId('delete-cancel-button')).toBeTruthy();
		});

		it('confirming delete calls onDelete with step localId', () => {
			const onDelete = vi.fn();
			const { getByTestId } = render(
				<NodeConfigPanel {...makeProps({ onDelete, step: makeStep({ localId: 'step-xyz' }) })} />
			);
			fireEvent.click(getByTestId('delete-step-button'));
			fireEvent.click(getByTestId('delete-confirm-button'));
			expect(onDelete).toHaveBeenCalledWith('step-xyz');
		});

		it('cancelling delete hides confirmation dialog', () => {
			const { getByTestId, queryByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			fireEvent.click(getByTestId('delete-step-button'));
			expect(getByTestId('delete-confirm-button')).toBeTruthy();
			fireEvent.click(getByTestId('delete-cancel-button'));
			expect(queryByTestId('delete-confirm-button')).toBeNull();
			expect(getByTestId('delete-step-button')).toBeTruthy();
		});

		it('onDelete not called when cancel clicked', () => {
			const onDelete = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onDelete })} />);
			fireEvent.click(getByTestId('delete-step-button'));
			fireEvent.click(getByTestId('delete-cancel-button'));
			expect(onDelete).not.toHaveBeenCalled();
		});

		it('guard in handleDeleteClick suppresses dialog when isStartNode=true (defence-in-depth)', () => {
			// The button is disabled, so a normal click won't fire. Dispatch a direct click event
			// bypassing the disabled attribute to verify the handler guard still blocks the dialog.
			const { getByTestId, queryByTestId } = render(
				<NodeConfigPanel {...makeProps({ isStartNode: true })} />
			);
			const btn = getByTestId('delete-step-button') as HTMLButtonElement;
			// Programmatically invoke the onClick handler via a non-trusted event
			fireEvent.click(btn);
			expect(queryByTestId('delete-confirm-button')).toBeNull();
		});

		it('confirmation dialog is reset when selected step changes', async () => {
			const stepA = makeStep({ localId: 'step-a', name: 'Step A' });
			const stepB = makeStep({ localId: 'step-b', name: 'Step B' });
			const props = makeProps({ step: stepA });
			const { getByTestId, queryByTestId, rerender } = render(<NodeConfigPanel {...props} />);

			// Open confirmation on step A
			fireEvent.click(getByTestId('delete-step-button'));
			expect(getByTestId('delete-confirm-button')).toBeTruthy();

			// Swap to step B (simulates user selecting a different node)
			await act(async () => {
				rerender(<NodeConfigPanel {...{ ...props, step: stepB }} />);
			});

			// Confirmation dialog should be gone
			expect(queryByTestId('delete-confirm-button')).toBeNull();
			expect(getByTestId('delete-step-button')).toBeTruthy();
		});
	});

	// ============================================================================
	// Multi-agent: AgentsSection
	// ============================================================================

	describe('multi-agent mode', () => {
		it('shows single agent dropdown in single-agent mode', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			// Single agent mode shows the agent-select dropdown
			expect(getByTestId('agent-select')).toBeTruthy();
		});

		it('shows "Add agent" button in single-agent mode', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('add-agent-button')).toBeTruthy();
		});

		it('clicking "Add agent" switches to multi-agent mode with existing agent', () => {
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ onUpdate })} />);
			fireEvent.click(getByTestId('add-agent-button'));
			expect(onUpdate).toHaveBeenCalledOnce();
			const updatedStep = onUpdate.mock.calls[0][0];
			expect(updatedStep.agents).toHaveLength(1);
			expect(updatedStep.agents[0].agentId).toBe('agent-1'); // existing agentId preserved
		});

		it('shows agents list in multi-agent mode', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-1', name: 'planner' },
					{ agentId: 'agent-2', name: 'coder' },
				],
			});
			const { getByTestId, queryByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(getByTestId('agents-list')).toBeTruthy();
			// Single agent dropdown should not be present
			expect(queryByTestId('agent-select')).toBeNull();
		});

		it('renders one entry per agent in multi-agent mode', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-1', name: 'planner' },
					{ agentId: 'agent-2', name: 'coder' },
				],
			});
			const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(getAllByTestId('agent-entry')).toHaveLength(2);
		});

		it('shows agent name and role in each agent entry', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			const entry = getByTestId('agents-list');
			// Agent name appears as text in a <p> element
			expect(entry.textContent).toContain('Planner');
			// Role appears as the value of the role input field
			const roleInput = getByTestId('agent-role-input') as HTMLInputElement;
			expect(roleInput.value).toBe('planner');
		});

		it('renders an agent selector for each multi-agent slot', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect((getByTestId('agent-slot-select') as HTMLSelectElement).value).toBe('agent-1');
		});

		it('remove agent button calls onUpdate without that agent', () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-1', name: 'planner' },
					{ agentId: 'agent-2', name: 'coder' },
				],
			});
			const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.click(getAllByTestId('remove-agent-button')[0]);
			const updatedStep = onUpdate.mock.calls[0][0];
			expect(updatedStep.agents).toHaveLength(1);
			expect(updatedStep.agents[0].agentId).toBe('agent-2');
		});

		it('removing last agent switches back to single-agent mode, restores agentId and clears channels', () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
				channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.click(getByTestId('remove-agent-button'));
			const updatedStep = onUpdate.mock.calls[0][0];
			// agents cleared
			expect(updatedStep.agents).toBeUndefined();
			// agentId restored from the removed agent
			expect(updatedStep.agentId).toBe('agent-1');
			// channels cleared (orphaned channels on single-agent step are invalid)
			expect(updatedStep.channels).toBeUndefined();
		});

		it('shows add-agent-select dropdown with all agents (same agent may be added multiple times)', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			// All agents appear in the dropdown regardless of whether they are already in the step
			const select = getByTestId('add-agent-select');
			expect(select.textContent).toContain('Coder');
		});

		it('does not auto-create channels when adding an agent (channels are managed at workflow level)', () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			// 2 agents added, but no auto-created channels (channels are workflow-level now)
			expect(updatedStep.agents).toHaveLength(2);
			expect(updatedStep.channels).toBeUndefined();
		});

		it('adding the same agent twice generates a unique slot role with numeric suffix', () => {
			const onUpdate = vi.fn();
			// Use the agent's actual name 'Coder' as the initial role so baseRole matches
			// and the suffix logic activates (case-sensitive comparison in addAgent).
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-2', name: 'Coder' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			// Add agent-2 (Coder) a second time
			fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.agents).toHaveLength(2);
			expect(updatedStep.agents[0].name).toBe('Coder');
			// Second slot must get a unique suffix to avoid duplicate-role validation error
			expect(updatedStep.agents[1].name).toBe('Coder-2');
		});

		it('adding the same agent three times produces Coder, Coder-2, Coder-3', () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-2', name: 'Coder' },
					{ agentId: 'agent-2', name: 'Coder-2' },
				],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.agents).toHaveLength(3);
			expect(updatedStep.agents[2].name).toBe('Coder-3');
		});
	});

	// ============================================================================
	// Per-slot fields: role and model
	// ============================================================================

	describe('per-slot fields', () => {
		it('renders a role input for each agent slot in multi-agent mode', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-1', name: 'planner' },
					{ agentId: 'agent-2', name: 'coder' },
				],
			});
			const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			const roleInputs = getAllByTestId('agent-role-input');
			expect(roleInputs).toHaveLength(2);
			expect((roleInputs[0] as HTMLInputElement).value).toBe('planner');
			expect((roleInputs[1] as HTMLInputElement).value).toBe('coder');
		});

		it('editing role input calls onUpdate with updated role', () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.input(getByTestId('agent-role-input'), { target: { value: 'lead-planner' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.agents[0].name).toBe('lead-planner');
		});

		it('shows override-badge when slot has instructions override', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{
						agentId: 'agent-1',
						name: 'planner',
						instructions: { mode: 'override', value: 'Be strict.' },
					},
				],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(getByTestId('override-badge')).toBeTruthy();
		});

		it('shows override-badge when slot has systemPrompt override', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{
						agentId: 'agent-1',
						name: 'planner',
						systemPrompt: { mode: 'override', value: 'Custom prompt.' },
					},
				],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(getByTestId('override-badge')).toBeTruthy();
		});

		it('does not show override-badge when slot has no overrides', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(queryByTestId('override-badge')).toBeNull();
		});

		it('does not render per-slot model selector in multi-agent mode (model is node-level)', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			// Per-slot model selector was removed; model override is at the node level only
			expect(queryByTestId('agent-model-select')).toBeNull();
		});

		it('editing agent selection calls onUpdate with updated agentId', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.change(getByTestId('agent-slot-select'), { target: { value: 'agent-2' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.agents[0].agentId).toBe('agent-2');
		});

		it('inline system prompt editor produces WorkflowNodeAgentOverride for multi-agent nodes', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.input(getByTestId('node-system-prompt-input'), {
				target: { value: 'Be very strict.' },
			});
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.systemPrompt).toEqual({
				mode: 'override',
				value: 'Be very strict.',
			});
		});

		it('adding same agent twice with different roles: both slots shown', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-2', name: 'coder' },
					{ agentId: 'agent-2', name: 'coder-2' },
				],
			});
			const { getAllByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			const roleInputs = getAllByTestId('agent-role-input') as HTMLInputElement[];
			expect(roleInputs).toHaveLength(2);
			expect(roleInputs[0].value).toBe('coder');
			expect(roleInputs[1].value).toBe('coder-2');
		});

		it('each slot can independently have overrides -- override-badge appears only on overridden slot', () => {
			const step = makeStep({
				agentId: '',
				agents: [
					{
						agentId: 'agent-2',
						name: 'coder',
						instructions: { mode: 'override', value: 'Code carefully.' },
					},
					{ agentId: 'agent-2', name: 'coder-2' },
				],
			});
			const { getAllByTestId, queryAllByTestId } = render(
				<NodeConfigPanel {...makeProps({ step })} />
			);
			// One badge for the slot with instructions override
			expect(getAllByTestId('override-badge')).toHaveLength(1);
			// Confirm the overridden slot's entry has amber styling via data attribute
			const entries = getAllByTestId('agent-entry');
			expect(entries[0].getAttribute('data-has-overrides')).toBe('true');
			expect(entries[1].getAttribute('data-has-overrides')).toBeNull();
			// No stray badges in the second slot
			expect(queryAllByTestId('override-badge')).toHaveLength(1);
		});

		it('inline system prompt input stays addressable after a slot role is renamed', async () => {
			// Use a controlled wrapper so onUpdate actually updates the step prop,
			// matching how the real parent (VisualWorkflowEditor) behaves.
			function Wrapper() {
				const [step, setStep] = useState(
					makeStep({ agentId: '', agents: [{ agentId: 'agent-1', name: 'planner' }] })
				);
				return <NodeConfigPanel {...makeProps({ step, onUpdate: setStep })} />;
			}
			const { getByTestId, queryByTestId } = render(<Wrapper />);

			await act(async () => {
				fireEvent.input(getByTestId('agent-role-input'), { target: { value: 'lead-planner' } });
			});

			expect(queryByTestId('node-system-prompt-input')).toBeTruthy();
		});
	});

	// ============================================================================
	// Single-agent mode: system prompt with OverrideModeSelector
	// ============================================================================

	describe('single-agent system prompt with mode selector', () => {
		it('shows single-agent system prompt field with mode selector', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('single-agent-system-prompt')).toBeTruthy();
			// The AgentsSection (single-agent mode) has an OverrideModeSelector
			// There may be multiple selectors on the page (agents section + node-level section),
			// so just check at least one exists
			expect(getByTestId('override-mode-selector')).toBeTruthy();
		});

		it('system prompt mode selector toggles between override and expand', async () => {
			const onUpdate = vi.fn();
			const step = makeStep();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);

			// The AgentsSection in single-agent mode has an OverrideModeSelector for systemPrompt
			const modeSelectors = document.querySelectorAll('[data-testid="override-mode-selector"]');
			expect(modeSelectors.length).toBeGreaterThanOrEqual(1);

			// Switch to expand mode
			const expandButton = modeSelectors[0].querySelector(
				'[data-testid="mode-expand"]'
			) as HTMLElement;
			fireEvent.click(expandButton);

			// Now type a system prompt
			await act(async () => {
				fireEvent.input(getByTestId('single-agent-system-prompt'), {
					target: { value: 'Extra context.' },
				});
			});

			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: { mode: 'expand', value: 'Extra context.' },
				})
			);
		});
	});

	// ============================================================================
	// Multi-agent mode: per-slot fields with OverrideModeSelector
	// ============================================================================

	describe('multi-agent per-slot fields with mode selectors', () => {
		it('shows per-slot instructions field with mode selector', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'coder' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(getByTestId('agent-slot-instructions')).toBeTruthy();
		});

		it('shows per-slot system prompt field with mode selector', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'coder' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(getByTestId('agent-slot-system-prompt')).toBeTruthy();
		});

		it('per-slot instructions use correct override mode', async () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'coder' }],
			});
			const { container, getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);

			// Find all override mode selectors in the agents-list
			const agentsList = getByTestId('agents-list');
			const modeSelectors = agentsList.querySelectorAll('[data-testid="override-mode-selector"]');
			// First selector is for instructions
			const instructionsSelector = modeSelectors[0];

			// Switch to expand mode
			const expandButton = instructionsSelector.querySelector(
				'[data-testid="mode-expand"]'
			) as HTMLElement;
			fireEvent.click(expandButton);

			// Type instructions
			await act(async () => {
				fireEvent.input(getByTestId('agent-slot-instructions'), {
					target: { value: 'Extra instructions.' },
				});
			});

			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					agents: [
						expect.objectContaining({
							instructions: { mode: 'expand', value: 'Extra instructions.' },
						}),
					],
				})
			);
		});

		it('per-slot system prompt uses correct override mode', async () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'coder' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);

			// Find all override mode selectors in the agents-list
			const agentsList = getByTestId('agents-list');
			const modeSelectors = agentsList.querySelectorAll('[data-testid="override-mode-selector"]');
			// Second selector is for system prompt
			const systemPromptSelector = modeSelectors[1];

			// Switch to expand mode
			const expandButton = systemPromptSelector.querySelector(
				'[data-testid="mode-expand"]'
			) as HTMLElement;
			fireEvent.click(expandButton);

			// Type system prompt
			await act(async () => {
				fireEvent.input(getByTestId('agent-slot-system-prompt'), {
					target: { value: 'Extra system prompt.' },
				});
			});

			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					agents: [
						expect.objectContaining({
							systemPrompt: { mode: 'expand', value: 'Extra system prompt.' },
						}),
					],
				})
			);
		});
	});
});
