/**
 * RoomSessions Component
 *
 * Displays list of sessions associated with the room.
 * Clicking a session navigates to the session view.
 */

import type { SessionSummary } from '@neokai/shared';
import { navigateToSession } from '../../lib/router';

interface RoomSessionsProps {
	sessions: SessionSummary[];
}

export function RoomSessions({ sessions }: RoomSessionsProps) {
	if (sessions.length === 0) {
		return (
			<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
				<p class="text-gray-400">No sessions in this room</p>
				<p class="text-sm text-gray-500 mt-1">Ask Neo to create one</p>
			</div>
		);
	}

	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
			<div class="px-4 py-3 border-b border-dark-700">
				<h3 class="font-semibold text-gray-100">Sessions</h3>
			</div>
			<div class="divide-y divide-dark-700">
				{sessions.map((session) => (
					<button
						key={session.id}
						type="button"
						onClick={() => navigateToSession(session.id)}
						class="w-full px-4 py-3 flex items-center justify-between hover:bg-dark-800 transition-colors"
					>
						<div class="flex items-center gap-3">
							<StatusIndicator status={session.status} />
							<span class="text-gray-100 truncate">{session.title || session.id.slice(0, 8)}</span>
						</div>
						<span class="text-xs text-gray-500">
							{session.lastActiveAt ? formatRelativeTime(session.lastActiveAt) : 'Unknown'}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

function StatusIndicator({ status }: { status: string }) {
	const colors: Record<string, string> = {
		idle: 'bg-gray-500',
		active: 'bg-green-500',
		processing: 'bg-blue-500',
		waiting: 'bg-yellow-500',
		error: 'bg-red-500',
		archived: 'bg-gray-600',
	};
	return <div class={`w-2 h-2 rounded-full ${colors[status] || colors.idle}`} />;
}

function formatRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return 'Just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}
