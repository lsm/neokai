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

import type { NeoTask, SessionInfo } from '@neokai/shared';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useModal } from '../../hooks/useModal';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { copyToClipboard } from '../../lib/utils';
import { ConfirmModal } from '../ui/ConfirmModal';
import { RejectModal } from '../ui/RejectModal';
import { InputTextarea } from '../InputTextarea';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { TaskConversationRenderer } from './TaskConversationRenderer';

interface CopyButtonProps {
	text: string;
}

function CopyButton({ text }: CopyButtonProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		const success = await copyToClipboard(text);
		if (success) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	};

	return (
		<button
			class={`ml-1 p-0.5 rounded transition-colors ${
				copied ? 'text-green-400' : 'text-gray-500 hover:text-gray-300'
			}`}
			onClick={handleCopy}
			title={copied ? 'Copied!' : 'Copy to clipboard'}
		>
			{copied ? (
				<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
			) : (
				<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
					/>
				</svg>
			)}
		</button>
	);
}

interface TaskGroupInfo {
	id: string;
	taskId: string;
	workerSessionId: string;
	leaderSessionId: string;
	workerRole: string;
	state: string;
	feedbackIteration: number;
	createdAt: number;
	completedAt: number | null;
}

interface TaskViewProps {
	roomId: string;
	taskId: string;
}

const GROUP_STATE_LABELS: Record<string, string> = {
	awaiting_worker: 'Worker active…',
	awaiting_leader: 'Leader reviewing…',
	awaiting_human: 'Needs human review',
	completed: 'Completed',
	failed: 'Failed',
	// Backward compat
	awaiting_craft: 'Worker active…',
	awaiting_lead: 'Leader reviewing…',
};

const TASK_STATUS_COLORS: Record<string, string> = {
	pending: 'text-gray-400',
	in_progress: 'text-yellow-400',
	completed: 'text-green-400',
	failed: 'text-red-400',
	review: 'text-purple-400',
	draft: 'text-gray-500',
	cancelled: 'text-gray-500',
};

interface HeaderReviewBarProps {
	roomId: string;
	taskId: string;
	/** Called after approval to refresh the conversation */
	onApproved: () => void;
	/** Called after rejection to refresh the conversation */
	onRejected: () => void;
}

