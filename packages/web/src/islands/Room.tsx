/**
 * Room Island Component
 *
 * Main room page component with:
 * - Room overview (stats + runtime controls)
 * - Tasks tab
 * - Missions tab
 * - Settings tab (includes Context & Agents)
 * - Real-time updates via state channels
 */

import { useEffect, useState } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import {
	navigateToHome,
	navigateToRoomTask,
	navigateToRoom,
	navigateToRoomAgent,
	navigateToRoomMission,
} from '../lib/router';
import {
	currentRoomTabSignal,
	currentRoomActiveTabSignal,
	currentRoomAgentActiveSignal,
} from '../lib/signals';
import { useRoomLiveQuery } from '../hooks/useRoomLiveQuery';
import { RoomDashboard } from '../components/room/RoomDashboard';
import { RoomTasks } from '../components/room/RoomTasks';
import { RoomAgentContextStrip } from '../components/room/RoomAgentContextStrip';
import ChatContainer from './ChatContainer';
import { GoalsEditor, RoomSettings, RoomAgents } from '../components/room';
import type { CreateGoalFormData } from '../components/room/GoalsEditor';
import { TaskViewToggle } from '../components/room/TaskViewToggle';
import { MissionDetail } from '../components/room/MissionDetail';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { MobileMenuButton } from '../components/ui/MobileMenuButton';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';

type RoomTab = 'chat' | 'overview' | 'tasks' | 'agents' | 'goals' | 'settings';

interface RoomProps {
	roomId: string;
	sessionViewId?: string | null; // When set, show this session content instead of room tabs
	taskViewId?: string | null; // When set, show TaskView (Craft + Lead) for this task
	missionViewId?: string | null; // When set, show MissionDetail for this goal
}

