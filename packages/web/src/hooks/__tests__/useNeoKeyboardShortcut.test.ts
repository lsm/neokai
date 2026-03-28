/**
 * Tests for useNeoKeyboardShortcut
 *
 * Verifies:
 * - Cmd+J calls neoStore.togglePanel() and preventDefault()
 * - Ctrl+J calls neoStore.togglePanel() and preventDefault()
 * - Does NOT fire when the target is an INPUT element
 * - Does NOT fire when the target is a TEXTAREA element
 * - Does NOT fire when the target is a contentEditable element
 * - Does NOT fire for unrelated key combos
 * - Listener is removed on unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Mock neoStore
// ---------------------------------------------------------------------------

vi.mock('../../lib/neo-store.ts', () => ({
	neoStore: {
		togglePanel: vi.fn(),
	},
}));

import { useNeoKeyboardShortcut } from '../useNeoKeyboardShortcut.ts';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireKeyDown(
	key: string,
	opts: { metaKey?: boolean; ctrlKey?: boolean; target?: EventTarget } = {}
) {
	const event = new KeyboardEvent('keydown', {
		key,
		metaKey: opts.metaKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
		bubbles: true,
		cancelable: true,
	});
	if (opts.target) {
		Object.defineProperty(event, 'target', { value: opts.target });
	}
	const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
	window.dispatchEvent(event);
	return { event, preventDefaultSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useNeoKeyboardShortcut', () => {
	beforeEach(() => {
		(neoStore.togglePanel as ReturnType<typeof vi.fn>).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('Cmd+J calls neoStore.togglePanel()', () => {
		renderHook(() => useNeoKeyboardShortcut());
		fireKeyDown('j', { metaKey: true });
		expect(neoStore.togglePanel).toHaveBeenCalledOnce();
	});

	it('Ctrl+J calls neoStore.togglePanel()', () => {
		renderHook(() => useNeoKeyboardShortcut());
		fireKeyDown('j', { ctrlKey: true });
		expect(neoStore.togglePanel).toHaveBeenCalledOnce();
	});

	it('Cmd+J calls preventDefault()', () => {
		renderHook(() => useNeoKeyboardShortcut());
		const { preventDefaultSpy } = fireKeyDown('j', { metaKey: true });
		expect(preventDefaultSpy).toHaveBeenCalled();
	});

	it('does NOT fire when target is INPUT', () => {
		renderHook(() => useNeoKeyboardShortcut());
		const input = document.createElement('input');
		fireKeyDown('j', { metaKey: true, target: input });
		expect(neoStore.togglePanel).not.toHaveBeenCalled();
	});

	it('does NOT fire when target is TEXTAREA', () => {
		renderHook(() => useNeoKeyboardShortcut());
		const textarea = document.createElement('textarea');
		fireKeyDown('j', { metaKey: true, target: textarea });
		expect(neoStore.togglePanel).not.toHaveBeenCalled();
	});

	it('does NOT fire when target is contentEditable', () => {
		renderHook(() => useNeoKeyboardShortcut());
		const div = document.createElement('div');
		div.contentEditable = 'true';
		fireKeyDown('j', { metaKey: true, target: div });
		expect(neoStore.togglePanel).not.toHaveBeenCalled();
	});

	it('does NOT fire for unrelated keys (Cmd+K)', () => {
		renderHook(() => useNeoKeyboardShortcut());
		fireKeyDown('k', { metaKey: true });
		expect(neoStore.togglePanel).not.toHaveBeenCalled();
	});

	it('does NOT fire without modifier key', () => {
		renderHook(() => useNeoKeyboardShortcut());
		fireKeyDown('j');
		expect(neoStore.togglePanel).not.toHaveBeenCalled();
	});

	it('removes the event listener on unmount', () => {
		const { unmount } = renderHook(() => useNeoKeyboardShortcut());
		unmount();
		fireKeyDown('j', { metaKey: true });
		expect(neoStore.togglePanel).not.toHaveBeenCalled();
	});
});