function HeaderReviewBar({ roomId, taskId, onApproved, onRejected }: HeaderReviewBarProps) {
	const { request } = useMessageHub();
	const [approving, setApproving] = useState(false);
	const [rejecting, setRejecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const rejectModal = useModal();

	const approveTask = async () => {
		if (approving) return;
		setApproving(true);
		setError(null);
		try {
			await request('goal.approveTask', { roomId, taskId });
			// Approval changes group state; re-fetch conversation to pick up the approval message
			onApproved();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to approve task');
		} finally {
			setApproving(false);
		}
	};

	const rejectTask = async (feedback: string) => {
		if (rejecting) return;
		setRejecting(true);
		setError(null);
		try {
			await request('task.reject', { roomId, taskId, feedback });
			// Rejection changes group state; re-fetch conversation to pick up the rejection message
			rejectModal.close();
			onRejected();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to reject task');
		} finally {
			setRejecting(false);
		}
	};

	return (
		<>
			<div class="border-b border-amber-700/30 bg-amber-900/20 px-4 py-2 flex items-center gap-3 flex-shrink-0">
				{/* Review prompt */}
				<div class="flex-1 flex items-center gap-2">
					<span class="text-amber-400 text-sm font-medium">
						Review the PR and approve or provide feedback below
					</span>
				</div>
				{/* Action buttons */}
				<div class="flex items-center gap-2">
					{/* Reject button */}
					<button
						class="py-1.5 px-4 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center gap-1.5"
						onClick={rejectModal.open}
						disabled={rejecting || approving}
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
						<span>Reject</span>
					</button>
					{/* Approve button */}
					<button
						class="py-1.5 px-4 rounded bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center gap-1.5"
						onClick={approveTask}
						disabled={approving || rejecting}
					>
						{approving ? (
							<>
								<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
									/>
								</svg>
								<span>Approving…</span>
							</>
						) : (
							<>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M5 13l4 4L19 7"
									/>
								</svg>
								<span>Approve</span>
							</>
						)}
					</button>
				</div>
				{error && <span class="text-xs text-red-400">{error}</span>}
			</div>
			{/* Reject modal */}
			<RejectModal
				isOpen={rejectModal.isOpen}
				onClose={rejectModal.close}
				onConfirm={rejectTask}
				title="Reject Task"
				message="Please provide feedback explaining why this task is being rejected. The worker will receive this feedback and can address the issues."
				isLoading={rejecting}
			/>
		</>
	);
}

interface HumanInputAreaProps {
	groupState: string;
	roomId: string;
	taskId: string;
	/** Called after a successful action that requires a full conversation re-fetch */
	onMessageSentWithReload: () => void;
}

function HumanInputArea({
	groupState,
	roomId,
	taskId,
	onMessageSentWithReload,
}: HumanInputAreaProps) {
	const { request } = useMessageHub();
	const [feedbackText, setFeedbackText] = useState('');
	const [leaderText, setLeaderText] = useState('');
	const [sendingFeedback, setSendingFeedback] = useState(false);
	const [sendingLeader, setSendingLeader] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);

	const sendFeedback = async () => {
		if (sendingFeedback || !feedbackText.trim()) return;
		setSendingFeedback(true);
		setInputError(null);
		try {
			await request('task.sendHumanMessage', { roomId, taskId, message: feedbackText.trim() });
			setFeedbackText('');
			// Rejection feedback changes group state; re-fetch conversation to pick up the human message
			onMessageSentWithReload();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to send feedback');
		} finally {
			setSendingFeedback(false);
		}
	};

	const sendToLeader = async () => {
		if (sendingLeader || !leaderText.trim()) return;
		setSendingLeader(true);
		setInputError(null);
		try {
			await request('task.sendHumanMessage', { roomId, taskId, message: leaderText.trim() });
			setLeaderText('');
			// state.groupMessages.delta handles the live update — no reload needed
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to send message');
		} finally {
			setSendingLeader(false);
		}
	};

	if (groupState === 'awaiting_human') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-2">
				{/* Feedback input using shared InputTextarea.
				    Large maxChars so users can paste diffs/logs freely. */}
				<InputTextarea
					content={feedbackText}
					onContentChange={setFeedbackText}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void sendFeedback();
						}
					}}
					onSubmit={() => void sendFeedback()}
					disabled={sendingFeedback}
					placeholder="Send feedback to request changes… (⌘↵ to send)"
					maxChars={50000}
				/>
				{inputError && <p class="text-xs text-red-400">{inputError}</p>}
			</div>
		);
	}

	if (groupState === 'awaiting_leader') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-2">
				{/* Message input using shared InputTextarea.
				    Large maxChars so users can paste context/diffs freely. */}
				<InputTextarea
					content={leaderText}
					onContentChange={setLeaderText}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void sendToLeader();
						}
					}}
					onSubmit={() => void sendToLeader()}
					disabled={sendingLeader}
					placeholder="Send a message to the leader… (⌘↵ to send)"
					maxChars={50000}
				/>
				{inputError && <p class="text-xs text-red-400">{inputError}</p>}
			</div>
		);
	}

	if (groupState === 'awaiting_worker') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3">
				<div title="Worker is running — wait for leader review">
					<textarea
						class="w-full bg-dark-800 border border-dark-600/50 rounded px-3 py-2 text-sm text-gray-600 placeholder-gray-600 resize-none cursor-not-allowed"
						placeholder="Worker is running — wait for leader review"
						rows={2}
						disabled
					/>
				</div>
			</div>
		);
	}

	return null;
}

