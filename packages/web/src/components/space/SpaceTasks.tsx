/**
 * SpaceTasks — tabbed task list for a space.
 *
 * Tabs: Action (review + blocked, grouped by reason),
 *       Active (open + in_progress + approved — see `task-filters.ts` for why
 *       `approved` belongs here),
 *       Completed (done + cancelled), Archived.
 *
 * Within each tab, tasks are grouped by status/reason in TaskGroup cards,
 * matching the RoomTasks component style.
 */

import type { SpaceBlockReason, SpaceTask, SpaceTaskStatus, TaskSchedule } from '@neokai/shared';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { navigateToSpaceTasks } from '../../lib/router';
import { currentSpaceIdSignal, currentSpaceTasksFilterTabSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { isActionRequired, isActiveTask, isDraftTask } from '../../lib/task-filters';
import { getRelativeTime } from '../../lib/utils';

type TaskFilterTab = 'action' | 'active' | 'draft' | 'completed' | 'archived' | 'scheduled';

/** Block reasons that indicate a task needs human attention */
const ATTENTION_BLOCK_REASONS: SpaceBlockReason[] = ['human_input_requested', 'gate_rejected'];

/**
 * Per-tab membership predicates. The `action` and `active` predicates are
 * the shared helpers from `task-filters.ts`, which are the single source
 * of truth also used by the sidebar in `SpaceDetailPanel` (Tasks-nav
 * badge, "Active"/"Action" sub-tabs). Both surfaces import from the same
 * helper so the lists and the badge counts cannot drift apart — see the
 * `task-filters.ts` doc comments for why `approved` belongs in Active.
 *
 * Exported for tests that assert the tasks-view's `active` predicate
 * matches the sidebar's `isActiveTask` exactly. Keeping this exported is
 * a regression guard: if someone later re-inlines the predicate here,
 * the parity test in `task-filters.test.ts` will fail.
 */
// Note: 'scheduled' tab is handled separately in the component (schedules, not tasks)
export const TAB_PREDICATES: Record<
	Exclude<TaskFilterTab, 'scheduled'>,
	(task: SpaceTask) => boolean
> = {
	action: isActionRequired,
	active: isActiveTask,
	draft: isDraftTask,
	completed: (t) => t.status === 'done' || t.status === 'cancelled',
	archived: (t) => t.status === 'archived',
};

const STATUS_BORDER: Record<string, string> = {
	draft: 'border-l-slate-500',
	open: 'border-l-gray-500',
	in_progress: 'border-l-blue-500',
	blocked: 'border-l-amber-500',
	review: 'border-l-purple-500',
	approved: 'border-l-emerald-500',
	done: 'border-l-green-500',
	cancelled: 'border-l-gray-600',
	archived: 'border-l-gray-700',
};

const STATUS_LABEL: Record<string, string> = {
	draft: 'Draft',
	open: 'Open',
	in_progress: 'In Progress',
	blocked: 'Blocked',
	review: 'Review',
	approved: 'Approved',
	done: 'Done',
	cancelled: 'Cancelled',
	archived: 'Archived',
};

/** Status group definitions within each tab */
interface StatusGroupDef {
	status: SpaceTaskStatus;
	title: string;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
	/** Optional filter override; when provided, used instead of status-only matching */
	filterFn?: (task: SpaceTask) => boolean;
}

const ACTION_GROUPS: StatusGroupDef[] = [
	{
		status: 'blocked',
		title: 'Needs Input',
		variant: 'red',
		filterFn: (t) =>
			t.status === 'blocked' && (t.blockReason as SpaceBlockReason) === 'human_input_requested',
	},
	{
		status: 'blocked',
		title: 'Gate Pending',
		variant: 'red',
		filterFn: (t) =>
			t.status === 'blocked' && (t.blockReason as SpaceBlockReason) === 'gate_rejected',
	},
	{ status: 'review', title: 'Awaiting Review', variant: 'purple' },
	{
		status: 'blocked',
		title: 'Blocked',
		variant: 'yellow',
		filterFn: (t) =>
			t.status === 'blocked' &&
			!ATTENTION_BLOCK_REASONS.includes(t.blockReason as SpaceBlockReason),
	},
];

const ACTIVE_GROUPS: StatusGroupDef[] = [
	{ status: 'in_progress', title: 'In Progress', variant: 'yellow' },
	// `approved` is a transient state — the post-approval sub-session runs,
	// then `mark_complete` transitions the task to `done`. Surface it in
	// Active so a task stuck in `approved` (post-approval dispatch failed,
	// `postApprovalBlockedReason` populated) stays visible.
	{ status: 'approved', title: 'Post-Approval Running', variant: 'green' },
	{ status: 'open', title: 'Open', variant: 'default' },
];

const COMPLETED_GROUPS: StatusGroupDef[] = [
	{ status: 'done', title: 'Done', variant: 'green' },
	{ status: 'cancelled', title: 'Cancelled', variant: 'gray' },
];

const ARCHIVED_GROUPS: StatusGroupDef[] = [
	{ status: 'archived', title: 'Archived', variant: 'gray' },
];

const DRAFT_GROUPS: StatusGroupDef[] = [{ status: 'draft', title: 'Drafts', variant: 'default' }];

const TAB_GROUPS_DEF: Record<Exclude<TaskFilterTab, 'scheduled'>, StatusGroupDef[]> = {
	action: ACTION_GROUPS,
	active: ACTIVE_GROUPS,
	draft: DRAFT_GROUPS,
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
	variant?: 'default' | 'amber' | 'purple' | 'green' | 'red' | 'gray';
}) {
	const baseClasses =
		'px-4 py-2 text-sm font-medium transition-colors relative flex items-center gap-1.5';

	const variantClasses: Record<string, string> = {
		default: isActive
			? 'text-blue-400 border-b-2 border-blue-400'
			: 'text-gray-400 hover:text-gray-300 border-b-2 border-transparent',
		amber: isActive
			? 'text-amber-400 border-b-2 border-amber-400'
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
						variant === 'amber'
							? 'bg-amber-900/30'
							: variant === 'purple'
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
		action: {
			title: 'No tasks needing action',
			description: 'Tasks requiring human input, review, or unblocking will appear here',
		},
		active: { title: 'No active tasks', description: 'Active tasks will appear here' },
		draft: { title: 'No draft tasks', description: 'Tasks created as drafts will appear here' },
		completed: { title: 'No completed tasks', description: 'Completed tasks will appear here' },
		archived: { title: 'No archived tasks', description: 'Archived tasks will appear here' },
		scheduled: {
			title: 'No scheduled tasks',
			description: 'Recurring and one-shot scheduled tasks will appear here',
		},
	};

	const { title, description } = messages[tab];

	return (
		<div class="flex flex-col items-center justify-center py-12 text-center">
			<p class="text-sm text-gray-400 font-medium">{title}</p>
			<p class="text-xs text-gray-500 mt-1">{description}</p>
		</div>
	);
}

