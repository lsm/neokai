/**
 * RoomContextPanel
 *
 * Goal-centric sidebar for a specific room. Layout (top to bottom):
 * 1. Task stats strip (pending · active counts)
 * 2. Pinned items: Dashboard, Room Agent
 * 3. Goals section (collapsible) with expandable linked tasks
 * 4. Tasks section (orphan tasks with tab filter)
 * 5. Sessions section (collapsible, default collapsed)
 */

import { useCallback, useMemo, useState } from 'preact/hooks';
import { CollapsibleSection } from '../components/room/CollapsibleSection';
import { roomStore } from '../lib/room-store';
import {
	navigateToRoom,
	navigateToRoomAgent,
	navigateToRoomSession,
	navigateToRoomTask,
} from '../lib/router';
import { currentRoomSessionIdSignal, currentRoomTaskIdSignal } from '../lib/signals';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';

function formatRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return 'now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function SessionStatusDot({ status }: { status: string }) {
	const colors: Record<string, string> = {
		idle: 'bg-gray-500',
		active: 'bg-green-500',
		processing: 'bg-blue-500 animate-pulse',
		waiting: 'bg-yellow-500',
		error: 'bg-red-500',
		archived: 'bg-gray-600',
	};
	return <div class={cn('w-2 h-2 rounded-full flex-shrink-0', colors[status] ?? colors.idle)} />;
}

const taskStatusColors: Record<string, string> = {
	draft: 'bg-gray-500',
	pending: 'bg-yellow-500',
	in_progress: 'bg-blue-500',
	review: 'bg-purple-500',
	needs_attention: 'bg-orange-500',
	completed: 'bg-green-500',
	cancelled: 'bg-gray-600',
};

function TaskStatusDot({ status }: { status: string }) {
	return (
		<div
			class={cn('w-2 h-2 rounded-full flex-shrink-0', taskStatusColors[status] ?? 'bg-gray-500')}
		/>
	);
}

const goalStatusColors: Record<string, string> = {
	active: 'text-green-400',
	needs_human: 'text-yellow-400',
	completed: 'text-gray-500',
	archived: 'text-gray-600',
};

type OrphanTab = 'active' | 'review' | 'done';

interface RoomContextPanelProps {
	roomId: string;
	onNavigate?: () => void;
}

