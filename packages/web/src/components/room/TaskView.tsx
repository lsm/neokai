/**
 * TaskView Component
 *
 * Shows the task detail view with:
 * - Task header (title, status, progress, group state)
 * - Unified conversation timeline (Worker + Leader messages in sub-agent blocks)
 * - Human input area (context-sensitive based on group.state)
 *
 * Uses session group messages for a single merged timeline.
 *
 * Subscribes to room.task.update events to refresh group info when status changes.
 *
 * Autoscroll: uses the shared useAutoScroll hook + ScrollToBottomButton so the
 * conversation area scrolls to the bottom on new messages and the floating button
 * appears when the user has scrolled up.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useTaskViewData } from '../../hooks/useTaskViewData';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { resetSessionQuery } from '../../lib/api-helpers';
import { toast } from '../../lib/toast';
import { RejectModal } from '../ui/RejectModal';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { TaskConversationRenderer } from './TaskConversationRenderer';
import { TaskInfoPanel } from './TaskInfoPanel';
import type { TaskViewVersionContext } from './TaskViewToggle';
import { HumanInputArea } from './task-shared/HumanInputArea';
import {
	CompleteTaskDialog,
	CancelTaskDialog,
	ArchiveTaskDialog,
	SetStatusModal,
} from './task-shared/TaskActionDialogs';
import { TaskHeader } from './task-shared/TaskHeader';
import { TaskReviewBar } from './task-shared/TaskReviewBar';

interface TaskViewProps {
	roomId: string;
	taskId: string;
	viewVersion?: TaskViewVersionContext;
}

export function TaskView({ roomId, taskId, viewVersion }: TaskViewProps) {
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
		reviewError,
		interrupting,
		reactivating,
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

	const [messageCount, setMessageCount] = useState(0);

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

	// Tracks whether the conversation pane is showing its first batch of messages.
	// Starts true, resets to true each time the conversation reloads (conversationKey bumps),
	// and becomes false once the first non-zero messageCount arrives — at which point
	// useAutoScroll fires its initial-load scroll path.
	const [isFirstLoad, setIsFirstLoad] = useState(true);

	// True while TaskConversationRenderer is prepending older messages via loadEarlier().
	// Passed to useAutoScroll so it skips the auto-scroll-to-bottom during that operation,
	// preventing a race with the scroll-position restoration in TaskConversationRenderer.
	const [isLoadingOlder, setIsLoadingOlder] = useState(false);

	// Refs for scroll container
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const { showScrollButton, scrollToBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: autoScrollEnabled,
		messageCount,
		isInitialLoad: isFirstLoad,
		loadingOlder: isLoadingOlder,
	});

	// Reset conversation scroll state whenever the rendered conversation changes.
	const rendererKey = group ? `${group.id}-${conversationKey}` : `null-${conversationKey}`;
	useEffect(() => {
		setIsFirstLoad(true);
		setMessageCount(0);
		setAutoScrollEnabled(true);
		// Reset isLoadingOlder so auto-scroll is not permanently suppressed if the child
		// unmounts (key change) while a load-earlier operation was in flight. The child's
		// onLoadingOlderChange?.(false) will never fire after unmount, so we clear it here.
		setIsLoadingOlder(false);
	}, [rendererKey]);

	// Mark initial load done after first messages arrive
	useEffect(() => {
		if (messageCount > 0 && isFirstLoad) {
			setIsFirstLoad(false);
		}
	}, [messageCount, isFirstLoad]);

	const handleScrollToBottom = useCallback(() => {
		scrollToBottom(true);
		setAutoScrollEnabled(true);
	}, [scrollToBottom]);

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

	return (
		<div class="flex-1 flex flex-col overflow-hidden bg-dark-900">
			{/* Header */}
			<TaskHeader
				roomId={roomId}
				task={task}
				associatedGoal={associatedGoal}
				canReactivate={canReactivate}
				reactivating={reactivating}
				reactivateTask={reactivateTask}
				isInfoPanelOpen={isInfoPanelOpen}
				onToggleInfoPanel={() => setIsInfoPanelOpen(!isInfoPanelOpen)}
			/>

			{/* Info panel — expands below header when gear is clicked */}
			<TaskInfoPanel
				isOpen={isInfoPanelOpen}
				viewVersion={viewVersion}
				roomId={roomId}
				taskId={task.id}
				groupId={group?.id}
				feedbackIteration={group?.feedbackIteration}
				taskCreatedAt={task.createdAt}
				prUrl={task.prUrl}
				prNumber={task.prNumber}
				// Future: populate from task.origin once NeoTask gains that field (task M6/M3)
				viaNeo={(task as typeof task & { origin?: string }).origin === 'neo'}
				worktreePath={
					workerSession?.worktree?.worktreePath ?? workerSession?.workspacePath ?? undefined
				}
				workerSession={workerSession}
				leaderSession={leaderSession}
				actions={{
					onInterrupt: canInterrupt
						? () => {
								setIsInfoPanelOpen(false);
								interruptSession();
							}
						: undefined,
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
					onResetWorkerAgent: workerSession
						? async () => {
								setIsInfoPanelOpen(false);
								try {
									const result = await resetSessionQuery(workerSession.id);
									if (result.success) {
										toast.success('Worker agent reset successfully.');
									} else {
										toast.error(result.error || 'Failed to reset worker agent');
									}
								} catch (error) {
									toast.error(
										error instanceof Error ? error.message : 'Failed to reset worker agent'
									);
								}
							}
						: undefined,
					onResetLeaderAgent: leaderSession
						? async () => {
								setIsInfoPanelOpen(false);
								try {
									const result = await resetSessionQuery(leaderSession.id);
									if (result.success) {
										toast.success('Leader agent reset successfully.');
									} else {
										toast.error(result.error || 'Failed to reset leader agent');
									}
								} catch (error) {
									toast.error(
										error instanceof Error ? error.message : 'Failed to reset leader agent'
									);
								}
							}
						: undefined,
				}}
				visibleActions={{
					interrupt: canInterrupt,
					complete: canComplete && task.status !== 'review',
					cancel: canCancel,
					archive: canArchive,
					setStatus: task.status !== 'archived',
					resetWorkerAgent: !!workerSession,
					resetLeaderAgent: !!leaderSession,
				}}
				disabledActions={{
					interrupt: interrupting,
					complete: interrupting,
					cancel: interrupting,
					archive: false,
					setStatus: false,
					resetWorkerAgent: interrupting,
					resetLeaderAgent: interrupting,
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

			{/* Conversation timeline — scroll container owned here for autoscroll support */}
			<div class="flex-1 relative min-h-0">
				<div
					ref={messagesContainerRef}
					class="absolute inset-0 overflow-y-auto flex flex-col"
					data-testid="task-messages-container"
				>
					{group ? (
						<TaskConversationRenderer
							key={`${group.id}-${conversationKey}`}
							groupId={group.id}
							leaderSessionId={group.leaderSessionId}
							workerSessionId={group.workerSessionId}
							onMessageCountChange={setMessageCount}
							scrollContainerRef={messagesContainerRef}
							onLoadingOlderChange={setIsLoadingOlder}
						/>
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

				{/* Scroll-to-bottom button */}
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
						<ScrollToBottomButton
							onClick={handleScrollToBottom}
							bottomClass="bottom-0"
							autoScroll={autoScrollEnabled}
						/>
					)}
				</div>
			</div>

			{/* Human input area (always visible) */}
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
			{/* Reject dialog — for tasks awaiting human review */}
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
