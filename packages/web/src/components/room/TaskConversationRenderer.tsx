/**
 * TaskConversationRenderer
 *
 * Renders a flat chronological conversation timeline for a task group.
 * Uses pagination to load messages efficiently:
 * - Initial load: fetches the newest N messages (default 50)
 * - "Load older" button at the top to load more history
 * - Real-time updates via state.groupMessages.delta events
 *
 * Each message is rendered inline with a thin colored left border indicating
 * which agent produced it. Role transitions show a small divider label.
 *
 * Subscribes to state.groupMessages.delta on channel group:{groupId} for
 * real-time updates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useMessageHub } from '../../hooks/useMessageHub';
import {
	useSessionQuestionState,
	type SessionQuestionState,
} from '../../hooks/useSessionQuestionState';
import { SDKMessageRenderer } from '../sdk/SDKMessageRenderer';
import { useMessageMaps } from '../../hooks/useMessageMaps';

/** Empty question state used as a safe fallback for messages with unknown session IDs */
const NO_OP_QUESTION_STATE: SessionQuestionState = {
	pendingQuestion: null,
	resolvedQuestions: new Map(),
	onQuestionResolved: () => {},
};

interface TaskMeta {
	authorRole: 'planner' | 'coder' | 'general' | 'leader' | 'craft' | 'lead' | 'human' | 'system';
	authorSessionId: string;
	turnId: string;
	iteration: number;
}

interface GroupMessage {
	id: number;
	groupId: string;
	sessionId: string | null;
	role: string;
	messageType: string;
	content: string;
	createdAt: number;
}

interface TaskConversationRendererProps {
	groupId: string;
	/** Session ID of the leader agent (used to render AskUserQuestion as interactive forms) */
	leaderSessionId?: string;
	/** Session ID of the worker agent (used to render AskUserQuestion as interactive forms) */
	workerSessionId?: string;
	/** Called whenever the message list length changes, so the parent can drive autoscroll */
	onMessageCountChange?: (count: number) => void;
}

const ROLE_COLORS: Record<string, { border: string; label: string; labelColor: string }> = {
	planner: { border: 'border-l-teal-500', label: 'Planner', labelColor: 'text-teal-400' },
	coder: { border: 'border-l-blue-500', label: 'Coder', labelColor: 'text-blue-400' },
	general: { border: 'border-l-slate-400', label: 'General', labelColor: 'text-slate-400' },
	leader: { border: 'border-l-purple-500', label: 'Leader', labelColor: 'text-purple-400' },
	human: { border: 'border-l-green-500', label: 'Human', labelColor: 'text-green-400' },
	system: { border: 'border-l-transparent', label: '', labelColor: 'text-gray-500' },
	craft: { border: 'border-l-blue-500', label: 'Craft', labelColor: 'text-blue-400' },
	lead: { border: 'border-l-purple-500', label: 'Lead', labelColor: 'text-purple-400' },
};

function parseGroupMessage(msg: GroupMessage): SDKMessage | null {
	// Status messages are plain text, not JSON
	if (msg.messageType === 'status') {
		return {
			type: 'status',
			text: msg.content,
			_taskMeta: {
				authorRole: 'system',
				authorSessionId: '',
				turnId: `status-${msg.id}`,
				iteration: 0,
			},
		} as unknown as SDKMessage;
	}

	// Leader summary messages are plain text with distinct rendering
	if (msg.messageType === 'leader_summary') {
		return {
			type: 'leader_summary',
			text: msg.content,
			_taskMeta: {
				authorRole: 'system',
				authorSessionId: '',
				turnId: `leader-summary-${msg.id}`,
				iteration: 0,
			},
		} as unknown as SDKMessage;
	}
	try {
		return JSON.parse(msg.content) as SDKMessage;
	} catch {
		return null;
	}
}

function getTaskMeta(msg: SDKMessage): TaskMeta | null {
	const meta = (msg as SDKMessage & { _taskMeta?: TaskMeta })._taskMeta;
	return meta ?? null;
}

