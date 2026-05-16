/**
 * ChatHeader Component
 *
 * Header section for the chat container with session title, stats, and action menu.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 *
 * Unified Session Architecture:
 * - Features prop controls visibility of UI elements (sessionInfo, archive, etc.)
 * - Space sessions hide features that aren't applicable
 */

import type { Session, SessionFeatures } from '@neokai/shared';
import { DEFAULT_WORKER_FEATURES } from '@neokai/shared';
import { connectionState } from '../lib/state';
import { cn } from '../lib/utils';
import { IconButton } from './ui/IconButton';
import { Dropdown } from './ui/Dropdown';
import { MobileMenuButton } from './ui/MobileMenuButton';

export interface ChatHeaderProps {
	session: Session | null;
	features?: SessionFeatures;
	onToolsClick: () => void;
	onInfoClick: () => void;
	onExportClick: () => void;
	onResetClick: () => void;
	onArchiveClick: () => void;
	onDeleteClick: () => void;
	onGitPanelToggle?: () => void;
	archiving?: boolean;
	resettingAgent?: boolean;
	readonly?: boolean;
	gitPanelOpen?: boolean;
	/**
	 * When provided, renders a left-arrow back button in the header's left
	 * slot (replacing the `MobileMenuButton`) that invokes this callback on
	 * click. Used when `ChatContainer` is embedded in a slide-over overlay
	 * (e.g. `AgentOverlayChat`) so the user can dismiss it without the
	 * redundant wrapper header chrome. When omitted, the header falls back to
	 * the default `MobileMenuButton` which toggles the context panel.
	 */
	onBack?: () => void;
}

export function ChatHeader({
	session,
	features = DEFAULT_WORKER_FEATURES,
	onToolsClick,
	onInfoClick,
	onExportClick,
	onResetClick,
	onArchiveClick,
	onDeleteClick,
	onGitPanelToggle,
	archiving = false,
	resettingAgent = false,
	readonly = false,
	gitPanelOpen = false,
	onBack,
}: ChatHeaderProps) {
	const isConnected = connectionState.value === 'connected';

	const getHeaderActions = () => {
		const actions: Array<
			| {
					label: string;
					onClick: () => void;
					icon: preact.JSX.Element;
					disabled?: boolean;
					danger?: boolean;
			  }
			| { type: 'divider' }
		> = [];

		// Tools - available unless readonly
		if (!readonly) {
			actions.push({
				label: 'Tools',
				onClick: onToolsClick,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
						/>
					</svg>
				),
			});
		}

		// Session Info - conditional based on features
		if (features.sessionInfo) {
			actions.push({
				label: 'Session Info',
				onClick: onInfoClick,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				),
			});
		}

		// Export - always available
		actions.push({
			label: 'Export Chat',
			onClick: onExportClick,
			disabled: !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
					/>
				</svg>
			),
		});

		// Reset Agent - always available
		actions.push({
			label: resettingAgent ? 'Resetting...' : 'Reset Agent',
			onClick: onResetClick,
			disabled: resettingAgent || !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
					/>
				</svg>
			),
		});

		// Archive/Delete section - conditional based on features
		if (features.archive) {
			actions.push({ type: 'divider' as const });
			actions.push({
				label: 'Archive Session',
				onClick: onArchiveClick,
				disabled: archiving || session?.status === 'archived' || !isConnected,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
						/>
					</svg>
				),
			});
			actions.push({
				label: 'Delete Chat',
				onClick: onDeleteClick,
				danger: true,
				disabled: !isConnected,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
						/>
					</svg>
				),
			});
		}

		return actions;
	};

	return (
		<div class="flex-shrink-0 bg-dark-900 px-4 h-[65px] flex items-center relative z-10">
			<div class="flex-1 min-w-0 flex items-center gap-3">
				{onBack ? (
					<button
						type="button"
						onClick={onBack}
						class="flex-shrink-0 p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-dark-700 transition-colors focus:outline-none focus:ring-1 focus:ring-gray-600"
						aria-label="Back"
						data-testid="chat-header-back"
					>
						<svg
							class="w-5 h-5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width={2}
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
						</svg>
					</button>
				) : (
					<MobileMenuButton />
				)}

				{/* Session title */}
				<h2
					data-testid="chat-header-title"
					class="flex-1 min-w-0 text-sm font-semibold text-gray-100 truncate"
				>
					{session?.title || 'New Session'}
				</h2>

				{onGitPanelToggle && (
					<IconButton
						title={gitPanelOpen ? 'Hide Git panel' : 'Show Git panel'}
						onClick={onGitPanelToggle}
						class={cn('hidden lg:inline-flex', gitPanelOpen && 'bg-white/10 text-gray-100')}
					>
						<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={1.8}
								d="M6 3v7m0 0a3 3 0 100-6 3 3 0 000 6zm0 0v11m12-7V3m0 11a3 3 0 100-6 3 3 0 000 6zm0 0v7"
							/>
						</svg>
					</IconButton>
				)}

				{/* Options dropdown */}
				<Dropdown
					trigger={
						<IconButton
							title={!isConnected ? 'Not connected' : 'Session options'}
							disabled={!isConnected}
						>
							<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
								<path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
							</svg>
						</IconButton>
					}
					items={getHeaderActions()}
				/>
			</div>
		</div>
	);
}
