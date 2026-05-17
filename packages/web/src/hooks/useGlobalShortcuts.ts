/**
 * Global keyboard shortcut hook.
 *
 * Listens for Cmd+K (mac) / Ctrl+K (non-mac) to toggle the command palette and
 * dispatches any other shortcuts registered on commands in the registry.
 *
 * Ignores key events that originate from text inputs / contenteditable nodes so
 * we don't hijack typing inside the chat composer. The palette toggle is also
 * allowed in inputs — except on macOS we never treat Ctrl+K as a palette toggle
 * because it's a native text-editing shortcut (kill-to-end-of-line).
 *
 * Auto-repeat keydown events are ignored so press-and-hold doesn't fire a
 * non-idempotent command (e.g. session.new) multiple times.
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

function isMacPlatform(): boolean {
	if (typeof navigator === 'undefined') return false;
	const platform = navigator.platform ?? '';
	if (platform) return /Mac|iPhone|iPad|iPod/i.test(platform);
	return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '');
}

function isPaletteToggle(event: KeyboardEvent, isMac: boolean): boolean {
	if (event.shiftKey || event.altKey) return false;
	if (event.code !== 'KeyK') return false;
	// On mac, only Cmd+K toggles. Ctrl+K is a native editing shortcut.
	// On non-mac, only Ctrl+K toggles.
	return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function useGlobalShortcuts(): void {
	useEffect(() => {
		const isMac = isMacPlatform();

		const handler = (event: KeyboardEvent) => {
			// Skip auto-repeat: each shortcut fires once per physical press.
			if (event.repeat) return;

			// Palette toggle works everywhere, including inside text inputs.
			if (isPaletteToggle(event, isMac)) {
				event.preventDefault();
				commandPaletteOpenSignal.value = !commandPaletteOpenSignal.value;
				return;
			}

			// Don't intercept other shortcuts while the user is typing.
			if (isTextEditingTarget(event.target)) return;

			const cmd = commandRegistry.findByShortcut(event);
			if (!cmd) return;
			event.preventDefault();
			void (async () => {
				try {
					await cmd.run();
				} catch (err) {
					// Surface to toast so users see the failure; swallow to keep the
					// boundary safe even if toast itself throws.
					try {
						const { toast } = await import('../lib/toast.ts');
						toast.error(err instanceof Error ? err.message : `Command "${cmd.label}" failed`);
					} catch {
						// ignore
					}
				}
			})();
		};

		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);
}
