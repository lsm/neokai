/**
 * SpaceSessionsPage — lists all user-created sessions for a space.
 *
 * Excludes system sessions (task worker sessions, workflow sessions).
 * Sessions can be clicked to navigate into them.
 */

import { useMemo } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceSession } from '../../lib/router';
import { getRelativeTime, cn } from '../../lib/utils';

const SESSION_STATUS_COLORS: Record<string, string> = {
	active: 'bg-green-500',
	pending_worktree_choice: 'bg-amber-500',
	paused: 'bg-amber-500',
	ended: 'bg-gray-500',
};

interface SpaceSessionsPageProps {
	spaceId: string;
}

export function SpaceSessionsPage({ spaceId }: SpaceSessionsPageProps) {
	const storeSessions = spaceStore.sessions.value;

	const sessions = useMemo(() => {
		const isSystemSpaceSession = (sessionId: string): boolean =>
			sessionId.startsWith(`space:${spaceId}:task:`) ||
			sessionId.startsWith(`space:${spaceId}:workflow:`);

		return [...storeSessions]
			.filter((s) => !isSystemSpaceSession(s.id))
			.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
	}, [storeSessions, spaceId]);

	if (sessions.length === 0) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<div class="text-center">
					<p class="text-sm text-gray-500">No sessions yet</p>
					<p class="text-xs text-gray-600 mt-1">
						Sessions will appear here when created in this space.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 overflow-y-auto">
			<div class="divide-y divide-dark-800">
				{sessions.map((session) => (
					<button
						key={session.id}
						onClick={() => navigateToSpaceSession(spaceId, session.id)}
						class={cn(
							'w-full px-4 py-3 flex items-center gap-3 transition-colors text-left hover:bg-dark-800'
						)}
					>
						<div
							class={cn(
								'w-2 h-2 rounded-full flex-shrink-0 mt-0.5',
								SESSION_STATUS_COLORS[session.status] ?? 'bg-gray-500'
							)}
						/>
						<div class="flex-1 min-w-0">
							<div class="text-sm text-gray-200 truncate">{session.title || session.id}</div>
							<div class="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
								<span class="capitalize">{session.status.replace(/_/g, ' ')}</span>
								{session.lastActiveAt && (
									<>
										<span>·</span>
										<span>{getRelativeTime(session.lastActiveAt)}</span>
									</>
								)}
							</div>
						</div>
					</button>
				))}
			</div>
		</div>
	);
}
