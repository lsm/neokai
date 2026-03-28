/**
 * NeoPanel
 *
 * Global slide-out panel for the Neo AI assistant.
 * - Slides in from the left, overlapping other content
 * - Header with "Neo" title, Chat / Activity tab switcher, close button
 * - Controlled by neoStore.panelOpen signal
 * - Subscribes to neo.messages and neo.activity LiveQueries on mount
 * - Click-outside-to-dismiss (backdrop click)
 * - Escape key closes
 * - Smooth 300ms CSS transition
 */

import { useEffect, useRef } from 'preact/hooks';
import { neoStore, type NeoActiveTab } from '../../lib/neo-store.ts';
import { NeoChatView } from './NeoChatView.tsx';
import { NeoActivityView } from './NeoActivityView.tsx';

// ---------------------------------------------------------------------------
// Sparkle icon (matches NeoNavButton)
// ---------------------------------------------------------------------------

function SparkleIcon() {
	return (
		<svg class="w-4 h-4 text-violet-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 2l2.09 6.41L20.5 10l-6.41 2.09L12 18.5l-2.09-6.41L4 10l6.41-2.09L12 2z" />
			<path d="M5 3l.75 2.25L8 6l-2.25.75L5 9l-.75-2.25L2 6l2.25-.75L5 3z" opacity={0.5} />
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

interface TabButtonProps {
	tab: NeoActiveTab;
	activeTab: NeoActiveTab;
	label: string;
	onSelect: (tab: NeoActiveTab) => void;
}

function TabButton({ tab, activeTab, label, onSelect }: TabButtonProps) {
	const isActive = activeTab === tab;
	return (
		<button
			type="button"
			onClick={() => onSelect(tab)}
			data-testid={`neo-tab-${tab}`}
			aria-selected={isActive}
			class={[
				'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
				isActive
					? 'bg-violet-500/20 text-violet-300'
					: 'text-gray-500 hover:text-gray-300 hover:bg-white/5',
			].join(' ')}
		>
			{label}
		</button>
	);
}

// ---------------------------------------------------------------------------
// NeoPanel
// ---------------------------------------------------------------------------

export function NeoPanel() {
	const isOpen = neoStore.panelOpen.value;
	const activeTab = neoStore.activeTab.value;

	const panelRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const triggerRef = useRef<Element | null>(null);

	// Subscribe to LiveQuery on mount; unsubscribe on unmount
	useEffect(() => {
		neoStore.subscribe().catch(() => {
			// Error is captured in neoStore.error signal — no action needed here
		});
		return () => {
			neoStore.unsubscribe();
		};
	}, []);

	// Focus management
	useEffect(() => {
		if (isOpen) {
			triggerRef.current = document.activeElement;
			requestAnimationFrame(() => {
				closeButtonRef.current?.focus();
			});
		} else {
			if (triggerRef.current instanceof HTMLElement) {
				triggerRef.current.focus();
			}
			triggerRef.current = null;
		}
	}, [isOpen]);

	// Escape key closes panel; focus trap
	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				neoStore.closePanel();
				return;
			}
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
	}, [isOpen]);

	const handleTabSelect = (tab: NeoActiveTab) => {
		neoStore.activeTab.value = tab;
	};

	return (
		<>
			{/* Backdrop */}
			<div
				data-testid="neo-panel-backdrop"
				class={[
					'fixed inset-0 bg-black/40 z-40 transition-opacity duration-300',
					isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
				].join(' ')}
				onClick={() => neoStore.closePanel()}
				aria-hidden="true"
			/>

			{/* Panel */}
			<div
				ref={panelRef}
				data-testid="neo-panel"
				role="dialog"
				aria-modal="true"
				aria-label="Neo AI assistant"
				class={[
					'fixed top-0 left-0 h-dvh pt-safe z-50',
					'w-full sm:w-80 md:w-96',
					'flex flex-col',
					'bg-gray-900 border-r border-gray-700 shadow-2xl',
					'transition-transform duration-300',
					isOpen ? 'translate-x-0' : '-translate-x-full',
				].join(' ')}
			>
				{/* Header */}
				<div
					data-testid="neo-panel-header"
					class="flex-shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-gray-700"
				>
					{/* Title */}
					<div class="flex items-center gap-2">
						<SparkleIcon />
						<span class="text-sm font-semibold text-gray-100">Neo</span>
					</div>

					{/* Tab switcher */}
					<div class="flex items-center gap-1" role="tablist" aria-label="Neo panel tabs">
						<TabButton tab="chat" activeTab={activeTab} label="Chat" onSelect={handleTabSelect} />
						<TabButton
							tab="activity"
							activeTab={activeTab}
							label="Activity"
							onSelect={handleTabSelect}
						/>
					</div>

					{/* Close button */}
					<button
						ref={closeButtonRef}
						data-testid="neo-panel-close"
						onClick={() => neoStore.closePanel()}
						class="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
						aria-label="Close Neo panel"
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
				<div
					class="flex-1 min-h-0"
					role="tabpanel"
					aria-label={activeTab === 'chat' ? 'Chat' : 'Activity'}
				>
					{activeTab === 'chat' ? <NeoChatView /> : <NeoActivityView />}
				</div>
			</div>
		</>
	);
}
