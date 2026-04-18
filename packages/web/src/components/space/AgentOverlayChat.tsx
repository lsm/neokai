/**
 * AgentOverlayChat — slide-over panel that renders a ChatContainer on top of
 * the current view without replacing it.
 *
 * Triggered by `spaceOverlaySessionIdSignal`. The embedded `ChatContainer`
 * owns the only header; its left-slot back button (opted in via `onBack`)
 * doubles as the overlay dismiss control. Escape and backdrop-click also
 * dismiss for consistency with other modals.
 */

import { useEffect, useRef } from 'preact/hooks';
import { Portal } from '../ui/Portal';
import { setupFocusTrap } from '../ui/Modal';
import ChatContainer from '../../islands/ChatContainer';
import { cn } from '../../lib/utils';

interface AgentOverlayChatProps {
	/** Session ID to display inside the overlay. */
	sessionId: string;
	/**
	 * Human-readable label for the agent (e.g. "Task Agent"). Used only on the
	 * wrapper dialog's aria-label so screen readers identify which agent is
	 * open; the visible title comes from `ChatContainer`'s session title.
	 */
	agentName?: string;
	/** Called when the overlay should be closed. */
	onClose: () => void;
}

export function AgentOverlayChat({ sessionId, agentName, onClose }: AgentOverlayChatProps) {
	const panelRef = useRef<HTMLDivElement>(null);

	// Close on Escape key
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	}, [onClose]);

	// Focus trap — keep keyboard focus inside the panel while it is open
	useEffect(() => {
		if (panelRef.current) {
			return setupFocusTrap(panelRef.current);
		}
	}, []);

	return (
		<Portal into="body">
			{/* Full-screen wrapper — backdrop on the left, panel on the right */}
			<div
				class="fixed inset-0 z-50 flex justify-end"
				data-testid="agent-overlay-chat"
				aria-modal="true"
				role="dialog"
				aria-label={agentName ? `${agentName} chat` : 'Agent chat'}
			>
				{/* Translucent backdrop — click to dismiss */}
				<div
					class="absolute inset-0 bg-black/40 backdrop-blur-[1px] cursor-pointer"
					onClick={onClose}
					aria-hidden="true"
				/>

				{/* Slide-over panel */}
				<div
					ref={panelRef}
					class={cn(
						'relative flex flex-col h-full w-full max-w-2xl bg-dark-900 shadow-2xl',
						'border-l border-dark-700',
						'animate-slideInRight'
					)}
				>
					{/* Chat content — ChatHeader owns the single header; back button replaces the mobile-menu toggle */}
					<div class="flex-1 min-h-0 overflow-hidden flex flex-col">
						<ChatContainer key={sessionId} sessionId={sessionId} onBack={onClose} />
					</div>
				</div>
			</div>
		</Portal>
	);
}
