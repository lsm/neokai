/**
 * RoomAgentStatus Component
 *
 * Displays the current state of a room agent and its activity.
 * Shows lifecycle state with color-coded badge, current activity,
 * error indicator, last activity time, and action buttons.
 */

import { useMemo } from 'preact/hooks';
import type { RoomAgentState, RoomAgentLifecycleState } from '@neokai/shared';
import { cn } from '../../lib/utils.ts';

/**
 * Color mapping for lifecycle states
 */
const STATE_COLORS: Record<RoomAgentLifecycleState, { bg: string; text: string; dot: string }> = {
	idle: { bg: 'bg-gray-700', text: 'text-gray-300', dot: 'bg-gray-400' },
	planning: { bg: 'bg-blue-900/50', text: 'text-blue-300', dot: 'bg-blue-400' },
	executing: { bg: 'bg-green-900/50', text: 'text-green-300', dot: 'bg-green-400' },
	waiting: { bg: 'bg-yellow-900/50', text: 'text-yellow-300', dot: 'bg-yellow-400' },
	reviewing: { bg: 'bg-purple-900/50', text: 'text-purple-300', dot: 'bg-purple-400' },
	error: { bg: 'bg-red-900/50', text: 'text-red-300', dot: 'bg-red-400' },
	paused: { bg: 'bg-orange-900/50', text: 'text-orange-300', dot: 'bg-orange-400' },
};

/**
 * Label mapping for lifecycle states
 */
const STATE_LABELS: Record<RoomAgentLifecycleState, string> = {
	idle: 'Idle',
	planning: 'Planning',
	executing: 'Executing',
	waiting: 'Waiting',
	reviewing: 'Reviewing',
	error: 'Error',
	paused: 'Paused',
};

/**
 * Format relative time from timestamp
 */
function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) {
		return 'Just now';
	} else if (minutes < 60) {
		return `${minutes} min ago`;
	} else if (hours < 24) {
		return `${hours}h ago`;
	} else if (days === 1) {
		return 'Yesterday';
	} else if (days < 7) {
		return `${days}d ago`;
	} else {
		return new Date(timestamp).toLocaleDateString();
	}
}

export interface RoomAgentStatusProps {
	roomId: string;
	state: RoomAgentState | null;
	onAction?: (action: 'pause' | 'resume' | 'start' | 'stop') => void;
}

export function RoomAgentStatus({ roomId: _roomId, state, onAction }: RoomAgentStatusProps) {
	// Determine current activity description
	const activityDescription = useMemo(() => {
		if (!state) return null;

		if (state.currentTaskId) {
			return `Working on task: ${state.currentTaskId.slice(0, 8)}`;
		}
		if (state.currentGoalId) {
			return `Pursuing goal: ${state.currentGoalId.slice(0, 8)}`;
		}
		if (state.activeSessionPairIds.length > 0) {
			return `${state.activeSessionPairIds.length} active session${state.activeSessionPairIds.length > 1 ? 's' : ''}`;
		}
		if (state.pendingActions.length > 0) {
			return `${state.pendingActions.length} pending action${state.pendingActions.length > 1 ? 's' : ''}`;
		}
		return null;
	}, [state]);

	// If no state, show "stopped" status with start button
	if (!state) {
		return (
			<div class="flex items-center justify-between p-3 bg-dark-800 border border-gray-700 rounded-lg">
				<div class="flex items-center gap-3">
					<div class="w-2 h-2 rounded-full bg-gray-500" />
					<span class="text-sm text-gray-400">Agent stopped</span>
				</div>
				{onAction && (
					<button
						class="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors"
						onClick={() => onAction('start')}
					>
						Start
					</button>
				)}
			</div>
		);
	}

	const colors = STATE_COLORS[state.lifecycleState];
	const stateLabel = STATE_LABELS[state.lifecycleState];
	const isPaused = state.lifecycleState === 'paused';
	const isRunning = !isPaused && state.lifecycleState !== 'idle';

	return (
		<div class="flex items-center justify-between p-3 bg-dark-800 border border-gray-700 rounded-lg">
			{/* Left side: State badge and activity */}
			<div class="flex items-center gap-3">
				{/* State badge */}
				<div class={cn('flex items-center gap-1.5 px-2 py-1 rounded-md', colors.bg)}>
					<div class={cn('w-2 h-2 rounded-full', colors.dot)} />
					<span class={cn('text-xs font-medium', colors.text)}>{stateLabel}</span>
				</div>

				{/* Activity description */}
				{activityDescription && (
					<span class="text-sm text-gray-400 truncate max-w-48">{activityDescription}</span>
				)}
			</div>

			{/* Right side: Error indicator, last activity, and actions */}
			<div class="flex items-center gap-3">
				{/* Error indicator */}
				{state.errorCount > 0 && (
					<div
						class="flex items-center gap-1 px-2 py-0.5 bg-red-900/50 rounded text-xs text-red-300"
						title={state.lastError || 'Errors occurred'}
					>
						<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
							<path
								fill-rule="evenodd"
								d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
								clip-rule="evenodd"
							/>
						</svg>
						<span>{state.errorCount}</span>
					</div>
				)}

				{/* Last activity time */}
				<span class="text-xs text-gray-500">{formatRelativeTime(state.lastActivityAt)}</span>

				{/* Action buttons */}
				{onAction && (
					<div class="flex items-center gap-2">
						{isPaused ? (
							<button
								class="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
								onClick={() => onAction('resume')}
							>
								Resume
							</button>
						) : isRunning ? (
							<button
								class="px-3 py-1.5 text-xs font-medium bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors"
								onClick={() => onAction('pause')}
							>
								Pause
							</button>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}
