// @ts-nocheck
/**
 * Tests for useTurnBlocks hook.
 *
 * useTurnBlocks takes a flat SessionGroupMessage[] and returns a structured
 * TurnBlockItem[] — an ordered mix of TurnBlock turn items and RuntimeMessage
 * items. The hook internally calls parseGroupMessage() on each raw message, so
 * test helpers produce SessionGroupMessages whose `content` is already valid JSON
 * that parseGroupMessage can parse (or a known non-JSON type like 'status').
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/preact';
import {
	useTurnBlocks,
	type TurnBlockItem,
	type TurnBlock,
	type RuntimeMessage,
} from '../useTurnBlocks';
import type { SessionGroupMessage } from '../useGroupMessages';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function resetIdCounter() {
	_idCounter = 0;
}

/**
 * Build a SessionGroupMessage whose content is a JSON-stringified SDKMessage
 * with a _taskMeta block. parseGroupMessage() will parse this into a real
 * SDKMessage with _taskMeta attached.
 */
function makeAgentMessage(opts: {
	authorRole: string;
	authorSessionId: string;
	sessionId?: string | null;
	uuid?: string;
	type?: string; // SDKMessage type ('assistant' | 'user' | 'result' | ...)
	createdAt?: number;
	content?: object; // extra fields merged into the SDKMessage
	messageType?: string; // SessionGroupMessage.messageType
}): SessionGroupMessage {
	_idCounter++;
	const id = _idCounter;
	const uuid = opts.uuid ?? `uuid-${id}`;
	const createdAt = opts.createdAt ?? id * 1000;

	const sdkMsg = {
		type: opts.type ?? 'assistant',
		uuid,
		message: { content: [] }, // default empty assistant content
		timestamp: createdAt,
		_taskMeta: {
			authorRole: opts.authorRole,
			authorSessionId: opts.authorSessionId,
			turnId: `turn-${id}`,
			iteration: 1,
		},
		...(opts.content ?? {}),
	};

	return {
		id,
		groupId: 'group-1',
		sessionId: opts.sessionId ?? opts.authorSessionId,
		role: opts.authorRole,
		messageType: opts.messageType ?? opts.type ?? 'assistant',
		content: JSON.stringify(sdkMsg),
		createdAt,
	};
}

/**
 * Build an assistant message that contains tool_use content blocks.
 * Each toolName becomes one tool_use block.
 */
function makeToolUseMessage(opts: {
	authorRole: string;
	authorSessionId: string;
	toolNames: string[];
	uuid?: string;
	createdAt?: number;
}): SessionGroupMessage {
	return makeAgentMessage({
		...opts,
		type: 'assistant',
		content: {
			message: {
				content: opts.toolNames.map((name, i) => ({
					type: 'tool_use',
					id: `tool-${i}`,
					name,
					input: {},
				})),
			},
		},
	});
}

/**
 * Build an assistant message that contains thinking content blocks.
 */
function makeThinkingMessage(opts: {
	authorRole: string;
	authorSessionId: string;
	thinkingCount?: number;
	uuid?: string;
	createdAt?: number;
}): SessionGroupMessage {
	const count = opts.thinkingCount ?? 1;
	return makeAgentMessage({
		...opts,
		type: 'assistant',
		content: {
			message: {
				content: Array.from({ length: count }, (_, i) => ({
					type: 'thinking',
					thinking: `thinking-${i}`,
				})),
			},
		},
	});
}

/**
 * Build a 'status' runtime message. parseGroupMessage() treats non-JSON
 * messageType='status' as a special case and returns a system-role message.
 */
function makeStatusMessage(opts: { text?: string; createdAt?: number } = {}): SessionGroupMessage {
	_idCounter++;
	const id = _idCounter;
	return {
		id,
		groupId: 'group-1',
		sessionId: null,
		role: 'system',
		messageType: 'status',
		content: opts.text ?? `Status ${id}`,
		createdAt: opts.createdAt ?? id * 1000,
	};
}

/**
 * Build a 'leader_summary' runtime message.
 */
