/**
 * TaskViewV2 Component
 *
 * Turn-based conversation summary view with slide-out detail panels.
 *
 * Combines:
 * - useTaskViewData: task/group/session data + action handlers
 * - useGroupMessages: live-streaming group messages via LiveQuery
 * - useTurnBlocks: converts flat messages → TurnBlockItem[] (turns + runtime messages)
 * - TurnSummaryBlock: compact per-turn card
 * - RuntimeMessageRenderer: inline runtime messages between turns
 * - SlideOutPanel: right-side slide-out showing full session chat on turn click
 *
 * Differences from V1:
 * - No client-side pagination (LiveQuery streams all messages)
 * - isAtTail is always true
 * - loadingOlder is omitted from useAutoScroll
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useGroupMessages } from '../../hooks/useGroupMessages';
import { useTaskViewData } from '../../hooks/useTaskViewData';
import { useTurnBlocks } from '../../hooks/useTurnBlocks';
import type { TurnBlock } from '../../hooks/useTurnBlocks';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { currentRoomTabSignal } from '../../lib/signals';
import { CircularProgressIndicator } from '../ui/CircularProgressIndicator';
import { RejectModal } from '../ui/RejectModal';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { RuntimeMessageRenderer } from './RuntimeMessageRenderer';
import { SlideOutPanel } from './SlideOutPanel';
import { TaskInfoPanel } from './TaskInfoPanel';
import { TurnSummaryBlock } from './TurnSummaryBlock';
import { HumanInputArea } from './task-shared/HumanInputArea';
import {
	CompleteTaskDialog,
	CancelTaskDialog,
	ArchiveTaskDialog,
	SetStatusModal,
} from './task-shared/TaskActionDialogs';
import { TaskHeaderActions } from './task-shared/TaskHeaderActions';
import { TaskReviewBar } from './task-shared/TaskReviewBar';

interface TaskViewV2Props {
	roomId: string;
	taskId: string;
}

const TASK_STATUS_COLORS: Record<string, string> = {
	pending: 'text-gray-400',
	in_progress: 'text-yellow-400',
	completed: 'text-green-400',
	needs_attention: 'text-red-400',
	review: 'text-purple-400',
	draft: 'text-gray-500',
	cancelled: 'text-gray-500',
	archived: 'text-gray-600',
};

export function TaskViewV2({ roomId, taskId }: TaskViewV2Props) {
	const {
		task,
		group,
		workerSession,
		leaderSession,
		isLoading,
		error,
		associatedGoal,
		conversationKey,
		approveReviewedTask,
		rejectReviewedTask,
		interruptSession,
		reactivateTask,
		completeTask,
		cancelTask,
		archiveTask,
		setTaskStatusManually,
		approving,
		rejecting,
		interrupting,
		reactivating,
		reviewError,
		rejectModal,
		completeModal,
		cancelModal,
		archiveModal,
		setStatusModal,
		canCancel,
		canInterrupt,
		canReactivate,
		canComplete,
		canArchive,
	} = useTaskViewData(roomId, taskId);

	// Live-stream messages for the current group
	const { messages, isLoading: messagesLoading } = useGroupMessages(group?.id ?? null);

	// isAtTail is always true for LiveQuery (no client-side pagination)
	const turnBlocks = useTurnBlocks(messages, true);

	// Slide-out panel state
	const [selectedTurn, setSelectedTurn] = useState<TurnBlock | null>(null);

	// UI state for autoscroll toggle
	const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

	// Info panel (gear button) expanded state
	const [isInfoPanelOpen, setIsInfoPanelOpen] = useState(false);

	// Close info panel on Escape key
	useEffect(() => {
		if (!isInfoPanelOpen) return;
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setIsInfoPanelOpen(false);
		};
		document.addEventListener('keydown', handleEscape, true);
		return () => document.removeEventListener('keydown', handleEscape, true);
	}, [isInfoPanelOpen]);

	// isFirstLoad: starts true, resets on conversationKey change, becomes false once
	// the first non-zero TurnBlockItem[] arrives.
	const [isFirstLoad, setIsFirstLoad] = useState(true);

	// Refs for scroll container
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const { showScrollButton, scrollToBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: autoScrollEnabled,
		messageCount: turnBlocks.length,
		isInitialLoad: isFirstLoad,
	});

	// Reset scroll state when the conversation changes (conversationKey bumps on approve/reject)
	const rendererKey = group ? `${group.id}-${conversationKey}` : `null-${conversationKey}`;
	useEffect(() => {
		setIsFirstLoad(true);
		setAutoScrollEnabled(true);
		// Close slide-out when conversation reloads
		setSelectedTurn(null);
	}, [rendererKey]);

	// Mark initial load done after first turn blocks arrive
	useEffect(() => {
		if (turnBlocks.length > 0 && isFirstLoad) {
			setIsFirstLoad(false);
		}
	}, [turnBlocks.length, isFirstLoad]);

	const handleScrollToBottom = useCallback(() => {
		scrollToBottom(true);
		setAutoScrollEnabled(true);
	}, [scrollToBottom]);

	const handleTurnClick = useCallback((turn: TurnBlock) => {
		setSelectedTurn((prev) => (prev?.id === turn.id ? null : turn));
	}, []);

	const handleClosePanel = useCallback(() => {
		setSelectedTurn(null);
	}, []);

	if (isLoading) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<p class="text-gray-400">Loading task…</p>
			</div>
		);
	}

	if (error || !task) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<p class="text-red-400 mb-3">{error ?? 'Task not found'}</p>
					<button
						class="text-sm text-blue-400 hover:text-blue-300"
						onClick={() => navigateToRoom(roomId)}
					>
						← Back to room
					</button>
				</div>
			</div>
		);
	}

	const statusColor = TASK_STATUS_COLORS[task.status] ?? 'text-gray-400';

	return (
		<div data-testid="task-view-v2" class="flex-1 flex flex-col overflow-hidden bg-dark-900">
			{/* Header */}
			<div class="border-b border-dark-700 bg-dark-850 px-4 py-3 flex items-center gap-3 flex-shrink-0">
				<button
					class="text-gray-400 hover:text-gray-200 transition-colors text-sm"
					onClick={() => navigateToRoom(roomId)}
					title="Back to room"
				>
					←
				</button>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<h2 class="text-base font-semibold text-gray-100 truncate">{task.title}</h2>
						<span class={`text-xs font-medium ${statusColor}`} data-testid="task-status-badge">
							{task.status.replace('_', ' ')}
						</span>
						{task.taskType && (
							<span class="text-xs text-gray-500 bg-dark-700 px-1.5 py-0.5 rounded">
								{task.taskType}
							</span>
						)}
						{/* PR link */}
						{task.prUrl && (
							<a
								href={task.prUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded transition-colors"
								title="View Pull Request"
							>
								<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
									<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
								</svg>
								<span>PR #{task.prNumber ?? '?'}</span>
							</a>
						)}
						{/* Mission link */}
						{associatedGoal && (
							<button
								data-testid="task-view-goal-badge"
								onClick={() => {
									navigateToRoom(roomId);
									currentRoomTabSignal.value = 'goals';
								}}
								class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-emerald-400 bg-emerald-900/20 border border-emerald-700/40 hover:bg-emerald-900/40 rounded transition-colors"
								title={`Mission: ${associatedGoal.title}`}
							>
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M13 10V3L4 14h7v7l9-11h-7z"
									/>
								</svg>
								<span class="max-w-[160px] truncate">{associatedGoal.title}</span>
							</button>
						)}
					</div>
					{group && (
						<div class="flex items-center gap-2 mt-0.5">
							<p class="text-xs text-gray-500">
								{group.feedbackIteration > 0 && `iteration ${group.feedbackIteration}`}
							</p>
							{group.submittedForReview && !task.activeSession && (
								<span class="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-900/30 border border-amber-700/40 px-1.5 py-0.5 rounded-full animate-pulse">
									Awaiting your review
								</span>
							)}
							{task.status === 'review' && task.activeSession && (
								<span class="inline-flex items-center gap-1 text-xs font-medium text-blue-400 bg-blue-900/30 border border-blue-700/40 px-1.5 py-0.5 rounded-full">
									<span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
									{task.activeSession === 'worker' ? 'Worker' : 'Leader'} processing your message…
								</span>
							)}
						</div>
					)}
				</div>
				{/* Circular progress indicator */}
				{task.progress != null && task.progress > 0 && (
					<CircularProgressIndicator
						progress={task.progress}
						size={32}
						title={`Task progress: ${task.progress}%`}
					/>
				)}
				<TaskHeaderActions
					canInterrupt={canInterrupt}
					interrupting={interrupting}
					onInterrupt={interruptSession}
					canReactivate={canReactivate}
					reactivating={reactivating}
					onReactivate={reactivateTask}
					isInfoPanelOpen={isInfoPanelOpen}
					onToggleInfoPanel={() => setIsInfoPanelOpen(!isInfoPanelOpen)}
				/>
			</div>

			{/* Info panel */}
			<TaskInfoPanel
				isOpen={isInfoPanelOpen}
				taskId={task.id}
				groupId={group?.id}
				feedbackIteration={group?.feedbackIteration}
				taskCreatedAt={task.createdAt}
				prUrl={task.prUrl}
				prNumber={task.prNumber}
				worktreePath={workerSession?.worktree?.worktreePath ?? workerSession?.workspacePath}
				workerSession={workerSession}
				leaderSession={leaderSession}
				actions={{
					onComplete:
						canComplete && task.status !== 'review'
							? () => {
									setIsInfoPanelOpen(false);
									completeModal.open();
								}
							: undefined,
					onCancel: canCancel
						? () => {
								setIsInfoPanelOpen(false);
								cancelModal.open();
							}
						: undefined,
					onArchive: canArchive
						? () => {
								setIsInfoPanelOpen(false);
								archiveModal.open();
							}
						: undefined,
					onSetStatus:
						task.status !== 'archived'
							? () => {
									setIsInfoPanelOpen(false);
									setStatusModal.open();
								}
							: undefined,
				}}
				visibleActions={{
					complete: canComplete && task.status !== 'review',
					cancel: canCancel,
					archive: canArchive,
					setStatus: task.status !== 'archived',
				}}
				disabledActions={{
					complete: interrupting,
					cancel: interrupting,
					archive: false,
					setStatus: false,
				}}
			/>

			{/* Review bar — shown when awaiting human review */}
			{group?.submittedForReview && (
				<TaskReviewBar
					task={task}
					approving={approving}
					rejecting={rejecting}
					onApprove={approveReviewedTask}
					onOpenRejectModal={rejectModal.open}
					reviewError={reviewError}
				/>
			)}

			{/* Dependencies */}
			{task.dependsOn && task.dependsOn.length > 0 && (
				<div class="border-b border-dark-700 bg-dark-850/50 px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap">
					<span class="text-xs text-gray-500">Depends on:</span>
					{task.dependsOn.map((depId) => (
						<button
							key={depId}
							class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-blue-400 hover:text-blue-300 hover:bg-dark-600 transition-colors"
							onClick={() => navigateToRoomTask(roomId, depId)}
							title={depId}
						>
							{depId.slice(0, 8)}...
						</button>
					))}
				</div>
			)}

			{/* Turn blocks area — scroll container */}
			<div class="flex-1 relative min-h-0">
				<div ref={messagesContainerRef} class="absolute inset-0 overflow-y-auto flex flex-col">
					{group ? (
						<div
							key={rendererKey}
							class="flex flex-col gap-2 p-3"
							data-testid="turn-blocks-container"
						>
							{messagesLoading && turnBlocks.length === 0 ? (
								<div class="flex items-center justify-center py-8 text-gray-500 text-sm">
									Loading conversation…
								</div>
							) : turnBlocks.length === 0 ? (
								<div class="flex items-center justify-center py-8 text-gray-500 text-sm">
									No messages yet
								</div>
							) : (
								turnBlocks.map((item) => {
									if (item.type === 'turn') {
										return (
											<TurnSummaryBlock
												key={item.turn.id}
												turn={item.turn}
												onClick={handleTurnClick}
												isSelected={selectedTurn?.id === item.turn.id}
											/>
										);
									}
									// runtime message
									return <RuntimeMessageRenderer key={item.index} message={item} />;
								})
							)}
						</div>
					) : (
						<div class="flex-1 flex items-center justify-center text-center p-8">
							<div>
								<p class="text-gray-400 mb-1">
									{task.status === 'review'
										? 'Loading conversation history…'
										: 'No active agent group'}
								</p>
								<p class="text-sm text-gray-500">
									{task.status === 'pending'
										? 'Waiting for the runtime to pick up this task.'
										: task.status === 'completed'
											? 'This task has been completed.'
											: task.status === 'needs_attention'
												? 'This task needs attention.'
												: task.status === 'review'
													? 'If this takes too long, try reloading the page.'
													: task.status === 'draft'
														? 'This task is a draft and has not been scheduled yet.'
														: task.status === 'cancelled'
															? 'This task was cancelled.'
															: 'No agent group has been spawned yet.'}
								</p>
							</div>
						</div>
					)}
					<div ref={messagesEndRef} />
				</div>

				{/* Scroll controls */}
				<div
					class="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
					style={{ bottom: '1rem' }}
				>
					{/* Autoscroll toggle */}
					<button
						class={`p-2 rounded-full shadow-lg transition-colors ${
							autoScrollEnabled
								? 'bg-blue-600 text-white hover:bg-blue-500'
								: 'bg-dark-700 text-gray-400 hover:text-gray-200 hover:bg-dark-600'
						}`}
						onClick={() => setAutoScrollEnabled(!autoScrollEnabled)}
						title={autoScrollEnabled ? 'Disable auto-scroll' : 'Enable auto-scroll'}
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 14l-7 7m0 0l-7-7m7 7V3"
							/>
						</svg>
					</button>
					{showScrollButton && (
						<ScrollToBottomButton onClick={handleScrollToBottom} bottomClass="bottom-0" />
					)}
				</div>

				{/* Slide-out panel — overlays the turn blocks area */}
				<SlideOutPanel
					isOpen={selectedTurn !== null}
					sessionId={selectedTurn?.sessionId ?? null}
					agentLabel={selectedTurn?.agentLabel}
					agentRole={selectedTurn?.agentRole}
					onClose={handleClosePanel}
				/>
			</div>

			{/* Human input area */}
			<HumanInputArea
				hasGroup={group !== null}
				taskStatus={task.status}
				roomId={roomId}
				taskId={taskId}
				leaderSessionId={group?.leaderSessionId}
				workerSessionId={group?.workerSessionId}
			/>

			{/* Task action dialogs */}
			<CompleteTaskDialog
				task={task}
				isOpen={completeModal.isOpen}
				onClose={completeModal.close}
				onConfirm={completeTask}
			/>
			<CancelTaskDialog
				task={task}
				isOpen={cancelModal.isOpen}
				onClose={cancelModal.close}
				onConfirm={cancelTask}
			/>
			<ArchiveTaskDialog
				task={task}
				isOpen={archiveModal.isOpen}
				onClose={archiveModal.close}
				onConfirm={archiveTask}
			/>
			<SetStatusModal
				task={task}
				isOpen={setStatusModal.isOpen}
				onClose={setStatusModal.close}
				onConfirm={setTaskStatusManually}
			/>
			{/* Reject dialog */}
			<RejectModal
				isOpen={rejectModal.isOpen}
				onClose={rejectModal.close}
				onConfirm={rejectReviewedTask}
				title="Reject Task"
				message="Please provide feedback explaining why this task is being rejected. The worker will receive this feedback and can address the issues."
				isLoading={rejecting}
			/>
		</div>
	);
}
