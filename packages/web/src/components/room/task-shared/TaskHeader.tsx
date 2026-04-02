/**
 * TaskHeader Component
 *
 * Shared mobile-responsive header for TaskView (V1) and TaskViewV2.
 *
 * Layout (two rows on all viewports):
 * - **Row 1:** Back arrow, task title (flex-1), progress indicator, gear
 * - **Row 2:** Tags (status badge, task type, PR link, mission badge) + sub-line info
 *
 * Responsive behavior:
 * - On mobile, Row 2 has top margin for visual separation
 * - On desktop (>= sm), Row 2 has no top margin and aligns under the title
 *   via a flex spacer matching the back-button width — no hardcoded pixel offset
 * - Tap targets are enlarged on mobile (min 36px) for stop/gear buttons
 */

import type { NeoTask, RoomGoal } from '@neokai/shared';
import type { TaskGroupInfo } from '../../../hooks/useTaskViewData';
import { TASK_STATUS_COLORS } from '../../../lib/task-constants';
import { navigateToRoom } from '../../../lib/router';
import { currentRoomTabSignal } from '../../../lib/signals';
import { CircularProgressIndicator } from '../../ui/CircularProgressIndicator';
import { TaskHeaderActions } from './TaskHeaderActions';

export interface TaskHeaderProps {
	roomId: string;
	task: NeoTask;
	group: TaskGroupInfo | null;
	associatedGoal: RoomGoal | null;
	canInterrupt: boolean;
	interrupting: boolean;
	canReactivate: boolean;
	reactivating: boolean;
	interruptSession: () => void;
	reactivateTask: () => void;
	isInfoPanelOpen: boolean;
	onToggleInfoPanel: () => void;
}

export function TaskHeader({
	roomId,
	task,
	group,
	associatedGoal,
	canInterrupt,
	interrupting,
	canReactivate,
	reactivating,
	interruptSession,
	reactivateTask,
	isInfoPanelOpen,
	onToggleInfoPanel,
}: TaskHeaderProps) {
	const statusColor = TASK_STATUS_COLORS[task.status] ?? 'text-gray-400';

	return (
		<div
			class="border-b border-dark-700 bg-dark-850 px-3 sm:px-4 py-2.5 sm:py-3 flex-shrink-0"
			data-testid="task-header"
		>
			{/* Row 1: Back, title, progress, gear */}
			<div class="flex items-center gap-2 sm:gap-3">
				<button
					class="text-gray-400 hover:text-gray-200 transition-colors text-sm p-1 min-w-[28px] min-h-[28px] sm:min-w-0 sm:min-h-0 sm:p-0 flex items-center justify-center"
					onClick={() => navigateToRoom(roomId)}
					title="Back to room"
				>
					←
				</button>

				<div class="flex-1 min-w-0">
					<h2 class="text-base font-semibold text-gray-100 truncate leading-tight">{task.title}</h2>
				</div>

				{/* Circular progress indicator for task progress */}
				{task.progress != null && task.progress > 0 && (
					<CircularProgressIndicator
						progress={task.progress}
						size={32}
						class="flex-shrink-0"
						title={`Task progress: ${task.progress}%`}
					/>
				)}

				<TaskHeaderActions
					canInterrupt={canInterrupt}
					interrupting={interrupting}
					onInterrupt={interruptSession}
					canReactivate={canReactivate}
					reactivating={reactivating}
					onReactivate={reactivateTask}
					isInfoPanelOpen={isInfoPanelOpen}
					onToggleInfoPanel={onToggleInfoPanel}
				/>
			</div>

			{/* Row 2: Tags and sub-line info */}
			<div class="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 mt-1.5 sm:mt-0">
				{/* Spacer: on desktop, aligns tags under the title by matching back-button width */}
				<div class="hidden sm:block w-7 flex-shrink-0" aria-hidden="true" />
				<div class="flex items-center gap-1.5 flex-wrap">
					<span
						class={`text-xs font-medium flex-shrink-0 ${statusColor}`}
						data-testid="task-status-badge"
					>
						{task.status.replace('_', ' ')}
					</span>
					{task.taskType && (
						<span class="text-xs text-gray-500 bg-dark-700 px-1.5 py-0.5 rounded flex-shrink-0">
							{task.taskType}
						</span>
					)}
					{/* PR link */}
					{task.prUrl && (
						<a
							href={task.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded transition-colors flex-shrink-0"
							title="View Pull Request"
						>
							<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							<span>PR #{task.prNumber ?? '?'}</span>
						</a>
					)}
					{/* Mission link */}
					{associatedGoal && (
						<button
							data-testid="task-view-goal-badge"
							onClick={() => {
								navigateToRoom(roomId);
								currentRoomTabSignal.value = 'goals';
							}}
							class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-emerald-400 bg-emerald-900/20 border border-emerald-700/40 hover:bg-emerald-900/40 rounded transition-colors flex-shrink-0"
							title={`Mission: ${associatedGoal.title}`}
						>
							<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M13 10V3L4 14h7v7l9-11h-7z"
								/>
							</svg>
							<span class="max-w-[160px] truncate">{associatedGoal.title}</span>
						</button>
					)}
				</div>

				{/* Sub-line info: iteration count and status indicators */}
				{group && (
					<div class="flex items-center gap-2 flex-wrap">
						<p class="text-xs text-gray-500">
							{group.feedbackIteration > 0 && `iteration ${group.feedbackIteration}`}
						</p>
						{group.submittedForReview && !task.activeSession && (
							<span class="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-900/30 border border-amber-700/40 px-1.5 py-0.5 rounded-full animate-pulse">
								Awaiting your review
							</span>
						)}
						{task.status === 'review' && task.activeSession && (
							<span class="inline-flex items-center gap-1 text-xs font-medium text-blue-400 bg-blue-900/30 border border-blue-700/40 px-1.5 py-0.5 rounded-full">
								<span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
								{task.activeSession === 'worker' ? 'Worker' : 'Leader'} processing your message…
							</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