function makeLeaderSummaryMessage(
	opts: { text?: string; createdAt?: number } = {}
): SessionGroupMessage {
	_idCounter++;
	const id = _idCounter;
	return {
		id,
		groupId: 'group-1',
		sessionId: null,
		role: 'system',
		messageType: 'leader_summary',
		content: opts.text ?? `Summary ${id}`,
		createdAt: opts.createdAt ?? id * 1000,
	};
}

/**
 * Build a 'rate_limited' runtime message.
 */
function makeRateLimitedMessage(opts: { createdAt?: number } = {}): SessionGroupMessage {
	_idCounter++;
	const id = _idCounter;
	return {
		id,
		groupId: 'group-1',
		sessionId: null,
		role: 'system',
		messageType: 'rate_limited',
		content: JSON.stringify({ resetsAt: Date.now() + 60000 }),
		createdAt: opts.createdAt ?? id * 1000,
	};
}

/**
 * Build a 'model_fallback' runtime message.
 */
function makeModelFallbackMessage(opts: { createdAt?: number } = {}): SessionGroupMessage {
	_idCounter++;
	const id = _idCounter;
	return {
		id,
		groupId: 'group-1',
		sessionId: null,
		role: 'system',
		messageType: 'model_fallback',
		content: JSON.stringify({ fromModel: 'claude-opus-4', toModel: 'claude-sonnet-4-5' }),
		createdAt: opts.createdAt ?? id * 1000,
	};
}

/**
 * Build a result message (session end).
 */
function makeResultMessage(opts: {
	authorRole: string;
	authorSessionId: string;
	isError?: boolean;
	errors?: string[];
	subtype?: string;
	uuid?: string;
	createdAt?: number;
}): SessionGroupMessage {
	return makeAgentMessage({
		...opts,
		type: 'result',
		content: {
			subtype: opts.subtype ?? (opts.isError ? 'error_during_execution' : 'success'),
			is_error: opts.isError ?? false,
			errors: opts.errors ?? [],
			duration_ms: 0,
			duration_api_ms: 0,
			num_turns: 1,
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
		},
	});
}

// Helper to render the hook and get results
function renderUseTurnBlocks(messages: SessionGroupMessage[], isAtTail?: boolean): TurnBlockItem[] {
	const { result } = renderHook(() => useTurnBlocks(messages, isAtTail));
	return result.current;
}

// Type narrowing helpers
function asTurn(item: TurnBlockItem): TurnBlock {
	expect(item.type).toBe('turn');
	return (item as { type: 'turn'; turn: TurnBlock }).turn;
}

