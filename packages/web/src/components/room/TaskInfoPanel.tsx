/**
 * TaskInfoPanel Component
 *
 * An inline panel that expands downward below the task header when the gear button
 * is clicked. Shows task info and available actions.
 *
 * Info section:
 * - Task ID (full, with copy button)
 * - Session Group ID (full, with copy button)
 * - Worktree path (last 2 segments, full path on hover)
 * - Session IDs for worker and leader (full, with copy buttons)
 * - Model switcher (allows changing model for current session)
 * - Task creation time
 * - PR number/link if available
 *
 * Actions section:
 * - Complete, Cancel, Archive buttons (context-aware based on task state)
 */

import type { SessionInfo } from '@neokai/shared';
import { borderColors } from '../../lib/design-tokens.ts';
import { ViaNeoIndicator } from '../neo/ViaNeoIndicator.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { TaskViewModelSelector } from './TaskViewModelSelector.tsx';
import type { TaskViewVersionContext } from './TaskViewToggle.tsx';

/**
 * Map session status to a CSS color class.
 * - green  → active (live, processing)
 * - amber  → paused / pending_worktree_choice (live but waiting)
 * - gray   → ended / archived (terminal)
 */
function sessionStatusColor(status: string): string {
	if (status === 'active') return 'text-green-400';
	if (status === 'paused' || status === 'pending_worktree_choice') return 'text-amber-400';
	return 'text-gray-500';
}

/**
 * Get the last N segments of a path
 */
function getLastPathSegments(path: string, segments: number = 2): string {
	if (!path) return '';
	const parts = path.split('/');
	if (parts.length <= segments) return path;
	return '.../' + parts.slice(-segments).join('/');
}

/**
 * Format a timestamp in milliseconds to a human-readable date/time string.
 */
function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

export interface TaskInfoPanelProps {
	isOpen: boolean;
	/** View version toggle context (optional — enables V1/V2 toggle in the panel) */
	viewVersion?: TaskViewVersionContext;
	/** Room ID for routing task session model switches through RoomRuntimeService */
	roomId?: string;
	/** Full task ID */
	taskId?: string;
	/** Full session group ID */
	groupId?: string;
	/** Feedback iteration number (0 = first run) */
	feedbackIteration?: number;
	/** Task creation timestamp in milliseconds */
	taskCreatedAt?: number;
	/** Pull request URL */
	prUrl?: string | null;
	/** Pull request number */
	prNumber?: number | null;
	/** Whether this task was created or last status-changed by Neo */
	viaNeo?: boolean;
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
		onSetStatus?: () => void;
		onResetWorkerAgent?: () => void;
		onResetLeaderAgent?: () => void;
	};
	/** Whether each action should be shown (context-aware) */
	visibleActions: {
		complete?: boolean;
		cancel?: boolean;
		archive?: boolean;
		setStatus?: boolean;
		resetWorkerAgent?: boolean;
		resetLeaderAgent?: boolean;
	};
	/** Whether each action is disabled */
	disabledActions?: {
		complete?: boolean;
		cancel?: boolean;
		archive?: boolean;
		setStatus?: boolean;
		resetWorkerAgent?: boolean;
		resetLeaderAgent?: boolean;
	};
}