export function TaskView({ roomId, taskId }: TaskViewProps) {
	const { request, onEvent, joinRoom, leaveRoom } = useMessageHub();
	const [task, setTask] = useState<NeoTask | null>(null);
	const [group, setGroup] = useState<TaskGroupInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [conversationKey, setConversationKey] = useState(0);
	const [messageCount, setMessageCount] = useState(0);

	// Session info for worker and leader (for displaying worktree path and agent info)
	const [workerSession, setWorkerSession] = useState<SessionInfo | null>(null);
	const [leaderSession, setLeaderSession] = useState<SessionInfo | null>(null);

	// UI state for info panel and autoscroll toggle
	const [showInfoPanel, setShowInfoPanel] = useState(false);
	const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

	// Cancel task modal state
	const cancelModal = useModal();
	const [cancelling, setCancelling] = useState(false);

	// Tracks whether the conversation pane is showing its first batch of messages.
	// Starts true, resets to true each time the conversation reloads (conversationKey bumps),
	// and becomes false once the first non-zero messageCount arrives — at which point
	// useAutoScroll fires its initial-load scroll path.
	const [isFirstLoad, setIsFirstLoad] = useState(true);

	// Refs for scroll container
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const { showScrollButton, scrollToBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: autoScrollEnabled,
		messageCount,
		isInitialLoad: isFirstLoad,
	});

	// Reset conversation scroll state whenever the rendered conversation changes.
	// This covers two cases:
	//   1. conversationKey bumps (manual reload after approve/feedback)
	//   2. group.id changes (room.task.update event spawns a new group)
	// Using the combined renderer key mirrors the `key` prop on TaskConversationRenderer,
	// so any remount that causes the child to re-fetch messages also resets the parent scroll state.
	const rendererKey = group ? `${group.id}-${conversationKey}` : `null-${conversationKey}`;
	useEffect(() => {
		setIsFirstLoad(true);
		setMessageCount(0);
		setAutoScrollEnabled(true);
	}, [rendererKey]);

	// Mark initial load done after first messages arrive (fires after the render where
	// useAutoScroll sees isFirstLoad:true and messageCount>0, so the initial scroll fires first)
	useEffect(() => {
		if (messageCount > 0 && isFirstLoad) {
			setIsFirstLoad(false);
		}
	}, [messageCount, isFirstLoad]);

	const handleScrollToBottom = useCallback(() => {
		scrollToBottom(true);
		setAutoScrollEnabled(true);
	}, [scrollToBottom]);

	useEffect(() => {
		const channel = `room:${roomId}`;
		joinRoom(channel);
		let cancelled = false;
		let fetchGroupSeq = 0;

		const fetchGroup = async () => {
			const seq = ++fetchGroupSeq;
			try {
				const res = await request<{ group: TaskGroupInfo | null }>('task.getGroup', {
					roomId,
					taskId,
				});
				if (!cancelled && seq === fetchGroupSeq) {
					setGroup(res.group);
					// Fetch session info for worker and leader
					void fetchSessionInfo(res.group);
				}
			} catch {
				// Group fetch failure is non-fatal — task may not have a group yet
			}
		};

		const fetchSessionInfo = async (grp: TaskGroupInfo | null) => {
			if (!grp) {
				setWorkerSession(null);
				setLeaderSession(null);
				return;
			}
			try {
				const [workerRes, leaderRes] = await Promise.all([
					request<{ session: SessionInfo }>('session.get', {
						sessionId: grp.workerSessionId,
					}).catch(() => null),
					request<{ session: SessionInfo }>('session.get', {
						sessionId: grp.leaderSessionId,
					}).catch(() => null),
				]);
				if (!cancelled) {
					setWorkerSession(workerRes?.session ?? null);
					setLeaderSession(leaderRes?.session ?? null);
				}
			} catch {
				// Session fetch failure is non-fatal
			}
		};

		const load = async () => {
			try {
				const taskRes = await request<{ task: NeoTask }>('task.get', { roomId, taskId });
				if (!cancelled) {
					setTask(taskRes.task);
					await fetchGroup();
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load task');
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		load();

		// Re-fetch group whenever the task status changes (e.g. group spawned or completed)
		const unsub = onEvent<{ roomId: string; task: NeoTask }>('room.task.update', (event) => {
			if (event.task.id === taskId && !cancelled) {
				setTask(event.task);
				void fetchGroup();
			}
		});

		return () => {
			cancelled = true;
			unsub();
			leaveRoom(channel);
		};
	}, [roomId, taskId]);

	if (loading) {
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

	// Show input area when group is active and in an interactive state
	const showInput =
		group !== null &&
		(group.state === 'awaiting_human' ||
			group.state === 'awaiting_leader' ||
			group.state === 'awaiting_worker');

	// Determine if cancel button should be shown (pending, in_progress, or review status)
	const canCancel =
		task.status === 'pending' || task.status === 'in_progress' || task.status === 'review';

	// Cancel task handler
	const cancelTask = async () => {
		if (cancelling) return;
		setCancelling(true);
		try {
			await request('task.cancel', { roomId, taskId });
			cancelModal.close();
			// Navigate back to room since task is now cancelled
			navigateToRoom(roomId);
		} catch {
			// Error is silently handled - modal stays open for retry
		} finally {
			setCancelling(false);
		}
	};

	return (
		<div class="flex-1 flex flex-col overflow-hidden bg-dark-900">
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
						<span class={`text-xs font-medium ${statusColor}`}>
							{task.status.replace('_', ' ')}
						</span>
						{task.taskType && (
							<span class="text-xs text-gray-500 bg-dark-700 px-1.5 py-0.5 rounded">
								{task.taskType}
							</span>
						)}
					</div>
					{group && (
						<div class="flex items-center gap-2 mt-0.5">
							<p class="text-xs text-gray-500">
								{GROUP_STATE_LABELS[group.state] ?? group.state}
								{group.feedbackIteration > 0 && ` · iteration ${group.feedbackIteration}`}
							</p>
							{group.state === 'awaiting_human' && (
								<span class="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-900/30 border border-amber-700/40 px-1.5 py-0.5 rounded-full animate-pulse">
									Awaiting your review
								</span>
							)}
						</div>
					)}
				</div>
				{task.progress != null && task.progress > 0 && (
					<div class="flex items-center gap-2 flex-shrink-0">
						<div class="w-24 h-1.5 bg-dark-700 rounded-full overflow-hidden">
							<div
								class="h-full bg-blue-500 transition-all duration-300"
								style={{ width: `${task.progress}%` }}
							/>
						</div>
						<span class="text-xs text-gray-400">{task.progress}%</span>
					</div>
				)}
				{/* Cancel button - shown for pending, in_progress, or review tasks */}
				{canCancel && (
					<button
						class="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-dark-700 transition-colors"
						onClick={cancelModal.open}
						title="Cancel task"
						disabled={cancelling}
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				)}
				{/* Info toggle button */}
				<button
					class={`p-1.5 rounded transition-colors ${
						showInfoPanel
							? 'bg-blue-600 text-white'
							: 'text-gray-400 hover:text-gray-200 hover:bg-dark-700'
					}`}
					onClick={() => setShowInfoPanel(!showInfoPanel)}
					title="Task info"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				</button>
			</div>

			{/* Header Review Bar - shown when awaiting human approval */}
			{group?.state === 'awaiting_human' && (
				<HeaderReviewBar
					roomId={roomId}
					taskId={taskId}
					onApproved={() => setConversationKey((k) => k + 1)}
					onRejected={() => setConversationKey((k) => k + 1)}
				/>
			)}

			{/* Info panel */}
			{showInfoPanel && (
				<div class="border-b border-dark-700 bg-dark-850/50 px-4 py-3 flex-shrink-0">
					<div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
						<div>
							<span class="text-gray-500">Task ID:</span>
							<span class="text-gray-300 ml-2 font-mono">{task.id}</span>
							<CopyButton text={task.id} />
						</div>
						{group && (
							<>
								<div>
									<span class="text-gray-500">Group ID:</span>
									<span class="text-gray-300 ml-2 font-mono">{group.id}</span>
									<CopyButton text={group.id} />
								</div>
								<div>
									<span class="text-gray-500">Worker:</span>
									<span class="text-gray-300 ml-2 font-mono">
										{group.workerSessionId.slice(0, 8)}...
									</span>
									<CopyButton text={group.workerSessionId} />
								</div>
								<div>
									<span class="text-gray-500">Leader:</span>
									<span class="text-gray-300 ml-2 font-mono">
										{group.leaderSessionId.slice(0, 8)}...
									</span>
									<CopyButton text={group.leaderSessionId} />
								</div>
							</>
						)}
						{workerSession && (
							<div class="md:col-span-2">
								<span class="text-gray-500">Worker worktree:</span>
								<span class="text-gray-300 ml-2 font-mono break-all">
									{workerSession.worktree?.worktreePath ?? workerSession.workspacePath}
								</span>
								<CopyButton
									text={workerSession.worktree?.worktreePath ?? workerSession.workspacePath}
								/>
								{workerSession.config.model && (
									<span class="text-gray-500 ml-2">(model: {workerSession.config.model})</span>
								)}
							</div>
						)}
						{leaderSession && (
							<div class="md:col-span-2">
								<span class="text-gray-500">Leader worktree:</span>
								<span class="text-gray-300 ml-2 font-mono break-all">
									{leaderSession.worktree?.worktreePath ?? leaderSession.workspacePath}
								</span>
								<CopyButton
									text={leaderSession.worktree?.worktreePath ?? leaderSession.workspacePath}
								/>
								{leaderSession.config.model && (
									<span class="text-gray-500 ml-2">(model: {leaderSession.config.model})</span>
								)}
							</div>
						)}
					</div>
				</div>
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
				<div ref={messagesContainerRef} class="absolute inset-0 overflow-y-auto flex flex-col">
					{group ? (
						<TaskConversationRenderer
							key={`${group.id}-${conversationKey}`}
							groupId={group.id}
							onMessageCountChange={setMessageCount}
						/>
					) : (
						<div class="flex-1 flex items-center justify-center text-center p-8">
							<div>
								<p class="text-gray-400 mb-1">No active agent group</p>
								<p class="text-sm text-gray-500">
									{task.status === 'pending'
										? 'Waiting for the runtime to pick up this task.'
										: task.status === 'completed'
											? 'This task has been completed.'
											: task.status === 'failed'
												? 'This task has failed.'
												: task.status === 'review'
													? 'This task is awaiting human review.'
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

				{/* Scroll-to-bottom button — shown when user has scrolled up.
				    bottomClass="bottom-4" because HumanInputArea is a sibling
				    outside this container, not an overlapping footer. */}
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
			</div>

			{/* Human input area */}
			{showInput && group && (
				<HumanInputArea
					groupState={group.state}
					roomId={roomId}
					taskId={taskId}
					onMessageSentWithReload={() => setConversationKey((k) => k + 1)}
				/>
			)}

			{/* Cancel confirmation modal */}
			<ConfirmModal
				isOpen={cancelModal.isOpen}
				onClose={cancelModal.close}
				onConfirm={cancelTask}
				title="Cancel Task"
				message="Are you sure you want to cancel this task? This action cannot be undone."
				confirmText="Cancel Task"
				confirmButtonVariant="danger"
				isLoading={cancelling}
			/>
		</div>
	);
}