export default function Room({ roomId, sessionViewId, taskViewId, missionViewId }: RoomProps) {
	const [initialLoad, setInitialLoad] = useState(true);
	const [activeTab, setActiveTab] = useState<RoomTab>(
		currentRoomAgentActiveSignal.value ? 'chat' : 'overview'
	);

	// Manage LiveQuery subscriptions for tasks and goals.
	// Intentionally declared before the select() effect so that LiveQuery
	// handlers are registered before the hub request fires — both share
	// [roomId] as their dependency and run in declaration order.
	useRoomLiveQuery(roomId);

	useEffect(() => {
		roomStore.select(roomId).finally(() => {
			setInitialLoad(false);
		});
		return () => {
			roomStore.select(null);
			// Clear any pending tab signal when leaving a room to prevent cross-room contamination.
			// Note: do NOT clear currentRoomAgentActiveSignal here — navigation functions
			// (navigateToRoom, navigateToRoomAgent) manage it explicitly. Clearing it during
			// room-to-room navigation would race with the incoming room's agent URL sync and
			// cause the Coordinator view to be lost.
			currentRoomTabSignal.value = null;
			currentRoomActiveTabSignal.value = null;
		};
	}, [roomId]);

	// Watch for pending tab navigation from goal badges in task list / task view
	const pendingTab = currentRoomTabSignal.value;
	useEffect(() => {
		if (pendingTab && !taskViewId) {
			const validTabs: RoomTab[] = ['chat', 'overview', 'tasks', 'agents', 'goals', 'settings'];
			if (validTabs.includes(pendingTab as RoomTab)) {
				setActiveTab(pendingTab as RoomTab);
				currentRoomActiveTabSignal.value = pendingTab;
			}
			currentRoomTabSignal.value = null;
		}
	}, [pendingTab, taskViewId, roomId]);

	// Watch for Room Agent activation (e.g., sidebar click, popstate)
	const agentActive = currentRoomAgentActiveSignal.value;
	useEffect(() => {
		if (agentActive) {
			setActiveTab('chat');
		}
	}, [agentActive]);

	// Update URL when tab changes — uses the pending-tab mechanism
	// (currentRoomTabSignal) so the Room effect and BottomTabBar stay in sync.
	const handleTabChange = (tab: RoomTab) => {
		setActiveTab(tab);
		currentRoomActiveTabSignal.value = tab;
		if (tab === 'chat') {
			navigateToRoomAgent(roomId);
		} else {
			currentRoomAgentActiveSignal.value = false;
			currentRoomTabSignal.value = tab;
			navigateToRoom(roomId);
		}
	};

	const loading = roomStore.loading.value;
	const error = roomStore.error.value;
	const room = roomStore.room.value;

	if (loading && initialLoad) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<Skeleton width="200px" height={24} class="mb-4" />
					<Skeleton width="400px" height={16} />
				</div>
			</div>
		);
	}

	if (error && !room) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Failed to load room</h3>
					<p class="text-gray-400 mb-4">{error}</p>
					<Button onClick={() => roomStore.select(roomId)}>Retry</Button>
				</div>
			</div>
		);
	}

	if (!room) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Room not found</h3>
					<Button onClick={() => navigateToHome()}>Go Home</Button>
				</div>
			</div>
		);
	}

	// Goals handlers
	const handleCreateGoal = async (goal: CreateGoalFormData) => {
		await roomStore.createGoal({
			title: goal.title,
			description: goal.description ?? '',
			priority: goal.priority,
			missionType: goal.missionType,
			autonomyLevel: goal.autonomyLevel,
			structuredMetrics: goal.structuredMetrics,
			schedule: goal.schedule,
		});
	};

	const handleUpdateGoal = async (goalId: string, updates: Record<string, unknown>) => {
		await roomStore.updateGoal(goalId, updates);
	};

	const handleDeleteGoal = async (goalId: string) => {
		await roomStore.deleteGoal(goalId);
	};

	const handleLinkTaskToGoal = async (goalId: string, taskId: string) => {
		await roomStore.linkTaskToGoal(goalId, taskId);
	};

	const handleArchiveRoom = async () => {
		await roomStore.archiveRoom();
		toast.success('Room archived successfully');
		navigateToHome();
	};

	const handleDeleteRoom = async () => {
		await roomStore.deleteRoom();
		toast.success('Room deleted permanently');
		navigateToHome();
	};

	// Non-agent room sessions still use full takeover (e.g., worker session views)
	const isSessionTakeover = sessionViewId && !currentRoomAgentActiveSignal.value;

	return (
		<div class="flex-1 flex bg-dark-900 overflow-hidden">
			{/* Main content area */}
			<div class="flex-1 flex flex-col overflow-hidden">
				{isSessionTakeover ? (
					<ChatContainer key={sessionViewId} sessionId={sessionViewId} />
				) : (
					<>
						{/* Header */}
						<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4 flex-shrink-0">
							<div class="flex items-center gap-3">
								<MobileMenuButton />
								<h2 class="text-xl font-bold text-gray-100">{room.name}</h2>
							</div>
						</div>

						{/* Review notification banner */}
						{roomStore.reviewTaskCount.value > 0 && !taskViewId && (
							<button
								type="button"
								onClick={() => {
									const reviewTask = roomStore.reviewTasks.value[0];
									if (reviewTask) {
										navigateToRoomTask(roomId, reviewTask.id);
									} else {
										handleTabChange('tasks');
									}
								}}
								class="flex items-center gap-2 w-full px-3 py-3 bg-purple-950/40 border-b border-purple-800/30 text-xs text-purple-300 hover:bg-purple-950/60 transition-colors flex-shrink-0"
							>
								<svg
									class="w-4 h-4 flex-shrink-0"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
									/>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
									/>
								</svg>
								<span>
									<strong>{roomStore.reviewTaskCount.value}</strong> task
									{roomStore.reviewTaskCount.value > 1 ? 's' : ''} awaiting review
								</span>
								<svg
									class="w-3.5 h-3.5 ml-auto text-purple-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M9 5l7 7-7 7"
									/>
								</svg>
							</button>
						)}

						{/* Tab bar */}
						<div class="flex border-b border-dark-700 bg-dark-850 flex-shrink-0">
							{(
								[
									{ id: 'chat' as const, label: 'Coordinator' },
									{ id: 'overview' as const, label: 'Overview' },
									{ id: 'tasks' as const, label: 'Tasks' },
									{ id: 'agents' as const, label: 'Agents' },
									{ id: 'goals' as const, label: 'Missions' },
									{ id: 'settings' as const, label: 'Settings' },
								] satisfies { id: RoomTab; label: string }[]
							).map((tab) => (
								<button
									key={tab.id}
									class={cn(
										'px-4 py-2.5 text-sm font-medium transition-colors',
										activeTab === tab.id
											? 'text-blue-400 border-b-2 border-blue-400'
											: 'text-gray-400 hover:text-gray-200'
									)}
									onClick={() => handleTabChange(tab.id)}
								>
									{tab.label}
									{tab.id === 'tasks' && roomStore.reviewTaskCount.value > 0 && (
										<span class="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-purple-900/40 text-purple-400">
											{roomStore.reviewTaskCount.value}
										</span>
									)}
								</button>
							))}
						</div>

						{/* Tab content */}
						<div class="flex-1 overflow-hidden relative">
							{/* Chat tab — always mounted (hidden when inactive) to preserve state */}
							<div
								class={cn('h-full flex flex-col overflow-hidden', activeTab !== 'chat' && 'hidden')}
							>
								<RoomAgentContextStrip />
								<div class="flex-1 flex flex-col overflow-hidden">
									<ChatContainer
										key={`room:chat:${roomId}`}
										sessionId={`room:chat:${roomId}`}
										hideRoomBreadcrumb
									/>
								</div>
							</div>

							{activeTab === 'overview' && (
								<div class="h-full overflow-y-auto">
									<RoomDashboard />
								</div>
							)}
							{activeTab === 'tasks' && (
								<div class="h-full overflow-y-auto">
									<RoomTasks
										tasks={roomStore.tasks.value}
										goalByTaskId={roomStore.goalByTaskId.value}
										onTaskClick={
											roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined
										}
										onGoalClick={(goalId) => navigateToRoomMission(roomId, goalId)}
										onReactivate={async (taskId) => {
											await roomStore.setTaskStatus(taskId, 'in_progress');
										}}
									/>
								</div>
							)}
							{activeTab === 'agents' && (
								<div class="h-full overflow-y-auto">
									<RoomAgents room={room} />
								</div>
							)}
							{activeTab === 'goals' && (
								<div class="h-full overflow-y-auto">
									<GoalsEditor
										roomId={roomId}
										goals={roomStore.goals.value}
										tasks={roomStore.tasks.value}
										onTaskClick={(taskId) => navigateToRoomTask(roomId, taskId)}
										onGoalClick={(goalId) => navigateToRoomMission(roomId, goalId)}
										onCreateGoal={handleCreateGoal}
										onUpdateGoal={handleUpdateGoal}
										onDeleteGoal={handleDeleteGoal}
										onLinkTask={handleLinkTaskToGoal}
										isLoading={roomStore.goalsLoading.value}
										autoCompletedNotifications={roomStore.autoCompletedNotifications.value}
										onDismissNotification={(taskId) => roomStore.dismissAutoCompleted(taskId)}
										onListExecutions={(goalId) => roomStore.listExecutions(goalId)}
										onTriggerNow={async (goalId) => {
											await roomStore.triggerNow(goalId);
										}}
										onScheduleNext={async (goalId, nextRunAt) => {
											await roomStore.scheduleNext(goalId, nextRunAt);
										}}
									/>
								</div>
							)}
							{activeTab === 'settings' && (
								<div class="h-full overflow-y-auto">
									<RoomSettings
										room={room}
										onSave={(params) => roomStore.updateSettings(params)}
										onArchive={handleArchiveRoom}
										onDelete={handleDeleteRoom}
										isLoading={roomStore.loading.value}
									/>
								</div>
							)}
							{/* Task slide-over: overlays tab content, keeps header/tabs accessible */}
							{taskViewId && (
								<div class="absolute inset-0 z-10 bg-dark-900 flex flex-col overflow-hidden">
									<TaskViewToggle key={taskViewId} roomId={roomId} taskId={taskViewId} />
								</div>
							)}
							{/* Mission slide-over: overlays tab content, keeps header/tabs accessible */}
							{missionViewId && (
								<div class="absolute inset-0 z-10 bg-dark-900 flex flex-col overflow-hidden">
									<MissionDetail key={missionViewId} roomId={roomId} goalId={missionViewId} />
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
