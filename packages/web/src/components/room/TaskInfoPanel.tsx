/**
 * TaskInfoPanel Component
 *
 * An inline panel that expands downward below the task header when the gear button
 * is clicked. Shows task info and available actions.
 *
 * Info section:
 * - Worktree path (last 2 segments, full path on hover)
 * - Session IDs (worker/leader)
 * - Current model
 *
 * Actions section:
 * - Complete, Cancel, Archive buttons (context-aware based on task state)
 */

import type { SessionInfo } from '@neokai/shared';
import { borderColors } from '../../lib/design-tokens.ts';
import { getModelLabel } from '../../lib/session-utils.ts';
import { CopyButton } from '../ui/CopyButton.tsx';

/**
 * Get the last N segments of a path
 */
function getLastPathSegments(path: string, segments: number = 2): string {
	if (!path) return '';
	const parts = path.split('/');
	if (parts.length <= segments) return path;
	return '.../' + parts.slice(-segments).join('/');
}

export interface TaskInfoPanelProps {
	isOpen: boolean;
	/** Worktree path to display (full path shown on hover) */
	worktreePath?: string;
	/** Worker session info */
	workerSession?: SessionInfo | null;
	/** Leader session info */
	leaderSession?: SessionInfo | null;
	/** Available action handlers */
	actions: {
		onComplete?: () => void;
		onCancel?: () => void;
		onArchive?: () => void;
	};
	/** Whether each action should be shown (context-aware) */
	visibleActions: {
		complete?: boolean;
		cancel?: boolean;
		archive?: boolean;
	};
	/** Whether each action is disabled */
	disabledActions?: {
		complete?: boolean;
		cancel?: boolean;
		archive?: boolean;
	};
}

export function TaskInfoPanel({
	isOpen,
	worktreePath,
	workerSession,
	leaderSession,
	actions,
	visibleActions,
	disabledActions,
}: TaskInfoPanelProps) {
	if (!isOpen) return null;

	const hasWorktreeInfo = worktreePath || workerSession || leaderSession;
	const displayPath = worktreePath ? getLastPathSegments(worktreePath) : null;

	// Git branch: prefer worktree branch, fall back to session gitBranch
	const gitBranch = workerSession?.worktree?.branch ?? workerSession?.gitBranch ?? null;

	const hasVisibleActions =
		visibleActions.complete || visibleActions.cancel || visibleActions.archive;

	return (
		<div
			class={`border-b ${borderColors.ui.secondary} bg-dark-850 flex-shrink-0`}
			data-testid="task-info-panel"
		>
			<div class="px-4 py-3 flex flex-col gap-3">
				{/* Info section */}
				{hasWorktreeInfo && (
					<div>
						<h3 class="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Info</h3>
						<div class="space-y-1.5 text-xs">
							{/* Worktree path */}
							{worktreePath && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-12">Path:</span>
									<span class="text-gray-300 font-mono truncate flex-1" title={worktreePath}>
										{displayPath}
									</span>
									<CopyButton text={worktreePath} />
								</div>
							)}

							{/* Git branch */}
							{gitBranch && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-12">Branch:</span>
									<span class="text-gray-300 font-mono truncate flex-1" title={gitBranch}>
										{gitBranch}
									</span>
									<CopyButton text={gitBranch} />
								</div>
							)}

							{/* Session IDs */}
							{workerSession && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-12">Worker:</span>
									<span class="text-gray-300 font-mono truncate flex-1" title={workerSession.id}>
										{workerSession.id.slice(0, 8)}...
									</span>
									<span
										class={`text-xs flex-shrink-0 ${workerSession.status === 'active' ? 'text-green-400' : 'text-gray-500'}`}
										data-testid="worker-session-status"
									>
										{workerSession.status}
									</span>
									<CopyButton text={workerSession.id} />
								</div>
							)}
							{leaderSession && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-12">Leader:</span>
									<span class="text-gray-300 font-mono truncate flex-1" title={leaderSession.id}>
										{leaderSession.id.slice(0, 8)}...
									</span>
									<span
										class={`text-xs flex-shrink-0 ${leaderSession.status === 'active' ? 'text-green-400' : 'text-gray-500'}`}
										data-testid="leader-session-status"
									>
										{leaderSession.status}
									</span>
									<CopyButton text={leaderSession.id} />
								</div>
							)}

							{/* Model info */}
							{(workerSession?.config.model || leaderSession?.config.model) && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-12">Model:</span>
									<span class="text-gray-300">
										{getModelLabel(workerSession?.config.model ?? leaderSession?.config.model)}
									</span>
								</div>
							)}
						</div>
					</div>
				)}

				{/* Actions section */}
				{hasVisibleActions && (
					<div>
						<h3 class="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
							Actions
						</h3>
						<div class="flex items-center gap-2 flex-wrap">
							{visibleActions.complete && actions.onComplete && (
								<button
									type="button"
									onClick={actions.onComplete}
									disabled={disabledActions?.complete}
									data-testid="task-info-panel-complete"
									class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-green-700/80 hover:bg-green-700 text-white"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M5 13l4 4L19 7"
										/>
									</svg>
									Complete
								</button>
							)}

							{visibleActions.cancel && actions.onCancel && (
								<button
									type="button"
									onClick={actions.onCancel}
									disabled={disabledActions?.cancel}
									data-testid="task-info-panel-cancel"
									class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-dark-600 text-gray-400 hover:text-red-400 hover:border-red-700/60"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M6 18L18 6M6 6l12 12"
										/>
									</svg>
									Cancel
								</button>
							)}

							{visibleActions.archive && actions.onArchive && (
								<button
									type="button"
									onClick={actions.onArchive}
									disabled={disabledActions?.archive}
									data-testid="task-info-panel-archive"
									class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-800/30 hover:border-red-700/50"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 13a2 2 0 002 2h8a2 2 0 002-2L19 8"
										/>
									</svg>
									Archive
								</button>
							)}
						</div>
					</div>
				)}

				{/* Empty state */}
				{!hasWorktreeInfo && !hasVisibleActions && (
					<p class="text-xs text-gray-500 text-center py-1">No info or actions available</p>
				)}
			</div>
		</div>
	);
}