export function RoomContextPanel({ roomId, onNavigate }: RoomContextPanelProps) {
	const sessions = roomStore.sessions.value;
	const tasks = roomStore.tasks.value;
	const [showArchived, setShowArchived] = useState(false);
	const [expandedGoals, setExpandedGoals] = useState<Set<string>>(() => new Set());
	const [orphanTab, setOrphanTab] = useState<OrphanTab>('active');

	// Task stats
	const pendingCount = useMemo(() => tasks.filter((t) => t.status === 'pending').length, [tasks]);
	const activeCount = useMemo(
		() => tasks.filter((t) => t.status === 'in_progress').length,
		[tasks]
	);

	// Goals data — show only active goals; count matches the rendered list
	const activeGoals = roomStore.activeGoals.value;
	const tasksByGoalId = roomStore.tasksByGoalId.value;

	// Orphan tasks by tab — read signal .value directly (no useMemo) so Preact
	// Signals auto-tracking picks up changes when the underlying task list updates.
	const orphanTasksForTab =
		orphanTab === 'active'
			? roomStore.orphanTasksActive.value
			: orphanTab === 'review'
				? roomStore.orphanTasksReview.value
				: roomStore.orphanTasksDone.value;

	// Sessions
	const filteredSessions = useMemo(() => {
		if (showArchived) return sessions;
		return sessions.filter((s) => s.status !== 'archived');
	}, [sessions, showArchived]);

	const hasArchivedSessions = useMemo(
		() => sessions.some((s) => s.status === 'archived'),
		[sessions]
	);

	// Selection state
	const selectedSessionId = currentRoomSessionIdSignal.value;
	const selectedTaskId = currentRoomTaskIdSignal.value;
	const roomAgentSessionId = `room:chat:${roomId}`;

	const isDashboardSelected = selectedSessionId === null && selectedTaskId === null;
	// Router clears taskId when navigating to agent, so checking sessionId alone is safe.
	const isRoomAgentSelected = selectedSessionId === roomAgentSessionId;

	// Goal expand/collapse
	const toggleGoal = (goalId: string) => {
		setExpandedGoals((prev) => {
			const next = new Set(prev);
			if (next.has(goalId)) {
				next.delete(goalId);
			} else {
				next.add(goalId);
			}
			return next;
		});
	};

	// Navigation handlers
	const handleDashboardClick = () => {
		navigateToRoom(roomId);
		onNavigate?.();
	};

	const handleRoomAgentClick = () => {
		navigateToRoomAgent(roomId);
		onNavigate?.();
	};

	const handleTaskClick = (taskId: string) => {
		navigateToRoomTask(roomId, taskId);
		onNavigate?.();
	};

	const handleSessionClick = (sessionId: string) => {
		navigateToRoomSession(roomId, sessionId);
		onNavigate?.();
	};

	const handleCreateSession = useCallback(
		async (e: Event) => {
			e.stopPropagation();
			try {
				const sessionId = await roomStore.createSession();
				navigateToRoomSession(roomId, sessionId);
				onNavigate?.();
			} catch {
				toast.error('Failed to create session');
			}
		},
		[roomId, onNavigate]
	);

	const hasTasks = pendingCount > 0 || activeCount > 0;

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Task stats strip */}
			<div class="px-3 py-2">
				{hasTasks ? (
					<span class="text-xs text-gray-500">
						{pendingCount > 0 && <span class="text-yellow-500/80">{pendingCount} pending</span>}
						{pendingCount > 0 && activeCount > 0 && <span class="text-gray-600"> · </span>}
						{activeCount > 0 && <span class="text-green-500/80">{activeCount} active</span>}
					</span>
				) : (
					<span class="text-xs text-gray-600">No tasks</span>
				)}
			</div>

			{/* Pinned items */}
			<button
				onClick={handleDashboardClick}
				class={cn(
					'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors',
					isDashboardSelected ? 'bg-dark-700' : 'hover:bg-dark-800'
				)}
			>
				<div class="w-6 h-6 flex-shrink-0 flex items-center justify-center bg-blue-900/40 rounded">
					<svg
						class="w-3.5 h-3.5 text-blue-400"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
						/>
					</svg>
				</div>
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Dashboard</span>
			</button>

			<button
				onClick={handleRoomAgentClick}
				class={cn(
					'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors',
					isRoomAgentSelected ? 'bg-dark-700' : 'hover:bg-dark-800'
				)}
			>
				<div class="w-6 h-6 flex-shrink-0 flex items-center justify-center bg-purple-900/40 rounded">
					<svg
						class="w-3.5 h-3.5 text-purple-400"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
						/>
					</svg>
				</div>
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Room Agent</span>
			</button>

			{/* Visual divider after pinned items */}
			<div class="border-t border-dark-700 mx-3 my-1" />

			{/* Scrollable sections */}
			<div class="flex-1 overflow-y-auto">
				{/* Goals section */}
				<CollapsibleSection title="Goals" count={activeGoals.length}>
					{activeGoals.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No goals</div>
					) : (
						activeGoals.map((goal) => {
							const isExpanded = expandedGoals.has(goal.id);
							const linkedTasks = tasksByGoalId.get(goal.id) ?? [];
							return (
								<div key={goal.id}>
									<button
										onClick={() => toggleGoal(goal.id)}
										class="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-dark-800 transition-colors text-left"
									>
										<span class="text-gray-500 text-[10px] leading-none w-3 flex-shrink-0">
											{isExpanded ? '▼' : '▶'}
										</span>
										<span class="flex-1 text-sm text-gray-300 truncate">{goal.title}</span>
										<span
											class={cn(
												'text-[10px] flex-shrink-0',
												goalStatusColors[goal.status] ?? 'text-gray-500'
											)}
										>
											●
										</span>
									</button>
									{isExpanded &&
										linkedTasks.map((task) => (
											<button
												key={task.id}
												onClick={() => handleTaskClick(task.id)}
												class={cn(
													'w-full pl-8 pr-3 py-1.5 flex items-center gap-2 transition-colors text-left',
													selectedTaskId === task.id ? 'bg-dark-700' : 'hover:bg-dark-800'
												)}
											>
												<TaskStatusDot status={task.status} />
												<span class="flex-1 text-sm text-gray-400 truncate">{task.title}</span>
											</button>
										))}
								</div>
							);
						})
					)}
				</CollapsibleSection>

				{/* Tasks section (orphan tasks) */}
				<CollapsibleSection title="Tasks">
					{/* Tab bar */}
					<div class="flex items-center gap-1 px-3 py-1.5">
						{(['active', 'review', 'done'] as const).map((tab) => (
							<button
								key={tab}
								onClick={() => setOrphanTab(tab)}
								class={cn(
									'px-2 py-0.5 text-xs rounded transition-colors capitalize',
									orphanTab === tab
										? 'bg-dark-600 text-gray-200'
										: 'text-gray-500 hover:text-gray-300'
								)}
							>
								{tab}
							</button>
						))}
					</div>
					{orphanTasksForTab.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No orphan tasks</div>
					) : (
						orphanTasksForTab.map((task) => (
							<button
								key={task.id}
								onClick={() => handleTaskClick(task.id)}
								class={cn(
									'w-full px-3 py-1.5 flex items-center gap-2 transition-colors text-left',
									selectedTaskId === task.id ? 'bg-dark-700' : 'hover:bg-dark-800'
								)}
							>
								<TaskStatusDot status={task.status} />
								<span class="flex-1 text-sm text-gray-400 truncate">{task.title}</span>
							</button>
						))
					)}
				</CollapsibleSection>

				{/* Sessions section */}
				<CollapsibleSection
					title="Sessions"
					count={filteredSessions.length}
					defaultExpanded={false}
					headerRight={
						<button
							onClick={handleCreateSession}
							class="text-gray-500 hover:text-gray-300 transition-colors p-0.5"
							aria-label="Create session"
						>
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 4v16m8-8H4"
								/>
							</svg>
						</button>
					}
				>
					{/* Archived toggle */}
					{hasArchivedSessions && (
						<div class="px-3 py-1.5 flex items-center justify-end">
							<button
								onClick={() => setShowArchived(!showArchived)}
								class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
							>
								{showArchived ? 'Hide archived' : 'Show archived'}
							</button>
						</div>
					)}
					{filteredSessions.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No sessions yet</div>
					) : (
						filteredSessions.map((session) => (
							<button
								key={session.id}
								onClick={() => handleSessionClick(session.id)}
								class={cn(
									'w-full px-3 py-2 flex items-center gap-2.5 transition-colors',
									selectedSessionId === session.id ? 'bg-dark-700' : 'hover:bg-dark-800'
								)}
							>
								<SessionStatusDot status={session.status} />
								<span class="flex-1 text-sm text-gray-300 truncate text-left">
									{session.title || session.id.slice(0, 8)}
								</span>
								{session.lastActiveAt != null && (
									<span class="text-xs text-gray-500 flex-shrink-0 tabular-nums">
										{formatRelativeTime(session.lastActiveAt)}
									</span>
								)}
							</button>
						))
					)}
				</CollapsibleSection>
			</div>
		</div>
	);
}
