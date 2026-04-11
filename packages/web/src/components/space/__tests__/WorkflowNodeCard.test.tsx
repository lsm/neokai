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
 * - OverrideModeSelector component
 * - extractOverrideValue and buildOverride helpers
 * - Single-agent system prompt field
 * - Multi-agent per-agent mode selectors for instructions and system prompt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { SpaceAgent, WorkflowNodeAgentOverride } from '@neokai/shared';
import { WorkflowNodeCard } from '../WorkflowNodeCard';
import type { NodeDraft, AgentTaskState } from '../WorkflowNodeCard';
import { extractOverrideValue, buildOverride, OverrideModeSelector } from '../WorkflowNodeCard';

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

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
		agents: defaultAgents,
		onToggleExpand: vi.fn(),
		onUpdate: vi.fn(),
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
			const agentSelect = selects[0] as HTMLSelectElement;
			const options = Array.from(agentSelect.querySelectorAll('option')).map((o) => o.textContent);
			expect(options).toContain('planner');
			expect(options).toContain('coder');
			expect(options).toContain('general');
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
			// The expanded view now has two textareas: system prompt (first) and instructions (second).
			// Find the instructions textarea by index.
			const textareas = container.querySelectorAll('textarea');
			const instructionsTextarea = textareas[1] as HTMLTextAreaElement;
			fireEvent.input(instructionsTextarea, { target: { value: 'Do the thing.' } });
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({ instructions: 'Do the thing.' })
			);
		});

		it('shows system prompt textarea for single-agent nodes when expanded', () => {
			const { container } = render(<WorkflowNodeCard {...makeProps({ expanded: true })} />);
			const systemPromptTextarea = container.querySelector(
				'[data-testid="single-agent-system-prompt"]'
			) as HTMLTextAreaElement;
			expect(systemPromptTextarea).toBeTruthy();
		});

		it('system prompt calls onUpdate with WorkflowNodeAgentOverride', () => {
			const onUpdate = vi.fn();
			const { container } = render(
				<WorkflowNodeCard {...makeProps({ expanded: true, onUpdate })} />
			);
			const systemPromptTextarea = container.querySelector(
				'[data-testid="single-agent-system-prompt"]'
			) as HTMLTextAreaElement;
			fireEvent.input(systemPromptTextarea, { target: { value: 'Custom system prompt.' } });
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: { mode: 'override', value: 'Custom system prompt.' },
				})
			);
		});

		it('system prompt clears to undefined when value is emptied', () => {
			const onUpdate = vi.fn();
			const node = makeStep({
				systemPrompt: { mode: 'override', value: 'Existing prompt.' },
			});
			const { container } = render(
				<WorkflowNodeCard {...makeProps({ node, expanded: true, onUpdate })} />
			);
			const systemPromptTextarea = container.querySelector(
				'[data-testid="single-agent-system-prompt"]'
			) as HTMLTextAreaElement;
			fireEvent.input(systemPromptTextarea, { target: { value: '' } });
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: undefined }));
		});
	});
});

// ============================================================================
// Per-slot override indicators in collapsed header
// ============================================================================

describe('WorkflowNodeCard — collapsed header override indicators', () => {
	afterEach(() => cleanup());

	it('shows slot role name in collapsed badge (not agent name)', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'strict-reviewer' },
				{ agentId: 'agent-2', name: 'quick-reviewer' },
			],
		});
		const { container } = render(<WorkflowNodeCard {...makeProps({ node, expanded: false })} />);
		expect(container.textContent).toContain('strict-reviewer');
		expect(container.textContent).toContain('quick-reviewer');
	});

	it('does not show override-dot when no slot has overrides', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'coder' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { queryAllByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: false })} />
		);
		expect(queryAllByTestId('override-dot')).toHaveLength(0);
	});

	it('shows override-dot on slot with instructions override', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{
					agentId: 'agent-1',
					name: 'coder',
					instructions: { mode: 'override', value: 'Be strict.' },
				},
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: false })} />
		);
		// Only the first slot has overrides
		expect(getAllByTestId('override-dot')).toHaveLength(1);
	});

	it('shows override-dot on slot with systemPrompt override', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{
					agentId: 'agent-1',
					name: 'coder',
					systemPrompt: { mode: 'override', value: 'Be strict.' },
				},
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ node, expanded: false })} />);
		expect(getByTestId('override-dot')).toBeTruthy();
	});

	it('shows override-dot on each slot that has overrides (multiple)', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{
					agentId: 'agent-1',
					name: 'coder',
					instructions: { mode: 'override', value: 'Code carefully.' },
				},
				{
					agentId: 'agent-2',
					name: 'reviewer',
					systemPrompt: { mode: 'override', value: 'Review carefully.' },
				},
			],
		});
		const { getAllByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: false })} />
		);
		expect(getAllByTestId('override-dot')).toHaveLength(2);
	});
});
// ============================================================================
// Per-slot override section expand/collapse in expanded card view
// ============================================================================

