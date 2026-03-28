/**
 * SpaceDetailPanel
 *
 * Space-specific context panel for the three-column layout.
 * Mirrors RoomContextPanel's visual structure for a space:
 * 1. Task stats strip (active · review · done counts)
 * 2. Pinned items: Dashboard, Space Agent
 * 3. Workflow Runs section (active runs with expandable tasks)
 * 4. Tasks section (standalone tasks with active/review/done tab filter)
 * 5. Sessions section (collapsible, default collapsed)
 */

import { useMemo, useState } from 'preact/hooks';
import { CollapsibleSection } from '../components/room/CollapsibleSection';
import { spaceStore } from '../lib/space-store';
import {
	navigateToSpace,
	navigateToSpaceAgent,
	navigateToSpaceSession,
	navigateToSpaceTask,
} from '../lib/router';
import { currentSpaceSessionIdSignal, currentSpaceTaskIdSignal } from '../lib/signals';
import { cn } from '../lib/utils';

type OrphanTab = 'active' | 'review' | 'done';

const taskStatusColors: Record<string, string> = {
	draft: 'bg-gray-500',
	pending: 'bg-yellow-500',
	in_progress: 'bg-blue-500',
	review: 'bg-purple-500',
	needs_attention: 'bg-orange-500',
	completed: 'bg-green-500',
	cancelled: 'bg-gray-600',
	archived: 'bg-gray-600',
	rate_limited: 'bg-orange-500',
	usage_limited: 'bg-orange-600',
};

const workflowRunStatusColors: Record<string, string> = {
	pending: 'bg-yellow-500',
	in_progress: 'bg-blue-500 animate-pulse',
	completed: 'bg-green-500',
	failed: 'bg-red-500',
	cancelled: 'bg-gray-600',
	needs_attention: 'bg-orange-500',
};

function TaskStatusDot({ status }: { status: string }) {
	return (
		<div
			class={cn('w-2 h-2 rounded-full flex-shrink-0', taskStatusColors[status] ?? 'bg-gray-500')}
		/>
	);
}

function RunStatusDot({ status }: { status: string }) {
	return (
		<div
			class={cn(
				'w-2 h-2 rounded-full flex-shrink-0',
				workflowRunStatusColors[status] ?? 'bg-gray-500'
			)}
		/>
	);
}

interface SpaceDetailPanelProps {
	spaceId: string;
	onNavigate?: () => void;
}

