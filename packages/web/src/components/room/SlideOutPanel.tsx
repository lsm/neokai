/**
 * SlideOutPanel
 *
 * A right-side slide-out panel absolutely positioned within the task view
 * container. Mounts ReadonlySessionChat when open. Does NOT use sessionStore.
 */

import { useEffect, useRef } from 'preact/hooks';
import { ROLE_COLORS } from '../../lib/role-colors';
import { ReadonlySessionChat } from './ReadonlySessionChat';

interface Props {
	isOpen: boolean;
	sessionId: string | null;
	agentLabel?: string;
	agentRole?: string;
	onClose: () => void;
	widthClass?: string;
}

export function SlideOutPanel({
	isOpen,
	sessionId,
	agentLabel,
	agentRole,
	onClose,
	widthClass = 'w-full sm:w-1/2',
}: Props) {
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	// Track the element that opened the panel so focus can be restored on close
	const triggerElementRef = useRef<Element | null>(null);

	// Save trigger element when opening; restore focus when closing
	useEffect(() => {
		if (isOpen) {
			triggerElementRef.current = document.activeElement;
			// Move focus to close button when panel opens
			requestAnimationFrame(() => {
				closeButtonRef.current?.focus();
			});
		} else {
			// Restore focus to trigger element
			if (triggerElementRef.current instanceof HTMLElement) {
				triggerElementRef.current.focus();
			}
			triggerElementRef.current = null;
		}
	}, [isOpen]);

	// Escape key closes panel
	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
			// Focus trap: keep Tab within panel
			if (e.key === 'Tab' && panelRef.current) {
				const focusable = panelRef.current.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				);
				if (focusable.length === 0) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (e.shiftKey) {
					if (document.activeElement === first) {
						e.preventDefault();
						last.focus();
					}
				} else {
					if (document.activeElement === last) {
						e.preventDefault();
						first.focus();
					}
				}
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, onClose]);

	const labelColor = agentRole
		? (ROLE_COLORS[agentRole]?.labelColor ?? 'text-gray-300')
		: 'text-gray-300';
	const displayLabel = agentLabel ?? agentRole ?? 'Session';

	return (
		<>
			{/* Backdrop */}
			<div
				data-testid="slide-out-backdrop"
				class={[
					'fixed inset-0 bg-black/40 z-40 transition-opacity duration-300',
					isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
				].join(' ')}
				onClick={onClose}
				aria-hidden="true"
			/>

			{/* Panel */}
			<div
				ref={panelRef}
				data-testid="slide-out-panel"
				role="dialog"
				aria-modal="true"
				aria-label={`Session chat for ${displayLabel}`}
				class={[
					'fixed top-0 right-0 h-screen z-50',
					widthClass,
					'flex flex-col',
					'bg-gray-900 border-l border-gray-700 shadow-2xl',
					'transition-transform duration-300',
					isOpen ? 'translate-x-0' : 'translate-x-full',
				].join(' ')}
			>
				{/* Header */}
				<div
					data-testid="slide-out-panel-header"
					class="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-700"
				>
					<span class={`text-sm font-semibold ${labelColor}`}>{displayLabel}</span>
					<button
						ref={closeButtonRef}
						data-testid="slide-out-panel-close"
						onClick={onClose}
						class="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
						aria-label="Close panel"
					>
						<svg
							class="w-4 h-4"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				{/* Body */}
				<div class="flex-1 min-h-0">
					{isOpen && sessionId ? (
						<ReadonlySessionChat sessionId={sessionId} />
					) : (
						<div class="flex items-center justify-center h-full text-gray-500 text-sm">
							No session selected
						</div>
					)}
				</div>
			</div>
		</>
	);
}
