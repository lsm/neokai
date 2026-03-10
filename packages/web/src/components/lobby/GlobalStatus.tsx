/**
 * GlobalStatus Component
 *
 * Displays global statistics across all rooms:
 * - Room count
 * - Session count
 * - Task count
 */

import { lobbyStore } from '../../lib/lobby-store';

export function GlobalStatus() {
	const rooms = lobbyStore.rooms.value;
	const globalStatus = lobbyStore.globalStatus.value;

	const activeSessions = rooms.reduce((sum, r) => sum + r.sessionIds.length, 0);
	const totalTasks = globalStatus?.totalActiveTasks ?? 0;

	return (
		<div class="bg-dark-850/30 border-b border-dark-700 px-6 py-3">
			<div class="flex gap-8 text-sm">
				<div class="flex items-center gap-2">
					<span class="text-gray-400">Rooms:</span>
					<span class="text-gray-100 font-medium">{rooms.length}</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-gray-400">Sessions:</span>
					<span class="text-gray-100 font-medium">{activeSessions}</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-gray-400">Tasks:</span>
					<span class="text-gray-100 font-medium">{totalTasks}</span>
				</div>
			</div>
		</div>
	);
}
