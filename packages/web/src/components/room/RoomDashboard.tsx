/**
 * RoomDashboard Component
 *
 * Overview dashboard showing:
 * - Large runtime state indicator with pause/resume/stop/start controls
 * - Task stats summary (active, review, done counts)
 * - Model indicator showing current leader/worker model
 * - Recent activity feed (latest task updates)
 * - Confirmation dialogs for pause and stop actions
 */

import { useState } from 'preact/hooks';
import type { RuntimeState, TaskSummary } from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { navigateToRoomTask } from '../../lib/router';
import { currentRoomTabSignal } from '../../lib/signals';
import { ConfirmModal } from '../ui/ConfirmModal';
import { cn } from '../../lib/utils';

// ─── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({
	label,
	count,
	color,
	onClick,
}: {
	label: string;
	count: number;
	color: string;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			class={cn(
				'flex flex-col items-center gap-1 rounded-xl border px-5 py-4 transition-all',
				'bg-dark-850/80 hover:bg-dark-800',
				color
			)}
		>
			<span class="text-2xl font-bold tabular-nums">{count}</span>
			<span class="text-xs text-gray-400 font-medium uppercase tracking-wider">{label}</span>
		</button>
	);
}

// ─── Runtime Controls ────────────────────────────────────────────────────────

const RUNTIME_STYLES: Record<
	RuntimeState,
	{ bg: string; border: string; dot: string; label: string }
> = {
	running: {
		bg: 'bg-green-950/30',
		border: 'border-green-800/40',
		dot: 'bg-green-400',
		label: 'Running',
	},
	paused: {
		bg: 'bg-yellow-950/30',
		border: 'border-yellow-800/40',
		dot: 'bg-yellow-400',
		label: 'Paused',
	},
	stopped: {
		bg: 'bg-dark-850',
		border: 'border-dark-600',
		dot: 'bg-gray-500',
		label: 'Stopped',
	},
};

function RuntimeControlBar({
	state,
	actionLoading,
	onPause,
	onResume,
	onStop,
	onStart,
}: {
	state: RuntimeState;
	actionLoading: boolean;
	onPause: () => void;
	onResume: () => void;
	onStop: () => void;
	onStart: () => void;
}) {
	const style = RUNTIME_STYLES[state];

	return (
		<div
			class={cn(
				'flex items-center justify-between rounded-xl border px-5 py-4 transition-colors',
				style.bg,
				style.border
			)}
		>
			<div class="flex items-center gap-3">
				<div class="relative">
					<div class={cn('w-3.5 h-3.5 rounded-full', style.dot)} />
					{state === 'running' && (
						<div
							class={cn(
								'absolute inset-0 w-3.5 h-3.5 rounded-full animate-ping opacity-40',
								style.dot
							)}
						/>
					)}
				</div>
				<div>
					<span class="text-sm font-semibold text-gray-100">{style.label}</span>
					{actionLoading && <span class="ml-2 text-xs text-gray-500 italic">Processing...</span>}
				</div>
			</div>
			<div class="flex items-center gap-2">
				{state === 'running' && (
					<>
						<button
							onClick={onPause}
							disabled={actionLoading}
							class="px-4 py-2 text-sm font-medium text-yellow-300 bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700/40 rounded-lg transition-colors disabled:opacity-40"
						>
							Pause
						</button>
						<button
							onClick={onStop}
							disabled={actionLoading}
							class="px-4 py-2 text-sm font-medium text-red-300 bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 rounded-lg transition-colors disabled:opacity-40"
						>
							Stop
						</button>
					</>
				)}
				{state === 'paused' && (
					<>
						<button
							onClick={onResume}
							disabled={actionLoading}
							class="px-4 py-2 text-sm font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
						>
							Resume
						</button>
						<button
							onClick={onStop}
							disabled={actionLoading}
							class="px-4 py-2 text-sm font-medium text-red-300 bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 rounded-lg transition-colors disabled:opacity-40"
						>
							Stop
						</button>
					</>
				)}
				{state === 'stopped' && (
					<button
						onClick={onStart}
						disabled={actionLoading}
						class="px-4 py-2 text-sm font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
					>
						Start
					</button>
				)}
			</div>
		</div>
	);
}

// ─── Recent Activity ─────────────────────────────────────────────────────────

function getRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

const STATUS_COLORS: Record<string, string> = {
	in_progress: 'text-blue-400',
	pending: 'text-gray-400',
	draft: 'text-gray-500',
	completed: 'text-green-400',
	cancelled: 'text-gray-500',
	needs_attention: 'text-red-400',
	rate_limited: 'text-orange-400',
	usage_limited: 'text-orange-400',
	review: 'text-purple-400',
	archived: 'text-gray-600',
};

