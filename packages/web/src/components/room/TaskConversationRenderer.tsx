/**
 * TaskConversationRenderer
 *
 * Renders a flat chronological conversation timeline for a task group.
 * Messages are fetched via task.getGroupMessages RPC
 * with pagination to fetch ALL messages (not just the first 100).
 *
 * Each message is rendered inline with a thin colored left border indicating
 * which agent produced it. Role transitions show a small divider label.
 *
 * Subscribes to state.groupMessages.delta on channel group:{groupId} for
 * real-time updates.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useMessageHub } from '../../hooks/useMessageHub';
import { SDKMessageRenderer } from '../sdk/SDKMessageRenderer';
import { useMessageMaps } from '../../hooks/useMessageMaps';

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

export function TaskConversationRenderer({
	groupId,
	onMessageCountChange,
}: TaskConversationRendererProps) {
	const { request, joinRoom, leaveRoom, onEvent } = useMessageHub();
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [loading, setLoading] = useState(true);
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

		const fetchAllMessages = async () => {
			// Declared outside the try so partial pages are committed even if a later page errors.
			const allGroupMessages: GroupMessage[] = [];
			try {
				let cursor: string | null = null;
				let hasMore = true;

				// Paginate through all messages
				while (hasMore) {
					const res = await request<{
						messages: GroupMessage[];
						hasMore: boolean;
						nextCursor?: string | null;
					}>('task.getGroupMessages', {
						groupId,
						cursor: cursor ?? undefined,
						limit: 500,
					});
					allGroupMessages.push(...res.messages);
					hasMore = res.hasMore;
					if (res.messages.length > 0) {
						cursor = res.nextCursor ?? null;
					} else {
						break;
					}
				}
			} catch {
				// Non-fatal: partial results in allGroupMessages are still committed below
			} finally {
				if (!cancelled) {
					// Merge fetched pages (may be partial on error) with buffered deltas.
					const parsed = allGroupMessages
						.map(parseGroupMessage)
						.filter((m): m is SDKMessage => m !== null);

					const uniqueParsed = parsed.filter((m) => {
						const id = getMessageId(m);
						if (id && seenIdsRef.current.has(id)) return false;
						if (id) seenIdsRef.current.add(id);
						return true;
					});

					// Merge buffered deltas, deduplicating against seenIds.
					// This handles: pre-fetch duplicates in the buffer itself, and
					// messages already present in the fetch response (uuid or turnId match).
					const newDeltas = pendingDeltasRef.current.filter((m) => {
						const id = getMessageId(m);
						if (id && seenIdsRef.current.has(id)) return false;
						if (id) seenIdsRef.current.add(id);
						return true;
					});

					if (uniqueParsed.length > 0 || newDeltas.length > 0) {
						setMessages([...uniqueParsed, ...newDeltas]);
					}
					fetchingRef.current = false;
					pendingDeltasRef.current = [];
					setLoading(false);
				}
			}
		};

		fetchAllMessages();

		return () => {
			cancelled = true;
			unsub();
			leaveRoom(channel);
		};
	}, [groupId]);

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

	if (messages.length === 0) {
		return (
			<div class="flex-1 flex items-center justify-center">
				<p class="text-gray-500 text-sm">Waiting for agent activity…</p>
			</div>
		);
	}

	return (
		<div class="px-4 py-3 space-y-0.5">
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

				// Insert a role transition divider when the agent changes
				const showTransition = roleTransitions.has(i);

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
								taskContext
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
