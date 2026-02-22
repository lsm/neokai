/**
 * RoomDashboard Component
 *
 * Dashboard showing room overview with:
 * - Agent status and escalated issues
 * - Stats overview (sessions, pending, active, completed tasks)
 * - Sessions list
 * - Tasks list grouped by status
 */

import { roomStore } from '../../lib/room-store';
import { RoomSessions } from './RoomSessions';
import { RoomTasks } from './RoomTasks';
import { RoomSelfStatus } from './RoomSelfStatus';
import { RoomEscalations } from './RoomEscalations';

export function RoomDashboard() {
	const tasks = roomStore.tasks.value;
	const sessions = roomStore.sessions.value;
	const agentState = roomStore.agentState.value;
	const waitingContext = roomStore.waitingContext.value;
	const roomId = roomStore.roomId.value;
	const pendingTasks = tasks.filter((t) => t.status === 'pending');
	const activeTasks = tasks.filter((t) => t.status === 'in_progress');
	const completedTasks = tasks.filter((t) => t.status === 'completed');

	const handleAgentAction = async (action: 'start' | 'stop' | 'pause' | 'resume') => {
		try {
			if (action === 'start') await roomStore.startAgent();
			else if (action === 'stop') await roomStore.stopAgent();
			else if (action === 'pause') await roomStore.pauseAgent();
			else if (action === 'resume') await roomStore.resumeAgent();
		} catch {
			// Error is already logged in roomStore
		}
	};

	return (
		<div class="p-4 space-y-6">
			{/* Agent status */}
			{roomId && <RoomSelfStatus roomId={roomId} state={agentState} onAction={handleAgentAction} />}

			{/* Escalated issues - show prominently when waiting */}
			{roomId && (waitingContext || agentState?.lifecycleState === 'waiting') && (
				<RoomEscalations roomId={roomId} agentState={agentState} waitingContext={waitingContext} />
			)}

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

			{/* Tasks list */}
			<div class="space-y-2">
				<h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wide">Tasks</h2>
				<RoomTasks tasks={tasks} />
			</div>

			{/* Sessions list */}
			<div class="space-y-2">
				<h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wide">Sessions</h2>
				<RoomSessions sessions={sessions} />
			</div>
		</div>
	);
}
