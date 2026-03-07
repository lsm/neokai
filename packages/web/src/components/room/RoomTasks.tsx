/**
 * RoomTasks Component
 *
 * Displays tasks grouped by status:
 * - In Progress
 * - Review (with Approve button)
 * - Pending (with "Blocked" badge for unmet dependencies)
 * - Draft
 * - Completed
 * - Failed
 * - Cancelled
 * - Archived (when showing archived)
 */

import type { TaskSummary } from '@neokai/shared';

interface RoomTasksProps {
	tasks: TaskSummary[];
	onTaskClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onView?: (taskId: string) => void;
	onArchive?: (taskId: string) => void;
	onUnarchive?: (taskId: string) => void;
	archiveLoading?: string | null;
}

export function RoomTasks({
	tasks,
	onTaskClick,
	onApprove,
	onView,
	onArchive,
	onUnarchive,
	archiveLoading,
}: RoomTasksProps) {
	if (tasks.length === 0) {
		return (
			<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
				<p class="text-gray-400">No tasks yet</p>
				<p class="text-sm text-gray-500 mt-1">Create a task to get started</p>
			</div>
		);
	}

	// Group by status
	const inProgress = tasks.filter((t) => t.status === 'in_progress');
	const review = tasks.filter((t) => t.status === 'review');
	const pending = tasks.filter((t) => t.status === 'pending');
	const draft = tasks.filter((t) => t.status === 'draft');
	const completed = tasks.filter((t) => t.status === 'completed');
	const failed = tasks.filter((t) => t.status === 'failed');
	const cancelled = tasks.filter((t) => t.status === 'cancelled');
	const archived = tasks.filter((t) => t.isArchived);

	return (
		<div class="space-y-4">
			{/* Failed — shown first so failures are immediately visible */}
			{failed.length > 0 && (
				<div class="bg-dark-850 border border-red-800/60 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-red-800/60 bg-red-900/20 flex items-center gap-2">
						<svg
							class="w-4 h-4 text-red-400 flex-shrink-0"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
							/>
						</svg>
						<h3 class="font-semibold text-red-400">Failed ({failed.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{failed.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* In Progress */}
			{inProgress.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-yellow-900/20">
						<h3 class="font-semibold text-yellow-400">In Progress ({inProgress.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{inProgress.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Review */}
			{review.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-purple-900/20">
						<h3 class="font-semibold text-purple-400">Review ({review.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{review.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onApprove={onApprove}
								onView={onView}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Pending */}
			{pending.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700">
						<h3 class="font-semibold text-gray-100">Pending ({pending.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{pending.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Draft */}
			{draft.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-dark-800">
						<h3 class="font-semibold text-gray-400">Draft ({draft.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{draft.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Completed */}
			{completed.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-green-900/20">
						<h3 class="font-semibold text-green-400">Completed ({completed.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{completed.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Cancelled */}
			{cancelled.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-dark-800">
						<h3 class="font-semibold text-gray-500">Cancelled ({cancelled.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{cancelled.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Archived */}
			{archived.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-dark-800">
						<h3 class="font-semibold text-gray-500">Archived ({archived.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{archived.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								allTasks={tasks}
								onClick={onTaskClick}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								archiveLoading={archiveLoading}
							/>
						))}
					</div>
				</div>
			)}
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
	onArchive,
	onUnarchive,
	archiveLoading,
}: {
	task: TaskSummary;
	allTasks: TaskSummary[];
	onClick?: (taskId: string) => void;
	onApprove?: (taskId: string) => void;
	onView?: (taskId: string) => void;
	onArchive?: (taskId: string) => void;
	onUnarchive?: (taskId: string) => void;
	archiveLoading?: string | null;
}) {
	const isClickable = !!onClick;
	const showApprove = task.status === 'review' && !!onApprove;
	const showView = task.status === 'review' && !!onView;
	const showArchive = !task.isArchived && !!onArchive;
	const showUnarchive = task.isArchived && !!onUnarchive;
	const blocked = task.status === 'pending' && isBlocked(task, allTasks);
	const hasDeps = task.dependsOn && task.dependsOn.length > 0;
	const isArchiving = archiveLoading === task.id;

	return (
		<div
			class={`px-4 py-3 ${isClickable ? 'cursor-pointer hover:bg-dark-800/50 transition-colors' : ''}`}
			onClick={isClickable ? () => onClick(task.id) : undefined}
		>
			<div class="flex items-start justify-between">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<h4 class="text-sm font-medium text-gray-100 truncate">{task.title}</h4>
						{blocked && (
							<span class="text-xs px-1.5 py-0.5 rounded bg-orange-900/20 text-orange-400 flex-shrink-0">
								Blocked
							</span>
						)}
						{task.isArchived && (
							<span class="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 flex-shrink-0">
								Archived
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
					{showArchive && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onArchive(task.id);
							}}
							disabled={isArchiving}
							class="px-2 py-1 text-xs font-medium text-gray-400 bg-dark-700 hover:bg-dark-600 border border-dark-600 rounded transition-colors disabled:opacity-50"
						>
							{isArchiving ? 'Archiving...' : 'Archive'}
						</button>
					)}
					{showUnarchive && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onUnarchive(task.id);
							}}
							disabled={isArchiving}
							class="px-2 py-1 text-xs font-medium text-gray-400 bg-dark-700 hover:bg-dark-600 border border-dark-600 rounded transition-colors disabled:opacity-50"
						>
							{isArchiving ? 'Unarchiving...' : 'Unarchive'}
						</button>
					)}
					{isClickable && <span class="text-xs text-gray-600">&rarr;</span>}
				</div>
			</div>
			{task.status === 'failed' && task.error && (
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
