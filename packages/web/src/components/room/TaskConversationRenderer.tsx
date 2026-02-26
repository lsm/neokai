/**
 * TaskConversationRenderer
 *
 * Renders a unified conversation timeline for a task group.
 * Messages are fetched from session_group_messages via task.getGroupMessages RPC
 * and grouped by turn (using _taskMeta.turnId + _taskMeta.authorRole).
 *
 * Each turn is rendered as a collapsible block with a colored left border:
 * - Planner: teal border
 * - Coder: blue border
 * - General: slate border
 * - Leader: purple border
 * - System: gray centered divider
 *
 * Subscribes to state.groupMessages.delta on channel group:{groupId} for
 * real-time updates.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { isSDKAssistantMessage } from '@neokai/shared/sdk/type-guards';
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
		label: 'Human',
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

/**
 * Parse a group message's content JSON into an SDKMessage with _taskMeta.
 */
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

/**
 * Extract a short summary from the first text block of an assistant message.
 */
function getMessagePreview(messages: SDKMessage[]): string | null {
	for (const msg of messages) {
		if (!isSDKAssistantMessage(msg)) continue;
		const content = msg.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as Record<string, unknown>;
			if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
				return b.text.length > 120 ? b.text.slice(0, 120) + '…' : b.text;
			}
		}
	}
	return null;
}

/**
 * Count tool uses across all messages in a turn.
 */
function countToolUses(messages: SDKMessage[]): number {
	let count = 0;
	for (const msg of messages) {
		if (!isSDKAssistantMessage(msg)) continue;
		const content = msg.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if ((block as Record<string, unknown>).type === 'tool_use') count++;
		}
	}
	return count;
}

/**
 * Group messages by turn using _taskMeta.turnId alone.
 * turnId is deterministic: `turn_{groupId}_{iteration}_{shortSessionId}`
 * so it uniquely identifies each agent's turn without needing authorRole in the key.
 * Messages without _taskMeta are placed in an 'unknown' group.
 */
function groupMessagesByTurn(messages: SDKMessage[]): TurnGroup[] {
	const groups: TurnGroup[] = [];
	let currentGroup: TurnGroup | null = null;

	for (const msg of messages) {
		const meta = getTaskMeta(msg);
		const turnId = meta?.turnId ?? 'unknown';
		const authorRole = meta?.authorRole ?? 'system';
		const iteration = meta?.iteration ?? 0;

		// Start a new group when turnId changes
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
	const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);

	// Fetch initial messages and subscribe to updates
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

		// Subscribe to real-time message deltas
		const unsub = onEvent<{ added: SDKMessage[]; timestamp: number }>(
			'state.groupMessages.delta',
			(event) => {
				if (event.added && event.added.length > 0) {
					setMessages((prev) => [...prev, ...event.added]);
					// Auto-scroll to bottom on new messages
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

	// Group messages by turn
	const turnGroups = useMemo(() => groupMessagesByTurn(messages), [messages]);

	// Compute message maps for tool result rendering
	const maps = useMessageMaps(messages, groupId);

	// Auto-collapse previous turns when new ones arrive
	useEffect(() => {
		if (turnGroups.length > 1) {
			const toCollapse = new Set<string>();
			// Collapse all turns except the last one
			for (let i = 0; i < turnGroups.length - 1; i++) {
				toCollapse.add(turnGroups[i].turnId);
			}
			setCollapsedTurns(toCollapse);
		}
	}, [turnGroups.length]);

	const toggleTurn = (turnKey: string) => {
		setCollapsedTurns((prev) => {
			const next = new Set(prev);
			if (next.has(turnKey)) {
				next.delete(turnKey);
			} else {
				next.add(turnKey);
			}
			return next;
		});
	};

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
				const isCollapsed = collapsedTurns.has(group.turnId);

				// System messages: render as centered dividers
				if (group.authorRole === 'system') {
					return (
						<div key={group.turnId} class="flex items-center gap-3 py-1.5">
							<div class="flex-1 h-px bg-dark-700" />
							<span class="text-xs text-gray-500 whitespace-nowrap">
								{getMessagePreview(group.messages) ?? 'Status update'}
							</span>
							<div class="flex-1 h-px bg-dark-700" />
						</div>
					);
				}

				const toolCount = countToolUses(group.messages);
				const preview = isCollapsed ? getMessagePreview(group.messages) : null;

				return (
					<div key={group.turnId} class={`border-l-2 ${style.border} bg-dark-850/50 rounded-r`}>
						{/* Turn header */}
						<button
							type="button"
							class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-dark-800/50 transition-colors"
							onClick={() => toggleTurn(group.turnId)}
						>
							<span class="text-[10px] text-gray-600 select-none">{isCollapsed ? '▶' : '▼'}</span>
							<span class={`text-xs font-semibold uppercase tracking-wide ${style.labelColor}`}>
								{style.label}
							</span>
							{group.iteration > 0 && (
								<span class="text-[10px] text-gray-600">iteration {group.iteration}</span>
							)}
							{toolCount > 0 && (
								<span class="text-[10px] text-gray-600">
									{toolCount} tool{toolCount !== 1 ? 's' : ''}
								</span>
							)}
							{isCollapsed && preview && (
								<span class="text-xs text-gray-500 truncate ml-1 flex-1 text-left">{preview}</span>
							)}
						</button>

						{/* Turn messages */}
						{!isCollapsed && (
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
						)}
					</div>
				);
			})}
		</div>
	);
}
