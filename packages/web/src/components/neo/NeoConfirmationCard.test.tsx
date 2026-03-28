/**
 * Tests for NeoConfirmationCard
 *
 * Verifies:
 * - Renders with description and risk level
 * - Confirm button calls neoStore.confirmAction(actionId)
 * - Cancel button calls neoStore.cancelAction(actionId)
 * - Shows loading state while awaiting RPC
 * - Shows error when RPC fails
 * - Resolved state: shows resolution, buttons hidden
 * - Risk levels render correct badge text
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Mock neoStore — define fns inside factory to avoid hoisting issues
// ---------------------------------------------------------------------------

vi.mock('../../lib/neo-store.ts', () => {
	const confirmAction = vi.fn();
	const cancelAction = vi.fn();
	return {
		neoStore: { confirmAction, cancelAction },
	};
});

import { NeoConfirmationCard } from './NeoConfirmationCard.tsx';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoConfirmationCard', () => {
	beforeEach(() => {
		(neoStore.confirmAction as ReturnType<typeof vi.fn>).mockReset();
		(neoStore.cancelAction as ReturnType<typeof vi.fn>).mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the action description', () => {
		const { getByText } = render(
			<NeoConfirmationCard actionId="act-1" description="Delete room prod-api" />
		);
		expect(getByText('Delete room prod-api')).toBeTruthy();
	});

	it('renders Confirm and Cancel buttons', () => {
		const { getByTestId } = render(
			<NeoConfirmationCard actionId="act-1" description="Create goal" />
		);
		expect(getByTestId('neo-confirm-button')).toBeTruthy();
		expect(getByTestId('neo-cancel-button')).toBeTruthy();
	});

	it('calls confirmAction with actionId on Confirm click', async () => {
		(neoStore.confirmAction as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
		const { getByTestId } = render(
			<NeoConfirmationCard actionId="act-42" description="Enable skill" />
		);
		await act(async () => {
			fireEvent.click(getByTestId('neo-confirm-button'));
		});
		expect(neoStore.confirmAction).toHaveBeenCalledWith('act-42');
	});

	it('calls cancelAction with actionId on Cancel click', async () => {
		(neoStore.cancelAction as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
		const { getByTestId } = render(
			<NeoConfirmationCard actionId="act-99" description="Delete space" />
		);
		await act(async () => {
			fireEvent.click(getByTestId('neo-cancel-button'));
		});
		expect(neoStore.cancelAction).toHaveBeenCalledWith('act-99');
	});

	it('disables buttons while loading', async () => {
		let resolveConfirm!: (v: { success: boolean }) => void;
		(neoStore.confirmAction as ReturnType<typeof vi.fn>).mockReturnValue(
			new Promise((res) => (resolveConfirm = res))
		);

		const { getByTestId } = render(
			<NeoConfirmationCard actionId="act-1" description="Do something" />
		);
		fireEvent.click(getByTestId('neo-confirm-button'));

		await waitFor(() => {
			expect(getByTestId('neo-confirm-button').hasAttribute('disabled')).toBe(true);
			expect(getByTestId('neo-cancel-button').hasAttribute('disabled')).toBe(true);
		});

		await act(async () => {
			resolveConfirm({ success: true });
		});
	});

	it('shows error message when confirmAction fails', async () => {
		(neoStore.confirmAction as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			error: 'Action expired',
		});
		const { getByTestId } = render(
			<NeoConfirmationCard actionId="act-1" description="Do something" />
		);
		await act(async () => {
			fireEvent.click(getByTestId('neo-confirm-button'));
		});
		await waitFor(() => {
			expect(getByTestId('neo-confirmation-error').textContent).toContain('Action expired');
		});
	});

	it('shows error message when cancelAction fails', async () => {
		(neoStore.cancelAction as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			error: 'Network error',
		});
		const { getByTestId } = render(
			<NeoConfirmationCard actionId="act-1" description="Do something" />
		);
		await act(async () => {
			fireEvent.click(getByTestId('neo-cancel-button'));
		});
		await waitFor(() => {
			expect(getByTestId('neo-confirmation-error').textContent).toContain('Network error');
		});
	});

	it('shows "Confirmed" label when resolved with confirmed', () => {
		const { queryByTestId, getByText } = render(
			<NeoConfirmationCard actionId="act-1" description="Done" resolved resolution="confirmed" />
		);
		expect(queryByTestId('neo-confirm-button')).toBeNull();
		expect(queryByTestId('neo-cancel-button')).toBeNull();
		expect(getByText('✓ Confirmed')).toBeTruthy();
	});

	it('shows "Cancelled" label when resolved with cancelled', () => {
		const { queryByTestId, getByText } = render(
			<NeoConfirmationCard actionId="act-1" description="Done" resolved resolution="cancelled" />
		);
		expect(queryByTestId('neo-confirm-button')).toBeNull();
		expect(queryByTestId('neo-cancel-button')).toBeNull();
		expect(getByText('✕ Cancelled')).toBeTruthy();
	});

	it('shows "Requires confirmation" badge for medium risk (default)', () => {
		const { getByText } = render(
			<NeoConfirmationCard actionId="act-1" description="Do it" riskLevel="medium" />
		);
		expect(getByText('Requires confirmation')).toBeTruthy();
	});

	it('shows "Low risk" badge', () => {
		const { getByText } = render(
			<NeoConfirmationCard actionId="act-1" description="Do it" riskLevel="low" />
		);
		expect(getByText('Low risk')).toBeTruthy();
	});

	it('shows "High risk — irreversible" badge', () => {
		const { getByText } = render(
			<NeoConfirmationCard actionId="act-1" description="Do it" riskLevel="high" />
		);
		expect(getByText('High risk — irreversible')).toBeTruthy();
	});

	it('does not call confirm/cancel when already resolved', () => {
		render(
			<NeoConfirmationCard actionId="act-1" description="Done" resolved resolution="confirmed" />
		);
		expect(neoStore.confirmAction).not.toHaveBeenCalled();
	});
});
