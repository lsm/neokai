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

	it('shows gate badge when channel has a gateId', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gateId: 'plan-approval-gate' })];
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
// Gate condition select
// -------------------------------------------------------------------------

describe('ChannelEditor — gate condition', () => {
	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows gate condition select when channel is expanded', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		expect(getByTestId('channel-gate-select-0')).toBeTruthy();
	});

	it('gate select defaults to "always" for ungated channel', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		const select = getByTestId('channel-gate-select-0') as HTMLSelectElement;
		expect(select.value).toBe('always');
	});

	it('selecting "human" sets gateId to "human-approval"', () => {
		const onChange = vi.fn();
		const channels = [makeChannel()];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-gate-select-0'), { target: { value: 'human' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gateId).toBe('human-approval');
	});

	it('selecting "always" clears gateId to undefined', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gateId: 'human-approval' })];
		const { getAllByTestId, getByTestId } = render(
			<ChannelEditor channels={channels} onChange={onChange} />
		);
		fireEvent.click(getAllByTestId('channel-toggle-button')[0]);
		fireEvent.change(getByTestId('channel-gate-select-0'), { target: { value: 'always' } });
		expect(onChange).toHaveBeenCalledOnce();
		const result = onChange.mock.calls[0][0] as WorkflowChannel[];
		expect(result[0].gateId).toBeUndefined();
	});

	it('gate badge shows "Human Approval" for human-approval gate', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gateId: 'human-approval' })];
		const { getByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		const badge = getByTestId('gate-badge');
		expect(badge.textContent).toBe('Human Approval');
	});

	it('gate badge shows "Custom Condition" for unknown gate IDs', () => {
		const onChange = vi.fn();
		const channels = [makeChannel({ gateId: 'my-custom-gate' })];
		const { getByTestId } = render(<ChannelEditor channels={channels} onChange={onChange} />);
		const badge = getByTestId('gate-badge');
		expect(badge.textContent).toBe('Custom Condition');
	});
});
