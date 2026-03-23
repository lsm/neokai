/**
 * useTurnBlocks Hook
 *
 * Consumes a flat SessionGroupMessage[] from useGroupMessages, parses each message
 * via parseGroupMessage(), and groups them into structured TurnBlock items with stats.
 *
 * Handles multi-agent interleaving: a new turn starts whenever authorSessionId changes
 * from the previous non-runtime message. Runtime messages (status, rate_limited,
 * model_fallback, leader_summary — identified by authorRole === 'system') appear as
 * RuntimeMessage items inline between turn blocks.
 */

import { useMemo } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import {
	parseGroupMessage,
	type ParsedGroupMessage,
	type TaskMeta,
} from '../lib/parse-group-message';
import { ROLE_COLORS } from '../lib/task-constants';
import type { SessionGroupMessage } from './useGroupMessages';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TurnBlock {
	/** Stable turn identifier: the first message's UUID, or `${sessionId}-${startTime}` fallback. */
	id: string;
	/** authorSessionId from _taskMeta of the first message in the turn. */
	sessionId: string;
	/** authorRole from _taskMeta (e.g. 'leader', 'coder', 'human'). */
	agentRole: string;
	/** Plain role label from ROLE_COLORS (e.g. 'Leader', 'Coder'). Does NOT include model name. */
	agentLabel: string;
	/** createdAt / timestamp of the first message in this turn. */
	startTime: number;
	/**
	 * Timestamp of the last message in this turn.
	 * null when the turn is still actively receiving messages (isActive === true).
	 */
	endTime: number | null;
	/** Total number of parsed messages in this turn. */
	messageCount: number;
	/** Count of tool_use content blocks across all assistant messages in this turn. */
	toolCallCount: number;
	/** Count of thinking content blocks across all assistant messages in this turn. */
	thinkingCount: number;
	/** Count of assistant-type messages in this turn. */
	assistantCount: number;
	/** Name of the most recent tool_use block, or null if none. */
	lastAction: string | null;
	/** Last message in the turn for preview rendering. */
	previewMessage: SDKMessage | null;
	/**
	 * True when this is the last turn, isAtTail is true, and no result message has been
	 * received yet (i.e. the agent is still running and endTime is null).
	 */
	isActive: boolean;
	/** True when the turn ended with an error (result message with is_error === true). */
	isError: boolean;
	/** Error text extracted from the result message, or null. */
	errorMessage: string | null;
	/** All parsed SDKMessages belonging to this turn, in order. */
	messages: SDKMessage[];
}

/** A runtime/system message that renders inline between turn blocks. */
export interface RuntimeMessage {
	type: 'runtime';
	/** The parsed SDKMessage (status, rate_limited, model_fallback, leader_summary). */
	message: SDKMessage;
	/** Position of this message in the original parsed array. */
	index: number;
}

export type TurnBlockItem = { type: 'turn'; turn: TurnBlock } | RuntimeMessage;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getTaskMeta(msg: SDKMessage): TaskMeta | null {
	const meta = (msg as ParsedGroupMessage)._taskMeta;
	return meta ?? null;
}

/** Extract the UUID from any SDK message that carries one. */
function getMessageUuid(msg: SDKMessage): string | null {
	const m = msg as { uuid?: string };
	return typeof m.uuid === 'string' ? m.uuid : null;
}

/** Timestamp attached by parseGroupMessage from the database row. */
function getMessageTimestamp(msg: SDKMessage): number {
	const m = msg as { timestamp?: number };
	return typeof m.timestamp === 'number' ? m.timestamp : 0;
}

/**
 * Count tool_use and thinking content blocks inside an assistant message.
 * Non-assistant messages contribute zero to both counters.
 */
function countAssistantBlocks(msg: SDKMessage): { toolCalls: number; thinking: number } {
	if (msg.type !== 'assistant') return { toolCalls: 0, thinking: 0 };

	type Block = { type: string };
	const assistantMsg = msg as { type: 'assistant'; message?: { content?: Block[] } };
	const content = assistantMsg.message?.content;
	if (!Array.isArray(content)) return { toolCalls: 0, thinking: 0 };

	let toolCalls = 0;
	let thinking = 0;
	for (const block of content) {
		if (block.type === 'tool_use') toolCalls++;
		if (block.type === 'thinking') thinking++;
	}
	return { toolCalls, thinking };
}

/**
 * Return the name of the last tool_use block in an assistant message, or null.
 * Used to set `lastAction` on the current turn.
 */
function extractLastToolName(msg: SDKMessage): string | null {
	if (msg.type !== 'assistant') return null;

	type Block = { type: string; name?: string };
	const assistantMsg = msg as { type: 'assistant'; message?: { content?: Block[] } };
	const content = assistantMsg.message?.content;
	if (!Array.isArray(content)) return null;

	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block.type === 'tool_use' && typeof block.name === 'string') return block.name;
	}
	return null;
}

/**
 * Check whether the message is a session-end result message with is_error=true,
 * and extract a human-readable error string if available.
 */
function extractErrorInfo(msg: SDKMessage): { isError: boolean; errorMessage: string | null } {
	if (msg.type !== 'result') {
		// Also catch assistant-level errors (e.g., billing_error surfaced before a result)
		const m = msg as { error?: string };
		if (typeof m.error === 'string') {
			return { isError: true, errorMessage: m.error };
		}
		return { isError: false, errorMessage: null };
	}

	const resultMsg = msg as { is_error?: boolean; errors?: string[]; result?: string };
	if (!resultMsg.is_error) return { isError: false, errorMessage: null };

	const errorText =
		Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0 ? resultMsg.errors[0] : null;
	return { isError: true, errorMessage: errorText };
}

