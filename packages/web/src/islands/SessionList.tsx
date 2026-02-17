import { useState, useEffect } from 'preact/hooks';
import { navigateToSession } from '../lib/router.ts';
import { sessions, hasArchivedSessions, globalSettings } from '../lib/state.ts';
import { updateGlobalSettings } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import SessionListItem from '../components/SessionListItem.tsx';

const SESSIONS_PER_PAGE = 20;

interface SessionListProps {
	/** Called when a session is selected (for mobile drawer close) */
	onSessionSelect?: () => void;
}

export function SessionList({ onSessionSelect }: SessionListProps) {
	const [visibleCount, setVisibleCount] = useState(SESSIONS_PER_PAGE);

	const sessionsList = sessions.value;
	const showArchived = globalSettings.value?.showArchived ?? false;

	// Pagination
	const visibleSessions = sessionsList.slice(0, visibleCount);
	const hasMore = sessionsList.length > visibleCount;

	// Reset visible count when archive filter changes
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

	return (
		<>
			{/* Archived Sessions Toggle - only show if there are any archived sessions */}
			{hasArchivedSessions.value && (
				<div class="px-4 py-2 border-b border-dark-700">
					<button
						type="button"
						onClick={handleToggleShowArchived}
						class="text-xs text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-2 w-full"
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

			{/* Session List */}
			<div class="flex-1 overflow-y-auto">
				{sessionsList.length === 0 && (
					<div class="p-6 text-center">
						<div class="text-4xl mb-3">💬</div>
						<p class="text-sm text-gray-400">No sessions yet.</p>
						<p class="text-xs text-gray-500 mt-1">Create one to get started!</p>
					</div>
				)}

				{visibleSessions.map((session) => (
					<SessionListItem key={session.id} session={session} onSessionClick={handleSessionClick} />
				))}

				{/* Load More Button */}
				{hasMore && (
					<div class="p-4">
						<button
							type="button"
							onClick={handleLoadMore}
							class="w-full py-2 px-4 text-sm text-gray-400 hover:text-gray-200 hover:bg-dark-800 rounded-lg transition-colors border border-dark-700 hover:border-dark-600"
						>
							Load More ({sessionsList.length - visibleCount} remaining)
						</button>
					</div>
				)}
			</div>
		</>
	);
}
