/**
 * SpaceOverview Component
 *
 * Overview dashboard showing:
 * - Runtime state indicator with pause/resume/stop/start controls (when available)
 * - Task stats summary (active, review, done counts)
 * - Recent tasks feed (latest task updates)
 * - Recent sessions (latest active sessions)
 */

import { useState, useCallback } from 'preact/hooks';
import type { RuntimeState, SpaceTask } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceTask, navigateToSpaceSession } from '../../lib/router';
import { createSession } from '../../lib/api-helpers';
import { cn, getRelativeTime } from '../../lib/utils';
import { SpaceCreateTaskDialog } from './SpaceCreateTaskDialog';

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
}: {
	state: RuntimeState;
	actionLoading: boolean;
	onPause: () => void;
	onResume: () => void;
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
					<button
						onClick={onPause}
						disabled={actionLoading}
						class="px-4 py-2 text-sm font-medium text-yellow-300 bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700/40 rounded-lg transition-colors disabled:opacity-40"
					>
						Pause
					</button>
				)}
				{state === 'paused' && (
					<button
						onClick={onResume}
						disabled={actionLoading}
						class="px-4 py-2 text-sm font-medium text-green-300 bg-green-900/30 hover:bg-green-900/50 border border-green-700/40 rounded-lg transition-colors disabled:opacity-40"
					>
						Resume
					</button>
				)}
			</div>
		</div>
	);
}

// ─── Recent Tasks ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
	in_progress: 'text-blue-400',
	open: 'text-gray-400',
	blocked: 'text-amber-400',
	review: 'text-purple-400',
	done: 'text-green-400',
	cancelled: 'text-gray-500',
	archived: 'text-gray-600',
};

function RecentTaskItem({ task, onClick }: { task: SpaceTask; onClick?: () => void }) {
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

interface SpaceOverviewProps {
	spaceId: string;
	onSelectTask?: (taskId: string) => void;
}

export function SpaceOverview({ spaceId, onSelectTask }: SpaceOverviewProps) {
	const [showCreateTask, setShowCreateTask] = useState(false);
	const [actionLoading, setActionLoading] = useState(false);

	const handlePause = useCallback(async () => {
		setActionLoading(true);
		try {
			await spaceStore.pauseSpace();
		} finally {
			setActionLoading(false);
		}
	}, []);

	const handleResume = useCallback(async () => {
		setActionLoading(true);
		try {
			await spaceStore.resumeSpace();
		} finally {
			setActionLoading(false);
		}
	}, []);

	const handleNewSession = useCallback(async () => {
		const space = spaceStore.space.value;
		const response = await createSession({ spaceId, workspacePath: space?.workspacePath });
		navigateToSpaceSession(spaceId, response.sessionId);
	}, [spaceId]);

	const loading = spaceStore.loading.value;
	const space = spaceStore.space.value;
	const tasks = spaceStore.tasks.value;
	const runtimeState = spaceStore.runtimeState.value;

	// Recent sessions — sorted by lastActiveAt, top 8 (computed before early returns)
	const recentSessions = [...spaceStore.sessions.value]
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
		.slice(0, 8);

	if (loading) {
		return (
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<div class="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
					<p class="text-sm text-gray-500">Loading space...</p>
				</div>
			</div>
		);
	}

	if (!space) {
		return (
			<div class="flex h-full items-center justify-center">
				<p class="text-sm text-gray-500">Space not found</p>
			</div>
		);
	}

	// Task counts
	const activeTasks = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
	const reviewTasks = tasks.filter((t) => t.status === 'blocked' || t.status === 'review');
	const doneTasks = tasks.filter(
		(t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived'
	);

	// Recent tasks — sorted by updatedAt, top 8
	const recentTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);

	const handleTaskClick =
		onSelectTask ?? ((taskId: string) => navigateToSpaceTask(spaceId, taskId));

	return (
		<div class="flex-1 min-h-0 w-full px-4 py-4 sm:px-8 sm:py-6 overflow-y-auto">
			<div class="min-h-[calc(100%+1px)] space-y-6">
				<SpaceCreateTaskDialog isOpen={showCreateTask} onClose={() => setShowCreateTask(false)} />

				{/* Runtime state with pause/resume controls */}
				{runtimeState && (
					<RuntimeControlBar
						state={runtimeState}
						actionLoading={actionLoading}
						onPause={() => void handlePause()}
						onResume={() => void handleResume()}
					/>
				)}

				{/* Stats strip */}
				<div class="grid grid-cols-3 gap-3">
					<StatCard
						label="Active"
						count={activeTasks.length}
						color="border-blue-800/30 text-blue-400"
					/>
					<StatCard
						label="Review"
						count={reviewTasks.length}
						color="border-purple-800/30 text-purple-400"
					/>
					<StatCard
						label="Done"
						count={doneTasks.length}
						color="border-green-800/30 text-green-400"
					/>
				</div>

				{/* Recent Tasks */}
				<div>
					<div class="flex items-center justify-between mb-2 px-1">
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">
							Recent Tasks
						</h3>
						<button
							type="button"
							onClick={() => setShowCreateTask(true)}
							class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
						>
							Create Task
						</button>
					</div>
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
							<p class="text-xs text-gray-600 mt-1">Create a task to get started</p>
						</div>
					) : (
						<div class="rounded-xl border border-dark-700 bg-dark-900/50 divide-y divide-dark-700/50 overflow-hidden">
							{recentTasks.map((task) => (
								<RecentTaskItem
									key={task.id}
									task={task}
									onClick={() => handleTaskClick(task.id)}
								/>
							))}
						</div>
					)}
				</div>

				{/* Recent Sessions */}
				{recentSessions.length > 0 && (
					<div>
						<div class="flex items-center justify-between mb-2 px-1">
							<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">
								Recent Sessions
							</h3>
							<button
								type="button"
								onClick={() => void handleNewSession()}
								class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
							>
								New Session
							</button>
						</div>
						<div class="rounded-xl border border-dark-700 bg-dark-900/50 divide-y divide-dark-700/50 overflow-hidden">
							{recentSessions.map((session) => (
								<button
									key={session.id}
									type="button"
									onClick={() => navigateToSpaceSession(spaceId, session.id)}
									class="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-dark-800/60 transition-colors text-left group"
								>
									<div class="w-2 h-2 rounded-full flex-shrink-0 bg-indigo-400" />
									<div class="flex-1 min-w-0">
										<span class="text-sm text-gray-200 group-hover:text-gray-100 truncate block">
											{session.title || 'Untitled Session'}
										</span>
									</div>
									<span class="text-xs text-gray-500 flex-shrink-0 tabular-nums">
										{getRelativeTime(session.lastActiveAt)}
									</span>
								</button>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
