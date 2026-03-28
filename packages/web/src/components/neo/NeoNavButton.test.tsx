/**
 * Tests for NeoNavButton
 *
 * Verifies:
 * - Renders a button with correct aria-label and tooltip
 * - Renders the sparkle SVG icon
 * - Clicking calls neoStore.togglePanel()
 * - Active state reflects neoStore.panelOpen signal
 * - onOpen callback is invoked when the panel transitions to open
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Mock neoStore
// ---------------------------------------------------------------------------

vi.mock('../../lib/neo-store.ts', async () => {
	const { signal: s } = await import('@preact/signals');
	const panelOpen = s(false);
	const togglePanel = vi.fn(() => {
		panelOpen.value = !panelOpen.value;
	});
	return {
		neoStore: { panelOpen, togglePanel },
	};
});

import { NeoNavButton } from './NeoNavButton.tsx';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoNavButton', () => {
	beforeEach(() => {
		neoStore.panelOpen.value = false;
		(neoStore.togglePanel as ReturnType<typeof vi.fn>).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders a button element', () => {
		const { container } = render(<NeoNavButton />);
		expect(container.querySelector('button')).toBeTruthy();
	});

	it('has the correct aria-label and title tooltip', () => {
		const { container } = render(<NeoNavButton />);
		const btn = container.querySelector('button');
		expect(btn?.getAttribute('aria-label')).toBe('Neo (⌘J)');
		expect(btn?.getAttribute('title')).toBe('Neo (⌘J)');
	});

	it('renders a sparkle SVG icon', () => {
		const { container } = render(<NeoNavButton />);
		expect(container.querySelector('svg')).toBeTruthy();
	});

	it('calls neoStore.togglePanel() when clicked', () => {
		const { container } = render(<NeoNavButton />);
		const btn = container.querySelector('button')!;
		fireEvent.click(btn);
		expect(neoStore.togglePanel).toHaveBeenCalledOnce();
	});

	it('is not aria-pressed when panel is closed', () => {
		neoStore.panelOpen.value = false;
		const { container } = render(<NeoNavButton />);
		const btn = container.querySelector('button');
		expect(btn?.getAttribute('aria-pressed')).toBe('false');
	});

	it('is aria-pressed when panel is open', () => {
		neoStore.panelOpen.value = true;
		const { container } = render(<NeoNavButton />);
		const btn = container.querySelector('button');
		expect(btn?.getAttribute('aria-pressed')).toBe('true');
	});

	it('reflects updated active state after toggle', () => {
		const { container } = render(<NeoNavButton />);
		const btn = container.querySelector('button')!;

		expect(btn.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(btn);
		expect(btn.getAttribute('aria-pressed')).toBe('true');
	});

	it('invokes onOpen callback when opening the panel', () => {
		const onOpen = vi.fn();
		neoStore.panelOpen.value = false;
		const { container } = render(<NeoNavButton onOpen={onOpen} />);
		const btn = container.querySelector('button')!;
		fireEvent.click(btn);
		expect(onOpen).toHaveBeenCalledOnce();
	});

	it('does NOT invoke onOpen when closing the panel', () => {
		const onOpen = vi.fn();
		neoStore.panelOpen.value = true;
		const { container } = render(<NeoNavButton onOpen={onOpen} />);
		const btn = container.querySelector('button')!;
		fireEvent.click(btn);
		expect(onOpen).not.toHaveBeenCalled();
	});
});
