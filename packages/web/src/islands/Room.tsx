/**
 * Room Island Component
 *
 * Main room page component with:
 * - Room dashboard showing sessions and tasks
 * - Room chat for AI orchestration
 * - Real-time updates via state channels
 *
 * Unified Session Architecture:
 * - Room chat uses ChatContainer with sessionId='room:{roomId}'
 * - Feature flags disabled for room sessions
 */

import { useEffect, useState, useMemo } from 'preact/hooks';
import type { RoomContextVersion } from '@neokai/shared';
import { roomStore } from '../lib/room-store';
import { navigateToHome } from '../lib/router';
import { RoomDashboard } from '../components/room/RoomDashboard';
import {
	ContextEditor,
	GoalsEditor,
	RecurringJobsConfig,
	ProposalList,
	ProposalHistory,
	QARoundPanel,
	QARoundHistory,
} from '../components/room';
import type { CreateJobParams } from '../components/room/RecurringJobsConfig';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import ChatContainer from './ChatContainer';

type RoomTab = 'dashboard' | 'chat' | 'context' | 'goals' | 'jobs' | 'proposals' | 'qa';

interface RoomProps {
	roomId: string;
}

export default function Room({ roomId }: RoomProps) {
	const [initialLoad, setInitialLoad] = useState(true);
	const [activeTab, setActiveTab] = useState<RoomTab>('dashboard');

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

	// Room session ID for unified session architecture
	const roomSessionId = `room:${roomId}`;

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

	// Proposals computed - filter resolved proposals for history
	const resolvedProposals = useMemo(() => {
		return roomStore.proposals.value.filter((p) => p.status !== 'pending');
	}, [roomStore.proposals.value]);

	// Proposals handlers
	const handleApproveProposal = async (proposalId: string) => {
		await roomStore.approveProposal(proposalId);
	};

	const handleRejectProposal = async (proposalId: string, reason: string) => {
		await roomStore.rejectProposal(proposalId, reason);
	};

	// Q&A handlers
	const handleAnswerQuestion = async (_roundId: string, questionId: string, answer: string) => {
		await roomStore.answerQuestion(questionId, answer);
	};

	const handleCompleteQARound = async (_roundId: string, summary?: string) => {
		await roomStore.completeQARound(summary);
	};

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header */}
			<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4 flex items-center justify-between">
				<div>
					<h2 class="text-xl font-bold text-gray-100">{room.name}</h2>
					{room.description && <p class="text-sm text-gray-400 mt-1">{room.description}</p>}
				</div>
				<div class="flex gap-2">
					<Button variant="ghost" size="sm" onClick={() => navigateToHome()}>
						Leave Room
					</Button>
				</div>
			</div>

			{/* Tab bar */}
			<div class="flex border-b border-dark-700 bg-dark-850">
				<button
					class={`px-4 py-2 text-sm font-medium transition-colors ${
						activeTab === 'dashboard'
							? 'text-blue-400 border-b-2 border-blue-400'
							: 'text-gray-400 hover:text-gray-200'
					}`}
					onClick={() => setActiveTab('dashboard')}
				>
					Dashboard
				</button>
				<button
					class={`px-4 py-2 text-sm font-medium transition-colors ${
						activeTab === 'chat'
							? 'text-blue-400 border-b-2 border-blue-400'
							: 'text-gray-400 hover:text-gray-200'
					}`}
					onClick={() => setActiveTab('chat')}
				>
					Room Chat
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
						activeTab === 'proposals'
							? 'text-blue-400 border-b-2 border-blue-400'
							: 'text-gray-400 hover:text-gray-200'
					}`}
					onClick={() => setActiveTab('proposals')}
				>
					Proposals
				</button>
				<button
					class={`px-4 py-2 text-sm font-medium transition-colors ${
						activeTab === 'qa'
							? 'text-blue-400 border-b-2 border-blue-400'
							: 'text-gray-400 hover:text-gray-200'
					}`}
					onClick={() => setActiveTab('qa')}
				>
					Q&A
				</button>
			</div>

			{/* Tab content */}
			<div class="flex-1 overflow-hidden">
				{activeTab === 'dashboard' && (
					<div class="h-full overflow-y-auto">
						<RoomDashboard />
					</div>
				)}
				{activeTab === 'chat' && (
					<div class="h-full">
						<ChatContainer sessionId={roomSessionId} />
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
				{activeTab === 'proposals' && (
					<div class="h-full overflow-y-auto p-4 space-y-6">
						<ProposalList
							roomId={roomId}
							proposals={roomStore.proposals}
							onApprove={handleApproveProposal}
							onReject={handleRejectProposal}
							isLoading={roomStore.proposalLoading.value}
						/>
						<ProposalHistory proposals={resolvedProposals} />
					</div>
				)}
				{activeTab === 'qa' && (
					<div class="h-full overflow-y-auto p-4 space-y-6">
						<QARoundPanel
							roomId={roomId}
							activeRound={roomStore.activeQARound}
							onAnswer={handleAnswerQuestion}
							onComplete={handleCompleteQARound}
						/>
						<QARoundHistory rounds={roomStore.qaRoundHistory.value} />
					</div>
				)}
			</div>
		</div>
	);
}