/**
 * Returns a stable deduplication key for a message.
 * Agent messages use their uuid; status messages use _taskMeta.turnId as a fallback.
 * Returns null for messages with no identifiable key (they pass through unfiltered).
 */
function getMessageId(msg: SDKMessage): string | null {
	const uuid = (msg as SDKMessage & { uuid?: string }).uuid;
	if (uuid) return uuid;
	return getTaskMeta(msg)?.turnId ?? null;
}

const PAGE_SIZE = 50;

export function TaskConversationRenderer({
	groupId,
	leaderSessionId,
	workerSessionId,
	onMessageCountChange,
}: TaskConversationRendererProps) {
	const { request, joinRoom, leaveRoom, onEvent } = useMessageHub();

	// Subscribe to question state for each agent session so AskUserQuestion
	// renders as an interactive form rather than a plain message
	const leaderQuestionState = useSessionQuestionState(leaderSessionId);
	const workerQuestionState = useSessionQuestionState(workerSessionId);
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [hasOlder, setHasOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Incremented to trigger a retry of the initial fetch
	const [retryKey, setRetryKey] = useState(0);
	// Track the oldest cursor for loading older messages
	const oldestCursorRef = useRef<string | null>(null);
	// Refs for useCallback guards (avoids recreating callback on state changes)
	const loadingOlderRef = useRef(false);
	const hasOlderRef = useRef(false);
	// Tracks every message ID (uuid or turnId) added to state, enabling deduplication
	// across: the initial fetch, buffered pre-fetch deltas, and live post-fetch deltas
	// (e.g. replays on WebSocket reconnect).
	const seenIdsRef = useRef<Set<string>>(new Set());
	// Guards the fetch/delta race: deltas received while the fetch is in-flight are
	// buffered here and merged (with dedup) once the fetch resolves.
	const fetchingRef = useRef(true);
	const pendingDeltasRef = useRef<SDKMessage[]>([]);

	useEffect(() => {
		const channel = `group:${groupId}`;
		joinRoom(channel);
		seenIdsRef.current.clear();
		fetchingRef.current = true;
		pendingDeltasRef.current = [];
		oldestCursorRef.current = null;
		loadingOlderRef.current = false;
		hasOlderRef.current = false;
		setError(null);
		let cancelled = false;

		// Subscribe first so no live messages can slip through before the fetch starts.
		const unsub = onEvent<{ added: SDKMessage[]; timestamp: number }>(
			'state.groupMessages.delta',
			(event) => {
				if (event.added && event.added.length > 0) {
					if (fetchingRef.current) {
						// Buffer deltas that arrive while the initial fetch is in-flight.
						pendingDeltasRef.current = [...pendingDeltasRef.current, ...event.added];
					} else {
						// Deduplicate against seenIds — handles replays on reconnect and
						// the same event firing twice within the buffer.
						const newMessages = event.added.filter((m) => {
							const id = getMessageId(m);
							if (id && seenIdsRef.current.has(id)) return false;
							if (id) seenIdsRef.current.add(id);
							return true;
						});
						if (newMessages.length > 0) {
							setMessages((prev) => [...prev, ...newMessages]);
						}
					}
				}
			}
		);

		const fetchInitialMessages = async () => {
			try {
				const res: {
					messages: GroupMessage[];
					hasMore: boolean;
					nextCursor: string | null;
					hasOlder: boolean;
					oldestCursor: string | null;
				} = await request('task.getGroupMessages', {
					groupId,
					limit: PAGE_SIZE,
				});

				if (!cancelled) {
					// Merge fetched messages with buffered deltas.
					const parsed = res.messages
						.map(parseGroupMessage)
						.filter((m): m is SDKMessage => m !== null);

					const uniqueParsed = parsed.filter((m) => {
						const id = getMessageId(m);
						if (id && seenIdsRef.current.has(id)) return false;
						if (id) seenIdsRef.current.add(id);
						return true;
					});

					// Merge buffered deltas, deduplicating against seenIds.
					const newDeltas = pendingDeltasRef.current.filter((m) => {
						const id = getMessageId(m);
						if (id && seenIdsRef.current.has(id)) return false;
						if (id) seenIdsRef.current.add(id);
						return true;
					});

					if (uniqueParsed.length > 0 || newDeltas.length > 0) {
						setMessages([...uniqueParsed, ...newDeltas]);
					}
					setHasOlder(res.hasOlder);
					hasOlderRef.current = res.hasOlder;
					oldestCursorRef.current = res.oldestCursor;
					fetchingRef.current = false;
					pendingDeltasRef.current = [];
					setLoading(false);
				}
			} catch (err) {
				if (!cancelled) {
					// On fetch failure, still surface any buffered deltas
					const newDeltas = pendingDeltasRef.current.filter((m) => {
						const id = getMessageId(m);
						if (id && seenIdsRef.current.has(id)) return false;
						if (id) seenIdsRef.current.add(id);
						return true;
					});
					if (newDeltas.length > 0) {
						setMessages([...newDeltas]);
					}
					fetchingRef.current = false;
					pendingDeltasRef.current = [];
					setLoading(false);
					setError(err instanceof Error ? err.message : 'Failed to load messages');
				}
			}
		};

		fetchInitialMessages();

		return () => {
			cancelled = true;
			unsub();
			leaveRoom(channel);
		};
	}, [groupId, retryKey, joinRoom, leaveRoom, onEvent, request]);

	const retryInitialFetch = useCallback(() => {
		setRetryKey((k) => k + 1);
	}, []);

	const loadOlderMessages = useCallback(async () => {
		// Use refs for guards to avoid recreating callback on state changes
		if (loadingOlderRef.current || !hasOlderRef.current || !oldestCursorRef.current) return;

		loadingOlderRef.current = true;
		setLoadingOlder(true);
		setError(null); // Clear previous errors on retry
		try {
			const res: {
				messages: GroupMessage[];
				hasMore: boolean;
				nextCursor: string | null;
				hasOlder: boolean;
				oldestCursor: string | null;
			} = await request('task.getGroupMessages', {
				groupId,
				before: oldestCursorRef.current,
				limit: PAGE_SIZE,
			});

			const parsed = res.messages.map(parseGroupMessage).filter((m): m is SDKMessage => m !== null);

			// Deduplicate and prepend to existing messages
			const uniqueParsed = parsed.filter((m) => {
				const id = getMessageId(m);
				if (id && seenIdsRef.current.has(id)) return false;
				if (id) seenIdsRef.current.add(id);
				return true;
			});

			if (uniqueParsed.length > 0) {
				setMessages((prev) => [...uniqueParsed, ...prev]);
			}
			setHasOlder(res.hasOlder);
			hasOlderRef.current = res.hasOlder;
			oldestCursorRef.current = res.oldestCursor;
		} catch (err) {
			// Show error feedback to user
			setError(err instanceof Error ? err.message : 'Failed to load older messages');
		} finally {
			loadingOlderRef.current = false;
			setLoadingOlder(false);
		}
	}, [groupId, request]);

	// Notify parent when message count changes so it can drive autoscroll
	useEffect(() => {
		onMessageCountChange?.(messages.length);
	}, [messages.length, onMessageCountChange]);

	const maps = useMessageMaps(messages, groupId);

	// Track role transitions to insert dividers
	const roleTransitions = useMemo(() => {
		const transitions = new Set<number>();
		let lastRole: string | null = null;
		for (let i = 0; i < messages.length; i++) {
			const meta = getTaskMeta(messages[i]);
			const role = meta?.authorRole ?? 'system';
			if (role !== 'system' && lastRole !== null && role !== lastRole) {
				transitions.add(i);
			}
			if (role !== 'system') lastRole = role;
		}
		return transitions;
	}, [messages]);

	if (loading) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<p class="text-gray-400 text-sm">Loading conversation…</p>
			</div>
		);
	}

	if (messages.length === 0 && error) {
		return (
			<div class="flex-1 flex flex-col items-center justify-center gap-2">
				<p class="text-red-400 text-sm">{error}</p>
				<button
					class="text-xs text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded bg-dark-800 hover:bg-dark-700 transition-colors"
					onClick={retryInitialFetch}
				>
					Retry
				</button>
			</div>
		);
	}

	if (messages.length === 0) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<p class="text-gray-500 text-sm">Waiting for agent activity…</p>
			</div>
		);
	}

	return (
		<div class="px-4 py-3 space-y-0.5">
			{/* Load older messages button */}
			{hasOlder && (
				<div class="flex flex-col items-center gap-2 py-2">
					{error && <p class="text-xs text-red-400">{error}</p>}
					<button
						class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 px-3 py-1.5 rounded bg-dark-800 hover:bg-dark-700 transition-colors"
						onClick={loadOlderMessages}
						disabled={loadingOlder}
					>
						{loadingOlder ? 'Loading…' : 'Load older messages'}
					</button>
				</div>
			)}
			{messages.map((msg, i) => {
				const meta = getTaskMeta(msg);
				const role = meta?.authorRole ?? 'system';
				const style = ROLE_COLORS[role] ?? ROLE_COLORS.system;
				const key = (msg as SDKMessage & { uuid?: string }).uuid ?? `msg-${groupId}-${i}`;

				// Status messages: render as centered dividers
				const raw = msg as Record<string, unknown>;
				if (raw.type === 'status') {
					const statusText = typeof raw.text === 'string' ? raw.text : 'Status update';
					return (
						<div key={key} class="flex items-center gap-3 py-1.5">
							<div class="flex-1 h-px bg-dark-700" />
							<span class="text-xs text-gray-500 whitespace-nowrap">{statusText}</span>
							<div class="flex-1 h-px bg-dark-700" />
						</div>
					);
				}

				// Leader summary messages: render as a context card
				if (raw.type === 'leader_summary') {
					const rawText = typeof raw.text === 'string' ? raw.text : '';
					const summaryText = rawText.startsWith('[Turn Summary] ')
						? rawText.slice('[Turn Summary] '.length)
						: rawText;
					return (
						<div
							key={key}
							class="my-1.5 rounded border border-purple-800/40 bg-purple-950/20 px-3 py-2"
						>
							<div class="flex items-center gap-1.5 mb-1">
								<svg
									class="w-3 h-3 text-purple-400 flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
									/>
								</svg>
								<span class="text-xs font-medium text-purple-400">Turn Summary</span>
							</div>
							<p class="text-xs text-gray-300 leading-relaxed">{summaryText}</p>
						</div>
					);
				}

				// Insert a role transition divider when the agent changes
				const showTransition = roleTransitions.has(i);

				// Look up the question state for the session that authored this message.
				// Fall back to a no-op state for messages whose authorSessionId does not
				// match either known session, to avoid rendering incorrect question forms.
				const authorSessionId = meta?.authorSessionId;
				let questionState: SessionQuestionState = NO_OP_QUESTION_STATE;
				if (authorSessionId && leaderSessionId && authorSessionId === leaderSessionId) {
					questionState = leaderQuestionState;
				} else if (authorSessionId && workerSessionId && authorSessionId === workerSessionId) {
					questionState = workerQuestionState;
				}

				return (
					<div key={key}>
						{showTransition && (
							<div class="flex items-center gap-2 py-1.5 mt-1">
								<div class="flex-1 h-px bg-dark-700" />
								<span
									class={`text-[10px] font-semibold uppercase tracking-wide ${style.labelColor}`}
								>
									{style.label}
								</span>
								<div class="flex-1 h-px bg-dark-700" />
							</div>
						)}
						<div class={`border-l-2 ${style.border} pl-3`}>
							<SDKMessageRenderer
								message={msg}
								toolResultsMap={maps.toolResultsMap}
								toolInputsMap={maps.toolInputsMap}
								subagentMessagesMap={maps.subagentMessagesMap}
								sessionId={authorSessionId || undefined}
								pendingQuestion={questionState.pendingQuestion}
								resolvedQuestions={questionState.resolvedQuestions}
								onQuestionResolved={questionState.onQuestionResolved}
								taskContext
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
