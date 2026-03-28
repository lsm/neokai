/**
 * SpaceDetailPanel
 *
 * Space-specific context panel for the three-column layout.
 * Mirrors RoomContextPanel's visual structure for a space:
 * 1. Space activity header (no status counters)
 * 2. Pinned items: Dashboard, Space Agent
 * 3. Tasks section (single task list with active/review filters)
 * 4. Sessions section (collapsible, default collapsed)
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

type OrphanTab = 'active' | 'review';

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

function TaskStatusDot({ status }: { status: string }) {
	return (
		<div
			class={cn('w-2 h-2 rounded-full flex-shrink-0', taskStatusColors[status] ?? 'bg-gray-500')}
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

	const [taskTab, setTaskTab] = useState<OrphanTab>('active');

	// Selection state
	const selectedSessionId = currentSpaceSessionIdSignal.value;
	const selectedTaskId = currentSpaceTaskIdSignal.value;
	const selectedTask = selectedTaskId ? (tasks.find((t) => t.id === selectedTaskId) ?? null) : null;
	const spaceAgentSessionId = `space:chat:${spaceId}`;

	const isDashboardSelected = selectedSessionId === null && selectedTaskId === null;
	const isSpaceAgentSelected = selectedSessionId === spaceAgentSessionId;

	// Tasks filtered by tab.
	// rate_limited/usage_limited are grouped with active.
	const tasksForTab = useMemo(() => {
		const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
		let filtered: typeof sorted;
		if (taskTab === 'active') {
			filtered = sorted.filter(
				(t) =>
					t.status === 'draft' ||
					t.status === 'pending' ||
					t.status === 'in_progress' ||
					t.status === 'rate_limited' ||
					t.status === 'usage_limited'
			);
		} else {
			filtered = sorted.filter((t) => t.status === 'review' || t.status === 'needs_attention');
		}

		// Keep the currently open task visible even if the tab filter would hide it.
		// This avoids "No tasks" in the list while the user is actively viewing a task.
		if (selectedTaskId && !filtered.some((t) => t.id === selectedTaskId)) {
			const selected = sorted.find((t) => t.id === selectedTaskId);
			if (selected) {
				filtered = [selected, ...filtered];
			}
		}
		return filtered;
	}, [tasks, taskTab, selectedTaskId]);

	// Sessions list: only manually created sessions from space.sessionIds.
	// Excludes built-in Space Agent + task/workflow orchestration sessions.
	const sessions = useMemo(() => {
		const list: { id: string; title: string }[] = [];
		const seen = new Set<string>();
		const isSystemSpaceSession = (sid: string): boolean =>
			sid === spaceAgentSessionId ||
			sid.startsWith(`space:${spaceId}:task:`) ||
			sid.startsWith(`space:${spaceId}:workflow:`);

		if (space?.sessionIds) {
			for (const sid of space.sessionIds) {
				if (isSystemSpaceSession(sid)) {
					continue;
				}
				if (!seen.has(sid)) {
					list.push({ id: sid, title: sid.slice(0, 8) });
					seen.add(sid);
				}
			}
		}

		return list;
	}, [space, spaceAgentSessionId, spaceId]);

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

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			<div class="px-3 pt-3 pb-2 space-y-3 border-b border-dark-800">
				<div class="space-y-1 px-1 pb-1">
					<p class="text-[11px] uppercase tracking-[0.18em] text-gray-600">Space Activity</p>
					<p class="text-xs text-gray-500">
						{tasks.length === 0
							? 'No tasks yet.'
							: 'Use Tasks and Space Agent to monitor and steer ongoing work.'}
					</p>
					{space?.workspacePath && (
						<p class="truncate font-mono text-[11px] text-gray-600">{space.workspacePath}</p>
					)}
				</div>
			</div>

			{/* Pinned items */}
			<button
				onClick={handleDashboardClick}
				data-testid="space-detail-dashboard"
				data-active={isDashboardSelected ? 'true' : 'false'}
				class={cn(
					'mx-3 mt-3 w-auto rounded-xl px-3 py-2.5 flex items-center gap-2.5 transition-colors border',
					isDashboardSelected
						? 'bg-dark-700 border-dark-600'
						: 'bg-transparent border-transparent hover:bg-dark-800 hover:border-dark-700'
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
					'mx-3 mt-2 w-auto rounded-xl px-3 py-2.5 flex items-center gap-2.5 transition-colors border',
					isSpaceAgentSelected
						? 'bg-dark-700 border-dark-600'
						: 'bg-transparent border-transparent hover:bg-dark-800 hover:border-dark-700'
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
			<div class="border-t border-dark-700 mx-3 my-3" />

			{/* Scrollable sections */}
			<div class="flex-1 overflow-y-auto">
				{/* Tasks section */}
				<CollapsibleSection title="Tasks">
					{/* Tab bar */}
					<div class="flex items-center gap-1 px-3 py-1.5">
						{(['active', 'review'] as const).map((tab) => (
							<button
								key={tab}
								onClick={() => setTaskTab(tab)}
								class={cn(
									'px-2 py-0.5 text-xs rounded transition-colors capitalize',
									taskTab === tab
										? 'bg-dark-600 text-gray-200'
										: 'text-gray-500 hover:text-gray-300'
								)}
							>
								{tab}
							</button>
						))}
					</div>
					{tasksForTab.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No tasks</div>
					) : (
						tasksForTab.map((task) => (
							<button
								key={task.id}
								onClick={() => handleTaskClick(task.id)}
								class={cn(
									'w-full px-3 py-1.5 flex items-center gap-2 transition-colors text-left',
									selectedTaskId === task.id ? 'bg-dark-700' : 'hover:bg-dark-800'
								)}
							>
								<TaskStatusDot status={task.status} />
								<div class="min-w-0 flex-1">
									<span class="block text-sm text-gray-400 truncate">{task.title}</span>
									<span class="block text-[11px] uppercase tracking-[0.14em] text-gray-600">
										{task.workflowRunId ? 'Workflow task' : 'Standalone task'}
										{selectedTask?.id === task.id &&
											selectedTask.status !== 'draft' &&
											selectedTask.status !== 'pending' &&
											selectedTask.status !== 'in_progress' &&
											selectedTask.status !== 'rate_limited' &&
											selectedTask.status !== 'usage_limited' &&
											` · ${selectedTask.status.replace('_', ' ')}`}
									</span>
								</div>
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
								<div class="w-2 h-2 rounded-full flex-shrink-0 bg-gray-500" />
								<span class="flex-1 text-sm text-gray-300 truncate text-left">{session.title}</span>
							</button>
						))
					)}
				</CollapsibleSection>
			</div>
		</div>
	);
}
