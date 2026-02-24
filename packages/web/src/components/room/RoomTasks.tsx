/**
 * RoomTasks Component
 *
 * Displays tasks grouped by status:
 * - In Progress
 * - Escalated
 * - Pending
 * - Draft
 * - Completed
 * - Failed
 */

import { useState } from 'preact/hooks';
import type { TaskSummary } from '@neokai/shared';

interface RoomTasksProps {
	tasks: TaskSummary[];
}

export function RoomTasks({ tasks }: RoomTasksProps) {
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
	const escalated = tasks.filter((t) => t.status === 'escalated');
	const pending = tasks.filter((t) => t.status === 'pending');
	const draft = tasks.filter((t) => t.status === 'draft');
	const completed = tasks.filter((t) => t.status === 'completed');
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

			{/* Escalated */}
			{escalated.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-orange-900/20">
						<h3 class="font-semibold text-orange-400">Escalated ({escalated.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{escalated.map((task) => (
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

			{/* Draft */}
			{draft.length > 0 && (
				<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
					<div class="px-4 py-3 border-b border-dark-700 bg-dark-800">
						<h3 class="font-semibold text-gray-400">Draft ({draft.length})</h3>
					</div>
					<div class="divide-y divide-dark-700">
						{draft.map((task) => (
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
	const [_isExpanded, setIsExpanded] = useState(false);

	return (
		<div class="px-4 py-3">
			<div class="flex items-start justify-between" onClick={() => setIsExpanded((v) => !v)}>
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
