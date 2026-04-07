/**
 * AgentOverlayChat — slide-over panel that renders a ChatContainer on top of
 * the current view without replacing it.
 *
 * Triggered by spaceOverlaySessionIdSignal.  Closes when the user clicks the
 * backdrop, the ✕ button, or presses Escape.
 */

import { useEffect, useRef } from 'preact/hooks';
import { Portal } from '../ui/Portal';
import { setupFocusTrap } from '../ui/Modal';
import ChatContainer from '../../islands/ChatContainer';
import { cn } from '../../lib/utils';

interface AgentOverlayChatProps {
	/** Session ID to display inside the overlay. */
	sessionId: string;
	/** Human-readable label shown in the header (e.g. agent name or session short-ID). */
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
					{/* Header */}
					<div class="flex items-center gap-3 px-4 py-3 border-b border-dark-700 flex-shrink-0 bg-dark-900">
						<div class="flex-1 min-w-0">
							<p
								class="text-sm font-medium text-gray-200 truncate"
								data-testid="agent-overlay-name"
							>
								{agentName ?? sessionId.slice(0, 8)}
							</p>
							<p class="text-xs text-gray-500 truncate">{sessionId}</p>
						</div>
						<button
							type="button"
							onClick={onClose}
							class="flex-shrink-0 p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-dark-700 transition-colors"
							aria-label="Close overlay"
							data-testid="agent-overlay-close"
						>
							<svg
								class="w-4 h-4"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								stroke-width={2}
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</div>

					{/* Chat content */}
					<div class="flex-1 min-h-0 overflow-hidden flex flex-col">
						<ChatContainer key={sessionId} sessionId={sessionId} />
					</div>
				</div>
			</div>
		</Portal>
	);
}