describe('WorkflowNodeCard — expanded view per-slot override section', () => {
	afterEach(() => cleanup());

	it('does not show slot-overrides section before toggle is clicked', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'planner' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { queryByTestId } = render(<WorkflowNodeCard {...makeProps({ node, expanded: true })} />);
		expect(queryByTestId('slot-overrides')).toBeNull();
	});

	it('shows slot-overrides section after toggle button is clicked', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'planner' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId, queryByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: true })} />
		);
		expect(queryByTestId('slot-overrides')).toBeNull();
		fireEvent.click(getAllByTestId('toggle-overrides-button')[0]);
		expect(queryByTestId('slot-overrides')).toBeTruthy();
	});

	it('hides slot-overrides section after second toggle click', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'planner' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId, queryByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: true })} />
		);
		const firstToggle = getAllByTestId('toggle-overrides-button')[0];
		fireEvent.click(firstToggle);
		expect(queryByTestId('slot-overrides')).toBeTruthy();
		fireEvent.click(firstToggle);
		expect(queryByTestId('slot-overrides')).toBeNull();
	});

	it('override section stays expanded after slot role is renamed', async () => {
		function Wrapper() {
			const [step, setStep] = useState(
				makeStep({
					agentId: '',
					agents: [
						{ agentId: 'agent-1', name: 'planner' },
						{ agentId: 'agent-2', name: 'reviewer' },
					],
				})
			);
			return <WorkflowNodeCard {...makeProps({ node: step, expanded: true, onUpdate: setStep })} />;
		}
		const { getAllByTestId, queryByTestId } = render(<Wrapper />);
		fireEvent.click(getAllByTestId('toggle-overrides-button')[0]);
		expect(queryByTestId('slot-overrides')).toBeTruthy();
		await act(async () => {
			fireEvent.input(getAllByTestId('agent-role-input')[0], {
				target: { value: 'lead-planner' },
			});
		});
		expect(queryByTestId('slot-overrides')).toBeTruthy();
	});

	it('model input inside slot-overrides is a no-op (model removed from WorkflowNodeAgent)', async () => {
		const onUpdate = vi.fn();
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'coder' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId, getByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: true, onUpdate })} />
		);
		fireEvent.click(getAllByTestId('toggle-overrides-button')[0]);
		await act(async () => {
			fireEvent.input(getByTestId('agent-model-input'), {
				target: { value: 'claude-opus-4-6' },
			});
		});
		// model is no longer a property of WorkflowNodeAgent; updateAgentModel is a no-op
		// onUpdate should not have been called (or if called, no model field on agents)
		if (onUpdate.mock.calls.length > 0) {
			const updated = onUpdate.mock.calls[0][0] as NodeDraft;
			expect((updated.agents?.[0] as unknown as Record<string, unknown>)['model']).toBeUndefined();
		}
	});
});

// ============================================================================
// Multi-agent per-agent mode selectors
// ============================================================================

