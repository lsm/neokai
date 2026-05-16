import { useState, useEffect } from 'preact/hooks';
import { navigateToSession } from '../lib/router.ts';
import {
	sessions,
	hasArchivedSessions,
	globalSettings,
	connectionState,
	authStatus,
} from '../lib/state.ts';
import { updateGlobalSettings, createSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { isUserSession } from '../lib/session-utils.ts';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import SessionListItem from '../components/SessionListItem.tsx';

const SESSIONS_PER_PAGE = 20;

interface SessionsSidebarProps {
	/** Called when a session is selected (for mobile drawer close). */
	onSessionSelect?: () => void;
	/** Called from the mobile-only close affordance. */
	onClose?: () => void;
}

/**
 * Codex-style chats sidebar: a borderless "New chat" row on top, followed by a
 * scrollable flat list of sessions. Projects grouping is layered on in a later step.
 */
export function SessionsSidebar({ onSessionSelect, onClose }: SessionsSidebarProps) {
	const [visibleCount, setVisibleCount] = useState(SESSIONS_PER_PAGE);
	const [creating, setCreating] = useState(false);

	// Only show user-created sessions (not internal orchestration agents).
	const sessionsList = sessions.value.filter(isUserSession);
	const showArchived = globalSettings.value?.showArchived ?? false;

	const visibleSessions = sessionsList.slice(0, visibleCount);
	const hasMore = sessionsList.length > visibleCount;
	const remaining = sessionsList.length - visibleCount;

	const canCreate =
		connectionState.value === 'connected' && (authStatus.value?.isAuthenticated ?? false);

	// Reset pagination when the archive filter changes.
	useEffect(() => {
		setVisibleCount(SESSIONS_PER_PAGE);
	}, [showArchived]);

	const handleSessionClick = (sessionId: string) => {
		navigateToSession(sessionId);
		onSessionSelect?.();
	};

	const handleLoadMore = () => {
		setVisibleCount((prev) => prev + SESSIONS_PER_PAGE);
	};

	const handleToggleShowArchived = async () => {
		try {
			await updateGlobalSettings({ showArchived: !showArchived });
		} catch {
			toast.error('Failed to toggle archived sessions visibility');
		}
	};

	const handleNewChat = async () => {
		if (!canCreate) {
			toast.error('Not connected to server. Please wait...');
			return;
		}
		setCreating(true);
		try {
			const response = await createSession({ workspacePath: undefined });
			if (!response?.sessionId) {
				toast.error('No sessionId in response');
				return;
			}
			navigateToSession(response.sessionId);
			onSessionSelect?.();
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Connection lost. Please try again.');
			} else {
				toast.error(err instanceof Error ? err.message : 'Failed to create session');
			}
		} finally {
			setCreating(false);
		}
	};

	return (
		<div class="flex flex-col h-full">
			{/* Top: mobile close + New chat */}
			<div class="p-2">
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						class="md:hidden mb-1 ml-auto flex p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-dark-850 transition-colors"
						title="Close panel"
						aria-label="Close panel"
					>
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				)}
				<button
					type="button"
					data-testid="new-chat-button"
					onClick={handleNewChat}
					disabled={creating || !canCreate}
					class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-gray-200 hover:bg-dark-850 hover:text-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
				>
					<svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
						/>
					</svg>
					<span>New chat</span>
				</button>
			</div>

			{/* Session list */}
			<div class="flex-1 overflow-y-auto px-2 pb-2">
				{sessionsList.length === 0 ? (
					<div class="px-2 py-10 text-center">
						<p class="text-sm text-gray-500">No chats yet</p>
						<p class="text-xs text-gray-600 mt-1">Start a new chat to begin.</p>
					</div>
				) : (
					<div class="flex flex-col gap-0.5">
						{visibleSessions.map((session) => (
							<SessionListItem
								key={session.id}
								session={session}
								onSessionClick={handleSessionClick}
							/>
						))}
						{hasMore && (
							<button
								type="button"
								onClick={handleLoadMore}
								class="w-full mt-1 px-2.5 py-1.5 text-xs text-left text-gray-500 hover:text-gray-300 hover:bg-dark-850 rounded-lg transition-colors"
							>
								Show {remaining} more
							</button>
						)}
					</div>
				)}
			</div>

			{/* Archived sessions toggle — only when archived sessions exist */}
			{hasArchivedSessions.value && (
				<div class="p-2">
					<button
						type="button"
						onClick={handleToggleShowArchived}
						class="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-dark-850 rounded-lg transition-colors"
					>
						<svg
							class={`w-3 h-3 transition-transform ${showArchived ? 'rotate-90' : ''}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9 5l7 7-7 7"
							/>
						</svg>
						<span>{showArchived ? 'Hide archived' : 'Show archived'}</span>
					</button>
				</div>
			)}
		</div>
	);
}
