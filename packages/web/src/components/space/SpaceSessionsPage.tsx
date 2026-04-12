/**
 * SpaceSessionsPage — lists all user-created sessions for a space.
 *
 * Sessions are grouped by status in cards matching the SpaceTasks style.
 * Excludes system sessions (task worker sessions, workflow sessions).
 */

import { useMemo } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceSession } from '../../lib/router';
import { getRelativeTime } from '../../lib/utils';

const STATUS_BORDER: Record<string, string> = {
	active: 'border-l-green-500',
	paused: 'border-l-amber-500',
	pending_worktree_choice: 'border-l-amber-500',
	ended: 'border-l-gray-600',
};

const STATUS_LABEL: Record<string, string> = {
	active: 'Active',
	paused: 'Paused',
	pending_worktree_choice: 'Pending',
	ended: 'Ended',
};

interface StatusGroupDef {
	statuses: string[];
	title: string;
	variant: 'green' | 'yellow' | 'gray';
}

const SESSION_GROUPS: StatusGroupDef[] = [
	{ statuses: ['active'], title: 'Active', variant: 'green' },
	{ statuses: ['paused', 'pending_worktree_choice'], title: 'Paused', variant: 'yellow' },
	{ statuses: ['ended'], title: 'Ended', variant: 'gray' },
];

function SessionGroup({
	title,
	count,
	variant,
	sessions,
	spaceId,
}: {
	title: string;
	count: number;
	variant: 'green' | 'yellow' | 'gray';
	sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
	spaceId: string;
}) {
	const headerStyles: Record<string, string> = {
		green: 'bg-green-900/20',
		yellow: 'bg-yellow-900/20',
		gray: 'bg-dark-800',
	};

	const titleStyles: Record<string, string> = {
		green: 'text-green-400',
		yellow: 'text-yellow-400',
		gray: 'text-gray-500',
	};

	const borderStyles: Record<string, string> = {
		green: 'border-dark-700',
		yellow: 'border-dark-700',
		gray: 'border-dark-700',
	};

	return (
		<div class={`bg-dark-850 border rounded-xl overflow-hidden ${borderStyles[variant]}`}>
			<div
				class={`px-4 py-3 border-b ${borderStyles[variant]} ${headerStyles[variant]} flex items-center gap-1`}
			>
				<h3 class={`font-semibold ${titleStyles[variant]}`}>
					{title} ({count})
				</h3>
			</div>
			<div class="divide-y divide-dark-700">
				{sessions.map((session) => (
					<SessionItem key={session.id} session={session} spaceId={spaceId} />
				))}
			</div>
		</div>
	);
}

function SessionItem({
	session,
	spaceId,
}: {
	session: { id: string; title: string; status: string; lastActiveAt: number };
	spaceId: string;
}) {
	const borderColor = STATUS_BORDER[session.status] ?? 'border-l-transparent';

	return (
		<div
			class={`px-4 py-3 border-l-2 ${borderColor} cursor-pointer hover:bg-dark-800/50 transition-colors`}
			onClick={() => navigateToSpaceSession(spaceId, session.id)}
		>
			<div class="flex items-start justify-between">
				<div class="flex-1 min-w-0">
					<h4 class="text-sm font-medium text-gray-100 truncate">{session.title || session.id}</h4>
					<div class="flex items-center gap-2 mt-1">
						<span class="text-xs text-gray-500">
							{STATUS_LABEL[session.status] ?? session.status}
						</span>
						{session.lastActiveAt > 0 && (
							<span class="text-xs text-gray-600">{getRelativeTime(session.lastActiveAt)}</span>
						)}
					</div>
				</div>
				<div class="ml-4 flex items-center flex-shrink-0">
					<span class="text-xs text-gray-600">&rarr;</span>
				</div>
			</div>
		</div>
	);
}

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
			<div class="w-full px-8 flex flex-col items-center justify-center py-16 text-center">
				<svg
					class="w-10 h-10 text-gray-700 mb-3"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={1.5}
						d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
					/>
				</svg>
				<p class="text-sm text-gray-400 font-medium">No sessions yet</p>
				<p class="text-xs text-gray-600 mt-1">Sessions will appear here when created</p>
			</div>
		);
	}

	return (
		<div class="flex-1 min-h-0 w-full px-4 py-4 sm:px-8 sm:py-6 overflow-y-auto">
			<div class="min-h-[calc(100%+1px)] space-y-4">
				{SESSION_GROUPS.map((group) => {
					const groupSessions = sessions.filter((s) => group.statuses.includes(s.status));
					if (groupSessions.length === 0) return null;
					return (
						<SessionGroup
							key={group.title}
							title={group.title}
							count={groupSessions.length}
							variant={group.variant}
							sessions={groupSessions}
							spaceId={spaceId}
						/>
					);
				})}
			</div>
		</div>
	);
}