function asRuntime(item: TurnBlockItem): RuntimeMessage {
	expect(item.type).toBe('runtime');
	return item as RuntimeMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTurnBlocks', () => {
	beforeEach(() => {
		resetIdCounter();
	});

	// ── Empty input ──────────────────────────────────────────────────────────

	describe('empty messages', () => {
		it('returns an empty array for empty input', () => {
			const items = renderUseTurnBlocks([]);
			expect(items).toEqual([]);
		});
	});

	// ── Runtime messages ─────────────────────────────────────────────────────

	describe('runtime messages', () => {
		it('emits RuntimeMessage for status messages', () => {
			const msgs = [makeStatusMessage({ text: 'Agent started' })];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(1);
			const rt = asRuntime(items[0]);
			expect(rt.index).toBe(0);
			expect(rt.message.type).toBe('status');
		});

		it('emits RuntimeMessage for leader_summary messages', () => {
			const msgs = [makeLeaderSummaryMessage()];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(1);
			asRuntime(items[0]);
		});

		it('emits RuntimeMessage for rate_limited messages', () => {
			const msgs = [makeRateLimitedMessage()];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(1);
			asRuntime(items[0]);
		});

		it('emits RuntimeMessage for model_fallback messages', () => {
			const msgs = [makeModelFallbackMessage()];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(1);
			asRuntime(items[0]);
		});

		it('runtime messages appear between turn blocks at correct positions', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeStatusMessage(),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'sess-2' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(3);
			expect(items[0].type).toBe('turn');
			expect(items[1].type).toBe('runtime');
			expect(items[2].type).toBe('turn');
		});

		it('multiple consecutive runtime messages all become RuntimeMessage items', () => {
			const msgs = [makeStatusMessage(), makeRateLimitedMessage(), makeLeaderSummaryMessage()];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(3);
			items.forEach((item) => expect(item.type).toBe('runtime'));
		});

		it('runtime message before same-session agent messages does not split the turn', () => {
			// Runtime message arrives BEFORE any agent message — emitted immediately, turn intact
			const msgs = [
				makeStatusMessage(),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 2000 }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 3000 }),
			];
			const items = renderUseTurnBlocks(msgs);
			// 1 runtime + 1 turn (two messages merged)
			expect(items).toHaveLength(2);
			expect(items[0].type).toBe('runtime');
			const turn = asTurn(items[1]);
			expect(turn.messageCount).toBe(2);
		});

		it('runtime message mid-turn does not fragment the agent turn', () => {
			// Status update arrives between two messages from the same session.
			// The turn should remain one cohesive block (not split into two).
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 1000 }),
				makeStatusMessage({ createdAt: 2000 }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 3000 }),
			];
			const items = renderUseTurnBlocks(msgs);
			// 1 turn (2 agent msgs merged) + 1 runtime (emitted after the turn)
			expect(items).toHaveLength(2);
			expect(items[0].type).toBe('turn');
			const turn = asTurn(items[0]);
			expect(turn.messageCount).toBe(2);
			expect(items[1].type).toBe('runtime');
		});

		it('multiple runtime messages mid-turn are all emitted after the turn', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 1000 }),
				makeStatusMessage({ createdAt: 2000 }),
				makeRateLimitedMessage({ createdAt: 3000 }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 4000 }),
			];
			const items = renderUseTurnBlocks(msgs);
			// 1 turn + 2 runtime items (emitted after the turn that caused the flush)
			expect(items).toHaveLength(3);
			expect(items[0].type).toBe('turn');
			expect(asTurn(items[0]).messageCount).toBe(2);
			expect(items[1].type).toBe('runtime');
			expect(items[2].type).toBe('runtime');
		});

		it('mid-turn runtime messages appear between turns when a new agent follows', () => {
			// [agent1, status, agent2] — status was buffered during agent1's turn,
			// emitted between the two turns once agent2 starts speaking.
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker', createdAt: 1000 }),
				makeStatusMessage({ createdAt: 2000 }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader', createdAt: 3000 }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(3);
			expect(items[0].type).toBe('turn');
			expect(asTurn(items[0]).sessionId).toBe('worker');
			expect(items[1].type).toBe('runtime');
			expect(items[2].type).toBe('turn');
			expect(asTurn(items[2]).sessionId).toBe('leader');
		});
	});

	// ── Turn grouping ────────────────────────────────────────────────────────

	describe('turn grouping', () => {
		it('groups consecutive messages from the same authorSessionId into one turn', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(1);
			const turn = asTurn(items[0]);
			expect(turn.messageCount).toBe(3);
			expect(turn.sessionId).toBe('sess-1');
		});

		it('creates a new turn when authorSessionId changes', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'sess-2' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(2);
			expect(asTurn(items[0]).sessionId).toBe('sess-1');
			expect(asTurn(items[1]).sessionId).toBe('sess-2');
		});

		it('handles multi-agent interleaving correctly', () => {
			// worker → leader → worker → leader (4 turns)
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(4);
			expect(asTurn(items[0]).sessionId).toBe('worker');
			expect(asTurn(items[0]).messageCount).toBe(2);
			expect(asTurn(items[1]).sessionId).toBe('leader');
			expect(asTurn(items[1]).messageCount).toBe(1);
			expect(asTurn(items[2]).sessionId).toBe('worker');
			expect(asTurn(items[2]).messageCount).toBe(1);
			expect(asTurn(items[3]).sessionId).toBe('leader');
			expect(asTurn(items[3]).messageCount).toBe(2);
		});

		it('human role messages form their own turn blocks', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
				makeAgentMessage({ authorRole: 'human', authorSessionId: 'human-session' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(items).toHaveLength(3);
			expect(asTurn(items[1]).agentRole).toBe('human');
			expect(asTurn(items[1]).agentLabel).toBe('Human');
		});
	});

	// ── Turn block fields ────────────────────────────────────────────────────

	describe('TurnBlock fields', () => {
		it('uses first message uuid as TurnBlock.id', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', uuid: 'first-uuid' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', uuid: 'second-uuid' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).id).toBe('first-uuid');
		});

		it('falls back to ${sessionId}-${startTime} when first message has no uuid', () => {
			// Create a message whose JSON content has no uuid field
			_idCounter++;
			const id = _idCounter;
			const createdAt = id * 1000;
			const rawMsg: SessionGroupMessage = {
				id,
				groupId: 'group-1',
				sessionId: 'sess-fallback',
				role: 'coder',
				messageType: 'assistant',
				content: JSON.stringify({
					type: 'assistant',
					// no uuid field
					message: { content: [] },
					timestamp: createdAt,
					_taskMeta: {
						authorRole: 'coder',
						authorSessionId: 'sess-fallback',
						turnId: 'turn-fb',
						iteration: 1,
					},
				}),
				createdAt,
			};
			const items = renderUseTurnBlocks([rawMsg]);
			expect(asTurn(items[0]).id).toBe(`sess-fallback-${createdAt}`);
		});

		it('sets agentRole and agentLabel correctly', () => {
			const msgs = [makeAgentMessage({ authorRole: 'leader', authorSessionId: 'sess-l' })];
			const items = renderUseTurnBlocks(msgs);
			const turn = asTurn(items[0]);
			expect(turn.agentRole).toBe('leader');
			expect(turn.agentLabel).toBe('Leader');
		});

		it('uses plain label from ROLE_COLORS (no model name)', () => {
			const roles = ['coder', 'leader', 'planner', 'human'];
			const expectedLabels = ['Coder', 'Leader', 'Planner', 'Human'];
			for (let i = 0; i < roles.length; i++) {
				resetIdCounter();
				const msgs = [makeAgentMessage({ authorRole: roles[i], authorSessionId: `sess-${i}` })];
				const items = renderUseTurnBlocks(msgs);
				expect(asTurn(items[0]).agentLabel).toBe(expectedLabels[i]);
			}
		});

		it('agentLabel falls back to raw agentRole for unknown roles', () => {
			// An unregistered role not present in ROLE_COLORS silently falls back to the
			// raw role string rather than throwing — this covers future SDK role additions.
			const msgs = [makeAgentMessage({ authorRole: 'unknown-agent', authorSessionId: 'sess-x' })];
			const items = renderUseTurnBlocks(msgs);
			const turn = asTurn(items[0]);
			expect(turn.agentRole).toBe('unknown-agent');
			expect(turn.agentLabel).toBe('unknown-agent');
		});

		it('startTime is timestamp of first message in the turn', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 5000 }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 6000 }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).startTime).toBe(5000);
		});

		it('sets messages array with all messages in the turn', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).messages).toHaveLength(3);
		});

		it('previewMessage is the last message in the turn', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', uuid: 'first' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', uuid: 'last' }),
			];
			const items = renderUseTurnBlocks(msgs);
			const turn = asTurn(items[0]);
			expect((turn.previewMessage as { uuid?: string })?.uuid).toBe('last');
		});
	});

	// ── Stats counting ───────────────────────────────────────────────────────

	describe('stats counting', () => {
		it('counts assistant messages', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'assistant' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'user' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'assistant' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).assistantCount).toBe(2);
		});

		it('counts tool_use blocks across assistant messages', () => {
			const msgs = [
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Read', 'Edit'],
				}),
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Bash'],
				}),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).toolCallCount).toBe(3);
		});

		it('counts thinking blocks across assistant messages', () => {
			const msgs = [
				makeThinkingMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					thinkingCount: 2,
				}),
				makeThinkingMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					thinkingCount: 1,
				}),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).thinkingCount).toBe(3);
		});

		it('zero stats for a non-assistant message with no content', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'user' }),
			];
			const items = renderUseTurnBlocks(msgs);
			const turn = asTurn(items[0]);
			expect(turn.toolCallCount).toBe(0);
			expect(turn.thinkingCount).toBe(0);
			expect(turn.assistantCount).toBe(0);
		});
	});

	// ── lastAction ───────────────────────────────────────────────────────────

	describe('lastAction', () => {
		it('sets lastAction to the most recent tool_use name', () => {
			const msgs = [
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Read', 'Edit'],
				}),
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Bash'],
				}),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).lastAction).toBe('Bash');
		});

		it('lastAction is null when no tool_use blocks exist', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'assistant' }),
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).lastAction).toBeNull();
		});

		it('lastAction updates to the last tool_use in the last message', () => {
			const msgs = [
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Read'],
				}),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'assistant' }),
			];
			// Second message has no tool_use, so lastAction should remain 'Read'
			const items = renderUseTurnBlocks(msgs);
			expect(asTurn(items[0]).lastAction).toBe('Read');
		});
	});

	// ── Active turn detection ────────────────────────────────────────────────

	describe('active turn detection', () => {
		it('isActive=true for last turn when isAtTail=true and no result message', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(asTurn(items[0]).isActive).toBe(true);
		});

		it('isActive=false when isAtTail=false even for last turn', () => {
			const msgs = [makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' })];
			const items = renderUseTurnBlocks(msgs, false);
			expect(asTurn(items[0]).isActive).toBe(false);
		});

		it('isActive=false for completed turn (has result message) even when isAtTail=true', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeResultMessage({ authorRole: 'coder', authorSessionId: 'sess-1', isError: false }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(asTurn(items[0]).isActive).toBe(false);
		});

		it('only the last turn is active, not intermediate turns', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(items).toHaveLength(2);
			expect(asTurn(items[0]).isActive).toBe(false);
			expect(asTurn(items[1]).isActive).toBe(true);
		});

		it('endTime is null when turn is active (isAtTail=true, no result)', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 1000 }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(asTurn(items[0]).endTime).toBeNull();
		});

		it('endTime is set when turn has a result message', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 1000 }),
				makeResultMessage({ authorRole: 'coder', authorSessionId: 'sess-1', createdAt: 5000 }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(asTurn(items[0]).endTime).toBe(5000);
		});

		it('defaults isAtTail to true (last turn is active when no result)', () => {
			const msgs = [makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' })];
			// Call without isAtTail argument
			const { result } = renderHook(() => useTurnBlocks(msgs));
			expect(asTurn(result.current[0]).isActive).toBe(true);
		});

		it('intermediate turns are never active (always have endTime)', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker', createdAt: 1000 }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader', createdAt: 2000 }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			// First turn should have endTime set (not active)
			expect(asTurn(items[0]).isActive).toBe(false);
			expect(asTurn(items[0]).endTime).not.toBeNull();
		});
	});

	// ── Error detection ──────────────────────────────────────────────────────

	describe('error detection', () => {
		it('isError=true when last message is an error result', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
				makeResultMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					isError: true,
					errors: ['execution failed'],
				}),
			];
			const items = renderUseTurnBlocks(msgs, true);
			const turn = asTurn(items[0]);
			expect(turn.isError).toBe(true);
		});

		it('errorMessage is the first error string from the result', () => {
			const msgs = [
				makeResultMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					isError: true,
					errors: ['Something went wrong'],
				}),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(asTurn(items[0]).errorMessage).toBe('Something went wrong');
		});

		it('isError=false for successful result', () => {
			const msgs = [
				makeResultMessage({ authorRole: 'coder', authorSessionId: 'sess-1', isError: false }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			const turn = asTurn(items[0]);
			expect(turn.isError).toBe(false);
			expect(turn.errorMessage).toBeNull();
		});

		it('isError=false when no result message present', () => {
			const msgs = [makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' })];
			const items = renderUseTurnBlocks(msgs, true);
			expect(asTurn(items[0]).isError).toBe(false);
		});

		it('detects assistant-level error even when it is not the last message in the turn', () => {
			// An SDKAssistantMessage can carry error:'billing_error' mid-turn before a result
			// arrives. The turn must still report isError=true in this case.
			const errorMsg = makeAgentMessage({
				authorRole: 'coder',
				authorSessionId: 'sess-1',
				type: 'assistant',
				content: { error: 'billing_error' },
			});
			const followupMsg = makeAgentMessage({
				authorRole: 'coder',
				authorSessionId: 'sess-1',
				type: 'assistant',
				// no error field — simulates a retry/continuation message
			});
			const items = renderUseTurnBlocks([errorMsg, followupMsg], true);
			const turn = asTurn(items[0]);
			expect(turn.isError).toBe(true);
			expect(turn.errorMessage).toBe('billing_error');
		});

		it('result-level error takes precedence over an earlier assistant-level error', () => {
			// Both an assistant error and a result error are present; result should win.
			const errorAssistant = makeAgentMessage({
				authorRole: 'coder',
				authorSessionId: 'sess-1',
				type: 'assistant',
				content: { error: 'billing_error' },
			});
			const resultError = makeResultMessage({
				authorRole: 'coder',
				authorSessionId: 'sess-1',
				isError: true,
				errors: ['max_turns exceeded'],
			});
			const items = renderUseTurnBlocks([errorAssistant, resultError], true);
			const turn = asTurn(items[0]);
			expect(turn.isError).toBe(true);
			expect(turn.errorMessage).toBe('max_turns exceeded');
		});
	});

	// ── Memoization ──────────────────────────────────────────────────────────

	describe('memoization', () => {
		it('returns the same array reference when messages and isAtTail do not change', () => {
			const msgs = [makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' })];
			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: msgs, tail: true } }
			);
			const first = result.current;
			rerender({ m: msgs, tail: true });
			expect(result.current).toBe(first);
		});

		it('returns a new array when messages change', () => {
			const msgs1 = [makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' })];
			const msgs2 = [
				...msgs1,
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }),
			];
			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: msgs1, tail: true } }
			);
			const first = result.current;
			rerender({ m: msgs2, tail: true });
			expect(result.current).not.toBe(first);
		});

		it('returns a new array when isAtTail changes', () => {
			const msgs = [makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' })];
			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: msgs, tail: true } }
			);
			const first = result.current;
			rerender({ m: msgs, tail: false });
			expect(result.current).not.toBe(first);
		});
	});

	// ── Complex scenarios ────────────────────────────────────────────────────

	describe('complex multi-agent scenarios', () => {
		it('handles runtime messages between agent turns without merging turns', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker', createdAt: 1000 }),
				makeStatusMessage({ createdAt: 2000 }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader', createdAt: 3000 }),
				makeLeaderSummaryMessage({ createdAt: 4000 }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker', createdAt: 5000 }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			// 3 turns + 2 runtime = 5 items
			expect(items).toHaveLength(5);
			expect(items[0].type).toBe('turn');
			expect(items[1].type).toBe('runtime');
			expect(items[2].type).toBe('turn');
			expect(items[3].type).toBe('runtime');
			expect(items[4].type).toBe('turn');
			expect(asTurn(items[4]).isActive).toBe(true);
		});

		it('only last non-runtime turn is active (runtime at end does not affect active)', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker', createdAt: 1000 }),
				makeStatusMessage({ createdAt: 2000 }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			expect(items).toHaveLength(2);
			// The turn should be active (it's the last turn even though there's a runtime after it)
			expect(asTurn(items[0]).isActive).toBe(true);
		});

		it('RuntimeMessage index reflects position in parsed message array', () => {
			const msgs = [
				makeStatusMessage(), // index 0
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' }), // parsed index 1
				makeLeaderSummaryMessage(), // parsed index 2
			];
			const items = renderUseTurnBlocks(msgs);
			expect(asRuntime(items[0]).index).toBe(0);
			expect(asRuntime(items[2]).index).toBe(2);
		});

		it('handles three simultaneous agents interleaving', () => {
			const msgs = [
				makeAgentMessage({ authorRole: 'planner', authorSessionId: 'planner' }),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' }),
				makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' }),
				makeAgentMessage({ authorRole: 'planner', authorSessionId: 'planner' }),
			];
			const items = renderUseTurnBlocks(msgs, false);
			expect(items).toHaveLength(4);
			expect(asTurn(items[0]).agentRole).toBe('planner');
			expect(asTurn(items[1]).agentRole).toBe('coder');
			expect(asTurn(items[2]).agentRole).toBe('leader');
			expect(asTurn(items[3]).agentRole).toBe('planner');
		});

		it('correctly accumulates stats across multiple messages in one turn', () => {
			const msgs = [
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Read'],
				}),
				makeThinkingMessage({ authorRole: 'coder', authorSessionId: 'sess-1', thinkingCount: 2 }),
				makeToolUseMessage({
					authorRole: 'coder',
					authorSessionId: 'sess-1',
					toolNames: ['Edit', 'Bash'],
				}),
				makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1', type: 'user' }),
			];
			const items = renderUseTurnBlocks(msgs, true);
			const turn = asTurn(items[0]);
			expect(turn.toolCallCount).toBe(3); // Read + Edit + Bash
			expect(turn.thinkingCount).toBe(2);
			expect(turn.assistantCount).toBe(3); // all assistant-type messages
			expect(turn.messageCount).toBe(4);
		});
	});

	// ── Real-time delta ──────────────────────────────────────────────────────

	describe('real-time delta', () => {
		it('adding a message to the same session extends the existing turn', () => {
			const msg1 = makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' });
			const msg2 = makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' });

			// Initial render with one message
			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: [msg1], tail: true } }
			);
			expect(result.current).toHaveLength(1);
			expect(asTurn(result.current[0]).messageCount).toBe(1);

			// Add second message from same session
			rerender({ m: [msg1, msg2], tail: true });
			expect(result.current).toHaveLength(1); // still one turn
			expect(asTurn(result.current[0]).messageCount).toBe(2);
		});

		it('adding a message from a new session starts a new turn', () => {
			const msg1 = makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' });
			const msg2 = makeAgentMessage({ authorRole: 'leader', authorSessionId: 'sess-2' });

			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: [msg1], tail: true } }
			);
			expect(result.current).toHaveLength(1);

			// Add message from a different session
			rerender({ m: [msg1, msg2], tail: true });
			expect(result.current).toHaveLength(2); // two turns now
			expect(asTurn(result.current[0]).sessionId).toBe('sess-1');
			expect(asTurn(result.current[1]).sessionId).toBe('sess-2');
		});

		it('new turn becomes active and previous turn becomes inactive after session switch', () => {
			const msg1 = makeAgentMessage({ authorRole: 'coder', authorSessionId: 'sess-1' });
			const msg2 = makeAgentMessage({ authorRole: 'leader', authorSessionId: 'sess-2' });

			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: [msg1], tail: true } }
			);
			// Initially first turn is active
			expect(asTurn(result.current[0]).isActive).toBe(true);

			// After session switch, first turn inactive, second is active
			rerender({ m: [msg1, msg2], tail: true });
			expect(asTurn(result.current[0]).isActive).toBe(false);
			expect(asTurn(result.current[1]).isActive).toBe(true);
		});

		it('previewMessage updates to the latest message in the turn as messages stream in', () => {
			const msg1 = makeAgentMessage({
				authorRole: 'coder',
				authorSessionId: 'sess-1',
				uuid: 'uuid-first',
			});
			const msg2 = makeAgentMessage({
				authorRole: 'coder',
				authorSessionId: 'sess-1',
				uuid: 'uuid-latest',
			});

			const { result, rerender } = renderHook(
				({ m, tail }: { m: SessionGroupMessage[]; tail: boolean }) => useTurnBlocks(m, tail),
				{ initialProps: { m: [msg1], tail: true } }
			);
			// Preview is the only message initially
			const preview1 = asTurn(result.current[0]).previewMessage;
			expect(preview1?.uuid).toBe('uuid-first');

			// After streaming new message, preview updates to the latest
			rerender({ m: [msg1, msg2], tail: true });
			const preview2 = asTurn(result.current[0]).previewMessage;
			expect(preview2?.uuid).toBe('uuid-latest');
		});

		it('two-agent worker→leader→worker scenario produces three turn blocks', () => {
			const workerMsg1 = makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' });
			const leaderMsg = makeAgentMessage({ authorRole: 'leader', authorSessionId: 'leader' });
			const workerMsg2 = makeAgentMessage({ authorRole: 'coder', authorSessionId: 'worker' });

			const items = renderUseTurnBlocks([workerMsg1, leaderMsg, workerMsg2], true);

			expect(items).toHaveLength(3);
			expect(asTurn(items[0]).agentRole).toBe('coder');
			expect(asTurn(items[1]).agentRole).toBe('leader');
			expect(asTurn(items[2]).agentRole).toBe('coder');
			// Only the last turn is active
			expect(asTurn(items[0]).isActive).toBe(false);
			expect(asTurn(items[1]).isActive).toBe(false);
			expect(asTurn(items[2]).isActive).toBe(true);
		});
	});
});
