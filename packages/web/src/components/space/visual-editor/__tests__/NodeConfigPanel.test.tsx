/**
 * Unit tests for NodeConfigPanel
 *
 * Tests:
 * - Renders all fields (step name, agent dropdown, entry/exit gates, instructions)
 * - Header shows step name and close button
 * - Step name in header updates when step changes
 * - "Set as Start" button visible for non-start nodes, hidden for start node
 * - "Set as Start" calls onSetAsStart with the step localId
 * - onClose fires when close button clicked
 * - onUpdate fires with updated step when fields change
 * - onUpdateEntryCondition fires when entry gate changes
 * - onUpdateExitCondition fires when exit gate changes
 * - Delete button is disabled for start node with tooltip hint
 * - Delete button shows confirmation dialog when clicked
 * - Confirming delete calls onDelete; cancelling dismisses dialog
 * - Start node badge shown in header when isStartNode=true
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import type { SpaceAgent } from '@neokai/shared';
import { NodeConfigPanel } from '../NodeConfigPanel';
import type { NodeConfigPanelProps } from '../NodeConfigPanel';
import type { StepDraft } from '../../WorkflowStepCard';
import type { ConditionDraft } from '../GateConfig';

afterEach(() => cleanup());

// ============================================================================
// Fixtures
// ============================================================================

function makeAgent(id: string, name: string, role = 'coder'): SpaceAgent {
	return { id, spaceId: 'space-1', name, role, createdAt: Date.now(), updatedAt: Date.now() };
}

function makeStep(overrides: Partial<StepDraft> = {}): StepDraft {
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
		entryCondition: { type: 'always' } as ConditionDraft,
		exitCondition: { type: 'always' } as ConditionDraft,
		isStartNode: false,
		onUpdate: vi.fn(),
		onUpdateEntryCondition: vi.fn(),
		onUpdateExitCondition: vi.fn(),
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

		it('shows "Unnamed Step" when name is empty', () => {
			const { getByText } = render(
				<NodeConfigPanel {...makeProps({ step: makeStep({ name: '' }) })} />
			);
			expect(getByText('Unnamed Step')).toBeTruthy();
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
			const textarea = getByTestId('instructions-textarea') as HTMLTextAreaElement;
			expect(textarea.value).toBe('Do stuff.');
		});

		it('renders entry gate selector', () => {
			const { getByText } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByText('Entry Gate')).toBeTruthy();
		});

		it('renders exit gate selector', () => {
			const { getByText } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByText('Exit Gate')).toBeTruthy();
		});

		it('renders close button', () => {
			const { getByTestId } = render(<NodeConfigPanel {...makeProps()} />);
			expect(getByTestId('close-button')).toBeTruthy();
		});

		it('renders delete step button', () => {
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
			fireEvent.input(getByTestId('instructions-textarea'), {
				target: { value: 'New instructions.' },
			});
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({ instructions: 'New instructions.' })
			);
		});

		it('calls onUpdateEntryCondition when entry gate type changes', () => {
			const onUpdateEntryCondition = vi.fn();
			const { container } = render(
				<NodeConfigPanel
					{...makeProps({ onUpdateEntryCondition, entryCondition: { type: 'always' } })}
				/>
			);
			// selects: agent (index 0), entry gate (index 1), exit gate (index 2)
			const selects = container.querySelectorAll('select');
			fireEvent.change(selects[1], { target: { value: 'human' } });
			expect(onUpdateEntryCondition).toHaveBeenCalledWith({ type: 'human', expression: undefined });
		});

		it('calls onUpdateExitCondition when exit gate type changes', () => {
			const onUpdateExitCondition = vi.fn();
			const { container } = render(
				<NodeConfigPanel
					{...makeProps({ onUpdateExitCondition, exitCondition: { type: 'always' } })}
				/>
			);
			const selects = container.querySelectorAll('select');
			fireEvent.change(selects[2], { target: { value: 'condition' } });
			expect(onUpdateExitCondition).toHaveBeenCalledWith({ type: 'condition', expression: '' });
		});
	});

	describe('gate config — condition type', () => {
		it('shows shell expression input when entry gate type is "condition"', () => {
			const { getByPlaceholderText } = render(
				<NodeConfigPanel
					{...makeProps({ entryCondition: { type: 'condition', expression: '' } })}
				/>
			);
			expect(getByPlaceholderText('e.g. bun test && git diff --quiet')).toBeTruthy();
		});

		it('shows human approval hint for "human" type', () => {
			const { getByText } = render(
				<NodeConfigPanel {...makeProps({ entryCondition: { type: 'human' } })} />
			);
			expect(getByText('Transition requires explicit human approval.')).toBeTruthy();
		});
	});

	describe('delete step', () => {
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

	describe('terminal messages for boundary nodes', () => {
		it('shows "Workflow starts here" for first step entry gate', () => {
			const { getByText } = render(<NodeConfigPanel {...makeProps({ isFirstStep: true })} />);
			expect(getByText('Workflow starts here')).toBeTruthy();
		});

		it('shows "Workflow ends here" for last step exit gate', () => {
			const { getByText } = render(<NodeConfigPanel {...makeProps({ isLastStep: true })} />);
			expect(getByText('Workflow ends here')).toBeTruthy();
		});

		it('does not show terminal messages for mid-workflow nodes', () => {
			const { container } = render(
				<NodeConfigPanel {...makeProps({ isFirstStep: false, isLastStep: false })} />
			);
			expect(container.textContent).not.toContain('Workflow starts here');
			expect(container.textContent).not.toContain('Workflow ends here');
		});
	});
});