/** Max dependency badges to render inline before collapsing into a "+N" overflow chip. */
const MAX_VISIBLE_DEPENDENCY_BADGES = 3;

/**
 * Inline dependency badges for a task. Each badge is a clickable pill showing
 * the prerequisite task number, coloured green when the dep is `done` and
 * gray otherwise. Deps not found in the loaded task list render as a gray
 * badge with a "task not found" tooltip. Shows at most
 * `MAX_VISIBLE_DEPENDENCY_BADGES` badges inline; any remainder is folded into
 * a non-interactive `+N` overflow chip.
 *
 * The dep lookup (`taskById`) is built once by the parent and passed in, so
 * the map construction is O(N) per render of the list — not per row.
 */
function TaskDependencyBadges({
	dependsOnIds,
	taskById,
	onSelectDependency,
}: {
	dependsOnIds: string[];
	taskById: ReadonlyMap<string, SpaceTask>;
	onSelectDependency?: (taskId: string) => void;
}) {
	if (dependsOnIds.length === 0) return null;

	const visible = dependsOnIds.slice(0, MAX_VISIBLE_DEPENDENCY_BADGES);
	const overflow = dependsOnIds.length - visible.length;

	return (
		<div class="flex items-center gap-1 flex-wrap mt-1" data-testid="task-dependency-badges">
			<span class="text-xs text-gray-500 mr-0.5">deps:</span>
			{visible.map((depId) => {
				const dep = taskById.get(depId);
				const isDone = dep?.status === 'done';
				const isMissing = !dep;

				const label = dep ? `#${dep.taskNumber}` : '#?';
				const tooltip = dep ? dep.title : 'task not found';

				const interactive = !isMissing && !!onSelectDependency;

				// Hover classes only applied when the badge is interactive —
				// disabled buttons shouldn't carry hover state, even though
				// browsers would ignore it.
				const colorClasses = isDone
					? `text-green-300 bg-green-900/40 border-green-700/60${interactive ? ' hover:bg-green-900/60' : ''}`
					: `text-gray-300 bg-dark-700 border-dark-600${interactive ? ' hover:bg-dark-600' : ''}`;

				return (
					<button
						type="button"
						key={depId}
						data-testid="task-dependency-badge"
						data-dep-id={depId}
						data-dep-status={dep?.status ?? 'missing'}
						title={tooltip}
						disabled={!interactive}
						onClick={(e) => {
							e.stopPropagation();
							if (interactive) onSelectDependency(depId);
						}}
						class={`inline-flex items-center gap-0.5 text-xs font-mono font-medium px-1.5 py-0.5 rounded border flex-shrink-0 transition-colors ${colorClasses} ${interactive ? 'cursor-pointer' : 'cursor-default'}`}
					>
						{isMissing && (
							<span aria-hidden="true" class="text-amber-400">
								⚠
							</span>
						)}
						{label}
					</button>
				);
			})}
			{overflow > 0 && (
				<span
					data-testid="task-dependency-overflow"
					class="inline-flex items-center text-xs font-mono font-medium text-gray-400 bg-dark-700 border border-dark-600 px-1.5 py-0.5 rounded flex-shrink-0"
				>
					+{overflow}
				</span>
			)}
		</div>
	);
}

