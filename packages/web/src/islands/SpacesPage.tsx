/**
 * SpacesPage - List of all spaces with recent activity
 *
 * Shows all spaces as cards with their recent task activity.
 * Clicking a card navigates to the space detail view.
 */

import { useEffect } from 'preact/hooks';
import { spaceStore } from '../lib/space-store.ts';
import { navigateToSpace } from '../lib/router.ts';
import { cn, getRelativeTime } from '../lib/utils.ts';
import type { SpaceWithTasks } from '../lib/space-store.ts';
import type { SpaceTask } from '@neokai/shared';

const STATUS_COLORS: Record<string, string> = {
	in_progress: 'bg-blue-400',
	open: 'bg-gray-400',
	blocked: 'bg-amber-400',
	review: 'bg-purple-400',
	done: 'bg-green-400',
	cancelled: 'bg-gray-500',
	archived: 'bg-gray-600',
};

function TaskRow({ task }: { task: SpaceTask }) {
	const dotColor = STATUS_COLORS[task.status] ?? 'bg-gray-400';
	return (
		<div class="flex items-center gap-2 py-1.5">
			<div class={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColor)} />
			<span class="text-xs text-gray-400 truncate flex-1">{task.title}</span>
			<span class="text-xs text-gray-600 flex-shrink-0 tabular-nums">
				{getRelativeTime(task.updatedAt)}
			</span>
		</div>
	);
}

function SpaceCard({ space }: { space: SpaceWithTasks }) {
	const activeTasks = space.tasks.filter(
		(t) => t.status === 'open' || t.status === 'in_progress' || t.status === 'review'
	);
	const recentTasks = [...space.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

	return (
		<button
			type="button"
			onClick={() => navigateToSpace(space.id)}
			class="w-full text-left rounded-xl border border-dark-700 bg-dark-900/60 hover:bg-dark-850 hover:border-dark-600 transition-all p-5 flex flex-col gap-3"
		>
			{/* Header */}
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<h3 class="text-sm font-semibold text-gray-100 truncate">{space.name}</h3>
					{space.description && (
						<p class="text-xs text-gray-500 mt-0.5 line-clamp-2">{space.description}</p>
					)}
				</div>
				{activeTasks.length > 0 && (
					<span class="flex-shrink-0 rounded-full bg-blue-900/50 border border-blue-800/40 px-2 py-0.5 text-xs font-medium text-blue-300 tabular-nums">
						{activeTasks.length} active
					</span>
				)}
			</div>

			{/* Recent tasks */}
			{recentTasks.length > 0 ? (
				<div class="border-t border-dark-700/60 pt-3 flex flex-col">
					{recentTasks.map((task) => (
						<TaskRow key={task.id} task={task} />
					))}
				</div>
			) : (
				<div class="border-t border-dark-700/60 pt-3">
					<p class="text-xs text-gray-600 italic">No tasks yet</p>
				</div>
			)}
		</button>
	);
}

export function SpacesPage() {
	useEffect(() => {
		spaceStore.initGlobalList().catch(() => {
			// Error tracked inside initGlobalList
		});
	}, []);

	const spaces = spaceStore.spacesWithTasks.value;
	const activeSpaces = spaces.filter((s) => s.status === 'active');

	return (
		<div class="flex-1 min-h-0 overflow-y-auto">
			<div class="max-w-5xl mx-auto px-6 py-8">
				<div class="flex items-center justify-between mb-6">
					<h1 class="text-lg font-semibold text-gray-100">Spaces</h1>
					<span class="text-sm text-gray-500 tabular-nums">{activeSpaces.length} spaces</span>
				</div>

				{activeSpaces.length === 0 ? (
					<div class="flex flex-col items-center justify-center py-20 text-center">
						<svg
							class="w-12 h-12 text-gray-700 mb-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={1.5}
								d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
							/>
						</svg>
						<p class="text-sm text-gray-500">No spaces yet</p>
						<p class="text-xs text-gray-600 mt-1">Create a space to get started</p>
					</div>
				) : (
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
						{activeSpaces.map((space) => (
							<SpaceCard key={space.id} space={space} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
