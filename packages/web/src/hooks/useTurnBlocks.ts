/**
 * useTurnBlocks Hook
 *
 * Consumes a flat SessionGroupMessage[] from useGroupMessages, parses each message
 * via parseGroupMessage(), and groups them into structured TurnBlock items with stats.
 *
 * Handles multi-agent interleaving: a new turn starts whenever authorSessionId changes
 * from the previous non-runtime message. Runtime messages (status, rate_limited,
 * model_fallback, leader_summary — identified by authorRole === 'system') are buffered
 * and emitted at turn boundaries, so they never fragment a single agent's turn.
 */

import { useMemo } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { isTextBlock, type ContentBlock } from '@neokai/shared/sdk/type-guards';
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
	/** True when any message in the turn carried an error. */
	isError: boolean;
	/** Error text extracted from the first error found in the turn, or null. */
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
 * Check if an assistant message has at least one text content block.
 */
function hasTextContent(msg: SDKMessage): boolean {
	if (msg.type !== 'assistant') return false;

	const assistantMsg = msg as { type: 'assistant'; message?: { content?: ContentBlock[] } };
	const content = assistantMsg.message?.content;
	if (!Array.isArray(content)) return false;

	return content.some((block) => isTextBlock(block));
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
 * Extract error info from a single message.
 * Handles both SDKResultError (is_error=true) and SDKAssistantMessage with an error field
 * (e.g. billing_error, authentication_failed surfaced before a result message arrives).
 */
function extractErrorInfo(msg: SDKMessage): { isError: boolean; errorMessage: string | null } {
	if (msg.type === 'result') {
		const resultMsg = msg as { is_error?: boolean; errors?: string[] };
		if (!resultMsg.is_error) return { isError: false, errorMessage: null };
		const errorText =
			Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0 ? resultMsg.errors[0] : null;
		return { isError: true, errorMessage: errorText };
	}

	// Assistant-level errors (e.g. billing_error) can appear before a result message.
	const m = msg as { error?: string };
	if (typeof m.error === 'string') {
		return { isError: true, errorMessage: m.error };
	}

	return { isError: false, errorMessage: null };
}

/**
 * Scan all messages in a turn for errors. Returns the last error found so that
 * a result-level error always takes precedence over an earlier assistant-level error.
 */
function extractTurnErrorInfo(msgs: SDKMessage[]): {
	isError: boolean;
	errorMessage: string | null;
} {
	let result: { isError: boolean; errorMessage: string | null } = {
		isError: false,
		errorMessage: null,
	};
	for (const msg of msgs) {
		const info = extractErrorInfo(msg);
		if (info.isError) result = info;
	}
	return result;
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
 * Runtime messages (status, rate_limited, model_fallback, leader_summary) are
 * buffered while an agent turn is in progress and emitted only when the turn ends
 * (i.e. when a different agent starts speaking). This prevents a status update
 * arriving mid-turn from fragmenting what should be one cohesive turn block.
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
		// Runtime messages seen while a turn is open are buffered here.
		// They are emitted after the turn is flushed so that a status update
		// arriving mid-turn does not fragment the turn into two separate blocks.
		let pendingRuntime: RuntimeMessage[] = [];

		/** Flush the current accumulator, then drain any buffered runtime items. */
		const flushTurnAndRuntime = (): void => {
			if (!current) {
				// No open turn — drain any buffered runtime items immediately.
				for (const rt of pendingRuntime) {
					items.push(rt);
				}
				pendingRuntime = [];
				return;
			}

			const { sessionId, agentRole, firstMsgUuid, startTime, msgs } = current;
			const lastMsg = msgs[msgs.length - 1] ?? null;
			const agentLabel = ROLE_COLORS[agentRole]?.label ?? agentRole;
			const { isError, errorMessage } = extractTurnErrorInfo(msgs);

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

			// Emit buffered runtime messages after the turn they interrupted.
			for (const rt of pendingRuntime) {
				items.push(rt);
			}
			pendingRuntime = [];
		};

		for (let i = 0; i < parsedMessages.length; i++) {
			const msg = parsedMessages[i];
			const meta = getTaskMeta(msg);

			// ── Runtime messages ──────────────────────────────────────────────────
			// Messages with authorRole === 'system' (status, rate_limited,
			// model_fallback, leader_summary) render inline and do not belong to a turn.
			//
			// If a turn is currently open, buffer the runtime message rather than
			// flushing the turn — status updates frequently arrive mid-turn during
			// tool execution and should not fragment a cohesive agent turn.
			if (!meta || meta.authorRole === 'system') {
				if (current) {
					// Buffer: emit after the current turn is flushed.
					pendingRuntime.push({ type: 'runtime', message: msg, index: i });
				} else {
					// No open turn — emit immediately at the current position.
					items.push({ type: 'runtime', message: msg, index: i });
				}
				continue;
			}

			const { authorRole, authorSessionId } = meta;

			// ── Turn boundary: new session starts speaking ────────────────────────
			if (current && current.sessionId !== authorSessionId) {
				flushTurnAndRuntime();
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
			// Only count assistant messages that have text content
			if (msg.type === 'assistant' && hasTextContent(msg)) current.assistantCount++;

			const toolName = extractLastToolName(msg);
			if (toolName) current.lastAction = toolName;

			current.msgs.push(msg);
		}

		// Flush any remaining accumulator and drain any buffered runtime items.
		flushTurnAndRuntime();

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
		// useGroupMessages always returns a new array reference on every delta
		// (via spread/filter/map), so the `messages` reference dep already captures
		// all length and content changes. `messages.length` is intentionally omitted.
	}, [messages, isAtTail]);
}