/** Task group card with colored header, matching RoomTasks.TaskGroup style */
function TaskGroup({
	title,
	count,
	variant,
	tasks,
	taskById,
	onTaskClick,
}: {
	title: string;
	count: number;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
	tasks: SpaceTask[];
	taskById: ReadonlyMap<string, SpaceTask>;
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
					<TaskItem key={task.id} task={task} taskById={taskById} onClick={onTaskClick} />
				))}
			</div>
		</div>
	);
}

/** Individual task item with left border, matching RoomTasks.TaskItem style */
function TaskItem({
	task,
	taskById,
	onClick,
}: {
	task: SpaceTask;
	taskById: ReadonlyMap<string, SpaceTask>;
	onClick?: (taskId: string) => void;
}) {
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
					<TaskDependencyBadges
						dependsOnIds={task.dependsOn}
						taskById={taskById}
						onSelectDependency={onClick}
					/>
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
	const schedules = spaceStore.schedules.value;
	const activeTab: TaskFilterTab = currentSpaceTasksFilterTabSignal.value as TaskFilterTab;
	const spaceId = currentSpaceIdSignal.value ?? '';

	// Load schedules when the tab is switched to 'scheduled'
	useEffect(() => {
		if (activeTab === 'scheduled') {
			spaceStore.listSchedules().catch(() => {});
		}
	}, [activeTab]);

	const counts = useMemo(() => {
		const c: Record<TaskFilterTab, number> = {
			action: 0,
			active: 0,
			draft: 0,
			completed: 0,
			archived: 0,
			scheduled: schedules.filter((s) => s.status !== 'completed').length,
		};
		for (const task of tasks) {
			for (const [tab, predicate] of Object.entries(TAB_PREDICATES) as [
				Exclude<TaskFilterTab, 'scheduled'>,
				(t: SpaceTask) => boolean,
			][]) {
				if (predicate(task)) {
					c[tab]++;
					break;
				}
			}
		}
		return c;
	}, [tasks, schedules]);

	const filteredTasks = useMemo(() => {
		if (activeTab === 'scheduled') return [];
		const predicate = TAB_PREDICATES[activeTab as Exclude<TaskFilterTab, 'scheduled'>];
		if (!predicate) return [];
		return [...tasks].filter(predicate).sort((a, b) => b.updatedAt - a.updatedAt);
	}, [tasks, activeTab]);

	// Build the dep lookup once per render of the list — O(N) total rather
	// than O(N) per row inside the badge component.
	const taskById = useMemo(() => {
		const map = new Map<string, SpaceTask>();
		for (const t of tasks) map.set(t.id, t);
		return map;
	}, [tasks]);

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
						label="Action"
						count={counts.action}
						isActive={activeTab === 'action'}
						onClick={() => navigateToSpaceTasks(spaceId, 'action')}
						variant="amber"
					/>
					<TabButton
						label="Active"
						count={counts.active}
						isActive={activeTab === 'active'}
						onClick={() => navigateToSpaceTasks(spaceId, 'active')}
					/>
					{counts.draft > 0 && (
						<TabButton
							label="Drafts"
							count={counts.draft}
							isActive={activeTab === 'draft'}
							onClick={() => navigateToSpaceTasks(spaceId, 'draft')}
						/>
					)}
					<TabButton
						label="Completed"
						count={counts.completed}
						isActive={activeTab === 'completed'}
						onClick={() => navigateToSpaceTasks(spaceId, 'completed')}
						variant="green"
					/>
					<TabButton
						label="Archived"
						count={counts.archived}
						isActive={activeTab === 'archived'}
						onClick={() => navigateToSpaceTasks(spaceId, 'archived')}
						variant="gray"
					/>
					<TabButton
						label="Scheduled"
						count={counts.scheduled}
						isActive={activeTab === 'scheduled'}
						onClick={() => navigateToSpaceTasks(spaceId, 'scheduled')}
						variant="default"
					/>
				</div>

				{activeTab === 'scheduled' ? (
					schedules.length === 0 ? (
						<EmptyTabState tab="scheduled" />
					) : (
						<ScheduleList
							schedules={schedules}
							onPause={(id) => spaceStore.pauseSchedule(id).catch(() => {})}
							onResume={(id) => spaceStore.resumeSchedule(id).catch(() => {})}
							onDelete={(id) => spaceStore.deleteSchedule(id).catch(() => {})}
						/>
					)
				) : filteredTasks.length === 0 ? (
					<EmptyTabState tab={activeTab} />
				) : (
					<TaskGroupList
						tasks={filteredTasks}
						taskById={taskById}
						tab={activeTab as Exclude<TaskFilterTab, 'scheduled'>}
						onTaskClick={onSelectTask}
					/>
				)}
			</div>
		</div>
	);
}

