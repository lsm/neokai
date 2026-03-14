/**
 * RoomTasks Component
 *
 * Displays tasks with filter tabs for organization:
 * - Active: pending + in_progress
 * - Review: review status (awaiting human action)
 * - Done: completed
 * - Needs Attention: needs_attention + cancelled
 */

import { signal, effect } from '@preact/signals';
import type { TaskSummary } from '@neokai/shared';

/** Tab filter types */
export type TaskFilterTab = 'active' | 'review' | 'done' | 'needs_attention';

/** Get initial tab from localStorage */
function getInitialTab(): TaskFilterTab {
	if (typeof window === 'undefined') return 'active';
	const stored = localStorage.getItem('neokai:room:taskFilterTab');
	if (
		stored === 'active' ||
		stored === 'review' ||
		stored === 'done' ||
		stored === 'needs_attention'
	) {
		return stored;
	}
	return 'active';
}

/** Persisted tab selection signal with localStorage sync - exported for testing */
export const selectedTabSignal = signal<TaskFilterTab>(getInitialTab());

// Sync signal changes to localStorage
if (typeof window !== 'undefined') {
	effect(() => {
		const tab = selectedTabSignal.value;
		localStorage.setItem('neokai:room:taskFilterTab', tab);
	});
}

interface RoomTasksProps {
	tasks: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onView?: (taskId: string) => void;
}

/** Get count of tasks for each filter tab */
function getTabCounts(tasks: TaskSummary[]) {
	return {
		active: tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').length,
		review: tasks.filter((t) => t.status === 'review').length,
		done: tasks.filter((t) => t.status === 'completed').length,
		needs_attention: tasks.filter((t) => t.status === 'needs_attention' || t.status === 'cancelled')
			.length,
	};
}

/** Filter tasks based on selected tab */
function getFilteredTasks(tasks: TaskSummary[], tab: TaskFilterTab): TaskSummary[] {
	switch (tab) {
		case 'active':
			return tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
		case 'review':
			return tasks.filter((t) => t.status === 'review');
		case 'done':
			return tasks.filter((t) => t.status === 'completed');
		case 'needs_attention':
			return tasks.filter((t) => t.status === 'needs_attention' || t.status === 'cancelled');
	}
}

export function RoomTasks({ tasks, onTaskClick, onApprove, onView }: RoomTasksProps) {
	const selectedTab = selectedTabSignal.value;
	const tabCounts = getTabCounts(tasks);
	const filteredTasks = getFilteredTasks(tasks, selectedTab);

	const handleTabClick = (tab: TaskFilterTab) => {
		selectedTabSignal.value = tab;
	};

	if (tasks.length === 0) {
		return (
			<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
				<p class="text-gray-400">No tasks yet</p>
				<p class="text-sm text-gray-500 mt-1">Create a task to get started</p>
			</div>
		);
	}

	return (
		<div class="space-y-4">
			{/* Tab Bar */}
			<div class="flex border-b border-dark-700">
				<TabButton
					label="Active"
					count={tabCounts.active}
					isActive={selectedTab === 'active'}
					onClick={() => handleTabClick('active')}
				/>
				<TabButton
					label="Review"
					count={tabCounts.review}
					isActive={selectedTab === 'review'}
					onClick={() => handleTabClick('review')}
					variant="purple"
				/>
				<TabButton
					label="Done"
					count={tabCounts.done}
					isActive={selectedTab === 'done'}
					onClick={() => handleTabClick('done')}
					variant="green"
				/>
				<TabButton
					label="Needs Attention"
					count={tabCounts.needs_attention}
					isActive={selectedTab === 'needs_attention'}
					onClick={() => handleTabClick('needs_attention')}
					variant="red"
				/>
			</div>

			{/* Task List */}
			{filteredTasks.length === 0 ? (
				<EmptyTabState tab={selectedTab} />
			) : (
				<TaskList
					tasks={filteredTasks}
					allTasks={tasks}
					tab={selectedTab}
					onTaskClick={onTaskClick}
					onApprove={onApprove}
					onView={onView}
				/>
			)}
		</div>
	);
}

