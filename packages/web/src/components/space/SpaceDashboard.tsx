/**
 * SpaceDashboard Component
 *
 * Default middle-column view for the Space layout.
 * Shows space overview, active run progress, and quick-action cards.
 */

import type { ComponentType } from 'preact';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';

interface SpaceDashboardProps {
	spaceId: string;
	onStartWorkflow?: () => void;
	onCreateTask?: () => void;
	/** Navigate to a task's detail pane */
	onSelectTask?: (taskId: string) => void;
	compact?: boolean;
}

/**
 * Truncate a long path for display, showing trailing segments
 */
function truncatePath(p: string, maxLen = 48): string {
	if (p.length <= maxLen) return p;
	return '…' + p.slice(-(maxLen - 1));
}

interface QuickActionCardProps {
	title: string;
	description: string;
	icon: ComponentType;
	onClick?: () => void;
	compact?: boolean;
}

function QuickActionCard({ title, description, icon: Icon, onClick, compact }: QuickActionCardProps) {
	return (
		<button
			onClick={onClick}
			class={cn(
				'flex items-start gap-3 border border-dark-700 rounded-xl text-left w-full group transition-all',
				compact
					? 'p-3 bg-dark-900/80 hover:bg-dark-850'
					: 'p-4 bg-dark-850 hover:bg-dark-800 hover:border-dark-600'
			)}
		>
			<div
				class={cn(
					'mt-0.5 flex-shrink-0 transition-colors',
					compact ? 'text-gray-400 group-hover:text-gray-200' : 'text-gray-500 group-hover:text-gray-300'
				)}
			>
				<Icon />
			</div>
			<div>
				<p
					class={cn(
						'font-medium transition-colors',
						compact
							? 'text-xs text-gray-200 group-hover:text-white'
							: 'text-sm text-gray-300 group-hover:text-gray-100'
					)}
				>
					{title}
				</p>
				<p class={cn('mt-0.5 text-xs', compact ? 'text-gray-500' : 'text-gray-600')}>
					{description}
				</p>
			</div>
		</button>
	);
}

