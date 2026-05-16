import type { Session } from '@neokai/shared';
import { currentSessionIdSignal } from '../lib/signals.ts';
import { allSessionStatuses, getProcessingPhaseColor } from '../lib/session-status.ts';
import { GitBranchIcon } from './icons/GitBranchIcon.tsx';
import { cn } from '../lib/utils.ts';

interface SessionListItemProps {
	session: Session;
	onSessionClick: (sessionId: string) => void;
}

/**
 * Status Indicator Component
 * Shows processing state (pulsing) or unread state (static)
 */
function StatusIndicator({ sessionId }: { sessionId: string }) {
	const statuses = allSessionStatuses.value;
	const status = statuses.get(sessionId);

	if (!status) return null;

	const { processingState, hasUnread } = status;
	const phaseColors = getProcessingPhaseColor(processingState);

	// Processing state takes priority - show pulsing indicator
	if (phaseColors) {
		return (
			<div class="relative flex-shrink-0 w-2 h-2">
				<span class={`absolute inset-0 rounded-full ${phaseColors.dot} animate-pulse`} />
				<span class={`absolute inset-0 rounded-full ${phaseColors.dot} animate-ping opacity-50`} />
			</div>
		);
	}

	// Unread state - show static blue dot
	if (hasUnread) {
		return (
			<div class="flex-shrink-0 w-2 h-2">
				<span class="block w-full h-full rounded-full bg-blue-500" />
			</div>
		);
	}

	// Idle and read - no indicator needed
	return null;
}

/**
 * Individual session list item — Codex-style borderless single-line row.
 * Separated to minimize re-renders: only the active state changes, not the list.
 */
export default function SessionListItem({ session, onSessionClick }: SessionListItemProps) {
	// Each item subscribes to currentSessionId independently so only styling updates.
	const isActive = currentSessionIdSignal.value === session.id;

	return (
		<button
			type="button"
			data-testid="session-card"
			data-session-id={session.id}
			onClick={() => onSessionClick(session.id)}
			class={cn(
				'group relative w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors',
				isActive
					? 'bg-white/10 text-gray-100'
					: 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
			)}
		>
			<StatusIndicator sessionId={session.id} />
			<h3 class={cn('flex-1 min-w-0 truncate text-sm', isActive && 'font-medium')}>
				{session.title || 'New Session'}
			</h3>
			{session.worktree && (
				<span class="text-purple-400 flex-shrink-0" title={`Worktree: ${session.worktree.branch}`}>
					<GitBranchIcon className="w-3.5 h-3.5" />
				</span>
			)}
			{session.status === 'archived' && (
				<span class="text-amber-600 flex-shrink-0" title="Archived session">
					<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
						<path d="M15.528 2.973a.75.75 0 0 1 .472.696v8.662a.75.75 0 0 1-.472.696l-7.25 2.9a.75.75 0 0 1-.557 0l-7.25-2.9A.75.75 0 0 1 0 12.331V3.669a.75.75 0 0 1 .471-.696L7.443.184l.01-.003.268-.108a.75.75 0 0 1 .558 0l.269.108.01.003zM10.404 2 4.25 4.461 1.846 3.5 1 3.839v.4l6.5 2.6v7.922l.5.2.5-.2V6.84l6.5-2.6v-.4l-.846-.339L8 5.961 5.596 5l6.154-2.461z" />
					</svg>
				</span>
			)}
		</button>
	);
}
