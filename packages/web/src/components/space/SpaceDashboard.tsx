/**
 * SpaceDashboard
 *
 * Task-centric overview for a Space.
 * Prioritizes:
 * - What needs attention now
 * - What is actively moving
 * - What finished recently
 * - The next action a human should take
 */

import type { ComponentChildren, ComponentType } from 'preact';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';

interface SpaceDashboardProps {
	spaceId: string;
	onOpenSpaceAgent?: () => void;
	onSelectTask?: (taskId: string) => void;
	compact?: boolean;
}

function truncatePath(path: string, maxLen = 64): string {
	if (path.length <= maxLen) return path;
	return '…' + path.slice(-(maxLen - 1));
}

function ActionButton({
	title,
	description,
	icon: Icon,
	onClick,
	tone = 'secondary',
}: {
	title: string;
	description: string;
	icon: ComponentType;
	onClick?: () => void;
	tone?: 'primary' | 'secondary';
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			class={cn(
				'w-full rounded-2xl border px-4 py-4 text-left transition-all',
				tone === 'primary'
					? 'border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/15'
					: 'border-dark-700 bg-dark-900/70 hover:border-dark-600 hover:bg-dark-900'
			)}
		>
			<div class="flex items-start gap-3">
				<div
					class={cn(
						'mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl',
						tone === 'primary' ? 'bg-blue-500/15 text-blue-200' : 'bg-dark-800 text-gray-300'
					)}
				>
					<Icon />
				</div>
				<div class="min-w-0">
					<p
						class={cn('text-sm font-medium', tone === 'primary' ? 'text-blue-50' : 'text-gray-100')}
					>
						{title}
					</p>
					<p class="mt-1 text-xs leading-5 text-gray-500">{description}</p>
				</div>
			</div>
		</button>
	);
}

