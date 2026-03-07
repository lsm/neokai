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
import type { NeoTask } from '@neokai/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { parsePrUrl } from '../../lib/utils';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { InputTextarea } from '../InputTextarea';
import { TaskConversationRenderer } from './TaskConversationRenderer';

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
};

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
	// Separate loading states so Approve button doesn't show "Approving…" during feedback send
	const [approving, setApproving] = useState(false);
	const [sendingFeedback, setSendingFeedback] = useState(false);
	const [sendingLeader, setSendingLeader] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);

	const approveTask = async () => {
		if (approving || sendingFeedback) return;
		setApproving(true);
		setInputError(null);
		try {
			await request('goal.approveTask', { roomId, taskId });
			// Approval changes group state; re-fetch conversation to pick up the approval message
			onMessageSentWithReload();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to approve task');
		} finally {
			setApproving(false);
		}
	};

	const sendFeedback = async () => {
		if (sendingFeedback || approving || !feedbackText.trim()) return;
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
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0">
				{/* Prominent banner */}
				<div class="px-4 py-2 bg-amber-900/20 border-b border-amber-800/30 flex items-center gap-2">
					<span class="text-amber-400 text-sm font-medium">⏳ Awaiting your review</span>
					<span class="text-xs text-amber-500/70 ml-auto">
						Review the PR and approve or provide feedback
					</span>
				</div>
				<div class="px-4 py-3 space-y-2">
					{/* Approve button */}
					<button
						class="w-full py-2 px-4 rounded bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
						onClick={approveTask}
						disabled={approving || sendingFeedback}
					>
						{approving ? 'Approving…' : '✓ Approve'}
					</button>
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
						disabled={sendingFeedback || approving}
						placeholder="Or send feedback to request changes… (⌘↵ to send)"
						maxChars={50000}
					/>
					{inputError && <p class="text-xs text-red-400">{inputError}</p>}
				</div>
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

	// Tracks whether the conversation pane is showing its first batch of messages.
	// Starts true, resets to true each time the conversation reloads (conversationKey bumps),
	// and becomes false once the first non-zero messageCount arrives — at which point
	// useAutoScroll fires its initial-load scroll path.
	const [isFirstLoad, setIsFirstLoad] = useState(true);

	// autoScroll mirrors whether the user is near the bottom of the scroll container.
	// Driven by isNearBottom from useAutoScroll so that arriving messages don't force-scroll
	// the user back down when they've intentionally scrolled up to read history.
	const [autoScroll, setAutoScroll] = useState(true);

	// Refs for scroll container
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const { showScrollButton, scrollToBottom, isNearBottom } = useAutoScroll({
		containerRef: messagesContainerRef,
		endRef: messagesEndRef,
		enabled: autoScroll,
		messageCount,
		isInitialLoad: isFirstLoad,
	});

	// Keep autoScroll in sync with scroll position: disable when user scrolls up,
	// re-enable automatically when they scroll back to the bottom.
	useEffect(() => {
		setAutoScroll(isNearBottom);
	}, [isNearBottom]);

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
		setAutoScroll(true);
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
		setAutoScroll(true);
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
				if (!cancelled && seq === fetchGroupSeq) setGroup(res.group);
			} catch {
				// Group fetch failure is non-fatal — task may not have a group yet
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
	const pr = task.currentStep ? parsePrUrl(task.currentStep) : null;

	// Show input area when group is active and in an interactive state
	const showInput =
		group !== null &&
		(group.state === 'awaiting_human' ||
			group.state === 'awaiting_leader' ||
			group.state === 'awaiting_worker');

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
						{pr && (
							<a
								href={pr.url}
								target="_blank"
								rel="noopener noreferrer"
								class="text-xs px-1.5 py-0.5 rounded bg-blue-900/20 text-blue-400 hover:text-blue-300 hover:bg-blue-900/40 border border-blue-700/40 transition-colors"
								title={pr.url}
							>
								PR #{pr.number}
							</a>
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
			</div>

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
				{showScrollButton && (
					<ScrollToBottomButton onClick={handleScrollToBottom} bottomClass="bottom-4" />
				)}
			</div>

			{/* Human input area */}
			{showInput && (
				<HumanInputArea
					groupState={group!.state}
					roomId={roomId}
					taskId={taskId}
					onMessageSentWithReload={() => setConversationKey((k) => k + 1)}
				/>
			)}
		</div>
	);
}
