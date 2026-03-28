/**
 * NeoNavButton
 *
 * Icon button for the NavRail that toggles the Neo slide-out panel.
 * Uses a sparkle icon, shows active state when the panel is open,
 * and has a tooltip "Neo (⌘J)".
 */

import { useComputed } from '@preact/signals';
import { neoStore } from '../../lib/neo-store.ts';
import { NavIconButton } from '../ui/NavIconButton.tsx';

/** Sparkle SVG icon — same visual language as ViaNeoIndicator */
function SparkleIcon() {
	return (
		<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 2l2.09 6.41L20.5 10l-6.41 2.09L12 18.5l-2.09-6.41L4 10l6.41-2.09L12 2z" />
			<path d="M5 3l.75 2.25L8 6l-2.25.75L5 9l-.75-2.25L2 6l2.25-.75L5 3z" opacity={0.5} />
			<path d="M19 15l.6 1.8L21.4 17l-1.8.6L19 19.4l-.6-1.8L16.6 17l1.8-.6L19 15z" opacity={0.5} />
		</svg>
	);
}

interface NeoNavButtonProps {
	/** Called after the panel toggle so the panel can auto-focus its input */
	onOpen?: () => void;
}

export function NeoNavButton({ onOpen }: NeoNavButtonProps) {
	const isOpen = useComputed(() => neoStore.panelOpen.value);

	const handleClick = () => {
		const wasOpen = isOpen.value;
		neoStore.togglePanel();
		if (!wasOpen) {
			// Panel is now open — notify caller to focus the input
			onOpen?.();
		}
	};

	return (
		<NavIconButton active={isOpen.value} onClick={handleClick} label="Neo (⌘J)">
			<SparkleIcon />
		</NavIconButton>
	);
}