/** Schedule list for the Scheduled tab */
function ScheduleList({
	schedules,
	onPause,
	onResume,
	onDelete,
}: {
	schedules: TaskSchedule[];
	onPause: (id: string) => void;
	onResume: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const [deletingId, setDeletingId] = useState<string | null>(null);

	const handleDelete = (id: string) => {
		setDeletingId(id);
		onDelete(id);
	};

	const formatNextRun = (nextRunAt: number | null) => {
		if (!nextRunAt) return 'N/A';
		return getRelativeTime(nextRunAt);
	};

	const formatTrigger = (s: TaskSchedule) => {
		if (s.triggerType === 'cron') return s.cronExpression ?? 'cron';
		if (s.runAt) return `once at ${new Date(s.runAt).toLocaleString()}`;
		return 'one-shot';
	};

	return (
		<div class="space-y-2">
			{schedules.map((s) => (
				<div
					key={s.id}
					class="flex items-start gap-3 rounded-lg border border-dark-700 bg-dark-800 p-3"
				>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium text-gray-200 truncate">{s.title}</span>
							<span
								class={`text-xs px-1.5 py-0.5 rounded ${
									s.status === 'active'
										? 'bg-green-900/40 text-green-400'
										: s.status === 'paused'
											? 'bg-amber-900/40 text-amber-400'
											: 'bg-gray-800 text-gray-500'
								}`}
							>
								{s.status}
							</span>
						</div>
						<div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
							<span title="Trigger">{formatTrigger(s)}</span>
							{s.nextRunAt && s.status === 'active' && (
								<span>next: {formatNextRun(s.nextRunAt)}</span>
							)}
							{s.lastRunAt && <span>last: {getRelativeTime(s.lastRunAt)}</span>}
						</div>
					</div>
					<div class="flex items-center gap-1 shrink-0">
						{s.status === 'active' && (
							<button
								class="px-2 py-1 text-xs rounded text-amber-400 hover:bg-amber-900/20"
								onClick={() => onPause(s.id)}
							>
								Pause
							</button>
						)}
						{s.status === 'paused' && (
							<button
								class="px-2 py-1 text-xs rounded text-green-400 hover:bg-green-900/20"
								onClick={() => onResume(s.id)}
							>
								Resume
							</button>
						)}
						<button
							class="px-2 py-1 text-xs rounded text-red-400 hover:bg-red-900/20"
							onClick={() => handleDelete(s.id)}
							disabled={deletingId === s.id}
						>
							Delete
						</button>
					</div>
				</div>
			))}
		</div>
	);
}

/** Groups tasks by status within the selected tab, rendering TaskGroup cards */
function TaskGroupList({
	tasks,
	taskById,
	tab,
	onTaskClick,
}: {
	tasks: SpaceTask[];
	taskById: ReadonlyMap<string, SpaceTask>;
	tab: Exclude<TaskFilterTab, 'scheduled'>;
	onTaskClick?: (taskId: string) => void;
}) {
	const groups = TAB_GROUPS_DEF[tab];

	return (
		<div class="space-y-4">
			{groups.map((group) => {
				const filterFn = group.filterFn ?? ((t: SpaceTask) => t.status === group.status);
				const groupTasks = tasks.filter(filterFn);
				if (groupTasks.length === 0) return null;
				return (
					<TaskGroup
						key={group.title}
						title={group.title}
						count={groupTasks.length}
						variant={group.variant}
						tasks={groupTasks}
						taskById={taskById}
						onTaskClick={onTaskClick}
					/>
				);
			})}
		</div>
	);
}
