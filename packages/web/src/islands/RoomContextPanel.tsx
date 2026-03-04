/**
 * RoomContextPanel
 *
 * Context panel content shown when viewing a specific room.
 * Replaces the generic RoomList with room-specific information:
 * - Back navigation to rooms list
 * - Task stats strip
 * - Room Dashboard pinned at top
 * - Sessions list below
 */

import { useMemo } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import { navigateToRooms, navigateToRoom, navigateToRoomSession } from '../lib/router';
import { currentRoomSessionIdSignal } from '../lib/signals';
import { cn } from '../lib/utils';

function formatRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return 'now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function StatusDot({ status }: { status: string }) {
	const colors: Record<string, string> = {
		idle: 'bg-gray-500',
		active: 'bg-green-500',
		processing: 'bg-blue-500 animate-pulse',
		waiting: 'bg-yellow-500',
		error: 'bg-red-500',
		archived: 'bg-gray-600',
	};
	return <div class={cn('w-2 h-2 rounded-full flex-shrink-0', colors[status] ?? colors.idle)} />;
}

interface RoomContextPanelProps {
	roomId: string;
	onNavigate?: () => void;
}

export function RoomContextPanel({ roomId, onNavigate }: RoomContextPanelProps) {
	const sessions = roomStore.sessions.value;
	const tasks = roomStore.tasks.value;

	const pendingCount = useMemo(() => tasks.filter((t) => t.status === 'pending').length, [tasks]);
	const activeCount = useMemo(
		() => tasks.filter((t) => t.status === 'in_progress').length,
		[tasks]
	);
	const doneCount = useMemo(() => tasks.filter((t) => t.status === 'completed').length, [tasks]);

	const roomAgentSessionId = `room:chat:${roomId}`;

	const handleDashboardClick = () => {
		navigateToRoom(roomId);
		onNavigate?.();
	};

	const handleRoomAgentClick = () => {
		navigateToRoomSession(roomId, roomAgentSessionId);
		onNavigate?.();
	};

	const handleSessionClick = (sessionId: string) => {
		navigateToRoomSession(roomId, sessionId);
		onNavigate?.();
	};

	const hasTasks = pendingCount > 0 || activeCount > 0 || doneCount > 0;

	const selectedSessionId = currentRoomSessionIdSignal.value;
	const isDashboardSelected = selectedSessionId === null;
	const isRoomAgentSelected = selectedSessionId === roomAgentSessionId;

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Back button */}
			<div class="px-3 pt-2 pb-1">
				<button
					onClick={() => navigateToRooms()}
					class="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
				>
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
					All Rooms
				</button>
			</div>

			{/* Create Session button */}
			<div class="px-3 py-2">
				<button
					onClick={async () => {
						const sessionId = await roomStore.createSession('New Session');
						navigateToRoomSession(roomId, sessionId);
						onNavigate?.();
					}}
					class="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-blue-400 bg-blue-900/20 hover:bg-blue-900/30 border border-blue-700/50 rounded-md transition-colors"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 4v16m8-8H4"
						/>
					</svg>
					New Session
				</button>
			</div>

			{/* Task stats */}
			<div class="px-3 py-2">
				{hasTasks ? (
					<span class="text-xs text-gray-500">
						{pendingCount > 0 && <span class="text-yellow-500/80">{pendingCount} pending</span>}
						{pendingCount > 0 && activeCount > 0 && <span class="text-gray-600"> · </span>}
						{activeCount > 0 && <span class="text-green-500/80">{activeCount} active</span>}
						{(pendingCount > 0 || activeCount > 0) && doneCount > 0 && (
							<span class="text-gray-600"> · </span>
						)}
						{doneCount > 0 && <span>{doneCount} done</span>}
					</span>
				) : (
					<span class="text-xs text-gray-600">No tasks</span>
				)}
			</div>

			{/* Divider */}
			<div class="border-t border-dark-700 mx-3 mb-1" />

			{/* Sessions */}
			<div class="flex-1 overflow-y-auto">
				{/* Pinned: Room Dashboard */}
				<button
					onClick={handleDashboardClick}
					class={cn(
						'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors',
						isDashboardSelected ? 'bg-dark-700' : 'hover:bg-dark-800'
					)}
				>
					<div class="w-6 h-6 flex-shrink-0 flex items-center justify-center bg-blue-900/40 rounded">
						<svg
							class="w-3.5 h-3.5 text-blue-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
							/>
						</svg>
					</div>
					<span class="flex-1 text-sm text-gray-200 text-left truncate">Room Dashboard</span>
				</button>

				{/* Room Agent */}
				<button
					onClick={handleRoomAgentClick}
					class={cn(
						'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors border-b border-dark-700/40',
						isRoomAgentSelected ? 'bg-dark-700' : 'hover:bg-dark-800'
					)}
				>
					<div class="w-6 h-6 flex-shrink-0 flex items-center justify-center bg-purple-900/40 rounded">
						<svg
							class="w-3.5 h-3.5 text-purple-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
							/>
						</svg>
					</div>
					<span class="flex-1 text-sm text-gray-200 text-left truncate">Room Agent</span>
				</button>

				{/* Sessions */}
				{sessions.length === 0 ? (
					<div class="px-4 py-5 text-center">
						<p class="text-xs text-gray-500">No sessions yet</p>
					</div>
				) : (
					sessions.map((session) => (
						<button
							key={session.id}
							onClick={() => handleSessionClick(session.id)}
							class={cn(
								'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors',
								selectedSessionId === session.id ? 'bg-dark-700' : 'hover:bg-dark-800'
							)}
						>
							<StatusDot status={session.status} />
							<span class="flex-1 text-sm text-gray-300 truncate text-left">
								{session.title || session.id.slice(0, 8)}
							</span>
							{session.lastActiveAt != null && (
								<span class="text-xs text-gray-500 flex-shrink-0 tabular-nums">
									{formatRelativeTime(session.lastActiveAt)}
								</span>
							)}
						</button>
					))
				)}
			</div>
		</div>
	);
}
