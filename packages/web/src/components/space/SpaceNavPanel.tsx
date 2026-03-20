/**
 * SpaceNavPanel Component
 *
 * Left column navigation panel for the Space view.
 * Shows workflow runs, standalone tasks, and navigation links.
 */

import type { ComponentType } from 'preact';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';
import type { SpaceWorkflowRun, SpaceTask } from '@neokai/shared';

interface SpaceNavPanelProps {
	spaceId: string;
	activeTaskId?: string | null;
	activeRunId?: string | null;
	onRunSelect: (runId: string) => void;
	onTaskSelect: (taskId: string) => void;
}

type RunStatus = SpaceWorkflowRun['status'];
type TaskStatus = SpaceTask['status'];

function StatusDot({ status }: { status: RunStatus | TaskStatus }) {
	const base = 'w-2 h-2 rounded-full flex-shrink-0';
	switch (status) {
		case 'in_progress':
			return <span class={cn(base, 'bg-blue-400 animate-pulse')} />;
		case 'completed':
			return <span class={cn(base, 'bg-green-500')} />;
		case 'needs_attention':
			return <span class={cn(base, 'bg-yellow-400')} />;
		case 'cancelled':
			return <span class={cn(base, 'bg-gray-600')} />;
		default:
			// pending, draft, review
			return <span class={cn(base, 'bg-gray-500')} />;
	}
}

interface RunItemProps {
	run: SpaceWorkflowRun;
	taskCount: number;
	isActive: boolean;
	onClick: () => void;
}

function RunItem({ run, taskCount, isActive, onClick }: RunItemProps) {
	return (
		<button
			onClick={onClick}
			class={cn(
				'w-full text-left px-3 py-2 rounded-md transition-colors group',
				isActive
					? 'bg-dark-700 text-gray-100'
					: 'text-gray-400 hover:bg-dark-800 hover:text-gray-200'
			)}
		>
			<div class="flex items-center gap-2 min-w-0">
				<StatusDot status={run.status} />
				<span class="text-xs font-medium truncate flex-1">{run.title}</span>
			</div>
			{taskCount > 0 && (
				<div class="text-xs text-gray-600 mt-0.5 pl-4">
					{taskCount} {taskCount === 1 ? 'task' : 'tasks'}
				</div>
			)}
		</button>
	);
}

interface TaskItemProps {
	task: SpaceTask;
	isActive: boolean;
	onClick: () => void;
}

function TaskItem({ task, isActive, onClick }: TaskItemProps) {
	return (
		<button
			onClick={onClick}
			class={cn(
				'w-full text-left px-3 py-2 rounded-md transition-colors',
				isActive
					? 'bg-dark-700 text-gray-100'
					: 'text-gray-400 hover:bg-dark-800 hover:text-gray-200'
			)}
		>
			<div class="flex items-center gap-2 min-w-0">
				<StatusDot status={task.status} />
				<span class="text-xs font-medium truncate flex-1">{task.title}</span>
			</div>
		</button>
	);
}

export function SpaceNavPanel({
	spaceId: _spaceId,
	activeTaskId,
	activeRunId,
	onRunSelect,
	onTaskSelect,
}: SpaceNavPanelProps) {
	const workflowRuns = spaceStore.workflowRuns.value;
	const standaloneTasks = spaceStore.standaloneTasks.value;
	const tasksByRun = spaceStore.tasksByRun.value;
	const loading = spaceStore.loading.value;

	if (loading) {
		return (
			<div class="flex items-center justify-center h-24">
				<span class="text-xs text-gray-600 animate-pulse">Loading...</span>
			</div>
		);
	}

	return (
		<div class="flex flex-col h-full overflow-y-auto py-2">
			{/* Workflow Runs */}
			{workflowRuns.length > 0 && (
				<div class="mb-4">
					<div class="px-3 mb-1">
						<span class="text-xs font-semibold text-gray-500 uppercase tracking-wider">
							Workflow Runs
						</span>
					</div>
					<div class="space-y-0.5 px-1">
						{workflowRuns.map((run) => (
							<RunItem
								key={run.id}
								run={run}
								taskCount={tasksByRun.get(run.id)?.length ?? 0}
								isActive={activeRunId === run.id}
								onClick={() => onRunSelect(run.id)}
							/>
						))}
					</div>
				</div>
			)}

			{/* Standalone Tasks */}
			{standaloneTasks.length > 0 && (
				<div class="mb-4">
					<div class="px-3 mb-1">
						<span class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Tasks</span>
					</div>
					<div class="space-y-0.5 px-1">
						{standaloneTasks.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								isActive={activeTaskId === task.id}
								onClick={() => onTaskSelect(task.id)}
							/>
						))}
					</div>
				</div>
			)}

			{workflowRuns.length === 0 && standaloneTasks.length === 0 && (
				<div class="px-3 py-4">
					<p class="text-xs text-gray-600 text-center">No runs or tasks yet</p>
				</div>
			)}

			{/* Navigation Links — TODO: wire onClick once Agent/Workflow/Settings routes are implemented */}
			<div class="mt-auto pt-4 border-t border-dark-700 px-1">
				<div class="space-y-0.5">
					<NavLink label="Agents" icon={AgentIcon} />
					<NavLink label="Workflows" icon={WorkflowIcon} />
					<NavLink label="Settings" icon={SettingsIcon} />
				</div>
			</div>
		</div>
	);
}

function NavLink({ label, icon: Icon }: { label: string; icon: ComponentType }) {
	return (
		<div class="flex items-center gap-2 px-3 py-2 rounded-md text-gray-500 hover:bg-dark-800 hover:text-gray-300 cursor-pointer transition-colors">
			<Icon />
			<span class="text-xs font-medium">{label}</span>
		</div>
	);
}

function AgentIcon() {
	return (
		<svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
			/>
		</svg>
	);
}

function WorkflowIcon() {
	return (
		<svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M4 6h16M4 10h16M4 14h16M4 18h16"
			/>
		</svg>
	);
}

function SettingsIcon() {
	return (
		<svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
			/>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
			/>
		</svg>
	);
}
