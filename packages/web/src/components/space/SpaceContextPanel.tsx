/**
 * SpaceContextPanel — Thread-style space list for the Context Panel.
 *
 * Inspired by Codex's thread navigation:
 * - Spaces as expandable threads
 * - Active tasks nested under each space
 * - Click task → navigate to task view
 * - Click space arrow → navigate to space detail
 */

import { useState, useEffect } from 'preact/hooks';
import type { SpaceTask } from '@neokai/shared';
import { navigateToSpace, navigateToSpaceTask } from '../../lib/router.ts';
import { currentSpaceIdSignal, currentSpaceTaskIdSignal } from '../../lib/signals.ts';
import { spaceStore, type SpaceWithTasks } from '../../lib/space-store.ts';
import { cn } from '../../lib/utils.ts';

type SpaceFilter = 'active' | 'archived';

interface SpaceContextPanelProps {
	onSpaceSelect?: () => void;
	onCreateSpace?: () => void;
}

/** Status color for task dots */
function taskStatusColor(status: string): string {
	switch (status) {
		case 'in_progress':
			return 'bg-blue-400';
		case 'review':
			return 'bg-amber-400';
		case 'pending':
			return 'bg-gray-400';
		case 'needs_attention':
			return 'bg-red-400';
		case 'draft':
			return 'bg-gray-500';
		default:
			return 'bg-gray-500';
	}
}