describe('WorkflowNodeCard — multi-agent per-agent mode selectors', () => {
	afterEach(() => cleanup());

	it('per-agent instructions include OverrideModeSelector', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'coder' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: true })} />
		);
		// Two slot-level instruction selectors + one node-level system-prompt selector.
		const selectors = getAllByTestId('override-mode-selector');
		expect(selectors.length).toBeGreaterThanOrEqual(3);
	});

	it('per-agent system prompt selector appears after expanding slot overrides', () => {
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'coder' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: true })} />
		);
		const before = getAllByTestId('override-mode-selector').length;
		fireEvent.click(getAllByTestId('toggle-overrides-button')[0]);
		const after = getAllByTestId('override-mode-selector').length;
		expect(after).toBe(before + 1);
	});

	it('toggling mode selector changes the mode used in override for system prompt', async () => {
		const onUpdate = vi.fn();
		const node = makeStep({
			agentId: '',
			agents: [
				{ agentId: 'agent-1', name: 'coder' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		});
		const { getAllByTestId, getByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node, expanded: true, onUpdate })} />
		);
		// Expand slot overrides to reveal slot-level system prompt controls.
		fireEvent.click(getAllByTestId('toggle-overrides-button')[0]);

		const slotOverrides = getByTestId('slot-overrides');
		const expandButton = slotOverrides.querySelector('[data-testid="mode-expand"]') as HTMLElement;
		fireEvent.click(expandButton);

		// Now type a system prompt
		const systemPromptInput = getByTestId('agent-system-prompt-input');
		await act(async () => {
			fireEvent.input(systemPromptInput, { target: { value: 'Extra context.' } });
		});

		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				agents: expect.arrayContaining([
					expect.objectContaining({
						systemPrompt: { mode: 'expand', value: 'Extra context.' },
					}),
				]),
			})
		);
	});
});

// ============================================================================
// Agent completion state
// ============================================================================

describe('WorkflowNodeCard — agent completion state', () => {
	afterEach(() => {
		cleanup();
	});

	function makeMultiAgentStep(): NodeDraft {
		return {
			localId: 'local-multi',
			id: 'node-multi',
			name: 'Multi Step',
			agentId: '',
			instructions: '',
			agents: [
				{ agentId: 'agent-1', name: 'coder' },
				{ agentId: 'agent-2', name: 'reviewer' },
			],
		};
	}

	it('shows spinner for in_progress agent (single-agent)', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'in_progress' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		expect(getByTestId('agent-status-spinner')).toBeTruthy();
	});

	it('shows checkmark for idle agent (single-agent)', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'idle' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		expect(getByTestId('agent-status-check')).toBeTruthy();
	});

	it('shows fail icon for blocked agent (single-agent)', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'blocked' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		expect(getByTestId('agent-status-fail')).toBeTruthy();
	});

	it('shows fail icon for cancelled agent', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'cancelled' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		expect(getByTestId('agent-status-fail')).toBeTruthy();
	});

	it('shows pending dot for pending agent', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'pending' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		expect(getByTestId('agent-status-pending')).toBeTruthy();
	});

	it('applies green step badge when all agents done', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'idle' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		const badge = getByTestId('node-step-badge');
		expect(badge.className).toContain('green');
	});

	it('does NOT apply green step badge when not all done', () => {
		const states: AgentTaskState[] = [{ agentName: null, status: 'in_progress' }];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		const badge = getByTestId('node-step-badge');
		expect(badge.className).not.toContain('green');
	});

	it('shows completion summary text when provided', () => {
		const states: AgentTaskState[] = [
			{ agentName: null, status: 'idle', completionSummary: 'All done nicely' },
		];
		const { getByTestId } = render(<WorkflowNodeCard {...makeProps({ nodeTaskStates: states })} />);
		expect(getByTestId('node-completion-summary').textContent).toBe('All done nicely');
	});

	it('shows per-agent status for multi-agent nodes', () => {
		const states: AgentTaskState[] = [
			{ agentName: 'coder', status: 'idle' },
			{ agentName: 'reviewer', status: 'in_progress' },
		];
		const { getAllByTestId } = render(
			<WorkflowNodeCard {...makeProps({ node: makeMultiAgentStep(), nodeTaskStates: states })} />
		);
		// One checkmark for coder, one spinner for reviewer
		expect(getAllByTestId('agent-status-check')).toHaveLength(1);
		expect(getAllByTestId('agent-status-spinner')).toHaveLength(1);
	});

	it('does not show status icons when nodeTaskStates is not provided', () => {
		const { container } = render(<WorkflowNodeCard {...makeProps()} />);
		expect(container.querySelector('[data-testid="agent-status-check"]')).toBeNull();
		expect(container.querySelector('[data-testid="agent-status-spinner"]')).toBeNull();
		expect(container.querySelector('[data-testid="agent-status-fail"]')).toBeNull();
	});

	it('shows green border when all agents done', () => {
		const states: AgentTaskState[] = [
			{ agentName: 'coder', status: 'idle' },
			{ agentName: 'reviewer', status: 'idle' },
		];
		const { container } = render(
			<WorkflowNodeCard {...makeProps({ node: makeMultiAgentStep(), nodeTaskStates: states })} />
		);
		// The outer border should include 'green'
		const outer = container.firstElementChild as HTMLElement;
		expect(outer.className).toContain('green');
	});
});

