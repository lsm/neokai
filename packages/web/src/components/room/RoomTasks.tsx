/**
 * RoomTasks Component
 *
 * Displays tasks with filter tabs for organization:
 * - Active: pending + in_progress
 * - Review: review status (awaiting human action)
 * - Done: completed
 * - Needs Attention: needs_attention + cancelled
 */

import { useState } from 'preact/hooks';
import { signal, effect } from '@preact/signals';
import type { TaskSummary, TaskStatus } from '@neokai/shared';

/** Tab filter types */
export type TaskFilterTab = 'active' | 'review' | 'done' | 'needs_attention';

/** Get initial tab from localStorage */
function getInitialTab(): TaskFilterTab {
	if (typeof window === 'undefined') return 'active';
	const stored = localStorage.getItem('neokai:room:taskFilterTab');
	// Migrate old 'failed' tab value to 'needs_attention'
	if (stored === 'failed') return 'needs_attention';
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
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
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

/** Map task status to a left border color class */
function getStatusBorderColor(status: TaskStatus): string {
	switch (status) {
		case 'pending':
			return 'border-l-gray-500';
		case 'in_progress':
			return 'border-l-blue-500';
		case 'review':
			return 'border-l-amber-500';
		case 'completed':
			return 'border-l-green-500';
		case 'needs_attention':
			return 'border-l-red-500';
		case 'cancelled':
			return 'border-l-gray-700';
		default:
			return 'border-l-transparent';
	}
}

export function RoomTasks({ tasks, onTaskClick, onView, onReject }: RoomTasksProps) {
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
					onView={onView}
					onReject={onReject}
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
	onView,
	onReject,
}: {
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	tab: TaskFilterTab;
	onTaskClick?: (taskId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
}) {
	const [rejectingTaskId, setRejectingTaskId] = useState<string | null>(null);

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
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
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
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
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
					onView={onView}
					onReject={onReject}
					rejectingTaskId={rejectingTaskId}
					onSetRejectingTaskId={setRejectingTaskId}
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
					rejectingTaskId={rejectingTaskId}
					onSetRejectingTaskId={setRejectingTaskId}
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
					rejectingTaskId={rejectingTaskId}
					onSetRejectingTaskId={setRejectingTaskId}
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
					rejectingTaskId={rejectingTaskId}
					onSetRejectingTaskId={setRejectingTaskId}
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
	onView,
	onReject,
	showAlert = false,
	rejectingTaskId,
	onSetRejectingTaskId,
}: {
	title: string;
	count: number;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
	showAlert?: boolean;
	rejectingTaskId?: string | null;
	onSetRejectingTaskId?: (id: string | null) => void;
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
						onView={onView}
						onReject={onReject}
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={onSetRejectingTaskId}
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
	onView,
	onReject,
	rejectingTaskId,
	onSetRejectingTaskId,
}: {
	task: TaskSummary;
	allTasks: TaskSummary[];
	onClick?: (taskId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
	rejectingTaskId?: string | null;
	onSetRejectingTaskId?: (id: string | null) => void;
}) {
	const [feedback, setFeedback] = useState('');
	const isClickable = !!onClick;
	const showView = task.status === 'review' && !!onView;
	const showReject = task.status === 'review' && !!onReject;
	const blocked = task.status === 'pending' && isBlocked(task, allTasks);
	const hasDeps = task.dependsOn && task.dependsOn.length > 0;
	const isWorking = task.status === 'review' && !!task.activeSession;
	const isRejecting = rejectingTaskId === task.id;

	return (
		<div
			class={`px-4 py-3 border-l-2 ${getStatusBorderColor(task.status)} ${isClickable ? 'cursor-pointer hover:bg-dark-800/50 transition-colors' : ''}`}
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
					{task.prUrl && (
						<a
							href={task.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							onClick={(e) => e.stopPropagation()}
							class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded transition-colors"
							title="View Pull Request"
						>
							<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							<span>PR #{task.prNumber ?? '?'}</span>
						</a>
					)}
					{showView && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onView(task.id);
							}}
							class="px-2 py-1 text-xs font-medium text-amber-400 bg-amber-900/20 hover:bg-amber-900/40 border border-amber-700/50 rounded transition-colors"
						>
							审阅
						</button>
					)}
					{showReject && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								if (isRejecting) {
									setFeedback('');
									onSetRejectingTaskId?.(null);
								} else {
									onSetRejectingTaskId?.(task.id);
								}
							}}
							class="px-2 py-1 text-xs font-medium text-red-400 bg-red-900/20 hover:bg-red-900/40 border border-red-700/50 rounded transition-colors"
						>
							Reject
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
			{isRejecting && (
				<div
					class="mt-3 pt-3 border-t border-dark-700"
					onClick={(e) => e.stopPropagation()}
				>
					<textarea
						rows={2}
						placeholder="Please provide feedback..."
						value={feedback}
						onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
						class="w-full text-sm bg-dark-900 border border-dark-600 rounded px-3 py-2 text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-red-500/60"
					/>
					<div class="flex justify-end gap-2 mt-2">
						<button
							onClick={(e) => {
								e.stopPropagation();
								setFeedback('');
								onSetRejectingTaskId?.(null);
							}}
							class="px-3 py-1.5 text-xs font-medium text-gray-400 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded transition-colors"
						>
							Cancel
						</button>
						<button
							onClick={(e) => {
								e.stopPropagation();
								onReject?.(task.id, feedback);
								setFeedback('');
								onSetRejectingTaskId?.(null);
							}}
							disabled={!feedback.trim()}
							class="px-3 py-1.5 text-xs font-medium text-red-400 bg-red-900/20 hover:bg-red-900/30 border border-red-700/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Confirm Reject
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
