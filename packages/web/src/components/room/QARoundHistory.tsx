/**
 * QARoundHistory Component
 *
 * Shows a list of completed Q&A rounds for a room.
 * Displays trigger type, question count, completion time, and allows
 * expanding to see all Q&A pairs within each round.
 */

import { useState } from 'preact/hooks';
import type { RoomQARound } from '@neokai/shared';
import { cn } from '../../lib/utils';

export interface QARoundHistoryProps {
	/** List of completed Q&A rounds */
	rounds: RoomQARound[];
	/** Maximum number of rounds to display (0 = all) */
	limit?: number;
}

/**
 * Trigger type badge colors
 */
const TRIGGER_COLORS: Record<RoomQARound['trigger'], string> = {
	room_created: 'bg-purple-900/50 text-purple-300 border-purple-700/50',
	context_updated: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
	goal_created: 'bg-green-900/50 text-green-300 border-green-700/50',
};

/**
 * Trigger type labels
 */
const TRIGGER_LABELS: Record<RoomQARound['trigger'], string> = {
	room_created: 'Room Created',
	context_updated: 'Context Updated',
	goal_created: 'Goal Created',
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
		return `${minutes}m ago`;
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

/**
 * Format duration between two timestamps
 */
function formatDuration(startedAt: number, completedAt: number): string {
	const diff = completedAt - startedAt;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	} else if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	} else {
		return `${seconds}s`;
	}
}

/**
 * Single round item in the history list
 */
function RoundItem({ round }: { round: RoomQARound }) {
	const [isExpanded, setIsExpanded] = useState(false);

	const answeredCount = round.questions.filter((q) => q.answer).length;
	const duration = round.completedAt ? formatDuration(round.startedAt, round.completedAt) : null;

	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
			{/* Header - always visible */}
			<button
				type="button"
				class="w-full px-4 py-3 text-left hover:bg-dark-800/50 transition-colors"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						{/* Completed indicator */}
						<div class="w-6 h-6 rounded-full bg-green-900/50 flex items-center justify-center flex-shrink-0">
							<svg class="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 20 20">
								<path
									fill-rule="evenodd"
									d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
									clip-rule="evenodd"
								/>
							</svg>
						</div>

						<div>
							{/* Trigger badge */}
							<span
								class={cn(
									'inline-block px-2 py-0.5 text-xs font-medium rounded border mb-1',
									TRIGGER_COLORS[round.trigger]
								)}
							>
								{TRIGGER_LABELS[round.trigger]}
							</span>

							{/* Question count */}
							<div class="text-sm text-gray-300">
								{answeredCount} question{answeredCount !== 1 ? 's' : ''} answered
							</div>
						</div>
					</div>

					<div class="flex items-center gap-3 text-xs text-gray-400">
						{duration && <span>{duration}</span>}
						{round.completedAt && <span>{formatRelativeTime(round.completedAt)}</span>}
						<svg
							class={cn('w-4 h-4 transition-transform', isExpanded && 'rotate-180')}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</div>
				</div>
			</button>

			{/* Expanded Q&A pairs */}
			{isExpanded && (
				<div class="px-4 pb-4 space-y-4 border-t border-dark-700">
					{/* Summary if present */}
					{round.summary && (
						<div class="pt-4">
							<h5 class="text-xs font-medium text-gray-400 uppercase mb-2">Summary</h5>
							<p class="text-sm text-gray-300 bg-dark-800/50 rounded p-3">{round.summary}</p>
						</div>
					)}

					{/* Q&A pairs */}
					<div class="pt-4 space-y-3">
						<h5 class="text-xs font-medium text-gray-400 uppercase">Q&A Pairs</h5>
						{round.questions.map((qa, index) => (
							<div key={qa.id} class="bg-dark-800/50 rounded-lg p-3 border border-dark-700/50">
								<div class="flex items-start gap-2 mb-2">
									<span class="text-xs font-medium text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
										Q{index + 1}
									</span>
									<p class="text-sm text-gray-100">{qa.question}</p>
								</div>
								{qa.answer && (
									<div class="flex items-start gap-2 ml-1">
										<span class="text-xs font-medium text-green-400 bg-green-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
											A
										</span>
										<p class="text-sm text-gray-300">{qa.answer}</p>
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Empty state when no rounds exist
 */
function EmptyState() {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
			<div class="w-10 h-10 rounded-full bg-dark-700 flex items-center justify-center mx-auto mb-3">
				<svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			</div>
			<h4 class="text-sm font-medium text-gray-200 mb-1">No Q&A History</h4>
			<p class="text-xs text-gray-400">Completed Q&A rounds will appear here.</p>
		</div>
	);
}

export function QARoundHistory({ rounds, limit = 0 }: QARoundHistoryProps) {
	// Filter to only completed rounds and sort by completion date (newest first)
	const completedRounds = rounds
		.filter((r) => r.status === 'completed' && r.completedAt)
		.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

	// Apply limit if specified
	const displayRounds = limit > 0 ? completedRounds.slice(0, limit) : completedRounds;

	if (displayRounds.length === 0) {
		return <EmptyState />;
	}

	return (
		<div class="space-y-4">
			{/* Header */}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<h3 class="text-sm font-semibold text-gray-100">Q&A History</h3>
					<span class="px-2 py-0.5 text-xs font-medium bg-dark-700 text-gray-300 rounded">
						{completedRounds.length}
					</span>
				</div>
				{limit > 0 && completedRounds.length > limit && (
					<span class="text-xs text-gray-400">
						Showing {limit} of {completedRounds.length}
					</span>
				)}
			</div>

			{/* Round list */}
			<div class="space-y-3">
				{displayRounds.map((round) => (
					<RoundItem key={round.id} round={round} />
				))}
			</div>
		</div>
	);
}