/** Tab button component */
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
	variant?: 'default' | 'purple' | 'green' | 'red';
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
									: 'bg-dark-700'
					}`}
				>
					{count}
				</span>
			)}
		</button>
	);
}

/** Empty state for each tab */
function EmptyTabState({ tab }: { tab: TaskFilterTab }) {
	const messages: Record<TaskFilterTab, { title: string; description: string }> = {
		active: {
			title: 'No active tasks',
			description: 'Active tasks will appear here',
		},
		review: {
			title: 'No tasks to review',
			description: 'Tasks needing review will appear here',
		},
		done: {
			title: 'No completed tasks',
			description: 'Completed tasks will appear here',
		},
		needs_attention: {
			title: 'No tasks needing attention',
			description: 'Tasks needing attention and cancelled tasks will appear here',
		},
	};

	const { title, description } = messages[tab];

	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
			<p class="text-gray-400">{title}</p>
			<p class="text-sm text-gray-500 mt-1">{description}</p>
		</div>
	);
}

/** Task list renderer - groups tasks by status within the filtered view */
function TaskList({
	tasks,
	allTasks,
	tab,
	onTaskClick,
	onApprove,
	onView,
}: {
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	tab: TaskFilterTab;
	onTaskClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onView?: (taskId: string) => void;
}) {
	// For Active tab, group by in_progress and pending
	// For Review tab - all are review status
	// For Done tab - all are completed
	// For Needs Attention tab - group by needs_attention and cancelled

	if (tab === 'active') {
		const inProgress = tasks.filter((t) => t.status === 'in_progress');
		const pending = tasks.filter((t) => t.status === 'pending');

		return (
			<div class="space-y-4">
				{inProgress.length > 0 && (
					<TaskGroup
						title="In Progress"
						count={inProgress.length}
						variant="yellow"
						tasks={inProgress}
						allTasks={allTasks}
						onTaskClick={onTaskClick}
					/>
				)}
				{pending.length > 0 && (
					<TaskGroup
						title="Pending"
						count={pending.length}
						variant="default"
						tasks={pending}
						allTasks={allTasks}
						onTaskClick={onTaskClick}
					/>
				)}
			</div>
		);
	}

	if (tab === 'review') {
		return (
			<div class="space-y-4">
				<TaskGroup
					title="Awaiting Review"
					count={tasks.length}
					variant="purple"
					tasks={tasks}
					allTasks={allTasks}
					onTaskClick={onTaskClick}
					onApprove={onApprove}
					onView={onView}
				/>
			</div>
		);
	}

	if (tab === 'done') {
		return (
			<div class="space-y-4">
				<TaskGroup
					title="Completed"
					count={tasks.length}
					variant="green"
					tasks={tasks}
					allTasks={allTasks}
					onTaskClick={onTaskClick}
				/>
			</div>
		);
	}

	// Needs Attention tab
	const needsAttention = tasks.filter((t) => t.status === 'needs_attention');
	const cancelled = tasks.filter((t) => t.status === 'cancelled');

	return (
		<div class="space-y-4">
			{needsAttention.length > 0 && (
				<TaskGroup
					title="Needs Attention"
					count={needsAttention.length}
					variant="red"
					tasks={needsAttention}
					allTasks={allTasks}
					onTaskClick={onTaskClick}
					showAlert
				/>
			)}
			{cancelled.length > 0 && (
				<TaskGroup
					title="Cancelled"
					count={cancelled.length}
					variant="gray"
					tasks={cancelled}
					allTasks={allTasks}
					onTaskClick={onTaskClick}
				/>
			)}
		</div>
	);
}

/** Task group component */
function TaskGroup({
	title,
	count,
	variant,
	tasks,
	allTasks,
	onTaskClick,
	onApprove,
	onView,
	showAlert = false,
}: {
	title: string;
	count: number;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onView?: (taskId: string) => void;
	showAlert?: boolean;
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
		<div class={`bg-dark-850 border rounded-lg overflow-hidden ${borderStyles[variant]}`}>
			<div
				class={`px-4 py-3 border-b ${borderStyles[variant]} ${headerStyles[variant]} flex items-center gap-1`}
			>
				{showAlert && (
					<svg
						class="w-4 h-4 text-red-400 flex-shrink-0"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={1.5}
							d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
						/>
					</svg>
				)}
				<h3 class={`font-semibold ${titleStyles[variant]}`}>
					{title} ({count})
				</h3>
			</div>
			<div class="divide-y divide-dark-700">
				{tasks.map((task) => (
					<TaskItem
						key={task.id}
						task={task}
						allTasks={allTasks}
						onClick={onTaskClick}
						onApprove={onApprove}
						onView={onView}
					/>
				))}
			</div>
		</div>
	);
}

function isBlocked(task: TaskSummary, allTasks: TaskSummary[]): boolean {
	if (!task.dependsOn || task.dependsOn.length === 0) return false;
	return task.dependsOn.some((depId) => {
		const dep = allTasks.find((t) => t.id === depId);
		return !dep || dep.status !== 'completed';
	});
}

function TaskItem({
	task,
	allTasks,
	onClick,
	onApprove,
	onView,
}: {
	task: TaskSummary;
	allTasks: TaskSummary[];
	onClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onView?: (taskId: string) => void;
}) {
	const isClickable = !!onClick;
	const showApprove = task.status === 'review' && !!onApprove;
	const showView = task.status === 'review' && !!onView;
	const blocked = task.status === 'pending' && isBlocked(task, allTasks);
	const hasDeps = task.dependsOn && task.dependsOn.length > 0;

	const isWorking = task.status === 'review' && !!task.activeSession;

	return (
		<div
			class={`px-4 py-3 ${isClickable ? 'cursor-pointer hover:bg-dark-800/50 transition-colors' : ''}`}
			onClick={isClickable ? () => onClick(task.id) : undefined}
		>
			<div class="flex items-start justify-between">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<h4 class="text-sm font-medium text-gray-100 truncate">{task.title}</h4>
						{isWorking && (
							<span class="inline-flex items-center gap-1 text-xs font-medium text-blue-400 bg-blue-900/20 border border-blue-700/40 px-1.5 py-0.5 rounded-full flex-shrink-0">
								<span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
								{task.activeSession === 'worker' ? 'Worker' : 'Leader'} working
							</span>
						)}
						{blocked && (
							<span class="text-xs px-1.5 py-0.5 rounded bg-orange-900/20 text-orange-400 flex-shrink-0">
								Blocked
							</span>
						)}
					</div>
				</div>
				<div class="ml-4 flex items-center gap-2 flex-shrink-0">
					{task.progress !== undefined && (
						<span class="text-xs text-gray-400">{task.progress}%</span>
					)}
					{showApprove && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onApprove(task.id);
							}}
							class="px-2 py-1 text-xs font-medium text-green-400 bg-green-900/20 hover:bg-green-900/40 border border-green-700/50 rounded transition-colors"
						>
							Approve
						</button>
					)}
					{showView && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onView(task.id);
							}}
							class="px-2 py-1 text-xs font-medium text-blue-400 bg-blue-900/20 hover:bg-blue-900/40 border border-blue-700/50 rounded transition-colors"
						>
							View
						</button>
					)}
					{isClickable && <span class="text-xs text-gray-600">&rarr;</span>}
				</div>
			</div>
			{task.status === 'needs_attention' && task.error && (
				<p class="text-xs text-red-400 mt-1.5 line-clamp-2" title={task.error}>
					{task.error}
				</p>
			)}
			{hasDeps && (
				<div class="flex items-center gap-1 mt-1.5 flex-wrap">
					<span class="text-xs text-gray-500">Deps:</span>
					{task.dependsOn.map((depId) => {
						const depTask = allTasks.find((t) => t.id === depId);
						const depCompleted = depTask?.status === 'completed';
						return (
							<span
								key={depId}
								class={`text-xs px-1.5 py-0.5 rounded ${
									depCompleted ? 'bg-green-900/20 text-green-400' : 'bg-dark-700 text-gray-400'
								}`}
								title={depTask?.title ?? depId}
							>
								{depTask?.title ?? depId.slice(0, 8)}
								{depCompleted ? ' \u2713' : ''}
							</span>
						);
					})}
				</div>
			)}
			{task.progress !== undefined && (
				<div class="mt-2 h-1 bg-dark-700 rounded-full overflow-hidden">
					<div
						class="h-full bg-blue-500 transition-all duration-300"
						style={{ width: `${task.progress}%` }}
					/>
				</div>
			)}
		</div>
	);
}
