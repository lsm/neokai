/**
 * Unit tests for ChannelEditor
 *
 * Tests:
 * - Renders empty state when no channels
 * - Renders channel entries with from/direction/to summary
 * - Toggle expand/collapse a channel entry
 * - Delete a channel calls onChange with filtered list
 * - Add channel form: disabled when from/to empty, calls onChange on add
 * - Gate badge rendered when channel has a non-always gate
 * - highlightIndex auto-expands the matching channel
 * - With agentRoles: renders dropdowns for from/to
 * - Without agentRoles: renders text inputs for from/to
 * - Updating direction, label, gate calls onChange with updated channel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { WorkflowChannel } from '@neokai/shared';
import { ChannelEditor } from '../ChannelEditor';

const DEFAULT_ROLES = ['coder', 'reviewer', 'planner'];

function makeChannel(overrides: Partial<WorkflowChannel> = {}): WorkflowChannel {
	return {
		from: 'task-agent',
		to: 'coder',
		direction: 'one-way',
		...overrides,
	};
}

describe('ChannelEditor', () => {
	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	// -------------------------------------------------------------------------
	// Empty state
	// -------------------------------------------------------------------------

	it('shows empty state message when no channels', () => {
		const onChange = vi.fn();
		const { getByTestId, getByText } = render(<ChannelEditor channels={[]} onChange={onChange} />);
		expect(getByTestId('channel-editor')).toBeTruthy();
		expect(getByText(/no channels/i)).toBeTruthy();
	});

	it('does not show empty state when channels exist', () => {
		const onChange = vi.fn();
		const { queryByText } = render(
			<ChannelEditor channels={[makeChannel()]} onChange={onChange} />
		);
		expect(queryByText(/no channels/i)).toBeNull();
	});

	// -------------------------------------------------------------------------
	// Channel list rendering
	// -------------------------------------------------------------------------

	it('renders channel entries with from/to summary', () => {
		const onChange = vi.fn();
		const channels = [
			makeChannel({ from: 'coder', to: 'reviewer', direction: 'one-way' }),
			makeChannel({ from: 'task-agent', to: 'coder', direction: 'bidirectional' }),
		];
		const { getAllByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		const entries = getAllByTestId('channel-entry');
		expect(entries).toHaveLength(2);
	});

	it('shows gate badge when channel has a non-always gate', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'human' } })];
		const { getByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		expect(getByTestId('gate-badge')).toBeTruthy();
	});

	it('does not show gate badge for ungated channel', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { queryByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		expect(queryByTestId('gate-badge')).toBeNull();
	});

	// -------------------------------------------------------------------------
	// Expand / collapse
	// -------------------------------------------------------------------------

	it('collapses all entries initially', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { queryByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		expect(queryByTestId('channel-edit-form')).toBeNull();
	});

	it('expands a channel entry when toggle button is clicked', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		const toggleBtn = getAllByTestId('channel-toggle-button')[0];
		fireEvent.click(toggleBtn);
		expect(getByTestId('channel-edit-form')).toBeTruthy();
	});

	it('collapses an already-expanded entry on second click', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, queryByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		const toggleBtn = getAllByTestId('channel-toggle-button')[0];
		fireEvent.click(toggleBtn);
		fireEvent.click(toggleBtn);
		expect(queryByTestId('channel-edit-form')).toBeNull();
	});

	// -------------------------------------------------------------------------
	// highlightIndex
	// -------------------------------------------------------------------------

	it('auto-expands the channel at highlightIndex', () => {
		const onChange = vi.fn();
		const channels = [makeChannel(), makeChannel({ from: 'reviewer', to: 'coder' })];
		const { getAllByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} highlightIndex={1} />
		);
		// The second entry (index 1) should be expanded
		const editForms = getAllByTestId('channel-edit-form');
		expect(editForms).toHaveLength(1);
		// The expanded entry should be the second one (index 1)
		const entries = getAllByTestId('channel-entry');
		expect(entries[1].querySelector('[data-testid="channel-edit-form"]')).toBeTruthy();
	});

	// -------------------------------------------------------------------------
	// Delete
	// -------------------------------------------------------------------------

	it('calls onChange with channel removed when delete is clicked', () => {
		const onChange = vi.fn();
		const channels = [
			makeChannel({ from: 'coder', to: 'reviewer' }),
			makeChannel({ from: 'task-agent', to: 'coder' }),
		];
		const { getAllByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		const deleteButtons = getAllByTestId('delete-channel-button');
		fireEvent.click(deleteButtons[0]);
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result).toHaveLength(1);
		expect(result[0].from).toBe('task-agent');
	});

	// -------------------------------------------------------------------------
	// Add channel form — no agentRoles (text inputs)
	// -------------------------------------------------------------------------

	it('renders text inputs when no agentRoles provided', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ChannelEditor channels={[]} onChange={onChange} />);
		expect(getByTestId('new-channel-from-input')).toBeTruthy();
		expect(getByTestId('new-channel-to-input')).toBeTruthy();
	});

	it('add-channel button is disabled when from/to are empty', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ChannelEditor channels={[]} onChange={onChange} />);
		const addBtn = getByTestId('add-channel-submit-button') as HTMLButtonElement;
		expect(addBtn.disabled).toBe(true);
	});

	it('add-channel button calls onChange with new channel when from and to are filled', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ChannelEditor channels={[]} onChange={onChange} />);
		fireEvent.input(getByTestId('new-channel-from-input'), { target: { value: 'coder' } });
		fireEvent.input(getByTestId('new-channel-to-input'), { target: { value: 'reviewer' } });
		fireEvent.click(getByTestId('add-channel-submit-button'));
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result).toHaveLength(1);
		expect(result[0].from).toBe('coder');
		expect(result[0].to).toBe('reviewer');
		expect(result[0].direction).toBe('one-way');
	});

	it('parses comma-separated to field into array on add', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ChannelEditor channels={[]} onChange={onChange} />);
		fireEvent.input(getByTestId('new-channel-from-input'), { target: { value: 'coder' } });
		fireEvent.input(getByTestId('new-channel-to-input'), {
			target: { value: 'reviewer, planner' },
		});
		fireEvent.click(getByTestId('add-channel-submit-button'));
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(Array.isArray(result[0].to)).toBe(true);
		expect(result[0].to).toEqual(['reviewer', 'planner']);
	});

	it('clears add-channel form after add', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ChannelEditor channels={[]} onChange={onChange} />);
		const fromInput = getByTestId('new-channel-from-input') as HTMLInputElement;
		const toInput = getByTestId('new-channel-to-input') as HTMLInputElement;
		fireEvent.input(fromInput, { target: { value: 'coder' } });
		fireEvent.input(toInput, { target: { value: 'reviewer' } });
		fireEvent.click(getByTestId('add-channel-submit-button'));
		expect(fromInput.value).toBe('');
		expect(toInput.value).toBe('');
	});

	// -------------------------------------------------------------------------
	// Add channel form — with agentRoles (dropdowns)
	// -------------------------------------------------------------------------

	it('renders dropdowns when agentRoles are provided', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(
			<ChannelEditor channels={[]} onChange={onChange} agentRoles={DEFAULT_ROLES} />
		);
		expect(getByTestId('new-channel-from-select')).toBeTruthy();
		expect(getByTestId('new-channel-to-select')).toBeTruthy();
	});

	it('add via dropdowns calls onChange with correct channel', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(
			<ChannelEditor channels={[]} onChange={onChange} agentRoles={DEFAULT_ROLES} />
		);
		fireEvent.change(getByTestId('new-channel-from-select'), { target: { value: 'coder' } });
		fireEvent.change(getByTestId('new-channel-to-select'), { target: { value: 'reviewer' } });
		fireEvent.click(getByTestId('add-channel-submit-button'));
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].from).toBe('coder');
		expect(result[0].to).toBe('reviewer');
	});

	// -------------------------------------------------------------------------
	// Channel editing
	// -------------------------------------------------------------------------

	it('updating direction calls onChange with updated channel', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ direction: 'one-way' })];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		// Expand the entry
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		// Change direction
		fireEvent.change(getByTestId('channel-direction-select'), {
			target: { value: 'bidirectional' },
		});
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].direction).toBe('bidirectional');
	});

	it('updating label calls onChange with updated channel', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.input(getByTestId('channel-label-input'), { target: { value: 'PR ready' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].label).toBe('PR ready');
	});

	it('cyclic checkbox updates isCyclic on channel', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-cyclic-checkbox'), {
			target: { checked: true },
		});
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].isCyclic).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Multi-channel add appends to existing list
	// -------------------------------------------------------------------------

	it('adds channel to existing list without replacing it', () => {
		let currentChannels: WorkflowChannel[] = [makeChannel({ from: 'coder', to: 'reviewer' })];
		const onChange = vi.fn((updated: WorkflowChannel[]) => {
			currentChannels = updated;
		});
		const { getByTestId, rerender } = render(
			<ChannelEditor channels={currentChannels} onChange={onChange} />
		);
		fireEvent.input(getByTestId('new-channel-from-input'), { target: { value: 'planner' } });
		fireEvent.input(getByTestId('new-channel-to-input'), { target: { value: 'coder' } });
		fireEvent.click(getByTestId('add-channel-submit-button'));
		expect(currentChannels).toHaveLength(2);
		expect(currentChannels[0].from).toBe('coder');
		expect(currentChannels[1].from).toBe('planner');
	});
});

// -------------------------------------------------------------------------
// Gate config — condition types
// -------------------------------------------------------------------------

describe('ChannelEditor — gate config', () => {
	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows gate select with all 4 condition types when channel is expanded', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		const gateSelect = getByTestId('channel-gate-select-0') as HTMLSelectElement;
		const values = Array.from(gateSelect.options).map((o) => o.value);
		expect(values).toContain('always');
		expect(values).toContain('human');
		expect(values).toContain('condition');
		expect(values).toContain('task_result');
	});

	it('shows "fires automatically" hint for "always" gate (default)', () => {
		const onChange = vi.fn();
		// No gate = always (default ungated channel)
		const channels = [makeChannel()];
		const { getAllByTestId, getByText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByText('Transition fires automatically.')).toBeTruthy();
	});

	it('shows "human approval" hint when gate type is "human"', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'human' } })];
		const { getAllByTestId, getByText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByText('Transition requires explicit human approval.')).toBeTruthy();
	});

	it('shows shell expression input for "condition" gate type', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'condition', expression: '' } })];
		const { getAllByTestId, getByPlaceholderText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByPlaceholderText('e.g. bun test && git diff --quiet')).toBeTruthy();
	});

	it('shows "fires when task result matches" hint for "condition" gate type', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'condition', expression: '' } })];
		const { getAllByTestId, getByText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByText('Transition fires when the shell command exits with code 0.')).toBeTruthy();
	});

	it('shows task-result expression input for "task_result" gate type', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'task_result', expression: '' } })];
		const { getAllByTestId, getByPlaceholderText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByPlaceholderText('e.g. passed, failed')).toBeTruthy();
	});

	it('shows "fires when task result matches" hint for "task_result" gate type', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'task_result', expression: '' } })];
		const { getAllByTestId, getByText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByText('Fires when the task result matches this value.')).toBeTruthy();
	});

	it('changing gate to "human" calls onChange with gate.type="human"', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-gate-select-0'), { target: { value: 'human' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gate?.type).toBe('human');
	});

	it('changing gate to "condition" calls onChange with gate.type="condition" and empty expression', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-gate-select-0'), { target: { value: 'condition' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gate?.type).toBe('condition');
		expect(result[0].gate?.expression).toBe('');
	});

	it('changing gate to "task_result" calls onChange with gate.type="task_result" and empty expression', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-gate-select-0'), { target: { value: 'task_result' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gate?.type).toBe('task_result');
		expect(result[0].gate?.expression).toBe('');
	});

	it('changing gate to "always" removes the gate from the channel', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'human' } })];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-gate-select-0'), { target: { value: 'always' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		// "always" gate is stored as undefined (no gate restriction)
		expect(result[0].gate).toBeUndefined();
	});

	it('expression input for "condition" gate updates channel expression via onChange', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'condition', expression: '' } })];
		const { getAllByTestId, getByPlaceholderText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.input(getByPlaceholderText('e.g. bun test && git diff --quiet'), {
			target: { value: 'bun test' },
		});
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gate?.expression).toBe('bun test');
	});

	it('expression input for "task_result" gate updates channel expression via onChange', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gate: { type: 'task_result', expression: '' } })];
		const { getAllByTestId, getByPlaceholderText } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.input(getByPlaceholderText('e.g. passed, failed'), {
			target: { value: 'passed' },
		});
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gate?.expression).toBe('passed');
	});
});