/** True when the message list for a turn contains at least one result message. */
function hasResultMessage(msgs: SDKMessage[]): boolean {
	return msgs.some((m) => m.type === 'result');
}

// ---------------------------------------------------------------------------
// Accumulator type (mutable, internal)
// ---------------------------------------------------------------------------

interface TurnAccumulator {
	sessionId: string;
	agentRole: string;
	firstMsgUuid: string | null;
	startTime: number;
	msgs: SDKMessage[];
	toolCallCount: number;
	thinkingCount: number;
	assistantCount: number;
	lastAction: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Transforms a flat SessionGroupMessage[] into a structured TurnBlockItem[].
 *
 * @param messages - Raw messages from useGroupMessages. Must already be sorted by createdAt.
 * @param isAtTail - Whether these messages represent the current tail of the conversation.
 *   With LiveQuery (the current implementation of useGroupMessages), this is always true
 *   since the server delivers a complete snapshot + incremental deltas. Defaults to true.
 *   Pass false when rendering a historical view without live-streaming.
 * @returns An ordered array of TurnBlockItems (turn blocks interleaved with runtime items).
 */
export function useTurnBlocks(messages: SessionGroupMessage[], isAtTail = true): TurnBlockItem[] {
	return useMemo(() => {
		// Parse all raw messages; skip any that fail to parse.
		const parsedMessages = messages
			.map(parseGroupMessage)
			.filter((m): m is SDKMessage => m !== null);

		const items: TurnBlockItem[] = [];
		let current: TurnAccumulator | null = null;

		/** Flush the current accumulator into items as a TurnBlockItem. */
		const flushTurn = (): void => {
			if (!current) return;

			const { sessionId, agentRole, firstMsgUuid, startTime, msgs } = current;
			const lastMsg = msgs[msgs.length - 1] ?? null;
			const agentLabel = ROLE_COLORS[agentRole]?.label ?? agentRole;
			const { isError, errorMessage } = lastMsg
				? extractErrorInfo(lastMsg)
				: { isError: false, errorMessage: null };

			const id = firstMsgUuid ?? `${sessionId}-${startTime}`;

			items.push({
				type: 'turn',
				turn: {
					id,
					sessionId,
					agentRole,
					agentLabel,
					startTime,
					// endTime is set to the last message's timestamp for now; adjusted below
					// for the last turn when isAtTail is true and no result has arrived.
					endTime: lastMsg ? getMessageTimestamp(lastMsg) : null,
					messageCount: msgs.length,
					toolCallCount: current.toolCallCount,
					thinkingCount: current.thinkingCount,
					assistantCount: current.assistantCount,
					lastAction: current.lastAction,
					previewMessage: lastMsg,
					isActive: false, // adjusted after the loop
					isError,
					errorMessage,
					messages: msgs,
				},
			});

			current = null;
		};

		for (let i = 0; i < parsedMessages.length; i++) {
			const msg = parsedMessages[i];
			const meta = getTaskMeta(msg);

			// ── Runtime messages ──────────────────────────────────────────────────
			// Messages with authorRole === 'system' (status, rate_limited,
			// model_fallback, leader_summary) render inline and do not belong to any turn.
			if (!meta || meta.authorRole === 'system') {
				flushTurn();
				items.push({ type: 'runtime', message: msg, index: i });
				continue;
			}

			const { authorRole, authorSessionId } = meta;

			// ── Turn boundary: new session starts speaking ────────────────────────
			if (current && current.sessionId !== authorSessionId) {
				flushTurn();
			}

			// ── Open a new turn accumulator ───────────────────────────────────────
			if (!current) {
				current = {
					sessionId: authorSessionId,
					agentRole: authorRole,
					firstMsgUuid: getMessageUuid(msg),
					startTime: getMessageTimestamp(msg),
					msgs: [],
					toolCallCount: 0,
					thinkingCount: 0,
					assistantCount: 0,
					lastAction: null,
				};
			}

			// ── Accumulate stats ──────────────────────────────────────────────────
			const { toolCalls, thinking } = countAssistantBlocks(msg);
			current.toolCallCount += toolCalls;
			current.thinkingCount += thinking;
			if (msg.type === 'assistant') current.assistantCount++;

			const toolName = extractLastToolName(msg);
			if (toolName) current.lastAction = toolName;

			current.msgs.push(msg);
		}

		// Flush any remaining accumulator.
		flushTurn();

		// ── Post-process: active turn detection ──────────────────────────────────
		// The last turn block is "active" if:
		//   1. isAtTail is true (we are viewing the live tail of the conversation)
		//   2. The turn has NOT received a result message yet (session still running)
		//
		// When active, endTime is set to null to signal that the turn is open-ended.
		if (isAtTail && items.length > 0) {
			for (let i = items.length - 1; i >= 0; i--) {
				const item = items[i];
				if (item.type === 'turn') {
					const isStillStreaming = !hasResultMessage(item.turn.messages);
					if (isStillStreaming) {
						item.turn.endTime = null;
						item.turn.isActive = true;
					}
					break;
				}
			}
		}

		return items;
	}, [messages, messages.length, isAtTail]);
}
