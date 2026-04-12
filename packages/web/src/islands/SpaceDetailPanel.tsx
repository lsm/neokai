/**
 * SpaceDetailPanel
 *
 * Space-specific context panel for the three-column layout.
 * Prioritizes fast access to overview, review work, and sessions.
 */

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { CollapsibleSection } from '../components/room/CollapsibleSection';
import { createSession } from '../lib/api-helpers';
import { spaceStore } from '../lib/space-store';
import {
	navigateToSpace,
	navigateToSpaceAgent,
	navigateToSpaceSession,
	navigateToSpaceTask,
	navigateToSpaceTasks,
} from '../lib/router';
import {
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceViewModeSignal,
} from '../lib/signals';
import { cn } from '../lib/utils';

type TaskTab = 'active' | 'action';

const sessionStatusColors: Record<string, string> = {
	active: 'bg-green-500',
	pending_worktree_choice: 'bg-amber-500',
	paused: 'bg-amber-500',
	ended: 'bg-gray-500',
};

const taskStatusColors: Record<string, string> = {
	open: 'bg-gray-500',
	in_progress: 'bg-blue-500',
	blocked: 'bg-amber-500',
	review: 'bg-purple-500',
	done: 'bg-green-500',
	cancelled: 'bg-gray-600',
	archived: 'bg-gray-700',
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

function TaskTabButton({
	label,
	count,
	active,
	onClick,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			class={cn(
				'flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors',
				active ? 'bg-dark-600 text-gray-200' : 'text-gray-500 hover:text-gray-300'
			)}
		>
			<span>{label}</span>
			<span class="rounded-full bg-dark-800 px-1.5 py-px text-[10px] text-gray-400">{count}</span>
		</button>
	);
}

export function SpaceDetailPanel({ spaceId, onNavigate }: SpaceDetailPanelProps) {
	const isLoading = spaceStore.loading.value;
	const loadedSpaceId = spaceStore.spaceId.value;
	const tasks = spaceStore.tasks.value;
	const space = spaceStore.space.value;

	const isReady = !isLoading && loadedSpaceId === spaceId;

	if (!isReady) {
		return (
			<div class="flex-1 flex items-center justify-center p-6">
				<span class="text-xs text-gray-600">Loading…</span>
			</div>
		);
	}

	const selectedSessionId = currentSpaceSessionIdSignal.value;
	const selectedTaskId = currentSpaceTaskIdSignal.value;
	const spaceAgentSessionId = `space:chat:${spaceId}`;

	const [taskTab, setTaskTab] = useState<TaskTab>('action');

	// Auto-switch tab when selectedTaskId or task status changes
	useEffect(() => {
		if (!selectedTaskId) return;
		const task = tasks.find((t) => t.id === selectedTaskId);
		if (!task) return;
		const isActive = task.status === 'open' || task.status === 'in_progress';
		const isAction = task.status === 'blocked' || task.status === 'review';
		if (isActive && taskTab !== 'active') setTaskTab('active');
		else if (isAction && taskTab !== 'action') setTaskTab('action');
	}, [selectedTaskId, tasks]);

	const isOverviewSelected =
		selectedSessionId === null &&
		selectedTaskId === null &&
		currentSpaceViewModeSignal.value === 'overview';
	const isSpaceAgentSelected = selectedSessionId === spaceAgentSessionId;
	const isTasksSelected = currentSpaceViewModeSignal.value === 'tasks';

	const attentionCount = spaceStore.attentionCount.value;

	const { activeCount, actionCount } = useMemo(() => {
		let active = 0;
		let action = 0;
		for (const task of tasks) {
			if (task.status === 'open' || task.status === 'in_progress') active++;
			else if (task.status === 'blocked' || task.status === 'review') action++;
		}
		return { activeCount: active, actionCount: action };
	}, [tasks]);

	const tasksForTab = useMemo(() => {
		const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
		let filtered: typeof sorted;

		if (taskTab === 'action') {
			filtered = sorted.filter((task) => task.status === 'blocked' || task.status === 'review');
		} else {
			filtered = sorted.filter((task) => task.status === 'open' || task.status === 'in_progress');
		}

		// Always include the selected task even if it doesn't match the current tab filter
		if (selectedTaskId && !filtered.some((t) => t.id === selectedTaskId)) {
			const selected = sorted.find((t) => t.id === selectedTaskId);
			if (selected) filtered.push(selected);
		}

		return filtered;
	}, [tasks, taskTab, selectedTaskId]);

	const sessions = useMemo(() => {
		const storeSessions = spaceStore.sessions.value;
		const isSystemSpaceSession = (sessionId: string): boolean =>
			sessionId.startsWith(`space:${spaceId}:task:`) ||
			sessionId.startsWith(`space:${spaceId}:workflow:`);

		return storeSessions.filter((s) => !isSystemSpaceSession(s.id));
	}, [spaceStore.sessions.value, spaceId]);

	const handleOverviewClick = useCallback(() => {
		navigateToSpace(spaceId);
		onNavigate?.();
	}, [spaceId, onNavigate]);

	const handleSpaceAgentClick = useCallback(() => {
		navigateToSpaceAgent(spaceId);
		onNavigate?.();
	}, [spaceId, onNavigate]);

	const handleTasksClick = useCallback(() => {
		navigateToSpaceTasks(spaceId);
		onNavigate?.();
	}, [spaceId, onNavigate]);

	const handleTaskClick = useCallback(
		(taskId: string) => {
			navigateToSpaceTask(spaceId, taskId);
			onNavigate?.();
		},
		[spaceId, onNavigate]
	);

	const handleSessionClick = useCallback(
		(sessionId: string) => {
			navigateToSpaceSession(spaceId, sessionId);
			onNavigate?.();
		},
		[spaceId, onNavigate]
	);

	const handleCreateSession = useCallback(
		async (e: Event) => {
			e.stopPropagation();
			try {
				const response = await createSession({
					spaceId,
					workspacePath: space?.workspacePath,
				});
				navigateToSpaceSession(spaceId, response.sessionId);
				onNavigate?.();
			} catch {
				// Session creation failed silently
			}
		},
		[spaceId, space?.workspacePath, onNavigate]
	);

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			<button
				onClick={handleOverviewClick}
				data-testid="space-detail-dashboard"
				data-active={isOverviewSelected ? 'true' : 'false'}
				class={cn(
					'mx-3 mt-3 w-auto rounded-xl px-3 py-2.5 flex items-center gap-2.5 transition-colors border',
					isOverviewSelected
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
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Overview</span>
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

			<button
				onClick={handleTasksClick}
				data-testid="space-detail-tasks"
				data-active={isTasksSelected ? 'true' : 'false'}
				class={cn(
					'mx-3 mt-2 w-auto rounded-xl px-3 py-2.5 flex items-center gap-2.5 transition-colors border',
					isTasksSelected
						? 'bg-dark-700 border-dark-600'
						: 'bg-transparent border-transparent hover:bg-dark-800 hover:border-dark-700'
				)}
			>
				<div class="w-6 h-6 flex-shrink-0 flex items-center justify-center bg-green-900/40 rounded">
					<svg
						class="w-3.5 h-3.5 text-green-400"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m0 0h-2"
						/>
					</svg>
				</div>
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Tasks</span>
				{attentionCount > 0 && (
					<span class="flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-amber-600 text-white text-xs font-medium flex items-center justify-center tabular-nums">
						{attentionCount}
					</span>
				)}
			</button>

			<div class="border-t border-dark-700 mx-3 my-3" />

			<div class="flex-1 overflow-y-auto">
				<CollapsibleSection title="Tasks">
					<div class="flex items-center gap-1 px-3 py-1.5">
						<TaskTabButton
							label="Active"
							count={activeCount}
							active={taskTab === 'active'}
							onClick={() => setTaskTab('active')}
						/>
						<TaskTabButton
							label="Action"
							count={actionCount}
							active={taskTab === 'action'}
							onClick={() => setTaskTab('action')}
						/>
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
								</div>
							</button>
						))
					)}
				</CollapsibleSection>

				<CollapsibleSection
					title="Sessions"
					count={sessions.length}
					defaultExpanded={true}
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
										sessionStatusColors[session.status] ?? 'bg-gray-500'
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
