import { useState } from 'preact/hooks';
import type { Session } from '@neokai/shared';
import { currentSessionIdSignal } from '../lib/signals.ts';
import { allSessionStatuses, getProcessingPhaseColor } from '../lib/session-status.ts';
import { cn } from '../lib/utils.ts';

interface SessionListItemProps {
	session: Session;
	onSessionClick: (sessionId: string) => void;
	/** Archive the session. May open a confirm dialog (handled by the parent). */
	onArchive: (sessionId: string) => void | Promise<void>;
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

function WorktreeBranchIcon() {
	return (
		<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 15 15">
			<path
				d="M2.5 4.5C1.39543 4.5 0.5 3.60457 0.5 2.5C0.5 1.39543 1.39543 0.5 2.5 0.5C3.60457 0.5 4.5 1.39543 4.5 2.5C4.5 3.60457 3.60457 4.5 2.5 4.5ZM2.5 4.5V10.5M4.5 12.5C4.5 13.6046 3.60457 14.5 2.5 14.5C1.39543 14.5 0.5 13.6046 0.5 12.5C0.5 11.3954 1.39543 10.5 2.5 10.5M4.5 12.5C4.5 11.3954 3.60457 10.5 2.5 10.5M4.5 12.5H9.5C11.1569 12.5 12.5 11.1569 12.5 9.5V7.5M12.5 7.5C11.3954 7.5 10.5 6.60457 10.5 5.5C10.5 4.39543 11.3954 3.5 12.5 3.5C13.6046 3.5 14.5 4.39543 14.5 5.5C14.5 6.60457 13.6046 7.5 12.5 7.5Z"
				stroke="currentColor"
			/>
		</svg>
	);
}

/**
 * Individual session list item — Codex-style borderless single-line row, with a
 * hover-revealed archive action that arms an inline red confirm before firing.
 */
export default function SessionListItem({
	session,
	onSessionClick,
	onArchive,
}: SessionListItemProps) {
	// Each item subscribes to currentSessionId independently so only styling updates.
	const isActive = currentSessionIdSignal.value === session.id;
	const [confirming, setConfirming] = useState(false);
	const [archiving, setArchiving] = useState(false);

	const handleArchive = async () => {
		setArchiving(true);
		try {
			await onArchive(session.id);
		} finally {
			setArchiving(false);
			setConfirming(false);
		}
	};

	return (
		<div
			data-testid="session-row"
			class={cn(
				'group/row relative flex items-stretch rounded-lg transition-colors',
				isActive ? 'bg-white/10' : 'hover:bg-white/5'
			)}
			onMouseLeave={() => {
				if (!archiving) setConfirming(false);
			}}
		>
			<button
				type="button"
				data-testid="session-card"
				data-session-id={session.id}
				onClick={() => onSessionClick(session.id)}
				class={cn(
					'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
					isActive ? 'text-gray-100' : 'text-gray-400 group-hover/row:text-gray-200'
				)}
			>
				<StatusIndicator sessionId={session.id} />
				<h3 class={cn('flex-1 min-w-0 truncate text-sm', isActive && 'font-medium')}>
					{session.title || 'New Session'}
				</h3>
				{session.worktree && (
					<span
						class="text-green-400 flex-shrink-0"
						title={`Worktree: ${session.worktree.branch}`}
					>
						<WorktreeBranchIcon />
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

			{/* Archive action — hover-revealed icon that arms an inline red confirm */}
			{session.status !== 'archived' && (
				<div class="flex items-center pr-1">
					{confirming ? (
						<button
							type="button"
							data-testid="session-archive-confirm"
							onClick={handleArchive}
							disabled={archiving}
							class="px-2 py-0.5 rounded text-xs font-medium bg-red-600 text-white transition-colors hover:bg-red-500 disabled:opacity-60"
						>
							{archiving ? 'Archiving…' : 'Archive'}
						</button>
					) : (
						<button
							type="button"
							data-testid="session-archive"
							onClick={() => setConfirming(true)}
							title="Archive chat"
							aria-label={`Archive ${session.title || 'chat'}`}
							class="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 p-1 rounded text-gray-500 transition-colors hover:text-gray-100 hover:bg-white/10"
						>
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={1.75}
									d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
								/>
							</svg>
						</button>
					)}
				</div>
			)}
		</div>
	);
}
