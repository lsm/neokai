/**
 * useNeoKeyboardShortcut
 *
 * Registers a global Cmd+J / Ctrl+J keyboard shortcut that toggles the Neo panel.
 * Guards against firing when the user is focused in an input, textarea, or
 * contentEditable element so it does not interfere with text editing.
 *
 * Note: Cmd+J is Firefox's Downloads shortcut. preventDefault() overrides this
 * within the app tab, which is acceptable since NeoKai is a dedicated web app.
 */

import { useEffect } from 'preact/hooks';
import { neoStore } from '../lib/neo-store.ts';

export function useNeoKeyboardShortcut(): void {
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key !== 'j') return;

			const target = e.target as HTMLElement;
			const tag = target.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;

			e.preventDefault();
			neoStore.togglePanel();
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);
}
