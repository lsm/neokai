/**
 * Tests for NeoActivityView
 *
 * Verifies:
 * - Loading state when activity is empty and loading=true
 * - Empty state when no activity and not loading
 * - Renders activity entries
 * - Each entry shows tool name, relative timestamp, status badge
 * - Clicking entry expands details
 * - Clicking again collapses details
 * - Status badge shows correct variant (success / error / cancelled)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/preact';
import type { NeoActivityEntry } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Mock neoStore — signals defined inside factory to avoid hoisting issues
// ---------------------------------------------------------------------------

vi.mock('../../lib/neo-store.ts', async () => {
	const { signal: s } = await import('@preact/signals');
	const activity = s<NeoActivityEntry[]>([]);
	const loading = s(false);
	return {
		neoStore: { activity, loading },
	};
});

import { NeoActivityView } from './NeoActivityView.tsx';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
	partial: Partial<NeoActivityEntry> & { id: string; toolName: string }
): NeoActivityEntry {
	return {
		input: null,
		output: null,
		status: 'success',
		error: null,
		targetType: null,
		targetId: null,
		undoable: false,
		undoData: null,
		createdAt: new Date().toISOString(),
		...partial,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoActivityView', () => {
	beforeEach(() => {
		neoStore.activity.value = [];
		neoStore.loading.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('shows loading state when activity empty and loading=true', () => {
		neoStore.loading.value = true;
		const { getByTestId } = render(<NeoActivityView />);
		expect(getByTestId('neo-activity-loading')).toBeTruthy();
	});

	it('shows empty state when no activity and not loading', () => {
		const { getByTestId } = render(<NeoActivityView />);
		expect(getByTestId('neo-activity-empty')).toBeTruthy();
	});

	it('does not show empty state when entries exist', () => {
		neoStore.activity.value = [makeEntry({ id: '1', toolName: 'create_space' })];
		const { queryByTestId } = render(<NeoActivityView />);
		expect(queryByTestId('neo-activity-empty')).toBeNull();
	});

	it('renders activity entries', () => {
		neoStore.activity.value = [
			makeEntry({ id: '1', toolName: 'create_space' }),
			makeEntry({ id: '2', toolName: 'delete_space', status: 'error' }),
		];
		const { getAllByTestId } = render(<NeoActivityView />);
		expect(getAllByTestId('activity-entry')).toHaveLength(2);
	});

	it('formats tool_name to title case', () => {
		neoStore.activity.value = [makeEntry({ id: '1', toolName: 'create_space' })];
		const { getByText } = render(<NeoActivityView />);
		expect(getByText('Create Space')).toBeTruthy();
	});

	it('shows success badge for successful entry', () => {
		neoStore.activity.value = [makeEntry({ id: '1', toolName: 'create_space', status: 'success' })];
		const { getByTestId } = render(<NeoActivityView />);
		expect(getByTestId('activity-status-success')).toBeTruthy();
	});

	it('shows error badge for failed entry', () => {
		neoStore.activity.value = [makeEntry({ id: '1', toolName: 'delete_space', status: 'error' })];
		const { getByTestId } = render(<NeoActivityView />);
		expect(getByTestId('activity-status-error')).toBeTruthy();
	});

	it('shows cancelled badge for cancelled entry', () => {
		neoStore.activity.value = [
			makeEntry({ id: '1', toolName: 'stop_session', status: 'cancelled' }),
		];
		const { getByTestId } = render(<NeoActivityView />);
		expect(getByTestId('activity-status-cancelled')).toBeTruthy();
	});

	it('expands details when entry is clicked', () => {
		neoStore.activity.value = [
			makeEntry({
				id: '1',
				toolName: 'create_space',
				input: JSON.stringify({ name: 'my-room' }),
				output: JSON.stringify({ id: 'room-123' }),
			}),
		];
		const { getByTestId, queryByTestId } = render(<NeoActivityView />);
		expect(queryByTestId('activity-entry-details')).toBeNull();

		act(() => {
			fireEvent.click(getByTestId('activity-entry').querySelector('button')!);
		});
		expect(getByTestId('activity-entry-details')).toBeTruthy();
	});

	it('collapses details on second click', () => {
		neoStore.activity.value = [makeEntry({ id: '1', toolName: 'create_space' })];
		const { getByTestId, queryByTestId } = render(<NeoActivityView />);
		const btn = getByTestId('activity-entry').querySelector('button')!;

		act(() => {
			fireEvent.click(btn);
		});
		expect(getByTestId('activity-entry-details')).toBeTruthy();

		act(() => {
			fireEvent.click(btn);
		});
		expect(queryByTestId('activity-entry-details')).toBeNull();
	});

	it('shows target from targetType + targetId', () => {
		neoStore.activity.value = [
			makeEntry({
				id: '1',
				toolName: 'get_space_status',
				targetType: 'room',
				targetId: 'prod-api',
			}),
		];
		const { getByText } = render(<NeoActivityView />);
		expect(getByText('room prod-api')).toBeTruthy();
	});

	it('shows error text in summary for error status', () => {
		neoStore.activity.value = [
			makeEntry({
				id: '1',
				toolName: 'delete_space',
				status: 'error',
				error: 'Space has active sessions',
			}),
		];
		const { getByText } = render(<NeoActivityView />);
		expect(getByText('Space has active sessions')).toBeTruthy();
	});

	it('shows all entries when multiple provided', () => {
		neoStore.activity.value = Array.from({ length: 5 }, (_, i) =>
			makeEntry({ id: String(i), toolName: `tool_${i}` })
		);
		const { getAllByTestId } = render(<NeoActivityView />);
		expect(getAllByTestId('activity-entry')).toHaveLength(5);
	});
});
