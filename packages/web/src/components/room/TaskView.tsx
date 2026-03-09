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
	feedbackIteration: number;
	submittedForReview: boolean;
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
			await request('task.approve', { roomId, taskId });
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
				<div class="flex-1 flex items-center gap-2">
					<span class="text-amber-400 text-sm font-medium">
						Review the PR and approve or provide feedback below
					</span>
				</div>
				<div class="flex items-center gap-2">
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

type HumanMessageTarget = 'worker' | 'leader';

interface HumanInputAreaProps {
	hasGroup: boolean;
	roomId: string;
	taskId: string;
	onMessageSentWithReload: () => void;
}

const TARGET_LABELS: Record<HumanMessageTarget, string> = {
	worker: 'Worker',
	leader: 'Leader',
};

function HumanInputArea({
	hasGroup,
	roomId,
	taskId,
	onMessageSentWithReload,
}: HumanInputAreaProps) {
	const { request } = useMessageHub();
	const [messageText, setMessageText] = useState('');
	const [sending, setSending] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);
	const [target, setTarget] = useState<HumanMessageTarget>('worker');
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const onDocMouseDown = (event: MouseEvent) => {
			const targetNode = event.target as Node;
			if (menuRef.current && !menuRef.current.contains(targetNode)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener('mousedown', onDocMouseDown);
		return () => document.removeEventListener('mousedown', onDocMouseDown);
	}, [menuOpen]);

	const canSend = hasGroup;

	const sendMessage = async () => {
		if (sending || !messageText.trim() || !canSend) return;
		setSending(true);
		setInputError(null);
		try {
			await request('task.sendHumanMessage', {
				roomId,
				taskId,
				message: messageText.trim(),
				target,
			});
			setMessageText('');
			onMessageSentWithReload();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to send message');
		} finally {
			setSending(false);
		}
	};

	const placeholder = !hasGroup
		? 'No active agent group yet — input will activate once a group starts.'
		: target === 'leader'
			? 'Send a message to the leader… (⌘↵ to send)'
			: 'Send a message to the worker… (⌘↵ to send)';

	return (
		<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-2">
			<InputTextarea
				content={messageText}
				onContentChange={setMessageText}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void sendMessage();
					}
				}}
				onSubmit={() => void sendMessage()}
				disabled={sending || !canSend}
				placeholder={placeholder}
				maxChars={50000}
				leadingPaddingClass="pl-[5.75rem]"
				leadingElement={
					<div class="relative" ref={menuRef}>
						<button
							type="button"
							class="inline-flex h-9 items-center gap-1 rounded-3xl bg-blue-500 px-3 text-xs font-medium text-white hover:bg-blue-600 active:scale-95 transition-all"
							onClick={(e) => {
								e.stopPropagation();
								setMenuOpen((open) => !open);
							}}
							data-testid="task-target-button"
							title="Select target agent"
						>
							<span>{TARGET_LABELS[target]}</span>
							<svg
								class="w-3 h-3 text-white/90"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						</button>

						{menuOpen && (
							<div class="absolute bottom-full mb-2 left-0 z-20 min-w-[140px] rounded-lg border border-dark-600 bg-dark-800 py-1 shadow-xl">
								{(['worker', 'leader'] as const).map((option) => {
									const selected = target === option;
									return (
										<button
											key={option}
											type="button"
											onClick={() => {
												setTarget(option);
												setMenuOpen(false);
											}}
											data-testid={`task-target-option-${option}`}
											class={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${
												selected
													? 'text-blue-400 bg-dark-700/70'
													: 'text-gray-200 hover:bg-dark-700'
											}`}
										>
											{TARGET_LABELS[option]}
										</button>
									);
								})}
							</div>
						)}
					</div>
				}
			/>
			{!canSend && <p class="text-xs text-gray-500">No active group to receive messages yet.</p>}
			{inputError && <p class="text-xs text-red-400">{inputError}</p>}
		</div>
	);
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

	// Cancel task modal state
	const cancelModal = useModal();
	const [cancelling, setCancelling] = useState(false);
	const [cancelError, setCancelError] = useState<string | null>(null);

	// Tracks whether the conversation pane is showing its first batch of messages.
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

	const statusColor = TASK_STATUS_COLORS[task.status] ?? 'text-gray-400';

	// Determine if cancel button should be shown (pending, in_progress, or review status)
	const canCancel =
		task.status === 'pending' || task.status === 'in_progress' || task.status === 'review';

	// Cancel task handler
	const cancelTask = async () => {
		if (cancelling) return;
		setCancelling(true);
		setCancelError(null);
		try {
			await request('task.cancel', { roomId, taskId });
			cancelModal.close();
			// Navigate back to room since task is now cancelled
			navigateToRoom(roomId);
		} catch (err) {
			setCancelError(err instanceof Error ? err.message : 'Failed to cancel task');
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
								{group.feedbackIteration > 0 && `iteration ${group.feedbackIteration}`}
							</p>
							{group.submittedForReview && (
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

			{/* Header Review Bar - shown when awaiting human approval */}
			{group?.submittedForReview && (
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

				{/* Scroll-to-bottom button */}
				<div
					class="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
					style={{ bottom: '1rem' }}
				>
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

			{/* Human input area (always visible) */}
			<HumanInputArea
				hasGroup={group !== null}
				roomId={roomId}
				taskId={taskId}
				onMessageSentWithReload={() => setConversationKey((k) => k + 1)}
			/>

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
				error={cancelError}
			/>
		</div>
	);
}
