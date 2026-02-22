/**
 * Room Island Component
 *
 * Main room page component with:
 * - Room dashboard showing sessions and tasks
 * - Tabs for context, goals, jobs
 * - Real-time updates via state channels
 * - Room chat using unified session architecture (ChatContainer)
 */

import { useEffect, useState } from 'preact/hooks';
import type { RoomContextVersion } from '@neokai/shared';
import { roomStore } from '../lib/room-store';
import { navigateToHome } from '../lib/router';
import { RoomDashboard } from '../components/room/RoomDashboard';
import ChatContainer from './ChatContainer';
import { ContextEditor, GoalsEditor, RecurringJobsConfig, RoomSettings } from '../components/room';
import type { CreateJobParams } from '../components/room/RecurringJobsConfig';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { toast } from '../lib/toast';

type RoomTab = 'overview' | 'context' | 'goals' | 'jobs' | 'settings';

interface RoomProps {
	roomId: string;
	sessionViewId?: string | null; // When set, show this session content instead of room tabs
}

export default function Room({ roomId, sessionViewId }: RoomProps) {
	const [initialLoad, setInitialLoad] = useState(true);
	const [activeTab, setActiveTab] = useState<RoomTab>('overview');

	useEffect(() => {
		roomStore.select(roomId).finally(() => setInitialLoad(false));
		return () => {
			roomStore.select(null);
		};
	}, [roomId]);

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

	// Context handlers
	const handleSaveContext = async (background?: string, instructions?: string) => {
		await roomStore.updateContext(background, instructions);
	};

	const handleRollbackContext = async (version: number) => {
		await roomStore.rollbackContext(version);
	};

	const handleFetchContextVersions = async (_roomId: string): Promise<RoomContextVersion[]> => {
		return await roomStore.fetchContextVersions();
	};

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

	// Jobs handlers
	const handleCreateJob = async (params: CreateJobParams) => {
		await roomStore.createRecurringJob({
			...params,
			roomId,
			description: params.description ?? '',
		});
	};

	const handleUpdateJob = async (jobId: string, updates: Record<string, unknown>) => {
		await roomStore.updateRecurringJob(jobId, updates);
	};

	const handleDeleteJob = async (jobId: string) => {
		await roomStore.deleteRecurringJob(jobId);
	};

	const handleTriggerJob = async (jobId: string) => {
		await roomStore.triggerRecurringJob(jobId);
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
				{/* If viewing a session within the room, show session content */}
				{sessionViewId ? (
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
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'overview'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => setActiveTab('overview')}
							>
								Overview
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'context'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => setActiveTab('context')}
							>
								Context
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'goals'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => setActiveTab('goals')}
							>
								Goals
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'jobs'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => setActiveTab('jobs')}
							>
								Jobs
							</button>
							<button
								class={`px-4 py-2 text-sm font-medium transition-colors ${
									activeTab === 'settings'
										? 'text-blue-400 border-b-2 border-blue-400'
										: 'text-gray-400 hover:text-gray-200'
								}`}
								onClick={() => setActiveTab('settings')}
							>
								Settings
							</button>
						</div>

						{/* Tab content */}
						<div class="flex-1 overflow-hidden">
							{activeTab === 'overview' && (
								<div class="h-full overflow-y-auto">
									<RoomDashboard />
								</div>
							)}
							{activeTab === 'context' && (
								<div class="h-full overflow-y-auto p-4">
									<ContextEditor
										room={room}
										onSave={handleSaveContext}
										onRollback={handleRollbackContext}
										onFetchVersions={handleFetchContextVersions}
										isLoading={roomStore.loading.value}
									/>
								</div>
							)}
							{activeTab === 'goals' && (
								<div class="h-full overflow-y-auto p-4">
									<GoalsEditor
										roomId={roomId}
										goals={roomStore.goals.value}
										onCreateGoal={handleCreateGoal}
										onUpdateGoal={handleUpdateGoal}
										onDeleteGoal={handleDeleteGoal}
										onLinkTask={handleLinkTaskToGoal}
										isLoading={roomStore.goalsLoading.value}
									/>
								</div>
							)}
							{activeTab === 'jobs' && (
								<div class="h-full overflow-y-auto p-4">
									<RecurringJobsConfig
										roomId={roomId}
										jobs={roomStore.recurringJobs.value}
										onCreateJob={handleCreateJob}
										onUpdateJob={handleUpdateJob}
										onDeleteJob={handleDeleteJob}
										onTriggerJob={handleTriggerJob}
										isLoading={roomStore.jobsLoading.value}
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

			{/* Room Chat Panel - only show when NOT viewing a session within the room */}
			{!sessionViewId && (
				<div class="w-96 border-l border-dark-700 flex flex-col bg-dark-950">
					<ChatContainer sessionId={`room:${roomId}`} />
				</div>
			)}
		</div>
	);
}
