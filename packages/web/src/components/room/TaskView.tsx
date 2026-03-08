/**
 * TaskView Component
 *
 * Shows the task detail view with:
 * - Compact header (breadcrumb + progress + info toggle)
 * - Unified conversation timeline (Worker + Leader messages in sub-agent blocks)
 * - Unified bottom panel (review actions / status indicator)
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
import { t } from '../../lib/i18n';
import { roomStore } from '../../lib/room-store';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { copyToClipboard } from '../../lib/utils';
import { InputTextarea } from '../InputTextarea';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { Breadcrumb } from '../ui/Breadcrumb';
import { TaskConversationRenderer } from './TaskConversationRenderer';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
			title={copied ? t('task.copiedToClipboard') : t('task.copyToClipboard')}
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

const TASK_STATUS_COLORS: Record<string, string> = {
	pending: 'text-gray-400',
	in_progress: 'text-yellow-400',
	completed: 'text-green-400',
	failed: 'text-red-400',
	review: 'text-purple-400',
	draft: 'text-gray-500',
	cancelled: 'text-gray-500',
};

const GROUP_STATE_LABEL_KEYS: Record<string, string> = {
	awaiting_worker: 'task.state.awaitingWorker',
	awaiting_leader: 'task.state.awaitingLeader',
	awaiting_human: 'task.state.awaitingHuman',
	completed: 'task.state.completed',
	failed: 'task.state.failed',
	// Backward compat
	awaiting_craft: 'task.state.awaitingWorker',
	awaiting_lead: 'task.state.awaitingLeader',
};

function getGroupStateLabel(state: string): string {
	const key = GROUP_STATE_LABEL_KEYS[state];
	return key ? t(key) : state;
}

// ─── Bottom Panel ────────────────────────────────────────────────────────────

interface BottomPanelProps {
	groupState: string;
	feedbackIteration: number;
	roomId: string;
	taskId: string;
	onMessageSentWithReload: () => void;
}

function BottomPanel({
	groupState,
	feedbackIteration,
	roomId,
	taskId,
	onMessageSentWithReload,
}: BottomPanelProps) {
	const { request } = useMessageHub();
	const [feedbackText, setFeedbackText] = useState('');
	const [leaderText, setLeaderText] = useState('');
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
			setInputError(err instanceof Error ? err.message : t('task.failedToApprove'));
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
			// Feedback changes group state; re-fetch conversation to pick up the human message
			onMessageSentWithReload();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : t('task.failedToSendFeedback'));
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
			setInputError(err instanceof Error ? err.message : t('task.failedToSendMessage'));
		} finally {
			setSendingLeader(false);
		}
	};

	// ── Awaiting human review: unified decision panel ──
	if (groupState === 'awaiting_human') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-3">
				<div class="flex items-center gap-2 text-sm">
					<span class="text-amber-400 font-medium">{t('task.awaitingReview')}</span>
					{feedbackIteration > 0 && (
						<span class="text-gray-500">· {t('task.iteration', { count: feedbackIteration })}</span>
					)}
					<span class="text-xs text-gray-600 ml-auto">{t('task.reviewHint')}</span>
				</div>

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
					placeholder={t('task.feedbackPlaceholder')}
					maxChars={50000}
				/>

				<div class="flex items-center justify-end gap-2">
					{inputError && <p class="text-xs text-red-400 mr-auto">{inputError}</p>}
					<button
						class="px-4 py-1.5 text-sm font-medium rounded-md text-gray-300 hover:text-white bg-dark-700 hover:bg-dark-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						onClick={() => void sendFeedback()}
						disabled={sendingFeedback || approving || !feedbackText.trim()}
					>
						{sendingFeedback ? t('task.sending') : t('task.sendFeedback')}
					</button>
					<button
						class="px-4 py-1.5 text-sm font-medium rounded-md text-white bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						onClick={approveTask}
						disabled={approving || sendingFeedback}
					>
						{approving ? t('task.approving') : t('task.approve')}
					</button>
				</div>
			</div>
		);
	}

	// ── Awaiting leader: message input ──
	if (groupState === 'awaiting_leader') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-2">
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
					placeholder={t('task.leaderPlaceholder')}
					maxChars={50000}
				/>
				{inputError && <p class="text-xs text-red-400">{inputError}</p>}
			</div>
		);
	}

	// ── Awaiting worker: status bar ──
	if (groupState === 'awaiting_worker') {
		return (
			<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-2.5">
				<div class="flex items-center gap-2 text-sm text-gray-500">
					<div class="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
					{t('task.workerRunning')}
				</div>
			</div>
		);
	}

	return null;
}

// ─── Main TaskView ───────────────────────────────────────────────────────────

export function TaskView({ roomId, taskId }: TaskViewProps) {
	const { request, onEvent, joinRoom, leaveRoom } = useMessageHub();
	const [task, setTask] = useState<NeoTask | null>(null);
	const [group, setGroup] = useState<TaskGroupInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [conversationKey, setConversationKey] = useState(0);
	const [messageCount, setMessageCount] = useState(0);

	// Session info for worker and leader
	const [workerSession, setWorkerSession] = useState<SessionInfo | null>(null);
	const [leaderSession, setLeaderSession] = useState<SessionInfo | null>(null);

	// UI state
	const [showInfoPanel, setShowInfoPanel] = useState(false);
	const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
	const [isFirstLoad, setIsFirstLoad] = useState(true);
	const [retrying, setRetrying] = useState(false);

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

	const rendererKey = group ? `${group.id}-${conversationKey}` : `null-${conversationKey}`;
	useEffect(() => {
		setIsFirstLoad(true);
		setMessageCount(0);
		setAutoScrollEnabled(true);
	}, [rendererKey]);

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
					void fetchSessionInfo(res.group);
				}
			} catch {
				// Group fetch failure is non-fatal
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
				<p class="text-gray-400">{t('task.loadingTask')}</p>
			</div>
		);
	}

	if (error || !task) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<p class="text-red-400 mb-3">{error ?? t('task.notFound')}</p>
					<button
						class="text-sm text-blue-400 hover:text-blue-300"
						onClick={() => navigateToRoom(roomId)}
					>
						{t('task.backToRoom')}
					</button>
				</div>
			</div>
		);
	}

	const showInput =
		group !== null &&
		(group.state === 'awaiting_human' ||
			group.state === 'awaiting_leader' ||
			group.state === 'awaiting_worker');

	return (
		<div class="flex-1 flex flex-col overflow-hidden bg-dark-900">
			{/* P1: Compact header — breadcrumb + progress + info */}
			<div class="border-b border-dark-700 bg-dark-850 px-4 flex items-center gap-3 flex-shrink-0 h-[61px]">
				<div class="min-w-0 flex-shrink">
					<Breadcrumb
						items={[
							{
								label: roomStore.room.value?.name ?? t('task.room'),
								onClick: () => navigateToRoom(roomId),
							},
							{ label: task.title },
						]}
					/>
				</div>
				<div class="flex items-center gap-3 ml-auto flex-shrink-0">
					{/* Progress bar */}
					{task.progress != null && task.progress > 0 && (
						<div class="hidden sm:flex items-center gap-2">
							<div class="w-24 h-1.5 bg-dark-700 rounded-full overflow-hidden">
								<div
									class="h-full bg-blue-500 transition-all duration-300"
									style={{ width: `${task.progress}%` }}
								/>
							</div>
							<span class="text-xs text-gray-400 tabular-nums">{task.progress}%</span>
						</div>
					)}
					{/* Info toggle */}
					<button
						class={`p-1.5 rounded transition-colors ${
							showInfoPanel
								? 'bg-blue-600 text-white'
								: 'text-gray-400 hover:text-gray-200 hover:bg-dark-700'
						}`}
						onClick={() => setShowInfoPanel(!showInfoPanel)}
						title={t('task.taskInfo')}
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
			</div>

			{/* P2: Info panel — status, type, iteration, session details */}
			{showInfoPanel && (
				<div class="border-b border-dark-700 bg-dark-850/50 px-4 py-3 flex-shrink-0">
					<div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
						{/* Status + type row */}
						<div class="md:col-span-2 flex items-center gap-2 flex-wrap">
							<span class={`font-medium ${TASK_STATUS_COLORS[task.status] ?? 'text-gray-400'}`}>
								{task.status.replace(/_/g, ' ')}
							</span>
							{task.taskType && (
								<span class="text-gray-500 bg-dark-700 px-1.5 py-0.5 rounded">{task.taskType}</span>
							)}
							{group && (
								<span class="text-gray-500">
									{getGroupStateLabel(group.state)}
									{group.feedbackIteration > 0 &&
										` · ${t('task.iteration', { count: group.feedbackIteration })}`}
								</span>
							)}
						</div>
						<div>
							<span class="text-gray-500">{t('task.taskId')}</span>
							<span class="text-gray-300 ml-2 font-mono">{task.id}</span>
							<CopyButton text={task.id} />
						</div>
						{group && (
							<>
								<div>
									<span class="text-gray-500">{t('task.groupId')}</span>
									<span class="text-gray-300 ml-2 font-mono">{group.id}</span>
									<CopyButton text={group.id} />
								</div>
								<div>
									<span class="text-gray-500">{t('task.worker')}</span>
									<span class="text-gray-300 ml-2 font-mono">
										{group.workerSessionId.slice(0, 8)}...
									</span>
									<CopyButton text={group.workerSessionId} />
								</div>
								<div>
									<span class="text-gray-500">{t('task.leader')}</span>
									<span class="text-gray-300 ml-2 font-mono">
										{group.leaderSessionId.slice(0, 8)}...
									</span>
									<CopyButton text={group.leaderSessionId} />
								</div>
							</>
						)}
						{workerSession && (
							<div class="md:col-span-2">
								<span class="text-gray-500">{t('task.workerWorktree')}</span>
								<span class="text-gray-300 ml-2 font-mono break-all">
									{workerSession.worktree?.worktreePath ?? workerSession.workspacePath}
								</span>
								<CopyButton
									text={workerSession.worktree?.worktreePath ?? workerSession.workspacePath}
								/>
								{workerSession.config.model && (
									<span class="text-gray-500 ml-2">
										({t('task.modelLabel', { model: workerSession.config.model })})
									</span>
								)}
							</div>
						)}
						{leaderSession && (
							<div class="md:col-span-2">
								<span class="text-gray-500">{t('task.leaderWorktree')}</span>
								<span class="text-gray-300 ml-2 font-mono break-all">
									{leaderSession.worktree?.worktreePath ?? leaderSession.workspacePath}
								</span>
								<CopyButton
									text={leaderSession.worktree?.worktreePath ?? leaderSession.workspacePath}
								/>
								{leaderSession.config.model && (
									<span class="text-gray-500 ml-2">
										({t('task.modelLabel', { model: leaderSession.config.model })})
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Dependencies */}
			{task.dependsOn && task.dependsOn.length > 0 && (
				<div class="border-b border-dark-700 bg-dark-850/50 px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap">
					<span class="text-xs text-gray-500">{t('task.dependsOn')}</span>
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

			{/* Conversation timeline */}
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
								<p class="text-gray-400 mb-1">{t('task.noActiveGroup')}</p>
								<p class="text-sm text-gray-500">
									{task.status === 'pending'
										? t('task.waitingForRuntime')
										: task.status === 'completed'
											? t('task.taskCompleted')
											: task.status === 'failed'
												? t('task.taskFailed')
												: task.status === 'review'
													? t('task.taskReview')
													: task.status === 'draft'
														? t('task.taskDraft')
														: task.status === 'cancelled'
															? t('task.taskCancelled')
															: t('task.noGroupSpawned')}
								</p>
							</div>
						</div>
					)}
					<div ref={messagesEndRef} />
				</div>

				{/* Scroll controls */}
				<div class="absolute right-2 flex flex-col gap-2" style={{ bottom: '1rem' }}>
					<button
						class={`p-2 rounded-full shadow-lg transition-colors ${
							autoScrollEnabled
								? 'bg-blue-600 text-white hover:bg-blue-500'
								: 'bg-dark-700 text-gray-400 hover:text-gray-200 hover:bg-dark-600'
						}`}
						onClick={() => setAutoScrollEnabled(!autoScrollEnabled)}
						title={autoScrollEnabled ? t('task.disableAutoScroll') : t('task.enableAutoScroll')}
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

			{/* P0: Unified bottom panel */}
			{showInput && group && (
				<BottomPanel
					groupState={group.state}
					feedbackIteration={group.feedbackIteration}
					roomId={roomId}
					taskId={taskId}
					onMessageSentWithReload={() => setConversationKey((k) => k + 1)}
				/>
			)}

			{/* Retry bar for failed tasks */}
			{task.status === 'failed' && (
				<div class="border-t border-dark-700 bg-dark-850 px-4 py-3 flex items-center justify-between">
					<span class="text-sm text-red-400">{t('task.taskFailed')}</span>
					<button
						disabled={retrying}
						onClick={() => {
							setRetrying(true);
							roomStore.retryTask(taskId).catch(() => {
								setRetrying(false);
							});
						}}
						class="px-3 py-1.5 text-sm font-medium text-amber-400 bg-amber-900/20 hover:bg-amber-900/40 border border-amber-700/50 rounded transition-colors disabled:opacity-50"
					>
						{retrying ? t('task.retrying') : t('tasks.retry')}
					</button>
				</div>
			)}
		</div>
	);
}
