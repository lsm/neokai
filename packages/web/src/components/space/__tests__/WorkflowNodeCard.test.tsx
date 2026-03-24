/**
 * Unit tests for WorkflowNodeCard
 *
 * Tests:
 * - Collapsed view: step number, agent name, gate icons
 * - Expanded view: name input, agent dropdown, gate selectors, instructions
 * - Agent dropdown excludes 'leader' (enforced by filterAgents in WorkflowEditor)
 * - Gate config forms: always/human/condition types
 * - Shell expression input shown only for 'condition' type
 * - Up/down reorder buttons disabled at boundaries
 * - Remove button fires onRemove
 * - Expand/collapse toggle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { SpaceAgent } from '@neokai/shared';
import { WorkflowNodeCard } from '../WorkflowNodeCard';
import type { NodeDraft, ConditionDraft } from '../WorkflowNodeCard';

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

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

function makeStep(overrides: Partial<NodeDraft> = {}): NodeDraft {
	return {
		localId: 'local-1',
		name: 'My Step',
		agentId: 'agent-1',
		instructions: '',
		...overrides,
	};
}

const defaultAgents: SpaceAgent[] = [
	makeAgent('agent-1', 'planner', 'planner'),
	makeAgent('agent-2', 'coder', 'coder'),
	makeAgent('agent-3', 'general', 'general'),
];

function makeProps(overrides: Partial<Parameters<typeof WorkflowNodeCard>[0]> = {}) {
	return {
		node: makeStep(),
		nodeIndex: 1,
		isFirst: false,
		isLast: false,
		expanded: false,
		entryCondition: { type: 'always' } as ConditionDraft,
		exitCondition: { type: 'always' } as ConditionDraft,
		agents: defaultAgents,
		onToggleExpand: vi.fn(),
		onUpdate: vi.fn(),
		onUpdateEntryCondition: vi.fn(),
		onUpdateExitCondition: vi.fn(),
		onMoveUp: vi.fn(),
		onMoveDown: vi.fn(),
		onRemove: vi.fn(),
		...overrides,
	};
}

describe('WorkflowNodeCard', () => {
	afterEach(() => {
		cleanup();
	});

	describe('collapsed view', () => {
		it('renders step number (1-based)', () => {
			const { getByText } = render(<WorkflowNodeCard {...makeProps({ nodeIndex: 2 })} />);
			expect(getByText('3')).toBeTruthy();
		});

		it('renders agent name in collapsed view', () => {
			const { getByText } = render(<WorkflowNodeCard {...makeProps()} />);
			expect(getByText('planner')).toBeTruthy();
		});

		it('renders step name in collapsed view', () => {
			const { getByText } = render(
				<WorkflowNodeCard {...makeProps({ node: makeStep({ name: 'My Awesome Step' }) })} />
			);
			expect(getByText('My Awesome Step')).toBeTruthy();
		});

		it('shows "Unnamed Node" when name is empty', () => {
			const { getByText } = render(
				<WorkflowNodeCard {...makeProps({ node: makeStep({ name: '' }) })} />
			);
			expect(getByText('Unnamed Node')).toBeTruthy();
		});

		it('calls onToggleExpand when header clicked', () => {
			const onToggleExpand = vi.fn();
			const { container } = render(<WorkflowNodeCard {...makeProps({ onToggleExpand })} />);
			const header = container.querySelector('.cursor-pointer') as HTMLElement;
			fireEvent.click(header);
			expect(onToggleExpand).toHaveBeenCalledOnce();
		});

		it('calls onMoveUp when up button clicked', () => {
			const onMoveUp = vi.fn();
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ onMoveUp })} />);
			fireEvent.click(getByTitle('Move up'));
			expect(onMoveUp).toHaveBeenCalledOnce();
		});

		it('calls onMoveDown when down button clicked', () => {
			const onMoveDown = vi.fn();
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ onMoveDown })} />);
			fireEvent.click(getByTitle('Move down'));
			expect(onMoveDown).toHaveBeenCalledOnce();
		});

		it('disables move up button for first step', () => {
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ isFirst: true })} />);
			expect((getByTitle('Move up') as HTMLButtonElement).disabled).toBe(true);
		});

		it('disables move down button for last step', () => {
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ isLast: true })} />);
			expect((getByTitle('Move down') as HTMLButtonElement).disabled).toBe(true);
		});

		it('calls onRemove when remove button clicked', () => {
			const onRemove = vi.fn();
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ onRemove })} />);
			fireEvent.click(getByTitle('Remove node'));
			expect(onRemove).toHaveBeenCalledOnce();
		});

		it('disables Remove button when disableRemove is true', () => {
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ disableRemove: true })} />);
			expect((getByTitle('Remove node') as HTMLButtonElement).disabled).toBe(true);
		});

		it('enables Remove button when disableRemove is false', () => {
			const { getByTitle } = render(<WorkflowNodeCard {...makeProps({ disableRemove: false })} />);
			expect((getByTitle('Remove node') as HTMLButtonElement).disabled).toBe(false);
		});

		it('shows human gate icon when entry condition is human', () => {
			const { getByTitle } = render(
				<WorkflowNodeCard {...makeProps({ entryCondition: { type: 'human' } })} />
			);
			expect(getByTitle('Entry: Human Approval')).toBeTruthy();
		});

		it('shows condition gate icon when exit condition is shell condition', () => {
			const { getByTitle } = render(
				<WorkflowNodeCard {...makeProps({ exitCondition: { type: 'condition' } })} />
			);
			expect(getByTitle('Exit: Shell Condition')).toBeTruthy();
		});

		it('does not show gate icons for always conditions', () => {
			const { container } = render(
				<WorkflowNodeCard
					{...makeProps({
						entryCondition: { type: 'always' },
						exitCondition: { type: 'always' },
					})}
				/>
			);
			// No gate icons for 'always' type
			expect(container.querySelector('[title*="Entry:"]')).toBeNull();
			expect(container.querySelector('[title*="Exit:"]')).toBeNull();
		});
	});

	describe('expanded view', () => {
		it('shows expanded body when expanded=true', () => {
			const { getByPlaceholderText } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true })} />
			);
			expect(getByPlaceholderText('e.g. Plan the approach')).toBeTruthy();
		});

		it('does not show expanded body when expanded=false', () => {
			const { container } = render(<WorkflowNodeCard {...makeProps({ expanded: false })} />);
			const textarea = container.querySelector('textarea');
			expect(textarea).toBeNull();
		});

		it('renders agent dropdown with all passed agents', () => {
			const { container } = render(<WorkflowNodeCard {...makeProps({ expanded: true })} />);
			const selects = container.querySelectorAll('select');
			// Agent select + entry gate select + exit gate select = 3 selects
			const agentSelect = selects[0] as HTMLSelectElement;
			const options = Array.from(agentSelect.querySelectorAll('option')).map((o) => o.textContent);
			expect(options).toContain('planner (planner)');
			expect(options).toContain('coder (coder)');
			expect(options).toContain('general (general)');
		});

		it('shows currently selected agent in dropdown', () => {
			const step = makeStep({ agentId: 'agent-2' });
			const { container } = render(
				<WorkflowNodeCard {...makeProps({ node: step, expanded: true })} />
			);
			const agentSelect = container.querySelectorAll('select')[0];
			expect(agentSelect.value).toBe('agent-2');
		});

		it('calls onUpdate when agent changed', () => {
			const onUpdate = vi.fn();
			const { container } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true, onUpdate })} />
			);
			const agentSelect = container.querySelectorAll('select')[0];
			fireEvent.change(agentSelect, { target: { value: 'agent-2' } });
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-2' }));
		});

		it('calls onUpdate when name changed', () => {
			const onUpdate = vi.fn();
			const { getByPlaceholderText } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true, onUpdate })} />
			);
			const nameInput = getByPlaceholderText('e.g. Plan the approach');
			fireEvent.input(nameInput, { target: { value: 'New Name' } });
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name' }));
		});

		it('calls onUpdate when instructions changed', () => {
			const onUpdate = vi.fn();
			const { container } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true, onUpdate })} />
			);
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			fireEvent.input(textarea, { target: { value: 'Do the thing.' } });
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({ instructions: 'Do the thing.' })
			);
		});

		it('renders "Workflow starts here" for first step entry gate', () => {
			const { getByText } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true, isFirst: true, entryCondition: null })} />
			);
			expect(getByText('Workflow starts here')).toBeTruthy();
		});

		it('renders "Workflow ends here" for last step exit gate', () => {
			const { getByText } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true, isLast: true, exitCondition: null })} />
			);
			expect(getByText('Workflow ends here')).toBeTruthy();
		});

		describe('gate config — condition type', () => {
			it('shows shell expression input when condition type is "condition"', () => {
				const { getByPlaceholderText } = render(
					<WorkflowNodeCard
						{...makeProps({
							expanded: true,
							entryCondition: { type: 'condition', expression: '' },
						})}
					/>
				);
				expect(getByPlaceholderText('e.g. bun test && git diff --quiet')).toBeTruthy();
			});

			it('does not show shell expression input for "always" type', () => {
				const { container } = render(
					<WorkflowNodeCard
						{...makeProps({
							expanded: true,
							entryCondition: { type: 'always' },
						})}
					/>
				);
				const inputs = container.querySelectorAll('input[type="text"]');
				// Only the step name input, no expression input
				expect(inputs.length).toBe(1);
			});

			it('calls onUpdateEntryCondition when entry gate type changed', () => {
				const onUpdateEntryCondition = vi.fn();
				const { container } = render(
					<WorkflowNodeCard
						{...makeProps({
							expanded: true,
							entryCondition: { type: 'always' },
							onUpdateEntryCondition,
						})}
					/>
				);
				const selects = container.querySelectorAll('select');
				// selects[0] = agent, selects[1] = entry gate, selects[2] = exit gate
				fireEvent.change(selects[1], { target: { value: 'human' } });
				expect(onUpdateEntryCondition).toHaveBeenCalledWith({
					type: 'human',
					expression: undefined,
				});
			});

			it('calls onUpdateExitCondition when exit gate type changed', () => {
				const onUpdateExitCondition = vi.fn();
				const { container } = render(
					<WorkflowNodeCard
						{...makeProps({
							expanded: true,
							exitCondition: { type: 'always' },
							onUpdateExitCondition,
						})}
					/>
				);
				const selects = container.querySelectorAll('select');
				// selects[2] = exit gate
				fireEvent.change(selects[2], { target: { value: 'condition' } });
				expect(onUpdateExitCondition).toHaveBeenCalledWith({ type: 'condition', expression: '' });
			});

			it('shows "Requires human approval" hint for human type', () => {
				const { getByText } = render(
					<WorkflowNodeCard
						{...makeProps({
							expanded: true,
							entryCondition: { type: 'human' },
						})}
					/>
				);
				expect(getByText('Transition requires explicit human approval.')).toBeTruthy();
			});

			it('shows "fires automatically" hint for always type', () => {
				const { getAllByText } = render(
					<WorkflowNodeCard
						{...makeProps({
							expanded: true,
							entryCondition: { type: 'always' },
						})}
					/>
				);
				expect(getAllByText('Transition fires automatically.').length).toBeGreaterThan(0);
			});
		});
	});
});
