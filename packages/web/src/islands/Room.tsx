/**
 * Room Island Component
 *
 * Main room page component with:
 * - Room dashboard showing sessions and tasks
 * - Goals tab
 * - Real-time updates via state channels
 * - Room chat using unified session architecture (ChatContainer)
 */

import { useEffect, useState } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import {
	navigateToHome,
	navigateToRoomTask,
	navigateToRoomChat,
	navigateToRoom,
} from '../lib/router';
import { RoomDashboard } from '../components/room/RoomDashboard';
import ChatContainer from './ChatContainer';
import { GoalsEditor, RoomContext, RoomSettings, RoomAgents } from '../components/room';
import { TaskView } from '../components/room/TaskView';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { toast } from '../lib/toast';

type RoomTab = 'chat' | 'overview' | 'context' | 'agents' | 'goals' | 'settings';

interface RoomProps {
	roomId: string;
	sessionViewId?: string | null; // When set, show this session content instead of room tabs
	taskViewId?: string | null; // When set, show TaskView (Craft + Lead) for this task
	chatTabActive?: boolean; // When true, activate the chat tab (from URL /room/:id/chat)
}

export default function Room({ roomId, sessionViewId, taskViewId, chatTabActive }: RoomProps) {
	const [initialLoad, setInitialLoad] = useState(true);
	const [activeTab, setActiveTab] = useState<RoomTab>(chatTabActive ? 'chat' : 'overview');

	// The room agent chat session ID
	const chatSessionId = `room:chat:${roomId}`;

	useEffect(() => {
		roomStore.select(roomId).finally(() => {
			setInitialLoad(false);
			// After initial load, default to chat tab if any tasks are in review
			// (only if not already overridden by URL or user interaction)
			setActiveTab((prev) => {
				if (prev === 'overview' && !chatTabActive) {
					const hasReviewTasks = roomStore.tasks.value.some((t) => t.status === 'review');
					return hasReviewTasks ? 'chat' : 'overview';
				}
				return prev;
			});
		});
		return () => {
			roomStore.select(null);
		};
	}, [roomId]);

	// Sync activeTab when chatTabActive prop changes (URL navigation)
	useEffect(() => {
		if (chatTabActive) {
			setActiveTab('chat');
		}
	}, [chatTabActive]);

	// Update URL when tab changes
	const handleTabChange = (tab: RoomTab) => {
		setActiveTab(tab);
		if (tab === 'chat') {
			navigateToRoomChat(roomId);
		} else if (activeTab === 'chat') {
			// Coming off chat tab, go back to plain room URL
			navigateToRoom(roomId);
		}
	};

	const loading = roomStore.loading.value;
	const error = roomStore.error.value;
	const room = roomStore.room.value;
	// Count tasks in review status for notification badge
	const reviewTaskCount = roomStore.tasks.value.filter((t) => t.status === 'review').length;

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
	const handleCreateGoal = async (goal: {
		title: string;
		description?: string;
		priority?: string;
	}) => {
		await roomStore.createGoal({
			title: goal.title,
			description: goal.description ?? '',
			priority: goal.priority as 'low' | 'normal' | 'high' | 'urgent',
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

	return (
		<div class="flex-1 flex bg-dark-900 overflow-hidden">
			{/* Main content area */}
			<div class="flex-1 flex flex-col overflow-hidden">
				{/* Task view: show Craft + Lead sessions for the selected task */}
				{taskViewId ? (
					<TaskView key={taskViewId} roomId={roomId} taskId={taskViewId} />
				) : sessionViewId ? (
					/* Session view: show a specific session within the room */
					<ChatContainer key={sessionViewId} sessionId={sessionViewId} />
				) : (
					<>
						{/* Header */}
						<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
							<h2 class="text-xl font-bold text-gray-100">{room.name}</h2>
						</div>

						{/* Tab bar */}
						<div class="flex border-b border-dark-700 bg-dark-850">
							<button
								class={`relative px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'chat'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('chat')}
							>
								Chat
								{reviewTaskCount > 0 && (
									<span class="absolute top-1.5 right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-0.5">
										{reviewTaskCount}
									</span>
								)}
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'overview'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('overview')}
							>
								Overview
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'context'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('context')}
							>
								Context
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'agents'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('agents')}
							>
								Agents
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'goals'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('goals')}
							>
								Goals
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'settings'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('settings')}
							>
								Settings
							</button>
						</div>

						{/* Tab content */}
						<div class="flex-1 overflow-hidden">
							{activeTab === 'chat' && (
								<ChatContainer key={chatSessionId} sessionId={chatSessionId} />
							)}
							{activeTab === 'overview' && (
								<div class="h-full overflow-y-auto">
									<RoomDashboard />
								</div>
							)}
							{activeTab === 'context' && (
								<div class="h-full overflow-y-auto p-4">
									<RoomContext room={room} />
								</div>
							)}
							{activeTab === 'agents' && (
								<div class="h-full overflow-y-auto p-4">
									<RoomAgents room={room} />
								</div>
							)}
							{activeTab === 'goals' && (
								<div class="h-full overflow-y-auto p-4">
									<GoalsEditor
										roomId={roomId}
										goals={roomStore.goals.value}
										tasks={roomStore.tasks.value}
										onTaskClick={(taskId) => navigateToRoomTask(roomId, taskId)}
										onCreateGoal={handleCreateGoal}
										onUpdateGoal={handleUpdateGoal}
										onDeleteGoal={handleDeleteGoal}
										onLinkTask={handleLinkTaskToGoal}
										isLoading={roomStore.goalsLoading.value}
									/>
								</div>
							)}
							{activeTab === 'settings' && (
								<div class="h-full overflow-y-auto p-4">
									<RoomSettings
										room={room}
										onSave={(params) => roomStore.updateSettings(params)}
										onArchive={handleArchiveRoom}
										onDelete={handleDeleteRoom}
										isLoading={roomStore.loading.value}
									/>
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
