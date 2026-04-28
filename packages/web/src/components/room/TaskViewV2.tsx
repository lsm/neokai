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
import { RejectModal } from '../ui/RejectModal';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { AgentTurnBlock } from './AgentTurnBlock';
import { RuntimeMessageRenderer } from './RuntimeMessageRenderer';
import { SlideOutPanel } from './SlideOutPanel';
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
import { TaskNoGroupState } from './task-shared/TaskNoGroupState';
import { TaskReviewBar } from './task-shared/TaskReviewBar';

interface TaskViewV2Props {
	roomId: string;
	taskId: string;
	viewVersion?: TaskViewVersionContext;
}

export function TaskViewV2({ roomId, taskId, viewVersion }: TaskViewV2Props) {
	const {
		task,
		group,
		diagnostic,
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

	// Live-stream messages for the current group
	const {
		messages,
		isLoading: messagesLoading,
		isReconnecting,
	} = useGroupMessages(group?.id ?? null);

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

	const handleClosePanel = useCallback(() => {
		setSelectedTurn(null);
	}, []);

	const handleTurnClick = useCallback((turn: TurnBlock) => {
		setSelectedTurn((prev) => (prev?.id === turn.id ? null : turn));
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

	return (
		<div data-testid="task-view-v2" class="flex-1 flex flex-col overflow-hidden bg-dark-900">
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

			{/* Info panel */}
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
				}}
				visibleActions={{
					interrupt: canInterrupt,
					complete: canComplete && task.status !== 'review',
					cancel: canCancel,
					archive: canArchive,
					setStatus: task.status !== 'archived',
				}}
				disabledActions={{
					interrupt: interrupting,
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
							{/* Reconnecting banner — shown while WebSocket is down and messages exist */}
							{isReconnecting && (
								<div
									data-testid="reconnecting-banner"
									class="flex items-center gap-2 rounded border border-yellow-700/50 bg-yellow-950/20 px-3 py-2 text-xs text-yellow-400"
								>
									<svg
										class="h-3 w-3 animate-spin"
										fill="none"
										viewBox="0 0 24 24"
										aria-hidden="true"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										/>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
										/>
									</svg>
									Reconnecting…
								</div>
							)}
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
											<div key={item.turn.id} class="mb-4">
												<AgentTurnBlock turn={item.turn} onHeaderClick={handleTurnClick} />
											</div>
										);
									}
									return <RuntimeMessageRenderer key={item.index} message={item} />;
								})
							)}
						</div>
					) : (
						<TaskNoGroupState
							task={task}
							diagnostic={diagnostic}
							canReactivate={canReactivate}
							reactivating={reactivating}
							onReactivate={reactivateTask}
							canArchive={canArchive}
							onArchive={archiveModal.open}
						/>
					)}
					<div ref={messagesEndRef} />
				</div>

				{/* Scroll controls */}
				<div class="absolute right-4 flex flex-col items-center gap-2" style={{ bottom: '1rem' }}>
					{showScrollButton && (
						<ScrollToBottomButton
							onClick={handleScrollToBottom}
							bottomClass="bottom-0"
							autoScroll={autoScrollEnabled}
						/>
					)}
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
				</div>

				{/* Slide-out panel — overlays the turn blocks area */}
			</div>

			{/* Slide-out panel — overlays the full TaskViewV2 area */}
			<SlideOutPanel
				isOpen={selectedTurn !== null}
				sessionId={selectedTurn?.sessionId ?? null}
				agentLabel={selectedTurn?.agentLabel}
				agentRole={selectedTurn?.agentRole}
				onClose={handleClosePanel}
				widthClass="w-full sm:w-[70%] lg:w-1/2"
			/>

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