// ============================================================================
// OverrideModeSelector component
// ============================================================================

describe('OverrideModeSelector', () => {
	afterEach(() => cleanup());

	it('renders with both Override and Append buttons', () => {
		const onChange = vi.fn();
		const { getByText } = render(<OverrideModeSelector mode="override" onChange={onChange} />);
		expect(getByText('Override')).toBeTruthy();
		expect(getByText('Append')).toBeTruthy();
	});

	it('renders correct active state for override mode', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<OverrideModeSelector mode="override" onChange={onChange} />);
		const overrideButton = getByTestId('mode-override');
		expect(overrideButton.className).toContain('bg-blue-700');
	});

	it('renders correct active state for expand mode', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<OverrideModeSelector mode="expand" onChange={onChange} />);
		const expandButton = getByTestId('mode-expand');
		expect(expandButton.className).toContain('bg-teal-700');
	});

	it('calls onChange when Override button is clicked', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<OverrideModeSelector mode="expand" onChange={onChange} />);
		fireEvent.click(getByTestId('mode-override'));
		expect(onChange).toHaveBeenCalledWith('override');
	});

	it('calls onChange when Expand button is clicked', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<OverrideModeSelector mode="override" onChange={onChange} />);
		fireEvent.click(getByTestId('mode-expand'));
		expect(onChange).toHaveBeenCalledWith('expand');
	});
});

// ============================================================================
// extractOverrideValue helper
// ============================================================================

describe('extractOverrideValue', () => {
	it('returns empty string for undefined', () => {
		expect(extractOverrideValue(undefined)).toBe('');
	});

	it('returns empty string for null', () => {
		expect(extractOverrideValue(null as unknown as WorkflowNodeAgentOverride)).toBe('');
	});

	it('returns the string value for plain string input', () => {
		expect(extractOverrideValue('hello world')).toBe('hello world');
	});

	it('returns the value property for override object', () => {
		expect(extractOverrideValue({ mode: 'override', value: 'system prompt text' })).toBe(
			'system prompt text'
		);
	});

	it('returns the value property for expand object', () => {
		expect(extractOverrideValue({ mode: 'expand', value: 'extra context' })).toBe('extra context');
	});

	it('returns empty string when override value is empty', () => {
		expect(extractOverrideValue({ mode: 'override', value: '' })).toBe('');
	});

	it('returns empty string when override value is undefined', () => {
		expect(extractOverrideValue({ mode: 'override', value: undefined as unknown as string })).toBe(
			''
		);
	});
});

// ============================================================================
// buildOverride helper
// ============================================================================

describe('buildOverride', () => {
	it('returns override object for non-empty value with override mode', () => {
		const result = buildOverride('Custom prompt.', 'override');
		expect(result).toEqual({ mode: 'override', value: 'Custom prompt.' });
	});

	it('returns override object for non-empty value with expand mode', () => {
		const result = buildOverride('Extra context.', 'expand');
		expect(result).toEqual({ mode: 'expand', value: 'Extra context.' });
	});

	it('returns undefined for empty string', () => {
		expect(buildOverride('', 'override')).toBeUndefined();
	});

	it('returns undefined for whitespace-only string', () => {
		expect(buildOverride('   ', 'expand')).toBeUndefined();
	});

	it('trims the value', () => {
		const result = buildOverride('  Custom prompt.  ', 'override');
		expect(result).toEqual({ mode: 'override', value: 'Custom prompt.' });
	});
});