export function TaskInfoPanel({
	isOpen,
	viewVersion,
	roomId,
	taskId,
	groupId,
	feedbackIteration,
	taskCreatedAt,
	prUrl,
	prNumber,
	worktreePath,
	workerSession,
	leaderSession,
	viaNeo,
	actions,
	visibleActions,
	disabledActions,
}: TaskInfoPanelProps) {
	if (!isOpen) return null;

	const hasWorktreeInfo =
		taskId ||
		groupId ||
		worktreePath ||
		workerSession ||
		leaderSession ||
		taskCreatedAt !== undefined ||
		prUrl;
	const displayPath = worktreePath ? getLastPathSegments(worktreePath) : null;

	// Git branch: prefer worker worktree branch, then worker gitBranch, then leader equivalents
	const gitBranch =
		workerSession?.worktree?.branch ??
		workerSession?.gitBranch ??
		leaderSession?.worktree?.branch ??
		leaderSession?.gitBranch ??
		null;

	const hasVisibleActions =
		visibleActions.complete ||
		visibleActions.cancel ||
		visibleActions.archive ||
		visibleActions.setStatus ||
		visibleActions.resetWorkerAgent ||
		visibleActions.resetLeaderAgent;

	// Model switchers: show separate selectors for worker and leader
	const hasWorkerModel = workerSession?.config.model != null;
	const hasLeaderModel = leaderSession?.config.model != null;

	return (
		<div
			class={`border-b ${borderColors.ui.secondary} bg-dark-850 flex-shrink-0`}
			data-testid="task-info-panel"
		>
			<div class="px-4 py-3 flex flex-col gap-3">
				{/* View toggle section */}
				{viewVersion && (
					<div class="flex items-center justify-between">
						<div class="flex flex-col gap-0.5">
							<span class="text-xs font-semibold text-gray-500 uppercase tracking-wide">View</span>
							<span class="text-[10px] text-gray-600">
								{viewVersion.version === 'v1'
									? 'V1 Timeline → V2 Turn-based'
									: 'V2 Turn-based → V1 Timeline'}
							</span>
						</div>
						<button
							data-testid="task-view-toggle"
							onClick={viewVersion.onToggleVersion}
							class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-gray-100"
							aria-label={`Switch to ${viewVersion.version === 'v1' ? 'V2 turn-based' : 'V1 timeline'} view`}
						>
							{viewVersion.version === 'v1' ? (
								<>
									<span>V1</span>
									<span class="text-gray-500">→ V2</span>
								</>
							) : (
								<>
									<span class="text-gray-500">V1 ←</span>
									<span>V2</span>
								</>
							)}
						</button>
					</div>
				)}

				{/* Info section */}
				{hasWorktreeInfo && (
					<div>
						<div class="flex items-center gap-2 mb-2">
							<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide">Info</h3>
							{viaNeo && <ViaNeoIndicator size="xs" />}
						</div>
						<div class="space-y-1.5 text-xs">
							{/* Task ID */}
							{taskId && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Task ID:</span>
									<span
										class="text-gray-300 font-mono truncate flex-1 min-w-0"
										title={taskId}
										data-testid="task-info-panel-task-id"
									>
										{taskId}
									</span>
									<CopyButton text={taskId} />
								</div>
							)}

							{/* Group ID */}
							{groupId && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Group ID:</span>
									<span
										class="text-gray-300 font-mono truncate flex-1 min-w-0"
										title={groupId}
										data-testid="task-info-panel-group-id"
									>
										{groupId}
									</span>
									<CopyButton text={groupId} />
								</div>
							)}

							{/* Worktree path */}
							{worktreePath && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Path:</span>
									<span class="text-gray-300 font-mono truncate flex-1" title={worktreePath}>
										{displayPath}
									</span>
									<CopyButton text={worktreePath} />
								</div>
							)}

							{/* Git branch */}
							{gitBranch && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Branch:</span>
									<span class="text-gray-300 font-mono truncate flex-1" title={gitBranch}>
										{gitBranch}
									</span>
									<CopyButton text={gitBranch} />
								</div>
							)}

							{/* Worker session */}
							{workerSession && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Worker:</span>
									<span
										class="text-gray-300 font-mono truncate flex-1 min-w-0"
										title={workerSession.id}
										data-testid="worker-session-id"
									>
										{workerSession.id}
									</span>
									<span
										class={`text-xs flex-shrink-0 ${sessionStatusColor(workerSession.status)}`}
										data-testid="worker-session-status"
									>
										{workerSession.status}
									</span>
									<CopyButton text={workerSession.id} />
								</div>
							)}

							{/* Leader session */}
							{leaderSession && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Leader:</span>
									<span
										class="text-gray-300 font-mono truncate flex-1 min-w-0"
										title={leaderSession.id}
										data-testid="leader-session-id"
									>
										{leaderSession.id}
									</span>
									<span
										class={`text-xs flex-shrink-0 ${sessionStatusColor(leaderSession.status)}`}
										data-testid="leader-session-status"
									>
										{leaderSession.status}
									</span>
									<CopyButton text={leaderSession.id} />
								</div>
							)}

							{/* Worker model switcher */}
							{hasWorkerModel && workerSession && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Worker:</span>
									<span class="text-xs text-gray-400">Model:</span>
									<TaskViewModelSelector
										sessionId={workerSession.id}
										roomId={roomId}
										currentModel={workerSession.config.model ?? ''}
										currentProvider={workerSession.config.provider}
									/>
								</div>
							)}

							{/* Leader model switcher */}
							{hasLeaderModel && leaderSession && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Leader:</span>
									<span class="text-xs text-gray-400">Model:</span>
									<TaskViewModelSelector
										sessionId={leaderSession.id}
										roomId={roomId}
										currentModel={leaderSession.config.model ?? ''}
										currentProvider={leaderSession.config.provider}
									/>
								</div>
							)}

							{/* Feedback iteration */}
							{feedbackIteration !== undefined && feedbackIteration > 0 && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Iteration:</span>
									<span class="text-gray-300" data-testid="task-info-panel-iteration">
										{feedbackIteration}
									</span>
								</div>
							)}

							{/* Created at */}
							{taskCreatedAt !== undefined && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">Created:</span>
									<span
										class="text-gray-300"
										title={new Date(taskCreatedAt).toISOString()}
										data-testid="task-info-panel-created-at"
									>
										{formatTimestamp(taskCreatedAt)}
									</span>
								</div>
							)}

							{/* PR link */}
							{prUrl && prNumber && (
								<div class="flex items-center gap-2">
									<span class="text-gray-500 flex-shrink-0 w-14">PR:</span>
									<a
										href={prUrl}
										target="_blank"
										rel="noopener noreferrer"
										class="text-purple-400 hover:text-purple-300 transition-colors"
										data-testid="task-info-panel-pr-link"
									>
										#{prNumber}
									</a>
									<CopyButton text={prUrl} />
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

							{visibleActions.setStatus && actions.onSetStatus && (
								<button
									type="button"
									onClick={actions.onSetStatus}
									disabled={disabledActions?.setStatus}
									data-testid="task-info-panel-set-status"
									class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-dark-600 text-gray-400 hover:text-blue-400 hover:border-blue-700/60"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 6h16M4 12h8m-8 6h16"
										/>
									</svg>
									Set Status
								</button>
							)}

							{visibleActions.resetWorkerAgent && actions.onResetWorkerAgent && (
								<button
									type="button"
									onClick={actions.onResetWorkerAgent}
									disabled={disabledActions?.resetWorkerAgent}
									data-testid="task-info-panel-reset-worker"
									class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-dark-600 text-gray-400 hover:text-orange-400 hover:border-orange-700/60"
									title="Reset worker agent to fix stuck state or apply changes"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									Reset Worker
								</button>
							)}

							{visibleActions.resetLeaderAgent && actions.onResetLeaderAgent && (
								<button
									type="button"
									onClick={actions.onResetLeaderAgent}
									disabled={disabledActions?.resetLeaderAgent}
									data-testid="task-info-panel-reset-leader"
									class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-dark-600 text-gray-400 hover:text-orange-400 hover:border-orange-700/60"
									title="Reset leader agent to fix stuck state or apply changes"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									Reset Leader
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
