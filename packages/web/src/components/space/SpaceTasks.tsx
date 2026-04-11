/**
 * SpaceTasks — tabbed task list for a space.
 *
 * Tabs: Active (open + in_progress), Review (blocked + review),
 *       Completed (done + cancelled), Archived.
 *
 * Within each tab, tasks are grouped by status in TaskGroup cards,
 * matching the RoomTasks component style.
 */

import { useMemo, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import type { SpaceTask, SpaceTaskStatus } from '@neokai/shared';
import { getRelativeTime } from '../../lib/utils';

type TaskFilterTab = 'active' | 'review' | 'completed' | 'archived';

const TAB_GROUPS: Record<TaskFilterTab, SpaceTaskStatus[]> = {
	active: ['open', 'in_progress'],
	review: ['blocked', 'review'],
	completed: ['done', 'cancelled'],
	archived: ['archived'],
};

const STATUS_BORDER: Record<string, string> = {
	open: 'border-l-gray-500',
	in_progress: 'border-l-blue-500',
	blocked: 'border-l-amber-500',
	review: 'border-l-purple-500',
	done: 'border-l-green-500',
	cancelled: 'border-l-gray-600',
	archived: 'border-l-gray-700',
};

const STATUS_LABEL: Record<string, string> = {
	open: 'Open',
	in_progress: 'In Progress',
	blocked: 'Blocked',
	review: 'Review',
	done: 'Done',
	cancelled: 'Cancelled',
	archived: 'Archived',
};

/** Status group definitions within each tab */
interface StatusGroupDef {
	status: SpaceTaskStatus;
	title: string;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
}

const ACTIVE_GROUPS: StatusGroupDef[] = [
	{ status: 'in_progress', title: 'In Progress', variant: 'yellow' },
	{ status: 'open', title: 'Open', variant: 'default' },
];

const REVIEW_GROUPS: StatusGroupDef[] = [
	{ status: 'blocked', title: 'Blocked', variant: 'red' },
	{ status: 'review', title: 'Awaiting Review', variant: 'purple' },
];

const COMPLETED_GROUPS: StatusGroupDef[] = [
	{ status: 'done', title: 'Done', variant: 'green' },
	{ status: 'cancelled', title: 'Cancelled', variant: 'gray' },
];

const ARCHIVED_GROUPS: StatusGroupDef[] = [
	{ status: 'archived', title: 'Archived', variant: 'gray' },
];

const TAB_GROUPS_DEF: Record<TaskFilterTab, StatusGroupDef[]> = {
	active: ACTIVE_GROUPS,
	review: REVIEW_GROUPS,
	completed: COMPLETED_GROUPS,
	archived: ARCHIVED_GROUPS,
};

function TabButton({
	label,
	count,
	isActive,
	onClick,
	variant = 'default',
}: {
	label: string;
	count: number;
	isActive: boolean;
	onClick: () => void;
	variant?: 'default' | 'purple' | 'green' | 'red' | 'gray';
}) {
	const baseClasses =
		'px-4 py-2 text-sm font-medium transition-colors relative flex items-center gap-1.5';

	const variantClasses: Record<string, string> = {
		default: isActive
			? 'text-blue-400 border-b-2 border-blue-400'
			: 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
		purple: isActive
			? 'text-purple-400 border-b-2 border-purple-400'
			: 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
		green: isActive
			? 'text-green-400 border-b-2 border-green-400'
			: 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
		red: isActive
			? 'text-red-400 border-b-2 border-red-400'
			: 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
		gray: isActive
			? 'text-gray-500 border-b-2 border-gray-500'
			: 'text-gray-500 hover:text-gray-400 border-b-2 border-transparent',
	};

	return (
		<button class={`${baseClasses} ${variantClasses[variant]}`} onClick={onClick}>
			{label}
			{count > 0 && (
				<span
					class={`text-xs px-1.5 py-0.5 rounded ${
						variant === 'purple'
							? 'bg-purple-900/30'
							: variant === 'green'
								? 'bg-green-900/30'
								: variant === 'red'
									? 'bg-red-900/30'
									: variant === 'gray'
										? 'bg-dark-800'
										: 'bg-dark-700'
					}`}
				>
					{count}
				</span>
			)}
		</button>
	);
}

function EmptyTabState({ tab }: { tab: TaskFilterTab }) {
	const messages: Record<TaskFilterTab, { title: string; description: string }> = {
		active: { title: 'No active tasks', description: 'Active tasks will appear here' },
		review: { title: 'No tasks to review', description: 'Tasks needing review will appear here' },
		completed: { title: 'No completed tasks', description: 'Completed tasks will appear here' },
		archived: { title: 'No archived tasks', description: 'Archived tasks will appear here' },
	};

	const { title, description } = messages[tab];

	return (
		<div class="flex flex-col items-center justify-center py-12 text-center">
			<p class="text-sm text-gray-400 font-medium">{title}</p>
			<p class="text-xs text-gray-500 mt-1">{description}</p>
		</div>
	);
}

/** Task group card with colored header, matching RoomTasks.TaskGroup style */
function TaskGroup({
	title,
	count,
	variant,
	tasks,
	onTaskClick,
}: {
	title: string;
	count: number;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
	tasks: SpaceTask[];
	onTaskClick?: (taskId: string) => void;
}) {
	const headerStyles: Record<string, string> = {
		default: '',
		yellow: 'bg-yellow-900/20',
		purple: 'bg-purple-900/20',
		green: 'bg-green-900/20',
		red: 'bg-red-900/20',
		gray: 'bg-dark-800',
	};

	const titleStyles: Record<string, string> = {
		default: 'text-gray-100',
		yellow: 'text-yellow-400',
		purple: 'text-purple-400',
		green: 'text-green-400',
		red: 'text-red-400',
		gray: 'text-gray-500',
	};

	const borderStyles: Record<string, string> = {
		default: 'border-dark-700',
		yellow: 'border-dark-700',
		purple: 'border-dark-700',
		green: 'border-dark-700',
		red: 'border-red-800/60',
		gray: 'border-dark-700',
	};

	return (
		<div class={`bg-dark-850 border rounded-xl overflow-hidden ${borderStyles[variant]}`}>
			<div
				class={`px-4 py-3 border-b ${borderStyles[variant]} ${headerStyles[variant]} flex items-center gap-1`}
			>
				<h3 class={`font-semibold ${titleStyles[variant]}`}>
					{title} ({count})
				</h3>
			</div>
			<div class="divide-y divide-dark-700">
				{tasks.map((task) => (
					<TaskItem key={task.id} task={task} onClick={onTaskClick} />
				))}
			</div>
		</div>
	);
}

/** Individual task item with left border, matching RoomTasks.TaskItem style */
function TaskItem({ task, onClick }: { task: SpaceTask; onClick?: (taskId: string) => void }) {
	const isClickable = !!onClick;
	const borderColor = STATUS_BORDER[task.status] ?? 'border-l-transparent';

	return (
		<div
			class={`px-4 py-3 border-l-2 ${borderColor} ${isClickable ? 'cursor-pointer hover:bg-dark-800/50 transition-colors' : ''}`}
			onClick={isClickable ? () => onClick(task.id) : undefined}
		>
			<div class="flex items-start justify-between">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<h4 class="text-sm font-medium text-gray-100 truncate">{task.title}</h4>
						<span class="inline-flex items-center text-xs font-mono font-medium text-gray-400 bg-dark-700 border border-dark-600 px-1.5 py-0.5 rounded flex-shrink-0">
							#{task.taskNumber}
						</span>
					</div>
					<div class="flex items-center gap-2 mt-1">
						<span class="text-xs text-gray-500">{STATUS_LABEL[task.status] ?? task.status}</span>
						{task.updatedAt > 0 && (
							<span class="text-xs text-gray-600">{getRelativeTime(task.updatedAt)}</span>
						)}
					</div>
					{task.status === 'blocked' && task.result && (
						<p class="mt-1 text-xs text-amber-400/80 truncate" data-testid="task-blocked-reason">
							{task.result}
						</p>
					)}
				</div>
				<div class="ml-4 flex items-center flex-shrink-0">
					{isClickable && <span class="text-xs text-gray-600">&rarr;</span>}
				</div>
			</div>
		</div>
	);
}

interface SpaceTasksProps {
	spaceId: string;
	onSelectTask?: (taskId: string) => void;
}

export function SpaceTasks({ spaceId: _spaceId, onSelectTask }: SpaceTasksProps) {
	const tasks = spaceStore.tasks.value;
	const [activeTab, setActiveTab] = useState<TaskFilterTab>('active');

	const counts = useMemo(() => {
		const c: Record<TaskFilterTab, number> = { active: 0, review: 0, completed: 0, archived: 0 };
		for (const task of tasks) {
			for (const [tab, statuses] of Object.entries(TAB_GROUPS) as [
				TaskFilterTab,
				SpaceTaskStatus[],
			][]) {
				if (statuses.includes(task.status as SpaceTaskStatus)) {
					c[tab]++;
					break;
				}
			}
		}
		return c;
	}, [tasks]);

	const filteredTasks = useMemo(() => {
		const statuses = TAB_GROUPS[activeTab];
		return [...tasks]
			.filter((t) => statuses.includes(t.status as SpaceTaskStatus))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}, [tasks, activeTab]);

	if (tasks.length === 0) {
		return (
			<div class="w-full px-8 flex flex-col items-center justify-center py-16 text-center">
				<svg
					class="w-10 h-10 text-gray-700 mb-3"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={1.5}
						d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
					/>
				</svg>
				<p class="text-sm text-gray-400 font-medium">No tasks yet</p>
				<p class="text-xs text-gray-600 mt-1">Create a task to get started</p>
			</div>
		);
	}

	return (
		<div class="flex-1 min-h-0 w-full px-4 py-4 sm:px-8 sm:py-6 overflow-y-auto">
			<div class="min-h-[calc(100%+1px)] space-y-6">
				<div class="flex border-b border-dark-700">
					<TabButton
						label="Active"
						count={counts.active}
						isActive={activeTab === 'active'}
						onClick={() => setActiveTab('active')}
					/>
					<TabButton
						label="Review"
						count={counts.review}
						isActive={activeTab === 'review'}
						onClick={() => setActiveTab('review')}
						variant="purple"
					/>
					<TabButton
						label="Completed"
						count={counts.completed}
						isActive={activeTab === 'completed'}
						onClick={() => setActiveTab('completed')}
						variant="green"
					/>
					<TabButton
						label="Archived"
						count={counts.archived}
						isActive={activeTab === 'archived'}
						onClick={() => setActiveTab('archived')}
						variant="gray"
					/>
				</div>

				{filteredTasks.length === 0 ? (
					<EmptyTabState tab={activeTab} />
				) : (
					<TaskGroupList tasks={filteredTasks} tab={activeTab} onTaskClick={onSelectTask} />
				)}
			</div>
		</div>
	);
}

/** Groups tasks by status within the selected tab, rendering TaskGroup cards */
function TaskGroupList({
	tasks,
	tab,
	onTaskClick,
}: {
	tasks: SpaceTask[];
	tab: TaskFilterTab;
	onTaskClick?: (taskId: string) => void;
}) {
	const groups = TAB_GROUPS_DEF[tab];

	return (
		<div class="space-y-4">
			{groups.map((group) => {
				const groupTasks = tasks.filter((t) => t.status === group.status);
				if (groupTasks.length === 0) return null;
				return (
					<TaskGroup
						key={group.status}
						title={group.title}
						count={groupTasks.length}
						variant={group.variant}
						tasks={groupTasks}
						onTaskClick={onTaskClick}
					/>
				);
			})}
		</div>
	);
}
