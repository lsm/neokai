/**
 * SpaceDashboard Component
 *
 * Default middle-column view for the Space layout.
 * Shows space overview, active run progress, and quick-action cards.
 */

import type { ComponentType } from 'preact';
import { spaceStore } from '../../lib/space-store';

interface SpaceDashboardProps {
	spaceId: string;
	onStartWorkflow?: () => void;
	onCreateTask?: () => void;
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
}

function QuickActionCard({ title, description, icon: Icon, onClick }: QuickActionCardProps) {
	return (
		<button
			onClick={onClick}
			class="flex items-start gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg
				hover:bg-dark-800 hover:border-dark-600 transition-colors text-left w-full group"
		>
			<div class="mt-0.5 text-gray-500 group-hover:text-gray-300 transition-colors flex-shrink-0">
				<Icon />
			</div>
			<div>
				<p class="text-sm font-medium text-gray-300 group-hover:text-gray-100 transition-colors">
					{title}
				</p>
				<p class="text-xs text-gray-600 mt-0.5">{description}</p>
			</div>
		</button>
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
}: SpaceDashboardProps) {
	const space = spaceStore.space.value;
	const loading = spaceStore.loading.value;
	const activeRuns = spaceStore.activeRuns.value;
	const activeTasks = spaceStore.activeTasks.value;
	const tasks = spaceStore.tasks.value;
	const workflowRuns = spaceStore.workflowRuns.value;

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

	return (
		<div class="flex flex-col h-full overflow-y-auto p-6 space-y-6">
			{/* Space header */}
			<div>
				<h1 class="text-xl font-semibold text-gray-100">{space.name}</h1>
				<p class="text-xs text-gray-600 font-mono mt-1 truncate" title={space.workspacePath}>
					{truncatePath(space.workspacePath)}
				</p>
				{space.description && <p class="text-sm text-gray-400 mt-2">{space.description}</p>}
			</div>

			{/* Active status */}
			{(activeRuns.length > 0 || activeTasks.length > 0) && (
				<div class="bg-blue-900/15 border border-blue-800/40 rounded-lg px-4 py-3">
					<div class="flex items-center gap-2">
						<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
						<p class="text-sm text-blue-300">
							{activeRuns.length > 0 && (
								<span>
									{activeRuns.length} active {activeRuns.length === 1 ? 'run' : 'runs'}
								</span>
							)}
							{activeRuns.length > 0 && activeTasks.length > 0 && <span class="mx-1">·</span>}
							{activeTasks.length > 0 && (
								<span>
									{activeTasks.length} {activeTasks.length === 1 ? 'task' : 'tasks'} in progress
								</span>
							)}
						</p>
					</div>
				</div>
			)}

			{/* Quick actions */}
			{/* TODO: onStartWorkflow and onCreateTask are unwired scaffolding — will be connected once workflow/task creation dialogs are implemented */}
			<div>
				<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
					Quick Actions
				</h2>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<QuickActionCard
						title="Start Workflow Run"
						description="Execute a workflow with agents"
						icon={PlayIcon}
						onClick={onStartWorkflow}
					/>
					<QuickActionCard
						title="Create Task"
						description="Add a standalone task to this space"
						icon={PlusIcon}
						onClick={onCreateTask}
					/>
				</div>
			</div>

			{/* Recent activity */}
			{(recentTasks.length > 0 || recentRuns.length > 0) && (
				<div>
					<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
						Recent Activity
					</h2>
					<div class="space-y-1">
						{recentRuns.map((run) => (
							<div
								key={run.id}
								class="flex items-center gap-3 px-3 py-2 rounded-md bg-dark-850 border border-dark-800"
							>
								<span class="text-xs text-gray-600 font-medium w-16 flex-shrink-0">Run</span>
								<span class="text-xs text-gray-300 truncate flex-1">{run.title}</span>
								<span class="text-xs text-gray-600 capitalize">{run.status.replace('_', ' ')}</span>
							</div>
						))}
						{recentTasks.map((task) => (
							<div
								key={task.id}
								class="flex items-center gap-3 px-3 py-2 rounded-md bg-dark-850 border border-dark-800"
							>
								<span class="text-xs text-gray-600 font-medium w-16 flex-shrink-0">Task</span>
								<span class="text-xs text-gray-300 truncate flex-1">{task.title}</span>
								<span class="text-xs text-gray-600 capitalize">
									{task.status.replace('_', ' ')}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