function RecentActivityItem({ task, onClick }: { task: TaskSummary; onClick?: () => void }) {
	const statusColor = STATUS_COLORS[task.status] ?? 'text-gray-400';

	return (
		<button
			type="button"
			onClick={onClick}
			class="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-dark-800/60 transition-colors text-left group"
		>
			<div class={cn('w-2 h-2 rounded-full flex-shrink-0', statusColor.replace('text-', 'bg-'))} />
			<div class="flex-1 min-w-0">
				<span class="text-sm text-gray-200 group-hover:text-gray-100 truncate block">
					{task.title}
				</span>
			</div>
			<span class="text-xs text-gray-500 flex-shrink-0 tabular-nums">
				{getRelativeTime(task.updatedAt)}
			</span>
		</button>
	);
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

export function RoomDashboard() {
	const tasks = roomStore.tasks.value;
	const roomId = roomStore.roomId.value;
	const runtimeState = roomStore.runtimeState.value;
	const runtimeModels = roomStore.runtimeModels.value;
	const [actionLoading, setActionLoading] = useState(false);
	const [showPauseConfirm, setShowPauseConfirm] = useState(false);
	const [showStopConfirm, setShowStopConfirm] = useState(false);

	const { leaderModel, workerModel } = runtimeModels;

	// Task counts
	const activeTasks = tasks.filter(
		(t) => t.status === 'in_progress' || t.status === 'pending' || t.status === 'draft'
	);
	const reviewTasks = tasks.filter(
		(t) =>
			t.status === 'review' ||
			t.status === 'needs_attention' ||
			t.status === 'rate_limited' ||
			t.status === 'usage_limited'
	);
	const doneTasks = tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled');

	// Recent activity — sorted by updatedAt, top 8
	const recentTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);

	const withLoading = (fn: () => Promise<void>, afterClose?: () => void) => async () => {
		setActionLoading(true);
		try {
			await fn();
		} catch {
			// Error handled by store
		} finally {
			setActionLoading(false);
			afterClose?.();
		}
	};

	return (
		<div class="max-w-3xl mx-auto px-5 py-6 space-y-6">
			{/* Runtime state + controls */}
			{runtimeState && (
				<RuntimeControlBar
					state={runtimeState}
					actionLoading={actionLoading}
					onPause={() => setShowPauseConfirm(true)}
					onResume={withLoading(() => roomStore.resumeRuntime())}
					onStop={() => setShowStopConfirm(true)}
					onStart={withLoading(() => roomStore.startRuntime())}
				/>
			)}

			{/* Stats strip */}
			<div class="grid grid-cols-3 gap-3">
				<StatCard
					label="Active"
					count={activeTasks.length}
					color="border-blue-800/30 text-blue-400"
					onClick={() => (currentRoomTabSignal.value = 'tasks')}
				/>
				<StatCard
					label="Review"
					count={reviewTasks.length}
					color="border-purple-800/30 text-purple-400"
					onClick={() => (currentRoomTabSignal.value = 'tasks')}
				/>
				<StatCard
					label="Done"
					count={doneTasks.length}
					color="border-green-800/30 text-green-400"
					onClick={() => (currentRoomTabSignal.value = 'tasks')}
				/>
			</div>

			{/* Model info */}
			{(leaderModel || workerModel) && (
				<div class="flex items-center gap-4 rounded-lg border border-dark-700 bg-dark-850/50 px-4 py-3">
					<svg
						class="w-5 h-5 text-gray-500 flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={1.5}
							d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
						/>
					</svg>
					<div class="flex items-center gap-4 text-sm">
						{leaderModel && (
							<span class="text-gray-400">
								Leader: <span class="text-gray-200 font-medium">{leaderModel}</span>
							</span>
						)}
						{workerModel && (
							<span class="text-gray-400">
								Worker: <span class="text-gray-200 font-medium">{workerModel}</span>
							</span>
						)}
					</div>
				</div>
			)}

			{/* Recent Activity */}
			<div>
				<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">
					Recent Activity
				</h3>
				{recentTasks.length === 0 ? (
					<div class="flex flex-col items-center justify-center py-12 text-center">
						<svg
							class="w-10 h-10 text-gray-700 mb-3"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={1.5}
								d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
							/>
						</svg>
						<p class="text-sm text-gray-500">No tasks yet</p>
						<p class="text-xs text-gray-600 mt-1">Create a mission to get started</p>
					</div>
				) : (
					<div class="rounded-xl border border-dark-700 bg-dark-900/50 divide-y divide-dark-700/50 overflow-hidden">
						{recentTasks.map((task) => (
							<RecentActivityItem
								key={task.id}
								task={task}
								onClick={roomId ? () => navigateToRoomTask(roomId, task.id) : undefined}
							/>
						))}
					</div>
				)}
			</div>

			{/* Pause Confirmation */}
			<ConfirmModal
				isOpen={showPauseConfirm}
				onClose={() => setShowPauseConfirm(false)}
				onConfirm={withLoading(
					() => roomStore.pauseRuntime(),
					() => setShowPauseConfirm(false)
				)}
				title="Pause Room"
				message="Pausing will prevent the room from starting new tasks. Currently running sessions will continue until they finish their current work."
				confirmText="Pause"
				confirmButtonVariant="primary"
				isLoading={actionLoading}
			/>

			{/* Stop Confirmation */}
			<ConfirmModal
				isOpen={showStopConfirm}
				onClose={() => setShowStopConfirm(false)}
				onConfirm={withLoading(
					() => roomStore.stopRuntime(),
					() => setShowStopConfirm(false)
				)}
				title="Stop Room"
				message="Stopping will completely shut down the room runtime. All active sessions will be terminated and no new tasks will be processed. You can start the room again later."
				confirmText="Stop Room"
				isLoading={actionLoading}
			/>
		</div>
	);
}