function StatCard({
	label,
	value,
	accentClass,
	helper,
	compact,
}: {
	label: string;
	value: string;
	accentClass: string;
	helper: string;
	compact?: boolean;
}) {
	return (
		<div
			class={cn(
				'rounded-xl border border-dark-700 bg-dark-900/80',
				compact ? 'px-3 py-3' : 'px-4 py-4'
			)}
		>
			<div class="flex items-center justify-between gap-3">
				<p class="text-[11px] uppercase tracking-[0.2em] text-gray-500">{label}</p>
				<span class={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', accentClass)} />
			</div>
			<p class={cn('mt-2 font-semibold text-gray-100', compact ? 'text-lg' : 'text-2xl')}>{value}</p>
			<p class="mt-1 text-xs text-gray-500">{helper}</p>
		</div>
	);
}

function ActivityItem({
	label,
	title,
	status,
	compact,
	clickable,
	onClick,
}: {
	label: string;
	title: string;
	status: string;
	compact?: boolean;
	clickable?: boolean;
	onClick?: () => void;
}) {
	const className = cn(
		'w-full rounded-xl border border-dark-800 bg-dark-900/70 text-left',
		compact ? 'px-3 py-2.5' : 'px-4 py-3',
		clickable && 'transition-colors hover:bg-dark-850 hover:border-dark-700'
	);
	const content = (
		<div class="flex items-center gap-3">
			<span class="text-[11px] uppercase tracking-[0.18em] text-gray-600">{label}</span>
			<span class="min-w-0 flex-1 truncate text-sm text-gray-200">{title}</span>
			<span class="text-xs text-gray-500 capitalize">{status.replace('_', ' ')}</span>
		</div>
	);

	if (clickable) {
		return (
			<button type="button" onClick={onClick} class={className}>
				{content}
			</button>
		);
	}

	return (
		<div class={className}>
			<div class="flex items-center gap-3">
				<span class="text-[11px] uppercase tracking-[0.18em] text-gray-600">{label}</span>
				<span class="min-w-0 flex-1 truncate text-sm text-gray-200">{title}</span>
				<span class="text-xs text-gray-500 capitalize">{status.replace('_', ' ')}</span>
			</div>
		</div>
	);
}

function EmptyPanel({
	title,
	copy,
	compact,
}: {
	title: string;
	copy: string;
	compact?: boolean;
}) {
	return (
		<div
			class={cn(
				'rounded-xl border border-dashed border-dark-700 bg-dark-900/50 text-center',
				compact ? 'px-4 py-5' : 'px-6 py-8'
			)}
		>
			<p class="text-sm text-gray-300">{title}</p>
			<p class="mt-1 text-xs text-gray-500">{copy}</p>
		</div>
	);
}

function PlayIcon() {
	return (
		<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
			/>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
			/>
		</svg>
	);
}

function PlusIcon() {
	return (
		<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 4v16m8-8H4" />
		</svg>
	);
}

export function SpaceDashboard({
	spaceId: _spaceId,
	onStartWorkflow,
	onCreateTask,
	onSelectTask,
	compact = false,
}: SpaceDashboardProps) {
	const space = spaceStore.space.value;
	const loading = spaceStore.loading.value;
	const activeRuns = spaceStore.activeRuns.value;
	const activeTasks = spaceStore.activeTasks.value;
	const tasks = spaceStore.tasks.value;
	const workflowRuns = spaceStore.workflowRuns.value;
	const workflows = spaceStore.workflows?.value ?? [];
	const agents = spaceStore.agents?.value ?? [];

	if (loading) {
		return (
			<div class="flex items-center justify-center h-full">
				<div class="text-center">
					<div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
					<p class="text-sm text-gray-500">Loading space...</p>
				</div>
			</div>
		);
	}

	if (!space) {
		return (
			<div class="flex items-center justify-center h-full">
				<p class="text-sm text-gray-500">Space not found</p>
			</div>
		);
	}

	// Recent activity: last 5 items by updatedAt
	const recentTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

	const recentRuns = [...workflowRuns].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
	const reviewTasks = tasks.filter((task) => task.status === 'review' || task.status === 'needs_attention');
	const completedTasks = tasks.filter(
		(task) => task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived'
	);
	const heroDescription =
		space.description ||
		'Coordinate workflows, task agents, and human approvals from one focused control surface.';
	const showActivity = recentTasks.length > 0 || recentRuns.length > 0;

	return (
		<div class={cn('flex flex-col h-full overflow-y-auto', compact ? 'p-4 space-y-4' : 'p-6 space-y-6')}>
			<div
				class={cn(
					'relative overflow-hidden rounded-2xl border border-dark-700',
					compact ? 'px-4 py-4 bg-dark-900' : 'px-5 py-5 bg-dark-900/90'
				)}
			>
				<div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(96,165,250,0.16),transparent_38%),radial-gradient(circle_at_85%_20%,rgba(168,85,247,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent)]" />
				<div class="relative">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<span class="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-blue-200">
								<span class="h-2 w-2 rounded-full bg-blue-400" />
								{activeRuns.length > 0 || activeTasks.length > 0 ? 'Live Space' : 'Ready'}
							</span>
							<h1 class={cn('mt-3 font-semibold text-gray-100', compact ? 'text-lg' : 'text-2xl')}>
								{space.name}
							</h1>
							<p class={cn('mt-2 max-w-2xl text-gray-400', compact ? 'text-xs leading-5' : 'text-sm leading-6')}>
								{heroDescription}
							</p>
						</div>
						<div class="hidden sm:flex flex-col items-end gap-2 text-right">
							<span class="text-[11px] uppercase tracking-[0.18em] text-gray-600">Workspace</span>
							<span
								class="max-w-[18rem] truncate rounded-full border border-dark-700 bg-dark-950/80 px-3 py-1 font-mono text-[11px] text-gray-400"
								title={space.workspacePath}
							>
								{truncatePath(space.workspacePath, compact ? 30 : 48)}
							</span>
						</div>
					</div>

					<div class={cn('mt-4 grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-2 xl:grid-cols-4')}>
						<StatCard
							label="Active Tasks"
							value={String(activeTasks.length)}
							helper={activeTasks.length === 1 ? 'Agent is currently working' : 'Agents are currently working'}
							accentClass="bg-blue-400"
							compact={compact}
						/>
						<StatCard
							label="Review Queue"
							value={String(reviewTasks.length)}
							helper={reviewTasks.length === 0 ? 'No blockers waiting on you' : 'Tasks need review or attention'}
							accentClass="bg-amber-400"
							compact={compact}
						/>
						<StatCard
							label="Live Flows"
							value={String(activeRuns.length)}
							helper={
								activeRuns.length === 0
									? 'No task-driven workflow execution right now'
									: 'Tasks are actively moving through workflows'
							}
							accentClass="bg-violet-400"
							compact={compact}
						/>
						<StatCard
							label="Coverage"
							value={`${agents.length}/${Math.max(workflows.length, 1)}`}
							helper={workflows.length > 0 ? 'Agents to workflow templates' : 'Agents configured in this space'}
							accentClass="bg-emerald-400"
							compact={compact}
						/>
					</div>
				</div>
			</div>

			<div>
				<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
					Launchpad
				</h2>
				<div class={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2')}>
					<QuickActionCard
						title="Start Workflow Run"
						description="Kick off orchestration for a prepared workflow"
						icon={PlayIcon}
						onClick={onStartWorkflow}
						compact={compact}
					/>
					<QuickActionCard
						title="Create Task"
						description="Open a focused standalone task with its own agent thread"
						icon={PlusIcon}
						onClick={onCreateTask}
						compact={compact}
					/>
				</div>
			</div>

			<div class={cn('grid gap-4', compact ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-[1.2fr_0.8fr]')}>
				<div class="space-y-3">
					<div class="flex items-center justify-between gap-3">
						<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Focus Queue</h2>
						{completedTasks.length > 0 && (
							<span class="text-xs text-gray-600">{completedTasks.length} completed recently</span>
						)}
					</div>
					{recentTasks.length === 0 ? (
						<EmptyPanel
							title="No tasks yet"
							copy="Create the first task to give this space a live execution history."
							compact={compact}
						/>
					) : (
						<div class="space-y-2">
							{recentTasks.map((task) => (
								<ActivityItem
									key={task.id}
									label="Task"
									title={task.title}
									status={task.status}
									compact={compact}
									clickable={!!onSelectTask}
									onClick={() => onSelectTask?.(task.id)}
								/>
							))}
						</div>
					)}
				</div>

				<div class="space-y-3">
					<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Workflow Pulse</h2>
					{recentRuns.length === 0 ? (
						<EmptyPanel
							title="No workflow runs yet"
							copy="Start a workflow run to light up the canvas and track orchestration in real time."
							compact={compact}
						/>
					) : (
						<div class="space-y-2">
							{recentRuns.map((run) => (
								<ActivityItem
									key={run.id}
									label="Run"
									title={run.title}
									status={run.status}
									compact={compact}
								/>
							))}
						</div>
					)}
				</div>
			</div>

			{!showActivity && !compact && (
				<div class="rounded-2xl border border-dark-700 bg-dark-900/70 px-5 py-5">
					<p class="text-sm text-gray-300">This space is quiet right now.</p>
					<p class="mt-1 text-sm text-gray-500">
						Start a workflow or create a task to establish the first execution trail.
					</p>
				</div>
			)}
		</div>
	);
}
