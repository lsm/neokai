/**
 * RoomTasks Component
 *
 * Displays tasks grouped by status:
 * - In Progress
 * - Pending
 * - Completed
 */

import type { TaskSummary } from '@neokai/shared';

interface RoomTasksProps {
	tasks: TaskSummary[];
}

export function RoomTasks({ tasks }: RoomTasksProps) {
	if (tasks.length === 0) {
		return (
			<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
				<p class="text-gray-400">No tasks yet</p>
				<p class="text-sm text-gray-500 mt-1">Ask Neo to create a task</p>
			</div>
		);
	}

	// Group by status
	const inProgress = tasks.filter((t) => t.status === 'in_progress');
	const pending = tasks.filter((t) => t.status === 'pending');
	const completed = tasks.filter((t) => t.status === 'completed');
	const blocked = tasks.filter((t) => t.status === 'blocked');
	const failed = tasks.filter((t) => t.status === 'failed');

	return (
		<div class="space-y-4">
			{/* In Progress */}
			{inProgress.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-yellow-900/20">
						<h3 class="font-semibold text-yellow-400">In Progress ({inProgress.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{inProgress.map((task) => (
							<TaskItem key={task.id} task={task} />
						))}
					</div>
				</div>
			)}

			{/* Blocked */}
			{blocked.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-orange-900/20">
						<h3 class="font-semibold text-orange-400">Blocked ({blocked.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{blocked.map((task) => (
							<TaskItem key={task.id} task={task} />
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
							<TaskItem key={task.id} task={task} />
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
							<TaskItem key={task.id} task={task} />
						))}
					</div>
				</div>
			)}

			{/* Failed */}
			{failed.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-red-900/20">
						<h3 class="font-semibold text-red-400">Failed ({failed.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{failed.map((task) => (
							<TaskItem key={task.id} task={task} />
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function TaskItem({ task }: { task: TaskSummary }) {
	return (
		<div class="px-4 py-3">
			<div class="flex items-start justify-between">
				<div class="flex-1 min-w-0">
					<h4 class="text-sm font-medium text-gray-100 truncate">{task.title}</h4>
				</div>
				{task.progress !== undefined && (
					<div class="ml-4 text-xs text-gray-400">{task.progress}%</div>
				)}
			</div>
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
