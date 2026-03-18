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
import { useTaskInputDraft } from '../../hooks/useTaskInputDraft';
import { navigateToRoom, navigateToRoomTask } from '../../lib/router';
import { copyToClipboard } from '../../lib/utils';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';
import { Modal } from '../ui/Modal';
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
	needs_attention: 'text-red-400',
	review: 'text-purple-400',
	draft: 'text-gray-500',
	cancelled: 'text-gray-500',
};

interface HeaderReviewBarProps {
	roomId: string;
	taskId: string;
	/** Task data for PR link display */
	task?: NeoTask | null;
	/** Called after approval to refresh the conversation */
	onApproved: () => void;
	/** Called after rejection to refresh the conversation */
	onRejected: () => void;
}

function HeaderReviewBar({ roomId, taskId, task, onApproved, onRejected }: HeaderReviewBarProps) {
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
					{/* PR link button */}
					{task?.prUrl && (
						<a
							href={task.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-300 bg-dark-700 hover:bg-dark-600 border border-dark-600 rounded transition-colors"
						>
							<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							<span>PR #{task.prNumber ?? '?'}</span>
							<svg
								class="w-3 h-3 text-gray-500"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
								/>
							</svg>
						</a>
					)}
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

type HumanMessageTarget = 'worker' | 'leader';

interface HumanInputAreaProps {
	hasGroup: boolean;
	roomId: string;
	taskId: string;
	/** Called after a successful action that requires a full conversation re-fetch */
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
	const {
		content: messageText,
		setContent: setMessageText,
		clear: clearDraft,
		draftRestored,
	} = useTaskInputDraft(roomId, taskId);
	const [sending, setSending] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);
	const [target, setTarget] = useState<HumanMessageTarget>('leader');
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const isTouchDeviceRef = useRef(false);

	useEffect(() => {
		isTouchDeviceRef.current =
			window.matchMedia('(pointer: coarse)').matches ||
			('ontouchstart' in window && window.innerWidth < 768);
	}, []);

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
			clearDraft();
			onMessageSentWithReload();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to send message');
		} finally {
			setSending(false);
		}
	};

	const targetLabel = target === 'leader' ? 'leader' : 'worker';
	const placeholder = !hasGroup
		? 'No active agent group yet — input will activate once a group starts.'
		: isTouchDeviceRef.current
			? `Send a message to the ${targetLabel}…`
			: `Send a message to the ${targetLabel}… (Enter to send, Shift+Enter for newline)`;

	return (
		<div class="border-t border-dark-700 bg-dark-850 flex-shrink-0 px-4 py-3 space-y-2">
			{draftRestored && (
				<div
					class="flex items-center justify-between rounded bg-blue-900/30 border border-blue-700/40 px-3 py-1.5 text-xs text-blue-300"
					data-testid="draft-restored-banner"
				>
					<span>Draft restored</span>
					<button
						type="button"
						class="ml-2 text-blue-400 hover:text-blue-200 transition-colors"
						onClick={clearDraft}
						data-testid="draft-dismiss-button"
					>
						Discard draft
					</button>
				</div>
			)}
			<InputTextarea
				content={messageText}
				onContentChange={setMessageText}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						if (e.metaKey || e.ctrlKey || (!e.shiftKey && !isTouchDeviceRef.current)) {
							e.preventDefault();
							void sendMessage();
						}
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

interface CompleteTaskDialogProps {
	task: NeoTask;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: (summary: string) => Promise<void>;
}

function CompleteTaskDialog({ task, isOpen, onClose, onConfirm }: CompleteTaskDialogProps) {
	const [summary, setSummary] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setSummary('');
		setError(null);
		onClose();
	};

	const handleConfirm = async () => {
		setLoading(true);
		setError(null);
		try {
			await onConfirm(summary);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to complete task');
		} finally {
			setLoading(false);
		}
	};

	return (
		<Modal
			isOpen={isOpen}
			onClose={handleClose}
			title="Mark Task as Complete?"
			size="md"
			showCloseButton
		>
			<div class="space-y-4">
				<p class="text-sm text-gray-300">
					You are about to mark <strong class="text-gray-100">{task.title}</strong> as completed.
				</p>

				<div class="bg-dark-800 border border-dark-600 rounded-lg p-3 text-xs text-gray-400">
					<p class="font-medium text-gray-300 mb-1.5">What happens next:</p>
					<ul class="list-disc list-inside space-y-1">
						<li>
							Task status changes to <span class="text-green-400">completed</span>
						</li>
						<li>All sessions will be terminated</li>
						<li>Task slot will be freed</li>
					</ul>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Completion Summary <span class="text-gray-500 font-normal">(optional)</span>
					</label>
					<textarea
						class="w-full h-24 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
						placeholder="Briefly describe what was accomplished..."
						value={summary}
						onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
						disabled={loading}
					/>
				</div>

				{error && (
					<p class="text-sm text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
						{error}
					</p>
				)}

				<div class="flex items-center justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={handleClose}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void handleConfirm()}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed bg-green-600 hover:bg-green-700 text-white disabled:bg-green-600/50 flex items-center gap-1.5"
						data-testid="complete-task-confirm"
					>
						{loading ? (
							'Completing…'
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
								Mark Complete
							</>
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
}

interface CancelTaskDialogProps {
	task: NeoTask;
	isOpen: boolean;
	onClose: () => void;
	onConfirm: () => Promise<void>;
}

function CancelTaskDialog({ task, isOpen, onClose, onConfirm }: CancelTaskDialogProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setError(null);
		onClose();
	};

	const handleConfirm = async () => {
		setLoading(true);
		setError(null);
		try {
			await onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to cancel task');
		} finally {
			setLoading(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Cancel Task?" size="sm" showCloseButton>
			<div class="space-y-4">
				<p class="text-sm text-gray-300">
					You are about to cancel <strong class="text-gray-100">{task.title}</strong>.
				</p>

				<div class="bg-red-900/20 border border-red-800/50 rounded-lg p-3 text-xs text-gray-400">
					<p class="font-medium text-red-400 mb-1.5">This action cannot be undone:</p>
					<ul class="list-disc list-inside space-y-1">
						<li>
							Task will be marked as <span class="text-gray-300">cancelled</span>
						</li>
						<li>All sessions will be terminated</li>
						<li>Isolated worktree and branch will be removed</li>
					</ul>
				</div>

				{error && (
					<p class="text-sm text-red-400 bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
						{error}
					</p>
				)}

				<div class="flex items-center justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={handleClose}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Keep Task
					</button>
					<button
						type="button"
						onClick={() => void handleConfirm()}
						disabled={loading}
						class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50 flex items-center gap-1.5"
						data-testid="cancel-task-confirm"
					>
						{loading ? (
							'Cancelling…'
						) : (
							<>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
								Cancel Task
							</>
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
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

	// Task action modals
	const completeModal = useModal();
	const cancelModal = useModal();

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

	// Determine which actions are available based on task status
	// Only in_progress and review tasks can transition to completed
	const canComplete = task.status === 'in_progress' || task.status === 'review';
	// Pending, in_progress, and review tasks can be cancelled
	const canCancel =
		task.status === 'pending' || task.status === 'in_progress' || task.status === 'review';

	// Complete task handler — throws on error so the dialog can display it
	const completeTask = async (summary: string) => {
		await request('task.setStatus', {
			roomId,
			taskId,
			status: 'completed',
			result: summary || 'Marked complete by user',
		});
		completeModal.close();
		navigateToRoom(roomId);
	};

	// Cancel task handler — throws on error so the dialog can display it
	const cancelTask = async () => {
		await request('task.cancel', { roomId, taskId });
		cancelModal.close();
		navigateToRoom(roomId);
	};

	// Build dropdown menu items for task actions
	const dropdownItems: DropdownMenuItem[] = [];
	if (canComplete) {
		dropdownItems.push({
			label: 'Mark as Complete',
			icon: (
				<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
			),
			onClick: () => completeModal.open(),
		});
	}
	if (canCancel) {
		if (canComplete) {
			dropdownItems.push({ type: 'divider' });
		}
		dropdownItems.push({
			label: 'Cancel Task',
			icon: (
				<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			),
			danger: true,
			onClick: () => cancelModal.open(),
		});
	}

	// Interrupt button shown only when task has active agent sessions
	const canInterrupt = task.status === 'in_progress' || task.status === 'review';
	const [interrupting, setInterrupting] = useState(false);

	// Interrupt handler - stops LLM generation without changing task status
	const interruptSession = async () => {
		if (interrupting) return;
		setInterrupting(true);
		try {
			await request('task.interruptSession', { roomId, taskId });
		} catch (err) {
			// Best-effort: ignore errors from interrupt (session may already be idle)
			void err;
		} finally {
			setInterrupting(false);
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
						{/* PR link — shown for all statuses once the PR has been created */}
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
				{/* Interrupt button - stops LLM generation without changing task status */}
				{canInterrupt && (
					<button
						class="p-1.5 rounded text-amber-400 hover:text-amber-300 hover:bg-dark-700 transition-colors disabled:opacity-50"
						onClick={interruptSession}
						title="Interrupt generation (task stays active, type your suggestions)"
						disabled={interrupting}
					>
						<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
							<rect x="6" y="6" width="12" height="12" rx="1" />
						</svg>
					</button>
				)}
				{/* Task options dropdown — shown when at least one action is available */}
				{dropdownItems.length > 0 && (
					<Dropdown
						position="right"
						trigger={
							<button
								class="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-dark-700 transition-colors"
								title="Task options"
								data-testid="task-options-menu"
							>
								<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
									<circle cx="12" cy="5" r="2" />
									<circle cx="12" cy="12" r="2" />
									<circle cx="12" cy="19" r="2" />
								</svg>
							</button>
						}
						items={dropdownItems}
					/>
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
			{group?.submittedForReview && (
				<HeaderReviewBar
					roomId={roomId}
					taskId={taskId}
					task={task}
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
											: task.status === 'needs_attention'
												? 'This task needs attention.'
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

			{/* Human input area (always visible) */}
			<HumanInputArea
				hasGroup={group !== null}
				roomId={roomId}
				taskId={taskId}
				onMessageSentWithReload={() => setConversationKey((k) => k + 1)}
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
		</div>
	);
}
