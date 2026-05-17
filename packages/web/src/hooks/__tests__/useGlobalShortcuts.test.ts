import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/preact';
import { useGlobalShortcuts } from '../useGlobalShortcuts.ts';
import { commandRegistry } from '../../lib/command-registry.ts';
import { commandPaletteOpenSignal } from '../../lib/signals.ts';

function fireKey(opts: KeyboardEventInit & { target?: HTMLElement }) {
	const { target, ...init } = opts;
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	(target ?? window).dispatchEvent(event);
	return event;
}

describe('useGlobalShortcuts', () => {
	beforeEach(() => {
		commandRegistry.clear();
		commandPaletteOpenSignal.value = false;
	});

	afterEach(() => {
		commandRegistry.clear();
		commandPaletteOpenSignal.value = false;
	});

	it('toggles command palette on Cmd+K', () => {
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', metaKey: true });
		expect(commandPaletteOpenSignal.value).toBe(true);
		fireKey({ key: 'k', metaKey: true });
		expect(commandPaletteOpenSignal.value).toBe(false);
	});

	it('also toggles on Ctrl+K (non-mac)', () => {
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', ctrlKey: true });
		expect(commandPaletteOpenSignal.value).toBe(true);
	});

	it('does not toggle on plain k', () => {
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k' });
		expect(commandPaletteOpenSignal.value).toBe(false);
	});

	it('runs registered command shortcut', async () => {
		let ran = 0;
		commandRegistry.register({
			id: 'test',
			label: 'Test',
			category: 'help',
			shortcut: { display: '⌘.', key: '.', mod: true },
			run: () => {
				ran += 1;
			},
		});
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: '.', metaKey: true });
		expect(ran).toBe(1);
	});

	it('ignores command shortcuts while typing in a text input', () => {
		let ran = 0;
		commandRegistry.register({
			id: 'test',
			label: 'Test',
			category: 'help',
			shortcut: { display: '⌘.', key: '.', mod: true },
			run: () => {
				ran += 1;
			},
		});
		renderHook(() => useGlobalShortcuts());
		const input = document.createElement('input');
		input.type = 'text';
		document.body.appendChild(input);
		input.focus();
		fireKey({ key: '.', metaKey: true, target: input });
		input.remove();
		expect(ran).toBe(0);
	});

	it('still toggles palette while typing', () => {
		renderHook(() => useGlobalShortcuts());
		const input = document.createElement('input');
		input.type = 'text';
		document.body.appendChild(input);
		input.focus();
		fireKey({ key: 'k', metaKey: true, target: input });
		input.remove();
		expect(commandPaletteOpenSignal.value).toBe(true);
	});
});
