import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

function setPlatform(value: string) {
	Object.defineProperty(navigator, 'platform', {
		value,
		configurable: true,
	});
}

describe('useGlobalShortcuts', () => {
	let originalPlatform: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
		commandRegistry.clear();
		commandPaletteOpenSignal.value = false;
	});

	afterEach(() => {
		commandRegistry.clear();
		commandPaletteOpenSignal.value = false;
		if (originalPlatform) {
			Object.defineProperty(navigator, 'platform', originalPlatform);
		}
		vi.restoreAllMocks();
	});

	it('toggles command palette on Cmd+K on mac', () => {
		setPlatform('MacIntel');
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', metaKey: true });
		expect(commandPaletteOpenSignal.value).toBe(true);
		fireKey({ key: 'k', metaKey: true });
		expect(commandPaletteOpenSignal.value).toBe(false);
	});

	it('does not toggle on Ctrl+K on mac (native editing shortcut)', () => {
		setPlatform('MacIntel');
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', ctrlKey: true });
		expect(commandPaletteOpenSignal.value).toBe(false);
	});

	it('toggles on Ctrl+K on non-mac', () => {
		setPlatform('Win32');
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', ctrlKey: true });
		expect(commandPaletteOpenSignal.value).toBe(true);
	});

	it('does not toggle on Cmd+K on non-mac', () => {
		setPlatform('Win32');
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', metaKey: true });
		expect(commandPaletteOpenSignal.value).toBe(false);
	});

	it('does not toggle on plain k', () => {
		setPlatform('MacIntel');
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k' });
		expect(commandPaletteOpenSignal.value).toBe(false);
	});

	it('runs registered command shortcut', () => {
		setPlatform('MacIntel');
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

	it('ignores auto-repeat keydown for shortcuts', () => {
		setPlatform('MacIntel');
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
		fireKey({ key: '.', metaKey: true, repeat: true });
		fireKey({ key: '.', metaKey: true, repeat: true });
		expect(ran).toBe(1);
	});

	it('ignores auto-repeat keydown for palette toggle', () => {
		setPlatform('MacIntel');
		renderHook(() => useGlobalShortcuts());
		fireKey({ key: 'k', metaKey: true });
		expect(commandPaletteOpenSignal.value).toBe(true);
		fireKey({ key: 'k', metaKey: true, repeat: true });
		expect(commandPaletteOpenSignal.value).toBe(true);
	});

	it('ignores command shortcuts while typing in a text input', () => {
		setPlatform('MacIntel');
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

	it('still toggles palette while typing (mac, Cmd+K)', () => {
		setPlatform('MacIntel');
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
