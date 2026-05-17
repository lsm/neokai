/**
 * Global keyboard shortcut hook.
 *
 * Listens for Cmd+K / Ctrl+K (toggles the command palette) and dispatches any
 * other shortcuts registered on commands in the registry.
 *
 * Ignores key events that originate from text inputs / contenteditable nodes so
 * we don't hijack typing inside the chat composer. Cmd+K is allowed in inputs
 * because users expect to be able to invoke the palette while composing.
 */

import { useEffect } from 'preact/hooks';
import { commandRegistry } from '../lib/command-registry.ts';
import { commandPaletteOpenSignal } from '../lib/signals.ts';

function isTextEditingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	if (tag === 'INPUT') {
		const type = (target as HTMLInputElement).type;
		// Allow shortcuts for non-text-like inputs (checkboxes, buttons)
		return type !== 'checkbox' && type !== 'radio' && type !== 'button';
	}
	return tag === 'TEXTAREA' || tag === 'SELECT';
}

function isPaletteToggle(event: KeyboardEvent): boolean {
	return (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k';
}

export function useGlobalShortcuts(): void {
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			// Palette toggle works everywhere, including inside text inputs.
			if (isPaletteToggle(event)) {
				event.preventDefault();
				commandPaletteOpenSignal.value = !commandPaletteOpenSignal.value;
				return;
			}

			// Don't intercept other shortcuts while the user is typing.
			if (isTextEditingTarget(event.target)) return;

			const cmd = commandRegistry.findByShortcut(event);
			if (!cmd) return;
			event.preventDefault();
			void cmd.run();
		};

		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);
}
