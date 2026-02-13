/**
 * RoomDashboard Component
 *
 * Dashboard showing room overview with:
 * - Stats overview (sessions, pending, active, completed tasks)
 * - Sessions list
 * - Tasks list grouped by status
 */

import { roomStore } from '../../lib/room-store';
import { RoomSessions } from './RoomSessions';
import { RoomTasks } from './RoomTasks';

interface RoomDashboardProps {
	roomId: string;
}

export function RoomDashboard({ roomId: _roomId }: RoomDashboardProps) {
	const tasks = roomStore.tasks.value;
	const sessions = roomStore.sessions.value;
	const pendingTasks = tasks.filter((t) => t.status === 'pending');
	const activeTasks = tasks.filter((t) => t.status === 'in_progress');
	const completedTasks = tasks.filter((t) => t.status === 'completed');

	return (
		<div class="p-4 space-y-6">
			{/* Stats overview */}
			<div class="grid grid-cols-4 gap-4">
				<div class="bg-dark-850 border border-dark-700 rounded-lg p-4">
					<div class="text-2xl font-bold text-gray-100">{sessions.length}</div>
					<div class="text-sm text-gray-400">Sessions</div>
				</div>
				<div class="bg-dark-850 border border-dark-700 rounded-lg p-4">
					<div class="text-2xl font-bold text-gray-100">{pendingTasks.length}</div>
					<div class="text-sm text-gray-400">Pending</div>
				</div>
				<div class="bg-dark-850 border border-dark-700 rounded-lg p-4">
					<div class="text-2xl font-bold text-gray-100">{activeTasks.length}</div>
					<div class="text-sm text-gray-400">Active</div>
				</div>
				<div class="bg-dark-850 border border-dark-700 rounded-lg p-4">
					<div class="text-2xl font-bold text-gray-100">{completedTasks.length}</div>
					<div class="text-sm text-gray-400">Completed</div>
				</div>
			</div>

			{/* Sessions list */}
			<RoomSessions sessions={sessions} />

			{/* Tasks list */}
			<RoomTasks tasks={tasks} />
		</div>
	);
}
