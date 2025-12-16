import type { Session } from '@liuboer/shared';
import { currentSessionIdSignal } from '../lib/signals.ts';
import { formatRelativeTime } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';

interface SessionListItemProps {
	session: Session;
	onSessionClick: (sessionId: string) => void;
}

/**
 * Individual session list item component
 * Separated to minimize re-renders - only the active state changes, not the entire list
 */
export default function SessionListItem({ session, onSessionClick }: SessionListItemProps) {
	// Each item subscribes to currentSessionId independently
	// This way, only the styling updates, not the DOM structure
	const isActive = currentSessionIdSignal.value === session.id;

	return (
		<button
			key={session.id}
			type="button"
			data-testid="session-card"
			data-session-id={session.id}
			onClick={() => onSessionClick(session.id)}
			class={`group relative p-4 border-b ${borderColors.ui.default} transition-all w-full text-left ${
				isActive ? 'bg-dark-850 border-l-2 border-l-blue-500' : 'hover:bg-dark-900'
			}`}
		>
			<div class="flex items-start justify-between gap-2">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 mb-1">
						<h3
							class={`font-medium truncate text-sm ${isActive ? 'text-gray-100' : 'text-gray-200'}`}
						>
							{session.title || 'New Session'}
						</h3>
						{session.worktree && (
							<span
								class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-purple-500/10 text-purple-400 rounded border border-purple-500/20"
								title={`Worktree: ${session.worktree.branch}`}
							>
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
									/>
								</svg>
							</span>
						)}
					</div>
					<div class="flex items-center gap-3 text-xs text-gray-500">
						<span class="flex items-center gap-1">
							<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
								/>
							</svg>
							{session.metadata.messageCount || 0}
						</span>
						<span class="flex items-center gap-1">
							<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							{formatRelativeTime(new Date(session.lastActiveAt))}
						</span>
					</div>
				</div>
			</div>
		</button>
	);
}