function StatCard({
	label,
	value,
	helper,
	accent,
}: {
	label: string;
	value: string;
	helper: string;
	accent: string;
}) {
	return (
		<div class="rounded-2xl border border-dark-700 bg-dark-900/70 px-4 py-4">
			<div class="flex items-center justify-between gap-3">
				<p class="text-[11px] uppercase tracking-[0.18em] text-gray-500">{label}</p>
				<span class={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', accent)} />
			</div>
			<p class="mt-2 text-2xl font-semibold text-gray-100">{value}</p>
			<p class="mt-1 text-xs text-gray-500">{helper}</p>
		</div>
	);
}

function QueueItem({
	task,
	onClick,
}: {
	task: {
		id: string;
		title: string;
		status: string;
		workflowRunId?: string;
		currentStep?: string | null;
	};
	onClick?: (taskId: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onClick?.(task.id)}
			disabled={!onClick}
			class={cn(
				'w-full rounded-2xl border border-dark-700 bg-dark-900/60 px-4 py-3 text-left',
				onClick && 'transition-colors hover:border-dark-600 hover:bg-dark-900'
			)}
		>
			<div class="flex items-start gap-3">
				<div class="pt-1">
					<span
						class={cn(
							'block h-2.5 w-2.5 rounded-full',
							task.status === 'in_progress'
								? 'bg-blue-400'
								: task.status === 'review'
									? 'bg-purple-400'
									: task.status === 'needs_attention'
										? 'bg-amber-400'
										: task.status === 'completed'
											? 'bg-green-400'
											: 'bg-gray-500'
						)}
					/>
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<p class="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{task.title}</p>
						<span class="text-[11px] uppercase tracking-[0.14em] text-gray-500">
							{task.status.replace('_', ' ')}
						</span>
					</div>
					<p class="mt-1 text-xs text-gray-500">
						{task.currentStep ||
							(task.workflowRunId ? 'Part of a workflow-backed task flow.' : 'Standalone task.')}
					</p>
				</div>
			</div>
		</button>
	);
}

function Section({
	title,
	eyebrow,
	children,
}: {
	title: string;
	eyebrow?: string;
	children: ComponentChildren;
}) {
	return (
		<section class="rounded-2xl border border-dark-700 bg-dark-950/70 p-4">
			<div class="mb-3 flex items-center justify-between gap-3">
				<div>
					<p class="text-[11px] uppercase tracking-[0.18em] text-gray-600">{eyebrow ?? title}</p>
					<h2 class="mt-1 text-sm font-medium text-gray-100">{title}</h2>
				</div>
			</div>
			{children}
		</section>
	);
}

function EmptyState({
	title,
	copy,
	fill = false,
}: {
	title: string;
	copy: string;
	fill?: boolean;
}) {
	return (
		<div
			class={cn(
				'rounded-2xl border border-dashed border-dark-700 bg-dark-900/40 px-5 py-8 text-center',
				fill && 'h-full'
			)}
		>
			<div class={cn(fill && 'flex min-h-full flex-col items-center justify-center')}>
				<p class="text-sm text-gray-200">{title}</p>
				<p class="mt-2 text-sm text-gray-500">{copy}</p>
			</div>
		</div>
	);
}

function SparkIcon() {
	return (
		<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1L12 3z"
			/>
		</svg>
	);
}

export function SpaceDashboard({
	spaceId: _spaceId,
	onOpenSpaceAgent,
	onSelectTask,
	compact = false,
}: SpaceDashboardProps) {
	const space = spaceStore.space.value;
	const loading = spaceStore.loading.value;
	const tasks = spaceStore.tasks.value;

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

	const activeTasks = tasks.filter(
		(task) =>
			task.status === 'draft' ||
			task.status === 'pending' ||
			task.status === 'in_progress' ||
			task.status === 'rate_limited' ||
			task.status === 'usage_limited'
	);
	const reviewTasks = tasks.filter(
		(task) => task.status === 'review' || task.status === 'needs_attention'
	);
	const completedTasks = tasks.filter(
		(task) =>
			task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived'
	);
	const recentCompleted = [...completedTasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
	const activeQueue = [...activeTasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
	const attentionQueue = [...reviewTasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
	const totalTasks = tasks.length;
	const empty = totalTasks === 0;
	const description =
		space.description ||
		'Organize execution through tasks, use workflows when they help, and keep the space agent nearby for coordination.';

	return (
		<div class={cn('flex h-full min-h-0 flex-col overflow-y-auto', compact ? 'p-4' : 'p-6')}>
			<div class="flex w-full flex-1 min-h-0 flex-col gap-6">
				<section class="rounded-[28px] border border-dark-700 bg-dark-900/90 px-6 py-6">
					<div class="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
						<div class="min-w-0">
							<p class="text-[11px] uppercase tracking-[0.22em] text-gray-600">Overview</p>
							<h1 class="mt-3 text-3xl font-semibold tracking-tight text-gray-100">{space.name}</h1>
							<p class="mt-3 max-w-3xl text-sm leading-6 text-gray-400">{description}</p>
							{space.workspacePath && (
								<p class="mt-3 font-mono text-[11px] text-gray-600" title={space.workspacePath}>
									{truncatePath(space.workspacePath)}
								</p>
							)}
						</div>
						<div class="w-full xl:w-[22rem]">
							<ActionButton
								title="Ask Space Agent"
								description="Use the shared agent thread to shape the task, refine the scope, and let the system choose the right workflow behind the scenes."
								icon={SparkIcon}
								onClick={onOpenSpaceAgent}
								tone="primary"
							/>
						</div>
					</div>
				</section>

				<div class="grid gap-4 md:grid-cols-3">
					<StatCard
						label="Active"
						value={String(activeTasks.length)}
						helper={
							activeTasks.length === 0 ? 'Nothing is running right now.' : 'Tasks currently moving.'
						}
						accent="bg-blue-400"
					/>
					<StatCard
						label="Needs Attention"
						value={String(reviewTasks.length)}
						helper={
							reviewTasks.length === 0
								? 'Nothing is waiting on you.'
								: 'Review or unblock these tasks next.'
						}
						accent="bg-amber-400"
					/>
					<StatCard
						label="Completed"
						value={String(completedTasks.length)}
						helper={
							completedTasks.length === 0
								? 'No finished work yet.'
								: 'Completed work in this space.'
						}
						accent="bg-green-400"
					/>
				</div>

				{empty ? (
					<div class="flex flex-1 min-h-[22rem]">
						<div class="flex h-full flex-1">
							<div class="h-full w-full">
								<EmptyState
									title="This space has no tasks yet."
									copy="Create the first task or ask the space agent to help you shape the work before reaching for a workflow."
									fill
								/>
							</div>
						</div>
					</div>
				) : (
					<div class="grid flex-1 min-h-[24rem] gap-4 xl:grid-cols-[1.1fr_1.1fr_0.9fr]">
						<Section title="Needs Attention" eyebrow="Attention Queue">
							{attentionQueue.length === 0 ? (
								<EmptyState
									title="Nothing is blocked on you."
									copy="Reviews, approvals, and escalations will collect here."
								/>
							) : (
								<div class="space-y-2">
									{attentionQueue.map((task) => (
										<QueueItem key={task.id} task={task} onClick={onSelectTask} />
									))}
								</div>
							)}
						</Section>

						<Section title="In Progress" eyebrow="Active Queue">
							{activeQueue.length === 0 ? (
								<EmptyState
									title="No tasks are moving right now."
									copy="New tasks and workflow-backed work will appear here while active."
								/>
							) : (
								<div class="space-y-2">
									{activeQueue.map((task) => (
										<QueueItem key={task.id} task={task} onClick={onSelectTask} />
									))}
								</div>
							)}
						</Section>

						<Section title="Recently Finished" eyebrow="Recent Activity">
							{recentCompleted.length === 0 ? (
								<EmptyState
									title="Nothing finished yet."
									copy="Completed tasks will form the execution trail for this space."
								/>
							) : (
								<div class="space-y-2">
									{recentCompleted.map((task) => (
										<QueueItem key={task.id} task={task} onClick={onSelectTask} />
									))}
								</div>
							)}
						</Section>
					</div>
				)}
			</div>
		</div>
	);
}
