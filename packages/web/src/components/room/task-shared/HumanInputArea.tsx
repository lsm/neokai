import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useMessageHub } from '../../../hooks/useMessageHub';
import { useTaskInputDraft } from '../../../hooks/useTaskInputDraft';
import { InputTextarea } from '../../InputTextarea';

type HumanMessageTarget = 'worker' | 'leader';

export interface HumanInputAreaProps {
	hasGroup: boolean;
	taskStatus: string;
	roomId: string;
	taskId: string;
	leaderSessionId?: string;
	workerSessionId?: string;
}

interface QueuedOverlayMessage {
	dbId: string;
	uuid: string;
	text: string;
	timestamp: number;
	status: 'deferred' | 'enqueued' | 'consumed';
}

const TARGET_LABELS: Record<HumanMessageTarget, string> = {
	worker: 'Worker',
	leader: 'Leader',
};

export function HumanInputArea({
	hasGroup,
	taskStatus,
	roomId,
	taskId,
	leaderSessionId,
	workerSessionId,
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
	const [queuedForCurrentTurn, setQueuedForCurrentTurn] = useState<QueuedOverlayMessage[]>([]);
	const [queuedForNextTurn, setQueuedForNextTurn] = useState<QueuedOverlayMessage[]>([]);
	const menuRef = useRef<HTMLDivElement>(null);
	const isTouchDeviceRef = useRef(false);
	const isMountedRef = useRef(true);
	const queueRequestVersionRef = useRef(0);

	useEffect(() => {
		isTouchDeviceRef.current =
			window.matchMedia('(pointer: coarse)').matches ||
			('ontouchstart' in window && window.innerWidth < 768);
	}, []);

	useEffect(() => {
		return () => {
			isMountedRef.current = false;
			queueRequestVersionRef.current += 1;
		};
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

	const isArchived = taskStatus === 'archived';
	const canReactivateWithMessage = taskStatus === 'completed' || taskStatus === 'cancelled';
	const canSend = !isArchived && (hasGroup || canReactivateWithMessage);
	const targetSessionId = target === 'leader' ? leaderSessionId : workerSessionId;

	const refreshQueuedMessages = useCallback(async () => {
		const requestVersion = ++queueRequestVersionRef.current;
		if (!hasGroup || !targetSessionId) {
			if (!isMountedRef.current || requestVersion !== queueRequestVersionRef.current) {
				return;
			}
			setQueuedForCurrentTurn([]);
			setQueuedForNextTurn([]);
			return;
		}

		try {
			const [enqueuedResponse, deferredResponse] = (await Promise.all([
				request('session.messages.byStatus', {
					sessionId: targetSessionId,
					status: 'enqueued',
					limit: 20,
				}),
				request('session.messages.byStatus', {
					sessionId: targetSessionId,
					status: 'deferred',
					limit: 20,
				}),
			])) as [{ messages?: QueuedOverlayMessage[] }, { messages?: QueuedOverlayMessage[] }];

			if (!isMountedRef.current || requestVersion !== queueRequestVersionRef.current) {
				return;
			}

			setQueuedForCurrentTurn(enqueuedResponse.messages ?? []);
			setQueuedForNextTurn(deferredResponse.messages ?? []);
		} catch {
			// Best-effort queue refresh.
		}
	}, [hasGroup, request, targetSessionId]);

	useEffect(() => {
		void refreshQueuedMessages();
	}, [refreshQueuedMessages]);

	useEffect(() => {
		if (!hasGroup || (queuedForCurrentTurn.length === 0 && queuedForNextTurn.length === 0)) {
			return;
		}
		const timer = setInterval(() => {
			void refreshQueuedMessages();
		}, 700);
		return () => clearInterval(timer);
	}, [hasGroup, queuedForCurrentTurn.length, queuedForNextTurn.length, refreshQueuedMessages]);

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
			await refreshQueuedMessages();
		} catch (err) {
			setInputError(err instanceof Error ? err.message : 'Failed to send message');
		} finally {
			setSending(false);
		}
	};

	const targetLabel = target === 'leader' ? 'leader' : 'worker';
	const placeholder = isArchived
		? 'Archived tasks cannot receive messages.'
		: canReactivateWithMessage && !hasGroup
			? 'Send a message to reactivate this task…'
			: !hasGroup
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
			{(queuedForCurrentTurn.length > 0 || queuedForNextTurn.length > 0) && canSend && (
				<div class="flex flex-col items-end gap-1.5" data-testid="queue-overlay">
					{queuedForCurrentTurn.slice(0, 3).map((queued, index) => (
						<div
							key={queued.dbId}
							class="pointer-events-none inline-flex max-w-[22rem] items-center gap-2 rounded-full border border-dark-600/80 bg-dark-900/85 px-3 py-1 text-xs text-gray-200 backdrop-blur-sm"
							data-testid="queued-current-turn-bubble"
						>
							<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
							<span class="truncate">
								{index === 0 && <span class="mr-1 text-amber-300">Now</span>}
								{queued.text}
							</span>
						</div>
					))}
					{queuedForNextTurn.slice(0, 3).map((queued, index) => (
						<div
							key={queued.dbId}
							class="pointer-events-none inline-flex max-w-[22rem] items-center gap-2 rounded-full border border-dark-600/80 bg-dark-900/85 px-3 py-1 text-xs text-gray-200 backdrop-blur-sm"
							data-testid="queued-next-turn-bubble"
						>
							<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
							<span class="truncate">
								{index === 0 && <span class="mr-1 text-blue-300">Next</span>}
								{queued.text}
							</span>
						</div>
					))}
					{queuedForCurrentTurn.length > 3 && (
						<p class="pointer-events-none text-xs text-amber-200/80">
							+{queuedForCurrentTurn.length - 3} more pending
						</p>
					)}
					{queuedForNextTurn.length > 3 && (
						<p class="pointer-events-none text-xs text-blue-200/80">
							+{queuedForNextTurn.length - 3} more deferred
						</p>
					)}
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
			{canReactivateWithMessage && !hasGroup && (
				<p class="text-xs text-amber-500/80">Sending a message will reactivate this task.</p>
			)}
			{!canSend && !canReactivateWithMessage && (
				<p class="text-xs text-gray-500">
					{isArchived
						? 'Archived tasks cannot receive messages.'
						: 'No active group to receive messages yet.'}
				</p>
			)}
			{inputError && <p class="text-xs text-red-400">{inputError}</p>}
		</div>
	);
}
