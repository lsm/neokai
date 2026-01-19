import type { Session } from '@liuboer/shared';
import { currentSessionIdSignal } from '../lib/signals.ts';
import { formatRelativeTime, formatTokens } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { allSessionStatuses, getProcessingPhaseColor } from '../lib/session-status.ts';
import { GitBranchIcon } from './icons/GitBranchIcon.tsx';

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
			<div class="relative flex-shrink-0 w-2.5 h-2.5">
				<span class={`absolute inset-0 rounded-full ${phaseColors.dot} animate-pulse`} />
				<span class={`absolute inset-0 rounded-full ${phaseColors.dot} animate-ping opacity-50`} />
			</div>
		);
	}

	// Unread state - show static blue dot
	if (hasUnread) {
		return (
			<div class="flex-shrink-0 w-2.5 h-2.5">
				<span class="block w-full h-full rounded-full bg-blue-500" />
			</div>
		);
	}

	// Idle and read - no indicator needed
	return null;
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
			<div class="flex-1 min-w-0">
				{/* Title row with status indicator */}
				<div class="flex items-center justify-between gap-2 mb-1">
					<div class="flex items-center gap-2 flex-1 min-w-0">
						<StatusIndicator sessionId={session.id} />
						<h3
							class={`font-medium truncate text-sm ${isActive ? 'text-gray-100' : 'text-gray-200'}`}
						>
							{session.title || 'New Session'}
						</h3>
					</div>
					<div class="flex items-center gap-1 flex-shrink-0">
						{session.worktree && (
							<span class="text-purple-400" title={`Worktree: ${session.worktree.branch}`}>
								<GitBranchIcon className="w-3.5 h-3.5" />
							</span>
						)}
						{session.status === 'archived' && (
							<span class="text-amber-600" title="Archived session">
								<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
									<path d="M15.528 2.973a.75.75 0 0 1 .472.696v8.662a.75.75 0 0 1-.472.696l-7.25 2.9a.75.75 0 0 1-.557 0l-7.25-2.9A.75.75 0 0 1 0 12.331V3.669a.75.75 0 0 1 .471-.696L7.443.184l.01-.003.268-.108a.75.75 0 0 1 .558 0l.269.108.01.003zM10.404 2 4.25 4.461 1.846 3.5 1 3.839v.4l6.5 2.6v7.922l.5.2.5-.2V6.84l6.5-2.6v-.4l-.846-.339L8 5.961 5.596 5l6.154-2.461z" />
								</svg>
							</span>
						)}
					</div>
				</div>
				{/* Stats row */}
				<div class="flex items-center gap-3 text-xs text-gray-500">
					<span class="flex items-center gap-1">
						<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
							<path d="M5 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m4 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0m3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2" />
							<path d="m2.165 15.803.02-.004c1.83-.363 2.948-.842 3.468-1.105A9 9 0 0 0 8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6a10.4 10.4 0 0 1-.524 2.318l-.003.011a11 11 0 0 1-.244.637c-.079.186.074.394.273.362a22 22 0 0 0 .693-.125m.8-3.108a1 1 0 0 0-.287-.801C1.618 10.83 1 9.468 1 8c0-3.192 3.004-6 7-6s7 2.808 7 6-3.004 6-7 6a8 8 0 0 1-2.088-.272 1 1 0 0 0-.711.074c-.387.196-1.24.57-2.634.893a11 11 0 0 0 .398-2" />
						</svg>
						{session.metadata.messageCount || 0}
					</span>
					<span class="flex items-center gap-1">
						<svg class="w-3 h-3" fill="currentColor" viewBox="-1 -1 18 18">
							<path d="M8 2a.5.5 0 0 1 .5.5V4a.5.5 0 0 1-1 0V2.5A.5.5 0 0 1 8 2M3.732 3.732a.5.5 0 0 1 .707 0l.915.914a.5.5 0 1 1-.708.708l-.914-.915a.5.5 0 0 1 0-.707M2 8a.5.5 0 0 1 .5-.5h1.586a.5.5 0 0 1 0 1H2.5A.5.5 0 0 1 2 8m9.5 0a.5.5 0 0 1 .5-.5h1.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5m.754-4.246a.39.39 0 0 0-.527-.02L7.547 7.31A.91.91 0 1 0 8.85 8.569l3.434-4.297a.39.39 0 0 0-.029-.518z" />
							<path
								fill-rule="evenodd"
								d="M6.664 15.889A8 8 0 1 1 9.336.11a8 8 0 0 1-2.672 15.78zm-4.665-4.283A11.95 11.95 0 0 1 8 10c2.186 0 4.236.585 6.001 1.606a7 7 0 1 0-12.002 0"
							/>
						</svg>
						{formatTokens(session.metadata.totalTokens || 0)}
					</span>
					<span class="font-mono text-green-400">
						${(session.metadata.totalCost || 0).toFixed(4)}
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
		</button>
	);
}
