/**
 * SpaceDashboard
 *
 * Task-first overview for a Space.
 * Spaces are designed for parallel task orchestration, so this view focuses on
 * triage and navigation instead of high-level summary cards.
 */

import type { ComponentType } from 'preact';
import { useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';

interface SpaceDashboardProps {
	spaceId: string;
	onOpenSpaceAgent?: () => void;
	onSelectTask?: (taskId: string) => void;
	compact?: boolean;
}

type OverviewTab = 'active' | 'review' | 'done';

interface TaskGroupConfig {
	id: string;
	title: string;
	description: string;
	tasks: typeof spaceStore.tasks.value;
	tone: 'default' | 'review' | 'done';
}

function truncatePath(path: string, maxLen = 64): string {
	if (path.length <= maxLen) return path;
	return '…' + path.slice(-(maxLen - 1));
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

function ActionButton({
	title,
	description,
	icon: Icon,
	onClick,
}: {
	title: string;
	description: string;
	icon: ComponentType;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			class="w-full rounded-2xl border border-blue-500/40 bg-blue-500/10 px-4 py-4 text-left transition-all hover:bg-blue-500/15"
		>
			<div class="flex items-start gap-3">
				<div class="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-200">
					<Icon />
				</div>
				<div class="min-w-0">
					<p class="text-sm font-medium text-blue-50">{title}</p>
					<p class="mt-1 text-xs leading-5 text-gray-400">{description}</p>
				</div>
			</div>
		</button>
	);
}

function SummaryChip({
	label,
	count,
	tone = 'default',
}: {
	label: string;
	count: number;
	tone?: 'default' | 'review' | 'done';
}) {
	const toneClass =
		tone === 'review'
			? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
			: tone === 'done'
				? 'border-green-500/30 bg-green-500/10 text-green-100'
				: 'border-blue-500/30 bg-blue-500/10 text-blue-100';

	return (
		<div class={cn('rounded-xl border px-3 py-2', toneClass)}>
			<p class="text-[11px] uppercase tracking-[0.18em] text-gray-500">{label}</p>
			<p class="mt-1 text-xl font-semibold">{count}</p>
		</div>
	);
}

function OverviewTabButton({
	label,
	count,
	active,
	onClick,
	tone = 'default',
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
	tone?: 'default' | 'review' | 'done';
}) {
	const activeClass =
		tone === 'review'
			? 'border-amber-400 text-amber-200'
			: tone === 'done'
				? 'border-green-400 text-green-200'
				: 'border-blue-400 text-gray-100';

	return (
		<button
			type="button"
			onClick={onClick}
			class={cn(
				'flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-medium transition-colors',
				active ? activeClass : 'border-transparent text-gray-400 hover:text-gray-200'
			)}
		>
			<span>{label}</span>
			<span class="rounded-full bg-dark-800 px-2 py-0.5 text-xs text-gray-300">{count}</span>
		</button>
	);
}

function TaskRow({
	task,
	onClick,
}: {
	task: {
		id: string;
		taskNumber: number;
		title: string;
		status: string;
		priority: string;
		workflowRunId?: string | null;
		updatedAt: number;
	};
	onClick?: (taskId: string) => void;
}) {
	const statusDotClass =
		task.status === 'in_progress'
			? 'bg-blue-400'
			: task.status === 'blocked'
				? 'bg-amber-400'
				: task.status === 'done'
					? 'bg-green-400'
					: task.status === 'cancelled' || task.status === 'archived'
						? 'bg-gray-600'
						: 'bg-gray-500';

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
					<span class={cn('block h-2.5 w-2.5 rounded-full', statusDotClass)} />
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<p class="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{task.title}</p>
						<span class="text-[11px] uppercase tracking-[0.14em] text-gray-500">
							#{task.taskNumber}
						</span>
					</div>
					<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
						<span class="uppercase tracking-[0.14em]">{task.status.replace('_', ' ')}</span>
						<span>·</span>
						<span class="capitalize">{task.priority} priority</span>
						<span>·</span>
						<span>{task.workflowRunId ? 'Workflow task' : 'Standalone task'}</span>
					</div>
				</div>
			</div>
		</button>
	);
}

function TaskGroup({ group, onSelectTask }: { group: TaskGroupConfig; onSelectTask?: (taskId: string) => void }) {
	const headingToneClass =
		group.tone === 'review'
			? 'text-amber-200'
			: group.tone === 'done'
				? 'text-green-200'
				: 'text-gray-100';

	return (
		<section class="rounded-2xl border border-dark-700 bg-dark-950/70 p-4">
			<div class="mb-3">
				<div class="flex items-center justify-between gap-3">
					<h2 class={cn('text-sm font-medium', headingToneClass)}>{group.title}</h2>
					<span class="rounded-full bg-dark-800 px-2 py-0.5 text-xs text-gray-400">
						{group.tasks.length}
					</span>
				</div>
				<p class="mt-1 text-xs text-gray-500">{group.description}</p>
			</div>
			<div class="space-y-2">
				{group.tasks.map((task) => (
					<TaskRow key={task.id} task={task} onClick={onSelectTask} />
				))}
			</div>
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

function EmptyTabState({ tab }: { tab: OverviewTab }) {
	const copy =
		tab === 'review'
			? {
					title: 'No tasks need attention right now.',
					description: 'Blocked tasks and human follow-ups will collect here first.',
				}
			: tab === 'done'
				? {
						title: 'No finished tasks yet.',
						description: 'Completed, cancelled, and archived tasks will build the execution trail here.',
					}
				: {
						title: 'No active tasks yet.',
						description: 'Queued and in-progress work will appear here once the space starts moving.',
					};

	return <EmptyState title={copy.title} copy={copy.description} fill />;
}

function buildGroups(
	tab: OverviewTab,
	tasks: typeof spaceStore.tasks.value
): TaskGroupConfig[] {
	if (tab === 'active') {
		const inProgress = tasks.filter((task) => task.status === 'in_progress');
		const queued = tasks.filter((task) => task.status === 'open');
		return [
			{
				id: 'in-progress',
				title: 'In Progress',
				description: 'Tasks currently being worked in parallel.',
				tasks: inProgress,
				tone: 'default' as const,
			},
			{
				id: 'queued',
				title: 'Queued',
				description: 'Ready tasks waiting for an execution slot.',
				tasks: queued,
				tone: 'default' as const,
			},
		].filter((group) => group.tasks.length > 0);
	}

	if (tab === 'review') {
		return [
			{
				id: 'blocked',
				title: 'Needs Review',
				description: 'Tasks blocked on human attention, approval, or intervention.',
				tasks: tasks.filter((task) => task.status === 'blocked'),
				tone: 'review' as const,
			},
		].filter((group) => group.tasks.length > 0);
	}

	return [
		{
			id: 'done',
			title: 'Completed',
			description: 'Tasks that finished successfully.',
			tasks: tasks.filter((task) => task.status === 'done'),
			tone: 'done' as const,
		},
		{
			id: 'cancelled',
			title: 'Cancelled',
			description: 'Tasks intentionally stopped before completion.',
			tasks: tasks.filter((task) => task.status === 'cancelled'),
			tone: 'done' as const,
		},
		{
			id: 'archived',
			title: 'Archived',
			description: 'Tasks hidden from the active execution flow.',
			tasks: tasks.filter((task) => task.status === 'archived'),
			tone: 'done' as const,
		},
	].filter((group) => group.tasks.length > 0);
}

export function SpaceDashboard({
	spaceId: _spaceId,
	onOpenSpaceAgent,
	onSelectTask,
	compact = false,
}: SpaceDashboardProps) {
	const [activeTab, setActiveTab] = useState<OverviewTab>('active');
	const space = spaceStore.space.value;
	const loading = spaceStore.loading.value;
	const tasks = [...spaceStore.tasks.value].sort((a, b) => b.updatedAt - a.updatedAt);

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

	const activeTasks = tasks.filter((task) => task.status === 'open' || task.status === 'in_progress');
	const reviewTasks = tasks.filter((task) => task.status === 'blocked');
	const doneTasks = tasks.filter(
		(task) => task.status === 'done' || task.status === 'cancelled' || task.status === 'archived'
	);
	const totalTasks = tasks.length;
	const groups = buildGroups(
		activeTab,
		activeTab === 'active' ? activeTasks : activeTab === 'review' ? reviewTasks : doneTasks
	);
	const description =
		space.description ||
		'Use this space to coordinate many tasks in parallel, keep review work visible, and let workflows scale the execution load.';

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
								description="Use the shared agent thread to reshape scope, create follow-up work, and steer execution across many tasks at once."
								icon={SparkIcon}
								onClick={onOpenSpaceAgent}
							/>
						</div>
					</div>
					<div class="mt-6 grid gap-3 md:grid-cols-3">
						<SummaryChip label="Active" count={activeTasks.length} />
						<SummaryChip label="Review" count={reviewTasks.length} tone="review" />
						<SummaryChip label="Done" count={doneTasks.length} tone="done" />
					</div>
				</section>

				{totalTasks === 0 ? (
					<div class="flex flex-1 min-h-[24rem]">
						<div class="h-full w-full">
							<EmptyState
								title="This space has no tasks yet."
								copy="Create the first task or ask the space agent to break the work into parallelizable pieces."
								fill
							/>
						</div>
					</div>
				) : (
					<section class="flex flex-1 min-h-[24rem] flex-col rounded-[28px] border border-dark-700 bg-dark-950/70">
						<div class="flex items-center gap-6 border-b border-dark-700 px-6">
							<OverviewTabButton
								label="Active"
								count={activeTasks.length}
								active={activeTab === 'active'}
								onClick={() => setActiveTab('active')}
							/>
							<OverviewTabButton
								label="Review"
								count={reviewTasks.length}
								active={activeTab === 'review'}
								onClick={() => setActiveTab('review')}
								tone="review"
							/>
							<OverviewTabButton
								label="Done"
								count={doneTasks.length}
								active={activeTab === 'done'}
								onClick={() => setActiveTab('done')}
								tone="done"
							/>
						</div>

						<div class="flex-1 overflow-y-auto p-6">
							{groups.length === 0 ? (
								<EmptyTabState tab={activeTab} />
							) : (
								<div class="grid gap-4 xl:grid-cols-2">
									{groups.map((group) => (
										<TaskGroup key={group.id} group={group} onSelectTask={onSelectTask} />
									))}
								</div>
							)}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