/** Collapsible space row */
function SpaceThread({
	space,
	isCurrentSpace,
	currentTaskId,
	onSelect,
	onSpaceNavigate,
	onTaskClick,
}: {
	space: SpaceWithTasks;
	isCurrentSpace: boolean;
	currentTaskId: string | null;
	onSelect: () => void;
	onSpaceNavigate: () => void;
	onTaskClick: () => void;
}) {
	const hasTasks = space.tasks.length > 0;

	// Auto-expand if this is the current space or if it has tasks
	const [expanded, setExpanded] = useState(true);

	// Auto-expand when this space becomes current
	useEffect(() => {
		if (isCurrentSpace && hasTasks) {
			setExpanded(true);
		}
	}, [isCurrentSpace, hasTasks]);

	return (
		<div class={cn('border-b border-dark-800 last:border-b-0', isCurrentSpace && 'bg-dark-800/50')}>
			{/* Space header row */}
			<div class="flex items-center gap-1 px-2 py-2 group">
				{/* Expand/collapse chevron */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						setExpanded(!expanded);
					}}
					class={cn(
						'p-1 rounded hover:bg-dark-700 transition-colors flex-shrink-0',
						!hasTasks && 'opacity-30 cursor-default'
					)}
					disabled={!hasTasks}
					title={hasTasks ? (expanded ? 'Collapse' : 'Expand') : 'No tasks'}
				>
					<svg
						class={cn('w-3.5 h-3.5 text-gray-400 transition-transform', expanded && 'rotate-90')}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M9 5l7 7-7 7"
						/>
					</svg>
				</button>

				{/* Space name — click to toggle expand */}
				<button
					onClick={() => {
						setExpanded(!expanded);
						onSelect();
					}}
					class={cn(
						'flex-1 min-w-0 text-left px-1 py-1 rounded transition-colors',
						'text-sm font-medium truncate',
						isCurrentSpace ? 'text-gray-100' : 'text-gray-300 hover:text-gray-100'
					)}
					title={space.description || space.name}
				>
					{space.name}
				</button>

				{/* Task count badge */}
				{hasTasks && (
					<span class="flex-shrink-0 px-1.5 py-0.5 text-xs rounded-full bg-dark-700 text-gray-400 tabular-nums">
						{space.tasks.length}
					</span>
				)}

				{/* Navigate to space detail */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						onSpaceNavigate();
					}}
					class={cn(
						'p-1 rounded hover:bg-dark-700 transition-colors flex-shrink-0',
						'opacity-0 group-hover:opacity-100',
						isCurrentSpace && 'opacity-100'
					)}
					title="Open space"
				>
					<svg
						class="w-3.5 h-3.5 text-gray-400"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M9 5l7 7-7 7"
						/>
					</svg>
				</button>
			</div>

			{/* Nested task list */}
			{expanded && hasTasks && (
				<div class="ml-4 border-l border-dark-800">
					{space.tasks.map((task) => (
						<TaskRow
							key={task.id}
							task={task}
							spaceId={space.id}
							isCurrent={currentTaskId === task.id}
							onClick={onTaskClick}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TaskRow({
	task,
	spaceId,
	isCurrent,
	onClick,
}: {
	task: SpaceTask;
	spaceId: string;
	isCurrent: boolean;
	onClick: () => void;
}) {
	const handleClick = () => {
		navigateToSpaceTask(spaceId, task.id);
		onClick();
	};

	return (
		<button
			onClick={handleClick}
			class={cn(
				'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
				'text-xs group',
				isCurrent
					? 'text-blue-300 bg-dark-800/80'
					: 'text-gray-400 hover:text-gray-200 hover:bg-dark-800/50'
			)}
			title={task.description || task.title}
		>
			<span class={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', taskStatusColor(task.status))} />
			<span class="truncate flex-1">{task.title}</span>
		</button>
	);
}

export function SpaceContextPanel({ onSpaceSelect, onCreateSpace }: SpaceContextPanelProps) {
	const [filter, setFilter] = useState<SpaceFilter>('active');
	const currentSpaceId = currentSpaceIdSignal.value;
	const currentTaskId = currentSpaceTaskIdSignal.value;

	const spacesWithTasks = spaceStore.spacesWithTasks.value;
	const filtered = spacesWithTasks.filter((s) => s.status === filter);

	// Sort: spaces with active tasks first, then by most recently updated task
	const sorted = [...filtered].sort((a, b) => {
		if (a.tasks.length > 0 && b.tasks.length === 0) return -1;
		if (a.tasks.length === 0 && b.tasks.length > 0) return 1;
		return 0;
	});

	const handleSpaceNavigate = (spaceId: string) => {
		navigateToSpace(spaceId);
		onSpaceSelect?.();
	};

	const handleTaskClick = () => {
		onSpaceSelect?.();
	};

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Filter tabs */}
			<div class="flex border-b border-dark-700 px-2 pt-2 gap-1">
				{(['active', 'archived'] as const).map((f) => (
					<button
						key={f}
						onClick={() => setFilter(f)}
						class={cn(
							'px-3 py-1.5 text-xs font-medium rounded-t transition-colors capitalize',
							filter === f
								? 'text-gray-100 border-b-2 border-blue-400'
								: 'text-gray-400 hover:text-gray-200'
						)}
					>
						{f}
					</button>
				))}
			</div>

			{/* Space thread list */}
			<div class="flex-1 overflow-y-auto">
				{sorted.length === 0 ? (
					<div class="flex flex-col items-center justify-center p-6 text-center">
						<div class="text-3xl mb-2">🚀</div>
						<p class="text-sm text-gray-400">
							{filter === 'active' ? 'No active spaces' : 'No archived spaces'}
						</p>
						{filter === 'active' && (
							<p class="text-xs text-gray-500 mt-1">Create a space to get started</p>
						)}
					</div>
				) : (
					<nav class="py-1">
						{sorted.map((space) => (
							<SpaceThread
								key={space.id}
								space={space}
								isCurrentSpace={currentSpaceId === space.id}
								currentTaskId={currentTaskId}
								onSelect={() => onSpaceSelect?.()}
								onSpaceNavigate={() => handleSpaceNavigate(space.id)}
								onTaskClick={handleTaskClick}
							/>
						))}
					</nav>
				)}
			</div>

			{/* Create button */}
			{onCreateSpace && (
				<div class="p-3 border-t border-dark-700">
					<button
						onClick={onCreateSpace}
						class="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-gray-100 hover:bg-dark-800 rounded-lg transition-colors"
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 4v16m8-8H4"
							/>
						</svg>
						Create Space
					</button>
				</div>
			)}
		</div>
	);
}
