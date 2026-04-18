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

	// Swipe-to-close: dragging the panel rightward dismisses it. We also
	// call preventDefault on horizontal touchmove so the browser's native
	// swipe-back gesture (which navigates the underlying page) is suppressed
	// while the user is clearly swiping the overlay away.
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;

		let startX = 0;
		let startY = 0;
		let dragging = false;
		let currentDx = 0;

		const CLOSE_THRESHOLD = 80; // px right to commit close

		const onTouchStart = (e: TouchEvent) => {
			const t = e.touches[0];
			startX = t.clientX;
			startY = t.clientY;
			currentDx = 0;
			dragging = true;
			// Remove transition so drag follows finger immediately
			panel.style.transition = 'none';
		};

		const onTouchMove = (e: TouchEvent) => {
			if (!dragging) return;
			const t = e.touches[0];
			const dx = t.clientX - startX;
			const dy = t.clientY - startY;

			// Only track right-ward swipes that are more horizontal than vertical
			if (dx > 0 && Math.abs(dx) > Math.abs(dy)) {
				currentDx = dx;
				panel.style.transform = `translateX(${dx}px)`;
				// Block the browser back-gesture and underlying scroll
				e.preventDefault();
			}
		};

		const finish = () => {
			if (!dragging) return;
			dragging = false;
			if (currentDx > CLOSE_THRESHOLD) {
				// Slide off-screen then close
				panel.style.transition = 'transform 200ms ease-out';
				panel.style.transform = 'translateX(100%)';
				setTimeout(onClose, 200);
			} else {
				// Spring back to original position
				panel.style.transition = 'transform 200ms ease-out';
				panel.style.transform = '';
				// Clean up inline style after animation
				const tid = setTimeout(() => {
					panel.style.transition = '';
					panel.style.transform = '';
				}, 200);
				return () => clearTimeout(tid);
			}
			currentDx = 0;
		};

		panel.addEventListener('touchstart', onTouchStart, { passive: true });
		// passive: false so we can call preventDefault to suppress browser back gesture
		panel.addEventListener('touchmove', onTouchMove, { passive: false });
		panel.addEventListener('touchend', finish, { passive: true });
		panel.addEventListener('touchcancel', finish, { passive: true });

		return () => {
			panel.removeEventListener('touchstart', onTouchStart);
			panel.removeEventListener('touchmove', onTouchMove);
			panel.removeEventListener('touchend', finish);
			panel.removeEventListener('touchcancel', finish);
		};
	}, [onClose]);

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
