/**
 * SpaceDetailPanel
 *
 * Space-specific context panel for the three-column layout.
 * Prioritizes fast access to overview, review work, and sessions.
 */

import { useMemo, useState } from 'preact/hooks';
import { CollapsibleSection } from '../components/room/CollapsibleSection';
import { spaceStore } from '../lib/space-store';
import { navigateToSpace, navigateToSpaceAgent, navigateToSpaceTask, navigateToSpaceTasks } from '../lib/router';
import {
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceViewModeSignal,
	spaceOverlaySessionIdSignal,
	spaceOverlayAgentNameSignal,
} from '../lib/signals';
import { cn } from '../lib/utils';

type TaskTab = 'active' | 'review';

const taskStatusColors: Record<string, string> = {
	open: 'bg-gray-500',
	in_progress: 'bg-blue-500',
	blocked: 'bg-amber-500',
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

	const [taskTab, setTaskTab] = useState<TaskTab>('review');

	const selectedSessionId = currentSpaceSessionIdSignal.value;
	const selectedTaskId = currentSpaceTaskIdSignal.value;
	const selectedTask = selectedTaskId
		? (tasks.find((task) => task.id === selectedTaskId) ?? null)
		: null;
	const spaceAgentSessionId = `space:chat:${spaceId}`;

	const isOverviewSelected =
		selectedSessionId === null && selectedTaskId === null && currentSpaceViewModeSignal.value === 'overview';
	const isSpaceAgentSelected = selectedSessionId === spaceAgentSessionId;
	const isTasksSelected = currentSpaceViewModeSignal.value === 'tasks';

	const activeCount = tasks.filter(
		(task) => task.status === 'open' || task.status === 'in_progress'
	).length;
	const reviewCount = tasks.filter((task) => task.status === 'blocked').length;

	const tasksForTab = useMemo(() => {
		const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
		let filtered: typeof sorted;

		if (taskTab === 'review') {
			filtered = sorted.filter((task) => task.status === 'blocked');
		} else {
			filtered = sorted.filter((task) => task.status === 'open' || task.status === 'in_progress');
		}

		if (selectedTaskId && !filtered.some((task) => task.id === selectedTaskId)) {
			const selected = sorted.find((task) => task.id === selectedTaskId);
			if (selected) {
				filtered = [selected, ...filtered];
			}
		}

		return filtered;
	}, [tasks, taskTab, selectedTaskId]);

	const sessions = useMemo(() => {
		const list: { id: string; title: string }[] = [];
		const seen = new Set<string>();
		const isSystemSpaceSession = (sessionId: string): boolean =>
			sessionId === spaceAgentSessionId ||
			sessionId.startsWith(`space:${spaceId}:task:`) ||
			sessionId.startsWith(`space:${spaceId}:workflow:`);

		if (space?.sessionIds) {
			for (const sessionId of space.sessionIds) {
				if (isSystemSpaceSession(sessionId) || seen.has(sessionId)) {
					continue;
				}
				list.push({ id: sessionId, title: sessionId.slice(0, 8) });
				seen.add(sessionId);
			}
		}

		return list;
	}, [space, spaceAgentSessionId, spaceId]);

	const handleOverviewClick = () => {
		navigateToSpace(spaceId);
		onNavigate?.();
	};

	const handleSpaceAgentClick = () => {
		navigateToSpaceAgent(spaceId);
		onNavigate?.();
	};

	const handleTasksClick = () => {
		navigateToSpaceTasks(spaceId);
		onNavigate?.();
	};

	const handleTaskClick = (taskId: string) => {
		navigateToSpaceTask(spaceId, taskId);
		onNavigate?.();
	};

	const handleSessionClick = (sessionId: string) => {
		// Use the truncated session ID as a human-readable label (matches what's displayed in the list)
		spaceOverlayAgentNameSignal.value = sessionId.slice(0, 8);
		spaceOverlaySessionIdSignal.value = sessionId;
		onNavigate?.();
	};

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
							label="Review"
							count={reviewCount}
							active={taskTab === 'review'}
							onClick={() => setTaskTab('review')}
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
									<span class="block text-[11px] uppercase tracking-[0.14em] text-gray-600">
										Task
										{selectedTask?.id === task.id &&
											task.status !== 'open' &&
											task.status !== 'in_progress' &&
											` · ${task.status.replace('_', ' ')}`}
									</span>
								</div>
							</button>
						))
					)}
				</CollapsibleSection>

				<CollapsibleSection title="Sessions" count={sessions.length} defaultExpanded={true}>
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
