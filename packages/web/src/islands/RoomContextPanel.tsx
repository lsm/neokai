/**
 * RoomContextPanel
 *
 * Navigation sidebar for a specific room. Layout (top to bottom):
 * 1. Task stats strip (active · review counts)
 * 2. Pinned items: Overview, Coordinator
 * 3. Missions section — clickable list, navigates to Missions tab
 * 4. Sessions section (collapsible, default collapsed)
 */

import { useCallback } from 'preact/hooks';
import { CollapsibleSection } from '../components/room/CollapsibleSection';
import { roomStore } from '../lib/room-store';
import { navigateToRoom, navigateToRoomAgent, navigateToRoomSession } from '../lib/router';
import {
	currentRoomSessionIdSignal,
	currentRoomTaskIdSignal,
	currentRoomAgentActiveSignal,
	currentRoomTabSignal,
} from '../lib/signals';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';

function formatRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return 'now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function SessionStatusDot({ status }: { status: string }) {
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

const goalStatusColors: Record<string, string> = {
	active: 'text-green-400',
	needs_human: 'text-yellow-400',
	completed: 'text-gray-500',
	archived: 'text-gray-600',
};

interface RoomContextPanelProps {
	roomId: string;
	onNavigate?: () => void;
}

export function RoomContextPanel({ roomId, onNavigate }: RoomContextPanelProps) {
	const sessions = roomStore.sessions.value;
	const tasks = roomStore.tasks.value;

	const activeCount = tasks.filter(
		(t) => t.status === 'draft' || t.status === 'pending' || t.status === 'in_progress'
	).length;
	const reviewCount = tasks.filter(
		(t) => t.status === 'review' || t.status === 'needs_attention'
	).length;

	// Goals data
	const activeGoals = roomStore.activeGoals.value;

	// Selection state
	const selectedSessionId = currentRoomSessionIdSignal.value;
	const selectedTaskId = currentRoomTaskIdSignal.value;
	const isAgentActive = currentRoomAgentActiveSignal.value;

	const isDashboardSelected =
		selectedSessionId === null && selectedTaskId === null && !isAgentActive;
	const isRoomAgentSelected = isAgentActive;

	// Navigation handlers
	const handleDashboardClick = () => {
		navigateToRoom(roomId);
		onNavigate?.();
	};

	const handleRoomAgentClick = () => {
		navigateToRoomAgent(roomId);
		onNavigate?.();
	};

	const handleMissionsClick = () => {
		currentRoomTabSignal.value = 'goals';
		navigateToRoom(roomId);
		onNavigate?.();
	};

	const handleTasksClick = () => {
		currentRoomTabSignal.value = 'tasks';
		navigateToRoom(roomId);
		onNavigate?.();
	};

	const handleSessionClick = (sessionId: string) => {
		navigateToRoomSession(roomId, sessionId);
		onNavigate?.();
	};

	const handleCreateSession = useCallback(
		async (e: Event) => {
			e.stopPropagation();
			try {
				const sessionId = await roomStore.createSession();
				navigateToRoomSession(roomId, sessionId);
				onNavigate?.();
			} catch {
				toast.error('Failed to create session');
			}
		},
		[roomId, onNavigate]
	);

	const hasTasks = activeCount > 0 || reviewCount > 0;

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Task stats strip — clickable, navigates to Tasks tab */}
			<button
				type="button"
				onClick={handleTasksClick}
				class="px-3 py-2 text-left hover:bg-dark-800 transition-colors"
			>
				{hasTasks ? (
					<span class="text-xs text-gray-500">
						{activeCount > 0 && <span class="text-blue-500/80">{activeCount} active</span>}
						{activeCount > 0 && reviewCount > 0 && <span class="text-gray-600"> · </span>}
						{reviewCount > 0 && <span class="text-purple-500/80">{reviewCount} review</span>}
					</span>
				) : (
					<span class="text-xs text-gray-600">No tasks</span>
				)}
			</button>

			{/* Pinned items */}
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
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Overview</span>
			</button>

			<button
				onClick={handleRoomAgentClick}
				class={cn(
					'w-full px-3 py-2.5 flex items-center gap-2.5 transition-colors',
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
				<span class="flex-1 text-sm text-gray-200 text-left truncate">Coordinator</span>
			</button>

			{/* Visual divider after pinned items */}
			<div class="border-t border-dark-700 mx-3 my-1" />

			{/* Scrollable sections */}
			<div class="flex-1 overflow-y-auto">
				{/* Missions section — pure navigation, click to jump to Missions tab */}
				<CollapsibleSection title="Missions" count={activeGoals.length}>
					{activeGoals.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No missions</div>
					) : (
						activeGoals.map((goal) => (
							<button
								key={goal.id}
								onClick={handleMissionsClick}
								class="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-dark-800 transition-colors text-left"
							>
								<span class="flex-1 text-sm text-gray-300 truncate">{goal.title}</span>
								<span
									class={cn(
										'text-[10px] flex-shrink-0',
										goalStatusColors[goal.status] ?? 'text-gray-500'
									)}
								>
									●
								</span>
							</button>
						))
					)}
				</CollapsibleSection>

				{/* Sessions section */}
				<CollapsibleSection
					title="Sessions"
					count={sessions.length}
					defaultExpanded={false}
					headerRight={
						<button
							onClick={handleCreateSession}
							class="text-gray-500 hover:text-gray-300 transition-colors p-0.5"
							aria-label="Create session"
						>
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 4v16m8-8H4"
								/>
							</svg>
						</button>
					}
				>
					{sessions.length === 0 ? (
						<div class="px-4 py-3 text-xs text-gray-600">No sessions yet</div>
					) : (
						sessions.map((session) => (
							<button
								key={session.id}
								onClick={() => handleSessionClick(session.id)}
								class={cn(
									'w-full px-3 py-2 flex items-center gap-2.5 transition-colors',
									selectedSessionId === session.id ? 'bg-dark-700' : 'hover:bg-dark-800'
								)}
							>
								<SessionStatusDot status={session.status} />
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
				</CollapsibleSection>
			</div>
		</div>
	);
}
