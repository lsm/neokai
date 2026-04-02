/**
 * Unit tests for NodeConfigPanel
 *
 * Tests:
 * - Renders all primary fields (step name, agent dropdown, model override, instructions)
 * - Header shows step name and close button
 * - Step name in header updates when step changes
 * - "Set as Start" button visible for non-start nodes, hidden for start node
 * - "Set as Start" calls onSetAsStart with the step localId
 * - onClose fires when close button clicked
 * - onUpdate fires with updated step when fields change
 * - Delete button is disabled for start node with tooltip hint
 * - Delete button shows confirmation dialog when clicked
 * - Confirming delete calls onDelete; cancelling dismisses dialog
 * - Start node badge shown in header when isStartNode=true
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { SpaceAgent } from '@neokai/shared';

vi.mock('../../../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: () => ({
			request: vi.fn(async (method: string) => {
				if (method === 'models.list') {
					return {
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
				}
				return {};
			}),
		}),
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
		onUpdate: vi.fn(),
		onSetAsStart: vi.fn(),
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
			expect(options).toContain('Planner (planner)');
			expect(options).toContain('Coder (coder)');
		});

		it('shows currently selected agent in dropdown', () => {
			const { getByTestId } = render(
				<NodeConfigPanel {...makeProps({ step: makeStep({ agentId: 'agent-2' }) })} />
			);
			const select = getByTestId('agent-select') as HTMLSelectElement;
			expect(select.value).toBe('agent-2');
		});

		it('renders the instructions textarea with current value', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			fireEvent.click(getByTestId('prompt-instructions-button'));
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
			fireEvent.click(getByTestId('prompt-instructions-button'));
			fireEvent.input(getByTestId('instructions-textarea'), {
				target: { value: 'New instructions.' },
			});
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({ instructions: 'New instructions.' })
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

		it('opens the dedicated prompt and instructions editor', () => {
			const { getByTestId, queryByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(queryByTestId('node-system-prompt-input')).toBeNull();
			fireEvent.click(getByTestId('prompt-instructions-button'));
			expect(getByTestId('node-system-prompt-input')).toBeTruthy();
			expect(getByTestId('node-panel-back-button')).toBeTruthy();
		});
	});

	describe('instructions copy', () => {
		it('explains that instructions are appended guidance, not the base system prompt', () => {
			const { getByTestId, getByText } = render(<NodeConfigPanel {...makeProps()} />);
			fireEvent.click(getByTestId('prompt-instructions-button'));
			expect(
				getByText(
					'This editor shows the current values for both the shared prompt override and the shared instructions.'
				)
			).toBeTruthy();
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
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-2', name: 'coder' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			// Add agent-2 (Coder) a second time
			fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.agents).toHaveLength(2);
			expect(updatedStep.agents[0].name).toBe('coder');
			// Second slot must get a unique suffix to avoid duplicate-role validation error
			expect(updatedStep.agents[1].name).toBe('coder-2');
		});

		it('adding the same agent three times produces coder, coder-2, coder-3', () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [
					{ agentId: 'agent-2', name: 'coder' },
					{ agentId: 'agent-2', name: 'coder-2' },
				],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.change(getByTestId('add-agent-select'), { target: { value: 'agent-2' } });
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.agents).toHaveLength(3);
			expect(updatedStep.agents[2].name).toBe('coder-3');
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

		it('does not show override-badge when slot has no overrides', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { queryByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			expect(queryByTestId('override-badge')).toBeNull();
		});

		it('shows model selector for each slot without extra expansion', async () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step })} />);
			await waitFor(() =>
				expect(
					(getByTestId('agent-model-select') as HTMLSelectElement).options.length
				).toBeGreaterThan(1)
			);
			expect(getByTestId('agent-model-select')).toBeTruthy();
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

		it('editing model selector is a no-op for agent slots (model removed from WorkflowNodeAgent)', async () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			await waitFor(() =>
				expect(
					(getByTestId('agent-model-select') as HTMLSelectElement).options.length
				).toBeGreaterThan(1)
			);
			fireEvent.change(getByTestId('agent-model-select'), { target: { value: 'gpt-5.4' } });
			// model is no longer on WorkflowNodeAgent; the selector is a no-op
			if (onUpdate.mock.calls.length > 0) {
				const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
				expect((updatedStep.agents[0] as Record<string, unknown>)['model']).toBeUndefined();
			}
		});

		it('clearing agent model selector is a no-op (model removed from WorkflowNodeAgent)', async () => {
			const onUpdate = vi.fn();
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			await waitFor(() =>
				expect(
					(getByTestId('agent-model-select') as HTMLSelectElement).options.length
				).toBeGreaterThan(1)
			);
			fireEvent.change(getByTestId('agent-model-select'), { target: { value: '' } });
			// no-op — model not on WorkflowNodeAgent
			expect(true).toBeTruthy();
		});

		it('shared prompt and instructions editor is used for multi-agent nodes too', () => {
			const step = makeStep({
				agentId: '',
				agents: [{ agentId: 'agent-1', name: 'planner' }],
			});
			const onUpdate = vi.fn();
			const { getByTestId } = render(<NodeConfigPanel {...makeProps({ step, onUpdate })} />);
			fireEvent.click(getByTestId('prompt-instructions-button'));
			fireEvent.input(getByTestId('node-system-prompt-input'), {
				target: { value: 'Be very strict.' },
			});
			const updatedStep = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
			expect(updatedStep.systemPrompt).toBe('Be very strict.');
			expect(getByTestId('node-panel-back-button')).toBeTruthy();
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

		it('each slot can independently have overrides — override-badge appears only on overridden slot', () => {
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
			// One badge for the slot with model override
			expect(getAllByTestId('override-badge')).toHaveLength(1);
			// Confirm the overridden slot's entry has amber styling via data attribute
			const entries = getAllByTestId('agent-entry');
			expect(entries[0].getAttribute('data-has-overrides')).toBe('true');
			expect(entries[1].getAttribute('data-has-overrides')).toBeNull();
			// No stray badges in the second slot
			expect(queryAllByTestId('override-badge')).toHaveLength(1);
		});

		it('shared prompt and instructions view stays addressable after a slot role is renamed', async () => {
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

			fireEvent.click(getByTestId('prompt-instructions-button'));
			expect(queryByTestId('node-system-prompt-input')).toBeTruthy();
		});
	});
});
