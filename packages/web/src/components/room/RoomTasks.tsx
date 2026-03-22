/**
 * RoomTasks Component
 *
 * Displays tasks with filter tabs for organization:
 * - Active: draft + pending + in_progress
 * - Review: review + needs_attention (awaiting human action)
 * - Done: completed + cancelled
 * - Archived: archived (hidden by default, expandable)
 */

import { useState } from 'preact/hooks';
import { signal, effect } from '@preact/signals';
import type { TaskSummary, TaskStatus, RoomGoal } from '@neokai/shared';
import { toast } from '../../lib/toast.ts';

/** Tab filter types */
export type TaskFilterTab = 'active' | 'review' | 'done' | 'archived';

/** Get initial tab from localStorage - exported for testing */
export function getInitialTab(): TaskFilterTab {
	if (typeof window === 'undefined') return 'active';
	const stored = localStorage.getItem('neokai:room:taskFilterTab');
	// Migrate old tab values: 'failed' and 'needs_attention' now live under 'review'
	if (stored === 'failed' || stored === 'needs_attention') return 'review';
	if (stored === 'active' || stored === 'review' || stored === 'done' || stored === 'archived') {
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
	goals?: RoomGoal[];
	onTaskClick?: (taskId: string) => void;
	onGoalClick?: (goalId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
	onApprove?: (taskId: string) => void;
	onReactivate?: (taskId: string) => void;
}

/** Get count of tasks for each filter tab */
function getTabCounts(tasks: TaskSummary[]) {
	return {
		active: tasks.filter(
			(t) => t.status === 'draft' || t.status === 'pending' || t.status === 'in_progress'
		).length,
		review: tasks.filter((t) => t.status === 'review' || t.status === 'needs_attention').length,
		done: tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled').length,
		archived: tasks.filter((t) => t.status === 'archived').length,
	};
}

/** Filter tasks based on selected tab */
function getFilteredTasks(tasks: TaskSummary[], tab: TaskFilterTab): TaskSummary[] {
	switch (tab) {
		case 'active':
			return tasks.filter(
				(t) => t.status === 'draft' || t.status === 'pending' || t.status === 'in_progress'
			);
		case 'review':
			return tasks.filter((t) => t.status === 'review' || t.status === 'needs_attention');
		case 'done':
			return tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled');
		case 'archived':
			return tasks.filter((t) => t.status === 'archived');
	}
}

/** Map task status to a left border color class */
function getStatusBorderColor(status: TaskStatus): string {
	switch (status) {
		case 'draft':
			return 'border-l-gray-600';
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
		case 'archived':
			return 'border-l-gray-800';
		default:
			return 'border-l-transparent';
	}
}

export function RoomTasks({
	tasks,
	goals,
	onTaskClick,
	onGoalClick,
	onView,
	onReject,
	onApprove,
	onReactivate,
}: RoomTasksProps) {
	// Build reverse lookup: taskId → RoomGoal
	const goalByTaskId = new Map<string, RoomGoal>();
	if (goals) {
		for (const goal of goals) {
			for (const taskId of goal.linkedTaskIds) {
				goalByTaskId.set(taskId, goal);
			}
		}
	}
	let selectedTab = selectedTabSignal.value;
	const tabCounts = getTabCounts(tasks);

	// Auto-reset to 'active' when archived tab is selected but no archived tasks exist
	if (selectedTab === 'archived' && tabCounts.archived === 0) {
		selectedTab = 'active';
		selectedTabSignal.value = 'active';
	}

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
				{tabCounts.archived > 0 && (
					<TabButton
						label="Archived"
						count={tabCounts.archived}
						isActive={selectedTab === 'archived'}
						onClick={() => handleTabClick('archived')}
						variant="gray"
					/>
				)}
			</div>

			{/* Task List */}
			{filteredTasks.length === 0 ? (
				<EmptyTabState tab={selectedTab} />
			) : (
				<TaskList
					tasks={filteredTasks}
					allTasks={tasks}
					tab={selectedTab}
					goalByTaskId={goalByTaskId}
					onTaskClick={onTaskClick}
					onGoalClick={onGoalClick}
					onView={onView}
					onReject={onReject}
					onApprove={onApprove}
					onReactivate={onReactivate}
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
			description: 'Completed and cancelled tasks will appear here',
		},
		archived: {
			title: 'No archived tasks',
			description: 'Archived tasks will appear here',
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
	goalByTaskId,
	onTaskClick,
	onGoalClick,
	onView,
	onReject,
	onApprove,
	onReactivate,
}: {
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	tab: TaskFilterTab;
	goalByTaskId?: Map<string, RoomGoal>;
	onTaskClick?: (taskId: string) => void;
	onGoalClick?: (goalId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
	onApprove?: (taskId: string) => void;
	onReactivate?: (taskId: string) => void;
}) {
	const [rejectingTaskId, setRejectingTaskId] = useState<string | null>(null);

	// Active tab: group by in_progress, pending, draft
	// Review tab: group by review and needs_attention
	// Done tab: group by completed and cancelled
	// Archived tab: all archived tasks

	if (tab === 'active') {
		const inProgress = tasks.filter((t) => t.status === 'in_progress');
		const pending = tasks.filter((t) => t.status === 'pending');
		const draft = tasks.filter((t) => t.status === 'draft');

		return (
			<div class="space-y-4">
				{inProgress.length > 0 && (
					<TaskGroup
						title="In Progress"
						count={inProgress.length}
						variant="yellow"
						tasks={inProgress}
						allTasks={allTasks}
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
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
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
					/>
				)}
				{draft.length > 0 && (
					<TaskGroup
						title="Draft"
						count={draft.length}
						variant="gray"
						tasks={draft}
						allTasks={allTasks}
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
					/>
				)}
			</div>
		);
	}

	if (tab === 'review') {
		const reviewTasks = tasks.filter((t) => t.status === 'review');
		const needsAttention = tasks.filter((t) => t.status === 'needs_attention');

		return (
			<div class="space-y-4">
				{reviewTasks.length > 0 && (
					<TaskGroup
						title="Awaiting Review"
						count={reviewTasks.length}
						variant="purple"
						tasks={reviewTasks}
						allTasks={allTasks}
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
						onView={onView}
						onReject={onReject}
						onApprove={onApprove}
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
					/>
				)}
				{needsAttention.length > 0 && (
					<TaskGroup
						title="Needs Attention"
						count={needsAttention.length}
						variant="red"
						tasks={needsAttention}
						allTasks={allTasks}
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
						showAlert
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
					/>
				)}
			</div>
		);
	}

	if (tab === 'done') {
		const completed = tasks.filter((t) => t.status === 'completed');
		const cancelled = tasks.filter((t) => t.status === 'cancelled');

		return (
			<div class="space-y-4">
				{completed.length > 0 && (
					<TaskGroup
						title="Completed"
						count={completed.length}
						variant="green"
						tasks={completed}
						allTasks={allTasks}
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
						onReactivate={onReactivate}
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
						goalByTaskId={goalByTaskId}
						onTaskClick={onTaskClick}
						onGoalClick={onGoalClick}
						onReactivate={onReactivate}
						rejectingTaskId={rejectingTaskId}
						onSetRejectingTaskId={setRejectingTaskId}
					/>
				)}
			</div>
		);
	}

	// Archived tab
	return (
		<div class="space-y-4">
			<TaskGroup
				title="Archived"
				count={tasks.length}
				variant="gray"
				tasks={tasks}
				allTasks={allTasks}
				goalByTaskId={goalByTaskId}
				onTaskClick={onTaskClick}
				onGoalClick={onGoalClick}
				rejectingTaskId={rejectingTaskId}
				onSetRejectingTaskId={setRejectingTaskId}
			/>
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
	goalByTaskId,
	onTaskClick,
	onGoalClick,
	onView,
	onReject,
	onApprove,
	onReactivate,
	showAlert = false,
	rejectingTaskId,
	onSetRejectingTaskId,
}: {
	title: string;
	count: number;
	variant: 'default' | 'yellow' | 'purple' | 'green' | 'red' | 'gray';
	tasks: TaskSummary[];
	allTasks: TaskSummary[];
	goalByTaskId?: Map<string, RoomGoal>;
	onTaskClick?: (taskId: string) => void;
	onGoalClick?: (goalId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
	onApprove?: (taskId: string) => void;
	onReactivate?: (taskId: string) => void;
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
						goal={goalByTaskId?.get(task.id)}
						onClick={onTaskClick}
						onGoalClick={onGoalClick}
						onView={onView}
						onReject={onReject}
						onApprove={onApprove}
						onReactivate={onReactivate}
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
	goal,
	onClick,
	onGoalClick,
	onView,
	onReject,
	onApprove,
	onReactivate,
	rejectingTaskId,
	onSetRejectingTaskId,
}: {
	task: TaskSummary;
	allTasks: TaskSummary[];
	goal?: RoomGoal;
	onClick?: (taskId: string) => void;
	onGoalClick?: (goalId: string) => void;
	onView?: (taskId: string) => void;
	onReject?: (taskId: string, feedback: string) => void;
	onApprove?: (taskId: string) => void;
	onReactivate?: (taskId: string) => void;
	rejectingTaskId?: string | null;
	onSetRejectingTaskId?: (id: string | null) => void;
}) {
	const [feedback, setFeedback] = useState('');
	// Approve animation: button shows "✓ Approved" for 300ms, card fades to opacity-40
	const [buttonApproved, setButtonApproved] = useState(false);
	const [cardFading, setCardFading] = useState(false);

	const isClickable = !!onClick;
	const isReview = task.status === 'review';
	const showView = isReview && !!onView;
	const showReject = isReview && !!onReject;
	const showApprove = isReview && !!onApprove;
	const blocked = task.status === 'pending' && isBlocked(task, allTasks);
	const hasDeps = task.dependsOn && task.dependsOn.length > 0;
	const isWorking = isReview && !!task.activeSession;
	const isRejecting = rejectingTaskId === task.id;
	const showReactivate =
		(task.status === 'completed' || task.status === 'cancelled') && !!onReactivate;

	// Compute border color: when approve animation active, switch to green
	const borderColor = cardFading ? 'border-l-green-500' : getStatusBorderColor(task.status);

	return (
		<div
			class={`px-4 py-3 border-l-2 ${borderColor} transition-[opacity,border-color] duration-500 ${cardFading ? 'opacity-40' : ''} ${isClickable ? 'cursor-pointer hover:bg-dark-800/50 transition-colors' : ''}`}
			onClick={isClickable ? () => onClick(task.id) : undefined}
		>
			<div class="flex items-start justify-between">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
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
						{goal && (
							<button
								data-testid={`task-goal-badge-${task.id}`}
								onClick={(e) => {
									e.stopPropagation();
									onGoalClick?.(goal.id);
								}}
								class="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-900/20 border border-emerald-700/40 px-1.5 py-0.5 rounded-full flex-shrink-0 hover:bg-emerald-900/40 transition-colors"
								title={`Mission: ${goal.title}`}
							>
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M13 10V3L4 14h7v7l9-11h-7z"
									/>
								</svg>
								<span class="max-w-[120px] truncate">{goal.title}</span>
							</button>
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
					{isClickable && !isReview && <span class="text-xs text-gray-600">&rarr;</span>}
				</div>
			</div>
			{/* Review: auto-expanded action section */}
			{isReview && (
				<div class="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
					{task.currentStep && (
						<p class="text-xs text-gray-400 italic line-clamp-2">{task.currentStep}</p>
					)}
					{(showApprove || showReject || showView) && (
						<div class="flex items-center gap-2">
							{showApprove && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										// Start approve animation: button text + card fade
										setButtonApproved(true);
										setCardFading(true);
										onApprove(task.id);
										// Reset button text after 300ms
										setTimeout(() => setButtonApproved(false), 300);
									}}
									disabled={buttonApproved}
									class="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:cursor-default"
								>
									{buttonApproved ? '✓ Approved' : 'Approve'}
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
									class="px-3 py-1.5 text-xs font-medium text-red-400 border border-red-700/50 hover:bg-red-900/20 rounded-lg transition-colors"
								>
									Reject
								</button>
							)}
							{showView && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										onView(task.id);
									}}
									class="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
								>
									View details →
								</button>
							)}
						</div>
					)}
				</div>
			)}
			{/* Done/Cancelled: reactivate action */}
			{showReactivate && (
				<div class="mt-2" onClick={(e) => e.stopPropagation()}>
					<button
						onClick={(e) => {
							e.stopPropagation();
							onReactivate(task.id);
						}}
						class="px-3 py-1.5 text-xs font-medium text-blue-400 border border-blue-700/50 hover:bg-blue-900/20 rounded-lg transition-colors"
						data-testid={`task-reactivate-${task.id}`}
					>
						Reactivate
					</button>
				</div>
			)}
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
			{/* Reject form — always rendered; max-height controls collapse with transition-all duration-200 */}
			<div
				class={`overflow-hidden transition-all duration-200 ${isRejecting ? 'max-h-48' : 'max-h-0 pointer-events-none'}`}
				onClick={(e) => e.stopPropagation()}
			>
				<div class="mt-3 pt-3 border-t border-dark-700">
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
								toast.rejected();
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
			</div>
		</div>
	);
}