export function SpaceDetailPanel({ spaceId, onNavigate }: SpaceDetailPanelProps) {
	// Read signal values directly for Preact Signals auto-tracking
	const isLoading = spaceStore.loading.value;
	const loadedSpaceId = spaceStore.spaceId.value;
	const tasks = spaceStore.tasks.value;
	const activeRuns = spaceStore.activeRuns.value;
	const tasksByRun = spaceStore.tasksByRun.value;
	const standaloneTasks = spaceStore.standaloneTasks.value;
	const space = spaceStore.space.value;

	// Show a loading state when the store hasn't loaded data for this space yet.
	// spaceStore.selectSpace() is called by SpaceIsland; the ContextPanel may render
	// before that call completes (e.g. on cold navigation before SpaceIsland mounts).
	const isReady = !isLoading && loadedSpaceId === spaceId;

	if (!isReady) {
		return (
			<div class="flex-1 flex items-center justify-center p-6">
				<span class="text-xs text-gray-600">Loading…</span>
			</div>
		);
	}

	const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
	const [orphanTab, setOrphanTab] = useState<OrphanTab>('active');

	// Task stats strip counts
	// rate_limited/usage_limited are transient throttle states — counted as active (still running).
	// archived is a terminal state — counted as done.
	const activeCount = useMemo(
		() =>
			tasks.filter(
				(t) =>
					t.status === 'draft' ||
					t.status === 'pending' ||
					t.status === 'in_progress' ||
					t.status === 'rate_limited' ||
					t.status === 'usage_limited'
			).length,
		[tasks]
	);
	const reviewCount = useMemo(
		() => tasks.filter((t) => t.status === 'review' || t.status === 'needs_attention').length,
		[tasks]
	);
	const doneCount = useMemo(
		() =>
			tasks.filter(
				(t) => t.status === 'completed' || t.status === 'cancelled' || t.status === 'archived'
			).length,
		[tasks]
	);

	// Selection state
	const selectedSessionId = currentSpaceSessionIdSignal.value;
	const selectedTaskId = currentSpaceTaskIdSignal.value;
	const spaceAgentSessionId = `space:chat:${spaceId}`;

	const isDashboardSelected = selectedSessionId === null && selectedTaskId === null;
	const isSpaceAgentSelected = selectedSessionId === spaceAgentSessionId;

	// Workflow run expand/collapse
	const toggleRun = (runId: string) => {
		setExpandedRuns((prev) => {
			const next = new Set(prev);
			if (next.has(runId)) {
				next.delete(runId);
			} else {
				next.add(runId);
			}
			return next;
		});
	};

	// Standalone tasks filtered by tab.
	// rate_limited/usage_limited are grouped with active; archived with done.
	const orphanTasksForTab = useMemo(() => {
		if (orphanTab === 'active') {
			return standaloneTasks.filter(
				(t) =>
					t.status === 'draft' ||
					t.status === 'pending' ||
					t.status === 'in_progress' ||
					t.status === 'rate_limited' ||
					t.status === 'usage_limited'
			);
		}
		if (orphanTab === 'review') {
			return standaloneTasks.filter((t) => t.status === 'review' || t.status === 'needs_attention');
		}
		return standaloneTasks.filter(
			(t) => t.status === 'completed' || t.status === 'cancelled' || t.status === 'archived'
		);
	}, [standaloneTasks, orphanTab]);

	// Build sessions list from available data sources
	// (1) Space agent session — always listed
	// (2) Task agent sessions linked via SpaceTask.taskAgentSessionId
	// (3) Manually created sessions from space.sessionIds
	const sessions = useMemo(() => {
		const list: { id: string; title: string; isAgent: boolean }[] = [];
		const seen = new Set<string>();

		// Always include space agent session
		list.push({ id: spaceAgentSessionId, title: 'Space Agent', isAgent: true });
		seen.add(spaceAgentSessionId);

		// Task agent sessions
		for (const task of tasks) {
			if (task.taskAgentSessionId && !seen.has(task.taskAgentSessionId)) {
				list.push({
					id: task.taskAgentSessionId,
					title: `${task.title} (agent)`,
					isAgent: true,
				});
				seen.add(task.taskAgentSessionId);
			}
		}

		// Manually created sessions from space.sessionIds
		if (space?.sessionIds) {
			for (const sid of space.sessionIds) {
				if (!seen.has(sid)) {
					list.push({ id: sid, title: sid.slice(0, 8), isAgent: false });
					seen.add(sid);
				}
			}
		}

		return list;
	}, [tasks, space, spaceAgentSessionId]);

	// Navigation handlers
	const handleDashboardClick = () => {
		navigateToSpace(spaceId);
		onNavigate?.();
	};

	const handleSpaceAgentClick = () => {
		navigateToSpaceAgent(spaceId);
		onNavigate?.();
	};

	const handleTaskClick = (taskId: string) => {
		navigateToSpaceTask(spaceId, taskId);
		onNavigate?.();
	};

	const handleSessionClick = (sessionId: string) => {
		navigateToSpaceSession(spaceId, sessionId);
		onNavigate?.();
	};

	const hasTasks = activeCount > 0 || reviewCount > 0 || doneCount > 0;

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Task stats strip */}
			<div class="px-3 py-2">
				{hasTasks ? (
					<span class="text-xs text-gray-500">
						{activeCount > 0 && <span class="text-blue-500/80">{activeCount} active</span>}
						{activeCount > 0 && reviewCount > 0 && <span class="text-gray-600"> · </span>}
						{reviewCount > 0 && <span class="text-purple-500/80">{reviewCount} review</span>}
						{(activeCount > 0 || reviewCount > 0) && doneCount > 0 && (
							<span class="text-gray-600"> · </span>
						)}
						{doneCount > 0 && <span>{doneCount} done</span>}
					</span>
				) : (
					<span class="text-xs text-gray-600">No tasks</span>
				)}
			</div>

			{/* Pinned items */}
			<button
				onClick={handleDashboardClick}
				data-testid="space-detail-dashboard"
				data-active={isDashboardSelected ? 'true' : 'false'}
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
				onClick={handleSpaceAgentClick}
				data-testid="space-detail-agent"
				data-active={isSpaceAgentSelected ? 'true' : 'false'}
				class={cn(
					'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors',
					isSpaceAgentSelected ? 'bg-dark-700' : 'hover:bg-dark-800'
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
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Space Agent</span>
			</button>

			{/* Visual divider after pinned items */}
			<div class="border-t border-dark-700 mx-3 my-1" />

			{/* Scrollable sections */}
			<div class="flex-1 overflow-y-auto">
				{/* Workflow Runs section */}
				<CollapsibleSection title="Workflow Runs" count={activeRuns.length}>
					{activeRuns.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No active runs</div>
					) : (
						activeRuns.map((run) => {
							const isExpanded = expandedRuns.has(run.id);
							const runTasks = tasksByRun.get(run.id) ?? [];
							return (
								<div key={run.id}>
									<button
										onClick={() => toggleRun(run.id)}
										class="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-dark-800 transition-colors text-left"
									>
										<span class="text-gray-500 text-[10px] leading-none w-3 flex-shrink-0">
											{isExpanded ? '▼' : '▶'}
										</span>
										<RunStatusDot status={run.status} />
										<span class="flex-1 text-sm text-gray-300 truncate">{run.title}</span>
									</button>
									{isExpanded && (
										<>
											{runTasks.length === 0 ? (
												<div class="pl-8 pr-3 py-1.5 text-xs text-gray-600">No tasks</div>
											) : (
												runTasks.map((task) => (
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
												))
											)}
										</>
									)}
								</div>
							);
						})
					)}
				</CollapsibleSection>

				{/* Tasks section (standalone tasks without a workflow run) */}
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
						<div class="px-4 py-3 text-xs text-gray-600">No tasks</div>
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
					count={sessions.length}
					defaultExpanded={false}
					headerRight={
						<button
							onClick={(e: MouseEvent) => {
								e.stopPropagation();
							}}
							disabled
							class="text-gray-600 cursor-not-allowed p-0.5"
							aria-label="Create session"
							title="Session creation coming soon"
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
					{sessions.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No sessions</div>
					) : (
						sessions.map((session) => (
							<button
								key={session.id}
								onClick={() => handleSessionClick(session.id)}
								class={cn(
									'w-full px-3 py-2 flex items-center gap-2.5 transition-colors',
									selectedSessionId === session.id ? 'bg-dark-700' : 'hover:bg-dark-800'
								)}
							>
								<div
									class={cn(
										'w-2 h-2 rounded-full flex-shrink-0',
										session.isAgent ? 'bg-purple-500' : 'bg-gray-500'
									)}
								/>
								<span class="flex-1 text-sm text-gray-300 truncate text-left">{session.title}</span>
							</button>
						))
					)}
				</CollapsibleSection>
			</div>
		</div>
	);
}
