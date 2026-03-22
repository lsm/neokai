/**
 * Tests for InboxBadge animation component (plan 8.3)
 *
 * Verifies:
 * - Badge renders when count > 0
 * - Badge does not render when count is 0
 * - Scale animation class (animate-badge-pop) is applied on mount
 * - Badge fades to opacity-0 when count reaches 0
 * - 9+ label is used for counts above 9
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { InboxBadge } from './InboxBadge';

describe('InboxBadge', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it('renders badge when count is positive', () => {
		const { container } = render(<InboxBadge count={3} />);
		const badge = container.querySelector('.bg-red-500');
		expect(badge).toBeTruthy();
		expect(badge?.textContent).toBe('3');
	});

	it('does not render badge when count is 0', () => {
		const { container } = render(<InboxBadge count={0} />);
		expect(container.querySelector('.bg-red-500')).toBeFalsy();
	});

	it('shows 9+ when count exceeds 9', () => {
		const { container } = render(<InboxBadge count={10} />);
		const badge = container.querySelector('.bg-red-500');
		expect(badge?.textContent).toBe('9+');
	});

	it('applies animate-badge-pop class on initial mount', () => {
		const { container } = render(<InboxBadge count={1} />);
		const badge = container.querySelector('.bg-red-500');
		expect(badge?.classList.contains('animate-badge-pop')).toBe(true);
	});

	it('applies additional positioning class when provided', () => {
		const { container } = render(<InboxBadge count={2} class="absolute top-1 right-1" />);
		const badge = container.querySelector('.bg-red-500');
		expect(badge?.classList.contains('absolute')).toBe(true);
		expect(badge?.classList.contains('top-1')).toBe(true);
		expect(badge?.classList.contains('right-1')).toBe(true);
	});

	it('is initially visible (opacity-100) when count is positive', () => {
		const { container } = render(<InboxBadge count={1} />);
		const badge = container.querySelector('.bg-red-500');
		expect(badge?.classList.contains('opacity-100')).toBe(true);
		expect(badge?.classList.contains('opacity-0')).toBe(false);
	});

	it('fades out (opacity-0) when count drops to 0', async () => {
		const { container, rerender } = render(<InboxBadge count={3} />);
		expect(container.querySelector('.bg-red-500')).toBeTruthy();

		// Drop count to 0 — badge should start fading
		await act(async () => {
			rerender(<InboxBadge count={0} />);
		});

		const badge = container.querySelector('.bg-red-500');
		// Badge still in DOM but opacity-0
		expect(badge).toBeTruthy();
		expect(badge?.classList.contains('opacity-0')).toBe(true);
	});

	it('removes badge from DOM after fade-out timeout (200ms)', async () => {
		const { container, rerender } = render(<InboxBadge count={3} />);

		await act(async () => {
			rerender(<InboxBadge count={0} />);
		});
		// Badge still visible (fading)
		expect(container.querySelector('.bg-red-500')).toBeTruthy();

		// Advance past the 200ms fade-out timeout
		await act(async () => {
			vi.advanceTimersByTime(210);
		});

		expect(container.querySelector('.bg-red-500')).toBeFalsy();
	});

	it('re-shows badge (opacity-100) when count becomes positive again after fade-out', async () => {
		const { container, rerender } = render(<InboxBadge count={3} />);

		await act(async () => {
			rerender(<InboxBadge count={0} />);
		});

		// Before timeout, bump count back up
		await act(async () => {
			rerender(<InboxBadge count={2} />);
		});

		const badge = container.querySelector('.bg-red-500');
		expect(badge).toBeTruthy();
		expect(badge?.classList.contains('opacity-0')).toBe(false);
	});
});
