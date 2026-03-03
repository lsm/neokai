/**
 * TaskConversationRenderer
 *
 * Renders a flat conversation timeline for a task group.
 * Messages are fetched from session_group_messages via task.getGroupMessages RPC
 * and grouped by turn (using _taskMeta.turnId).
 *
 * Each turn is rendered with a colored left border and a small header showing
 * the agent name and turn number. All messages are always visible (no collapse).
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

interface TurnGroup {
	turnId: string;
	authorRole: string;
	iteration: number;
	messages: SDKMessage[];
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
}

const ROLE_STYLES: Record<string, { border: string; label: string; labelColor: string }> = {
	planner: {
		border: 'border-l-teal-500',
		label: 'Planner',
		labelColor: 'text-teal-400',
	},
	coder: {
		border: 'border-l-blue-500',
		label: 'Coder',
		labelColor: 'text-blue-400',
	},
	general: {
		border: 'border-l-slate-400',
		label: 'General',
		labelColor: 'text-slate-400',
	},
	leader: {
		border: 'border-l-purple-500',
		label: 'Leader',
		labelColor: 'text-purple-400',
	},
	human: {
		border: 'border-l-green-500',
		label: 'Task Prompt',
		labelColor: 'text-green-400',
	},
	system: {
		border: '',
		label: '',
		labelColor: 'text-gray-500',
	},
	// Backward compat for messages already in DB from before the rename
	craft: {
		border: 'border-l-blue-500',
		label: 'Craft',
		labelColor: 'text-blue-400',
	},
	lead: {
		border: 'border-l-purple-500',
		label: 'Lead',
		labelColor: 'text-purple-400',
	},
};

function parseGroupMessage(msg: GroupMessage): SDKMessage | null {
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

function getSystemText(messages: SDKMessage[]): string | null {
	for (const msg of messages) {
		const raw = msg as Record<string, unknown>;
		if (raw.type === 'user' && raw.message) {
			const m = raw.message as Record<string, unknown>;
			if (Array.isArray(m.content)) {
				for (const block of m.content) {
					const b = block as Record<string, unknown>;
					if (b.type === 'text' && typeof b.text === 'string') return b.text;
				}
			}
		}
	}
	return null;
}

function countToolUses(messages: SDKMessage[]): number {
	let count = 0;
	for (const msg of messages) {
		const raw = msg as Record<string, unknown>;
		if (raw.type !== 'assistant') continue;
		const m = raw.message as Record<string, unknown> | undefined;
		if (!m || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if ((block as Record<string, unknown>).type === 'tool_use') count++;
		}
	}
	return count;
}

/**
 * Group consecutive messages by turnId.
 */
function groupMessagesByTurn(messages: SDKMessage[]): TurnGroup[] {
	const groups: TurnGroup[] = [];
	let currentGroup: TurnGroup | null = null;

	for (const msg of messages) {
		const meta = getTaskMeta(msg);
		const turnId = meta?.turnId ?? 'unknown';
		const authorRole = meta?.authorRole ?? 'system';
		const iteration = meta?.iteration ?? 0;

		if (!currentGroup || currentGroup.turnId !== turnId) {
			currentGroup = { turnId, authorRole, iteration, messages: [] };
			groups.push(currentGroup);
		}

		currentGroup.messages.push(msg);
	}

	return groups;
}

export function TaskConversationRenderer({ groupId }: TaskConversationRendererProps) {
	const { request, joinRoom, leaveRoom, onEvent } = useMessageHub();
	const [messages, setMessages] = useState<SDKMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const channel = `group:${groupId}`;
		joinRoom(channel);

		const fetchMessages = async () => {
			try {
				const res = await request<{ messages: GroupMessage[] }>('task.getGroupMessages', {
					groupId,
				});
				const parsed = res.messages
					.map(parseGroupMessage)
					.filter((m): m is SDKMessage => m !== null);
				setMessages(parsed);
			} catch {
				// Non-fatal: group may not have messages yet
			} finally {
				setLoading(false);
			}
		};

		fetchMessages();

		const unsub = onEvent<{ added: SDKMessage[]; timestamp: number }>(
			'state.groupMessages.delta',
			(event) => {
				if (event.added && event.added.length > 0) {
					setMessages((prev) => [...prev, ...event.added]);
					requestAnimationFrame(() => {
						scrollRef.current?.scrollTo({
							top: scrollRef.current.scrollHeight,
							behavior: 'smooth',
						});
					});
				}
			}
		);

		return () => {
			unsub();
			leaveRoom(channel);
		};
	}, [groupId]);

	const turnGroups = useMemo(() => groupMessagesByTurn(messages), [messages]);
	const maps = useMessageMaps(messages, groupId);

	// Assign sequential turn numbers per role
	const turnNumbers = useMemo(() => {
		const counters: Record<string, number> = {};
		const result = new Map<string, number>();
		for (const group of turnGroups) {
			if (group.authorRole === 'system' || group.authorRole === 'human') continue;
			const role = group.authorRole;
			counters[role] = (counters[role] ?? 0) + 1;
			result.set(group.turnId, counters[role]);
		}
		return result;
	}, [turnGroups]);

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
		<div ref={scrollRef} class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
			{turnGroups.map((group) => {
				const style = ROLE_STYLES[group.authorRole] ?? ROLE_STYLES.system;

				// System messages: render as centered dividers
				if (group.authorRole === 'system') {
					const text = getSystemText(group.messages);
					return (
						<div key={group.turnId} class="flex items-center gap-3 py-1.5">
							<div class="flex-1 h-px bg-dark-700" />
							<span class="text-xs text-gray-500 whitespace-nowrap">
								{text ?? 'Status update'}
							</span>
							<div class="flex-1 h-px bg-dark-700" />
						</div>
					);
				}

				const turnNum = turnNumbers.get(group.turnId);
				const toolCount = countToolUses(group.messages);

				return (
					<div key={group.turnId} class={`border-l-2 ${style.border} bg-dark-850/50 rounded-r`}>
						{/* Turn header — always visible, not clickable */}
						<div class="flex items-center gap-2 px-3 py-1.5">
							<span class={`text-xs font-semibold uppercase tracking-wide ${style.labelColor}`}>
								{style.label}
							</span>
							{turnNum != null && (
								<span class="text-[10px] text-gray-600">#{turnNum}</span>
							)}
							{group.iteration > 0 && (
								<span class="text-[10px] text-gray-600">
									iter {group.iteration}
								</span>
							)}
							{toolCount > 0 && (
								<span class="text-[10px] text-gray-600">
									{toolCount} tool{toolCount !== 1 ? 's' : ''}
								</span>
							)}
						</div>

						{/* All messages — always expanded */}
						<div class="px-3 pb-2 space-y-1">
							{group.messages.map((msg) => (
								<SDKMessageRenderer
									key={(msg as SDKMessage & { uuid?: string }).uuid ?? Math.random().toString()}
									message={msg}
									toolResultsMap={maps.toolResultsMap}
									toolInputsMap={maps.toolInputsMap}
									subagentMessagesMap={maps.subagentMessagesMap}
								/>
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}
