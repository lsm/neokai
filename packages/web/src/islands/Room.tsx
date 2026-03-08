/**
 * Room Island Component
 *
 * Main room page component with:
 * - Room dashboard showing sessions and tasks
 * - Goals tab
 * - Real-time updates via state channels
 */

import { useEffect, useState } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import { navigateToHome, navigateToRooms, navigateToRoom } from '../lib/router';
import { Breadcrumb } from '../components/ui/Breadcrumb';
import { RoomOverview } from '../components/room/RoomOverview';
import ChatContainer from './ChatContainer';
import { RoomSettings, RoomAgentAvatars } from '../components/room';
import { TaskView } from '../components/room/TaskView';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { MobileMenuButton } from '../components/ui/MobileMenuButton';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';

type RoomTab = 'overview' | 'settings';

interface RoomProps {
	roomId: string;
	sessionViewId?: string | null; // When set, show this session content instead of room tabs
	taskViewId?: string | null; // When set, show TaskView (Craft + Lead) for this task
}

export default function Room({ roomId, sessionViewId, taskViewId }: RoomProps) {
	const [initialLoad, setInitialLoad] = useState(true);
	const [activeTab, setActiveTab] = useState<RoomTab>('overview');

	useEffect(() => {
		roomStore.select(roomId).finally(() => {
			setInitialLoad(false);
		});
		return () => {
			roomStore.select(null);
		};
	}, [roomId]);

	// Update URL when tab changes
	const handleTabChange = (tab: RoomTab) => {
		setActiveTab(tab);
		navigateToRoom(roomId);
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
					<h3 class="text-lg font-semibold text-gray-100 mb-2">{t('room.failedToLoad')}</h3>
					<p class="text-gray-400 mb-4">{error}</p>
					<Button onClick={() => roomStore.select(roomId)}>{t('common.retry')}</Button>
				</div>
			</div>
		);
	}

	if (!room) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<h3 class="text-lg font-semibold text-gray-100 mb-2">{t('room.notFound')}</h3>
					<Button onClick={() => navigateToHome()}>{t('common.goHome')}</Button>
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
		toast.success(t('room.archivedSuccess'));
		navigateToHome();
	};

	const handleDeleteRoom = async () => {
		await roomStore.deleteRoom();
		toast.success(t('room.deletedSuccess'));
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
						<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 px-4 flex items-center h-[61px]">
							<div class="flex items-center gap-3 w-full">
								<MobileMenuButton />
								<Breadcrumb
									items={[
										{ label: t('nav.rooms'), onClick: () => navigateToRooms() },
										{
											label: room.name,
											onEdit: async (newName) => {
												try {
													await roomStore.updateSettings({ name: newName });
												} catch {
													toast.error(t('toast.saveFailed'));
												}
											},
										},
									]}
								/>
								<div class="flex-1" />
								<RoomAgentAvatars room={room} onClickAdd={() => setActiveTab('settings')} />
							</div>
						</div>

						{/* Tab bar */}
						<div class="flex border-b border-dark-700 bg-dark-850">
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'overview'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('overview')}
							>
								{t('room.overview')}
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'settings'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => handleTabChange('settings')}
							>
								{t('room.settings')}
							</button>
						</div>

						{/* Tab content */}
						<div class="flex-1 overflow-hidden">
							{activeTab === 'overview' && (
								<RoomOverview
									roomId={roomId}
									room={room}
									onCreateGoal={handleCreateGoal}
									onUpdateGoal={handleUpdateGoal}
									onDeleteGoal={handleDeleteGoal}
									onLinkTask={handleLinkTaskToGoal}
								/>
							)}
							{activeTab === 'settings' && (
								<RoomSettings
									room={room}
									onSave={(params) => roomStore.updateSettings(params)}
									onArchive={handleArchiveRoom}
									onDelete={handleDeleteRoom}
									isLoading={roomStore.loading.value}
								/>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
