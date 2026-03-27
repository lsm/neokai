/**
 * Unit tests for WorkflowRulesEditor
 *
 * Tests:
 * - Renders empty state when no rules
 * - "Add Rule" button adds a new rule card
 * - Name input fires onChange
 * - Content textarea fires onChange
 * - Remove button removes the rule
 * - Step multi-select shows step names and toggles selection
 * - Empty step list shows "No steps defined" message
 * - makeEmptyRule returns a rule draft with empty fields
 * - rulesToDrafts maps WorkflowRule[] to RuleDraft[]
 * - Rule count display
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { WorkflowRule, WorkflowNode } from '@neokai/shared';
import { WorkflowRulesEditor, makeEmptyRule, rulesToDrafts } from '../WorkflowRulesEditor';
import type { RuleDraft } from '../WorkflowRulesEditor';

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

afterEach(() => cleanup());

function makeStep(id: string, name: string): WorkflowNode {
	return { id, name, agentId: 'agent-1' };
}

function makeRule(overrides: Partial<WorkflowRule> = {}): WorkflowRule {
	return {
		id: 'rule-1',
		name: 'Test Rule',
		content: 'Rule content',
		appliesTo: [],
		...overrides,
	};
}

function makeDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
	return {
		localId: 'local-1',
		id: 'rule-1',
		name: 'Draft Rule',
		content: 'Some content',
		appliesTo: [],
		...overrides,
	};
}

// ============================================================================
// makeEmptyRule
// ============================================================================

describe('makeEmptyRule', () => {
	it('returns a draft with empty fields and a unique localId', () => {
		const r1 = makeEmptyRule();
		const r2 = makeEmptyRule();
		expect(r1.name).toBe('');
		expect(r1.content).toBe('');
		expect(r1.appliesTo).toEqual([]);
		expect(r1.id).toBeUndefined();
		expect(r1.localId).toBeTruthy();
		expect(r1.localId).not.toBe(r2.localId);
	});
});

// ============================================================================
// rulesToDrafts
// ============================================================================

describe('rulesToDrafts', () => {
	it('maps WorkflowRule[] to RuleDraft[] preserving fields', () => {
		const rules = [
			makeRule({ id: 'r1', name: 'Rule A', content: 'Content A', appliesTo: ['s1', 's2'] }),
			makeRule({ id: 'r2', name: 'Rule B', content: 'Content B', appliesTo: [] }),
		];
		const drafts = rulesToDrafts(rules);
		expect(drafts).toHaveLength(2);
		expect(drafts[0].id).toBe('r1');
		expect(drafts[0].name).toBe('Rule A');
		expect(drafts[0].content).toBe('Content A');
		expect(drafts[0].appliesTo).toEqual(['s1', 's2']);
		expect(drafts[0].localId).toBeTruthy();
		expect(drafts[1].id).toBe('r2');
	});

	it('handles undefined appliesTo by defaulting to empty array', () => {
		const rule = makeRule({ appliesTo: undefined });
		const [draft] = rulesToDrafts([rule]);
		expect(draft.appliesTo).toEqual([]);
	});

	it('returns empty array for empty input', () => {
		expect(rulesToDrafts([])).toEqual([]);
	});
});

// ============================================================================
// WorkflowRulesEditor component
// ============================================================================

describe('WorkflowRulesEditor', () => {
	it('shows empty state message when no rules', () => {
		const { getByText } = render(<WorkflowRulesEditor rules={[]} steps={[]} onChange={vi.fn()} />);
		expect(getByText(/No rules yet/)).toBeTruthy();
	});

	it('shows rule count', () => {
		const rules = [makeDraft(), makeDraft({ localId: 'local-2', id: 'rule-2' })];
		const { getByText } = render(
			<WorkflowRulesEditor rules={rules} steps={[]} onChange={vi.fn()} />
		);
		expect(getByText('2 rules')).toBeTruthy();
	});

	it('shows singular "1 rule" for one rule', () => {
		const { getByText } = render(
			<WorkflowRulesEditor rules={[makeDraft()]} steps={[]} onChange={vi.fn()} />
		);
		expect(getByText('1 rule')).toBeTruthy();
	});

	it('"Add Rule" button calls onChange with a new empty rule appended', () => {
		const onChange = vi.fn();
		const { getByText } = render(<WorkflowRulesEditor rules={[]} steps={[]} onChange={onChange} />);
		fireEvent.click(getByText('Add Rule'));
		expect(onChange).toHaveBeenCalledTimes(1);
		const [newRules] = onChange.mock.calls[0];
		expect(newRules).toHaveLength(1);
		expect(newRules[0].name).toBe('');
		expect(newRules[0].content).toBe('');
	});

	it('name input change triggers onChange with updated rule', () => {
		const onChange = vi.fn();
		const { container } = render(
			<WorkflowRulesEditor rules={[makeDraft()]} steps={[]} onChange={onChange} />
		);
		const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
		fireEvent.input(nameInput, { target: { value: 'New Rule Name' } });
		expect(onChange).toHaveBeenCalledTimes(1);
		const [updated] = onChange.mock.calls[0];
		expect(updated[0].name).toBe('New Rule Name');
	});

	it('content textarea change triggers onChange with updated rule', () => {
		const onChange = vi.fn();
		const { container } = render(
			<WorkflowRulesEditor rules={[makeDraft()]} steps={[]} onChange={onChange} />
		);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'Updated content' } });
		expect(onChange).toHaveBeenCalledTimes(1);
		const [updated] = onChange.mock.calls[0];
		expect(updated[0].content).toBe('Updated content');
	});

	it('remove button removes the rule from the list', () => {
		const onChange = vi.fn();
		const { getByTitle } = render(
			<WorkflowRulesEditor rules={[makeDraft()]} steps={[]} onChange={onChange} />
		);
		fireEvent.click(getByTitle('Remove rule'));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it('renders step buttons from steps prop', () => {
		const steps = [makeStep('s1', 'Plan'), makeStep('s2', 'Code')];
		const { getByText } = render(
			<WorkflowRulesEditor rules={[makeDraft()]} steps={steps} onChange={vi.fn()} />
		);
		expect(getByText('Plan')).toBeTruthy();
		expect(getByText('Code')).toBeTruthy();
	});

	it('clicking a step button adds its ID to appliesTo', () => {
		const onChange = vi.fn();
		const steps = [makeStep('s1', 'Plan'), makeStep('s2', 'Code')];
		const draft = makeDraft({ appliesTo: [] });
		const { getByText } = render(
			<WorkflowRulesEditor rules={[draft]} steps={steps} onChange={onChange} />
		);
		fireEvent.click(getByText('Plan'));
		expect(onChange).toHaveBeenCalledTimes(1);
		const [updated] = onChange.mock.calls[0];
		expect(updated[0].appliesTo).toContain('s1');
	});

	it('clicking an already-selected step button removes it from appliesTo', () => {
		const onChange = vi.fn();
		const steps = [makeStep('s1', 'Plan')];
		const draft = makeDraft({ appliesTo: ['s1'] });
		const { getByText } = render(
			<WorkflowRulesEditor rules={[draft]} steps={steps} onChange={onChange} />
		);
		fireEvent.click(getByText('Plan'));
		expect(onChange).toHaveBeenCalledTimes(1);
		const [updated] = onChange.mock.calls[0];
		expect(updated[0].appliesTo).not.toContain('s1');
	});

	it('shows "No steps defined" when steps array is empty', () => {
		const { getByText } = render(
			<WorkflowRulesEditor rules={[makeDraft()]} steps={[]} onChange={vi.fn()} />
		);
		expect(getByText(/No steps defined/)).toBeTruthy();
	});

	it('handles multiple rules — remove second rule correctly', () => {
		const onChange = vi.fn();
		const rules = [
			makeDraft({ localId: 'local-1', id: 'r1', name: 'Rule 1' }),
			makeDraft({ localId: 'local-2', id: 'r2', name: 'Rule 2' }),
		];
		const { getAllByTitle } = render(
			<WorkflowRulesEditor rules={rules} steps={[]} onChange={onChange} />
		);
		const removeButtons = getAllByTitle('Remove rule');
		expect(removeButtons).toHaveLength(2);
		fireEvent.click(removeButtons[0]); // remove first
		expect(onChange).toHaveBeenCalledWith([rules[1]]);
	});
});
