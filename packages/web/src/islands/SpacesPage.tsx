/**
 * SpacesPage - List of all spaces with recent activity
 *
 * Shows all spaces as cards with their recent task activity.
 * Clicking a card navigates to the space detail view.
 */

import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../lib/space-store.ts';
import { navigateToSpace } from '../lib/router.ts';
import { cn, getRelativeTime } from '../lib/utils.ts';
import type { SpaceSessionSummary, SpaceWithTasks } from '../lib/space-store.ts';
import type { SpaceTask } from '@neokai/shared';
import { borderColors } from '../lib/design-tokens.ts';
import { SpaceCreateDialog } from '../components/space/SpaceCreateDialog.tsx';

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

const SESSION_STATUS_COLORS: Record<string, string> = {
	active: 'bg-green-400',
	paused: 'bg-amber-400',
	ended: 'bg-gray-500',
	pending_worktree_choice: 'bg-blue-400',
};

function SessionRow({ session }: { session: SpaceSessionSummary }) {
	const dotColor = SESSION_STATUS_COLORS[session.status] ?? 'bg-gray-400';
	const label = session.title || session.id.slice(0, 20);
	return (
		<div class="flex items-center gap-2 py-1.5">
			<div class={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColor)} />
			<span class="text-xs text-gray-500 truncate flex-1 italic">{label}</span>
			<span class="text-xs text-gray-600 flex-shrink-0 tabular-nums">
				{getRelativeTime(session.lastActiveAt)}
			</span>
		</div>
	);
}

/** Block reasons that indicate a task needs human attention */
const ATTENTION_REASONS = ['human_input_requested', 'gate_rejected'];

function SpaceCard({ space }: { space: SpaceWithTasks }) {
	const activeTasks = space.tasks.filter(
		(t) => t.status === 'open' || t.status === 'in_progress' || t.status === 'review'
	);
	const attentionTasks = space.tasks.filter(
		(t) =>
			t.status === 'review' ||
			(t.status === 'blocked' && ATTENTION_REASONS.includes(t.blockReason ?? ''))
	);
	const recentTasks = [...space.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
	const activeSessions = (space.sessions ?? []).filter((s) => s.status === 'active').slice(0, 3);

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
				<div class="flex items-center gap-1.5 flex-shrink-0">
					{attentionTasks.length > 0 && (
						<span class="rounded-full bg-amber-900/50 border border-amber-800/40 px-2 py-0.5 text-xs font-medium text-amber-300 tabular-nums">
							{attentionTasks.length} action
						</span>
					)}
					{activeTasks.length > 0 && (
						<span class="rounded-full bg-blue-900/50 border border-blue-800/40 px-2 py-0.5 text-xs font-medium text-blue-300 tabular-nums">
							{activeTasks.length} active
						</span>
					)}
				</div>
			</div>

			{/* Active sessions */}
			{activeSessions.length > 0 && (
				<div class="border-t border-dark-700/60 pt-3 flex flex-col">
					<div class="text-xs font-medium text-gray-600 mb-1">Sessions</div>
					{activeSessions.map((session) => (
						<SessionRow key={session.id} session={session} />
					))}
				</div>
			)}

			{/* Recent tasks */}
			{recentTasks.length > 0 ? (
				<div
					class={cn(
						'flex flex-col',
						activeSessions.length === 0 && 'border-t border-dark-700/60 pt-3'
					)}
				>
					{activeSessions.length > 0 && (
						<div class="text-xs font-medium text-gray-600 mb-1 mt-2">Tasks</div>
					)}
					{recentTasks.map((task) => (
						<TaskRow key={task.id} task={task} />
					))}
				</div>
			) : activeSessions.length === 0 ? (
				<div class="border-t border-dark-700/60 pt-3">
					<p class="text-xs text-gray-600 italic">No tasks yet</p>
				</div>
			) : null}
		</button>
	);
}

export function SpacesPage() {
	const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

	useEffect(() => {
		spaceStore.initGlobalList().catch(() => {
			// Error tracked inside initGlobalList
		});
	}, []);

	const spaces = spaceStore.spacesWithTasks.value;
	const activeSpaces = spaces.filter((s) => s.status === 'active');

	return (
		<div class="flex-1 min-h-0 flex flex-col">
			<SpaceCreateDialog isOpen={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />

			{/* Sticky header — matches SpacePageHeader pattern */}
			<div
				class={`flex-shrink-0 bg-dark-850 border-b ${borderColors.ui.default} px-4 py-2.5 relative z-10`}
			>
				<div class="flex items-center gap-3">
					<div class="flex-1 min-w-0 flex items-center justify-between">
						<h1 class="text-sm font-semibold text-gray-100">Spaces</h1>
						<div class="flex items-center gap-3">
							<span class="text-xs text-gray-500 tabular-nums">{activeSpaces.length} spaces</span>
							<button
								type="button"
								onClick={() => setCreateSpaceOpen(true)}
								class="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-dark-800 hover:bg-dark-700 border border-dark-600 text-xs text-gray-300 hover:text-gray-100 transition-colors"
							>
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M12 4v16m8-8H4"
									/>
								</svg>
								New Space
							</button>
						</div>
					</div>
				</div>
			</div>

			<div class="flex-1 min-h-0 overflow-y-auto">
				<div class="max-w-5xl mx-auto px-4 sm:px-6 py-6">
					{activeSpaces.length === 0 ? (
						<div class="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto">
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
							<h2 class="text-base font-semibold text-gray-200 mb-2">No spaces yet</h2>
							<p class="text-sm text-gray-500 leading-relaxed">
								Spaces are isolated project environments where AI agents collaborate on tasks. Each
								space maps to a codebase directory with its own sessions, tasks, and workflows.
							</p>
							<button
								type="button"
								onClick={() => setCreateSpaceOpen(true)}
								class="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
							>
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M12 4v16m8-8H4"
									/>
								</svg>
								Create Your First Space
							</button>
						</div>
					) : (
						<div class="flex flex-col gap-6">
							<p class="text-sm text-gray-500">
								Spaces are isolated project environments where AI agents collaborate on tasks. Each
								space maps to a codebase directory with its own sessions, tasks, and workflows.
							</p>
							<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{activeSpaces.map((space) => (
									<SpaceCard key={space.id} space={space} />
								))}
								<button
									type="button"
									onClick={() => setCreateSpaceOpen(true)}
									class="w-full rounded-xl border border-dashed border-dark-600 hover:border-dark-500 bg-transparent hover:bg-dark-900/40 transition-all p-5 flex flex-col items-center justify-center gap-2 min-h-[120px]"
								>
									<svg
										class="w-8 h-8 text-gray-600"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={1.5}
											d="M12 4v16m8-8H4"
										/>
									</svg>
									<span class="text-xs text-gray-500">New Space</span>
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
