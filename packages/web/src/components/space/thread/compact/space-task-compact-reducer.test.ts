import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import {
	buildLogicalBlocks,
	applyCompactVisibilityRules,
	applyBlockRowVisibility,
	shouldShowRunningIndicator,
	resolveRunningBlockIndex,
	rowHasToolUse,
	type CompactLogicalBlock,
} from './space-task-compact-reducer';
import type { ParsedThreadRow } from '../space-task-thread-events';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(
	id: string,
	label: string,
	message: SDKMessage | null = makeAssistantTextMessage(id, 'hello')
): ParsedThreadRow {
	return {
		id,
		sessionId: null,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message,
		fallbackText: null,
	};
}

function makeAssistantTextMessage(uuid: string, text: string): SDKMessage {
	return {
		type: 'assistant',
		uuid,
		message: { content: [{ type: 'text', text }] },
	} as unknown as SDKMessage;
}

function makeResultMessage(uuid: string, subtype: 'success' | 'error' = 'success'): SDKMessage {
	return {
		type: 'result',
		subtype,
		uuid,
		usage: { input_tokens: 1, output_tokens: 1 },
	} as unknown as SDKMessage;
}

function makeResultRow(
	id: string,
	label: string,
	subtype: 'success' | 'error' = 'success'
): ParsedThreadRow {
	return makeRow(id, label, makeResultMessage(id, subtype));
}

// ── buildLogicalBlocks ────────────────────────────────────────────────────────

describe('buildLogicalBlocks', () => {
	it('returns empty array for no rows', () => {
		expect(buildLogicalBlocks([])).toEqual([]);
	});

	it('groups single-agent consecutive rows into one block', () => {
		const rows = [
			makeRow('r1', 'Task Agent'),
			makeRow('r2', 'Task Agent'),
			makeRow('r3', 'Task Agent'),
		];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].agentLabel).toBe('Task Agent');
		expect(blocks[0].rows).toHaveLength(3);
		expect(blocks[0].isTerminal).toBe(false);
	});

	it('creates separate blocks when agents alternate', () => {
		const rows = [
			makeRow('r1', 'Task Agent'),
			makeRow('r2', 'Coder Agent'),
			makeRow('r3', 'Reviewer Agent'),
		];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].agentLabel).toBe('Task Agent');
		expect(blocks[1].agentLabel).toBe('Coder Agent');
		expect(blocks[2].agentLabel).toBe('Reviewer Agent');
	});

	it('groups interleaved same-agent runs into separate blocks', () => {
		const rows = [
			makeRow('r1', 'Task Agent'),
			makeRow('r2', 'Coder Agent'),
			makeRow('r3', 'Task Agent'),
		];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].agentLabel).toBe('Task Agent');
		expect(blocks[0].rows).toHaveLength(1);
		expect(blocks[2].agentLabel).toBe('Task Agent');
		expect(blocks[2].rows).toHaveLength(1);
	});

	it('marks a block terminal when it contains a result message (success)', () => {
		const rows = [makeRow('r1', 'Task Agent'), makeResultRow('r2', 'Task Agent', 'success')];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].isTerminal).toBe(true);
	});

	it('marks block terminal for error result as well', () => {
		const rows = [makeResultRow('r1', 'Task Agent', 'error')];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks[0].isTerminal).toBe(true);
	});

	it('does not mark non-result rows as terminal', () => {
		const rows = [
			makeRow('r1', 'Task Agent'),
			makeRow('r2', 'Task Agent'),
			makeRow('r3', 'Task Agent'),
		];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks[0].isTerminal).toBe(false);
	});

	it('treats rows with null message as non-terminal', () => {
		const rows = [makeRow('r1', 'Task Agent', null)];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks[0].isTerminal).toBe(false);
	});

	it('uses the first row id as the block id', () => {
		const rows = [makeRow('first-row', 'Task Agent'), makeRow('second-row', 'Task Agent')];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks[0].id).toBe('first-row');
	});

	it('treats agent label comparison as case-insensitive and trims whitespace', () => {
		const rows = [makeRow('r1', 'Task Agent'), makeRow('r2', '  task agent  ')];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].rows).toHaveLength(2);
	});

	it('treats a sub-agent sequence as one block (same agent label)', () => {
		const rows = [
			makeRow('c1', 'Coder Agent'),
			makeRow('c2', 'Coder Agent'),
			makeRow('c3', 'Coder Agent'),
			makeResultRow('c4', 'Coder Agent', 'success'),
		];
		const blocks = buildLogicalBlocks(rows);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].rows).toHaveLength(4);
		expect(blocks[0].isTerminal).toBe(true);
	});
});

// ── applyCompactVisibilityRules ───────────────────────────────────────────────

function makeBlock(id: string, agentLabel: string, isTerminal = false): CompactLogicalBlock {
	return {
		id,
		agentLabel,
		rows: [],
		isTerminal,
	};
}

describe('applyCompactVisibilityRules', () => {
	it('returns all blocks when count <= maxBlocks', () => {
		const blocks = [makeBlock('b1', 'Task Agent'), makeBlock('b2', 'Coder Agent')];
		expect(applyCompactVisibilityRules(blocks, 3)).toEqual(blocks);
	});

	it('returns all blocks when count === maxBlocks', () => {
		const blocks = [makeBlock('b1', 'A'), makeBlock('b2', 'B'), makeBlock('b3', 'C')];
		expect(applyCompactVisibilityRules(blocks, 3)).toHaveLength(3);
	});

	it('returns last N blocks when count > maxBlocks (no terminal)', () => {
		const blocks = [
			makeBlock('b1', 'A'),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C'),
			makeBlock('b4', 'D'),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		expect(result).toHaveLength(3);
		expect(result.map((b) => b.id)).toEqual(['b2', 'b3', 'b4']);
	});

	it('drops scattered (non-trailing) terminal blocks outside the last-N window', () => {
		// Per the current reducer: only the contiguous trailing-terminal tail is
		// always kept. A terminal block followed by more non-terminal work is
		// treated as ordinary history and falls out of the last-N body window.
		const blocks = [
			makeBlock('b1', 'A', true),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C'),
			makeBlock('b4', 'D'),
			makeBlock('b5', 'E'),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		expect(result.map((b) => b.id)).toEqual(['b3', 'b4', 'b5']);
	});

	it('always includes the trailing terminal tail even when it exceeds maxBlocks', () => {
		// b4 + b5 form the contiguous terminal tail; body window is last 3 of [b1,b2,b3].
		const blocks = [
			makeBlock('b1', 'A'),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C'),
			makeBlock('b4', 'D', true),
			makeBlock('b5', 'E', true),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		expect(result.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
	});

	it('includes terminal block already within the last-N window (no duplication)', () => {
		const blocks = [makeBlock('b1', 'A'), makeBlock('b2', 'B'), makeBlock('b3', 'C', true)];
		const result = applyCompactVisibilityRules(blocks, 3);
		expect(result).toHaveLength(3);
	});

	it('preserves chronological order across body window and terminal tail', () => {
		const blocks = [
			makeBlock('b1', 'A'),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C'),
			makeBlock('b4', 'D', true),
			makeBlock('b5', 'E', true),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		const ids = result.map((b) => b.id);
		expect(ids.indexOf('b3')).toBeLessThan(ids.indexOf('b4'));
	});

	it('only keeps the trailing-terminal tail — scattered non-trailing terminals are dropped', () => {
		// b1 and b3 are terminals but they are NOT part of the trailing tail
		// because b4, b5, b6 follow them (non-terminal). Body window of size 3
		// from [b1..b6] is [b4, b5, b6]; no scattered terminal survives.
		const blocks = [
			makeBlock('b1', 'A', true),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C', true),
			makeBlock('b4', 'D'),
			makeBlock('b5', 'E'),
			makeBlock('b6', 'F'),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		expect(result.map((b) => b.id)).toEqual(['b4', 'b5', 'b6']);
	});

	it('works with maxBlocks=1', () => {
		const blocks = [makeBlock('b1', 'A'), makeBlock('b2', 'B'), makeBlock('b3', 'C')];
		const result = applyCompactVisibilityRules(blocks, 1);
		expect(result.map((b) => b.id)).toEqual(['b3']);
	});
});

// ── shouldShowRunningIndicator ────────────────────────────────────────────────

describe('shouldShowRunningIndicator', () => {
	it('returns false for empty block list', () => {
		expect(shouldShowRunningIndicator([])).toBe(false);
	});

	it('returns true when the last block is non-terminal', () => {
		const blocks = [makeBlock('b1', 'Task Agent', false)];
		expect(shouldShowRunningIndicator(blocks)).toBe(true);
	});

	it('returns false when the last block is terminal', () => {
		const blocks = [makeBlock('b1', 'Task Agent', true)];
		expect(shouldShowRunningIndicator(blocks)).toBe(false);
	});

	it('returns true when any earlier block is still non-terminal even if the last is terminal', () => {
		// With the current reducer, terminal tails pin themselves to the end —
		// so if any earlier block is non-terminal we treat the task as still running.
		const blocks = [makeBlock('b1', 'A', false), makeBlock('b2', 'B', true)];
		expect(shouldShowRunningIndicator(blocks)).toBe(true);
	});

	it('shows indicator when earlier blocks are terminal but last is not', () => {
		const blocks = [makeBlock('b1', 'A', true), makeBlock('b2', 'B', false)];
		expect(shouldShowRunningIndicator(blocks)).toBe(true);
	});
});

// ── rowHasToolUse ─────────────────────────────────────────────────────────────

function makeToolUseMessage(uuid: string, toolName = 'bash'): SDKMessage {
	return {
		type: 'assistant',
		uuid,
		message: { content: [{ type: 'tool_use', id: `tu-${uuid}`, name: toolName, input: {} }] },
	} as unknown as SDKMessage;
}

describe('rowHasToolUse', () => {
	it('returns false for null message', () => {
		expect(rowHasToolUse(makeRow('r1', 'A', null))).toBe(false);
	});

	it('returns false for a plain text assistant message', () => {
		expect(rowHasToolUse(makeRow('r1', 'A', makeAssistantTextMessage('r1', 'hello')))).toBe(false);
	});

	it('returns true for an assistant message with a tool_use block', () => {
		expect(rowHasToolUse(makeRow('r1', 'A', makeToolUseMessage('r1', 'bash')))).toBe(true);
	});

	it('returns false for a result message', () => {
		expect(rowHasToolUse(makeResultRow('r1', 'A'))).toBe(false);
	});
});

// ── resolveRunningBlockIndex ──────────────────────────────────────────────────

function makeBlockWithRows(
	id: string,
	label: string,
	isTerminal: boolean,
	rows: ParsedThreadRow[]
): CompactLogicalBlock {
	return { id, agentLabel: label, rows, isTerminal };
}

describe('resolveRunningBlockIndex', () => {
	it('returns -1 when isAgentActive is false', () => {
		const block = makeBlockWithRows('b1', 'A', false, [
			makeRow('r1', 'A', makeToolUseMessage('r1')),
		]);
		expect(resolveRunningBlockIndex([block], false)).toBe(-1);
	});

	it('returns -1 when all blocks are terminal', () => {
		const block = makeBlockWithRows('b1', 'A', true, [makeResultRow('r1', 'A')]);
		expect(resolveRunningBlockIndex([block], true)).toBe(-1);
	});

	it('returns -1 when last row of non-terminal block is not tool_use', () => {
		const block = makeBlockWithRows('b1', 'A', false, [
			makeRow('r1', 'A', makeAssistantTextMessage('r1', 'thinking…')),
		]);
		expect(resolveRunningBlockIndex([block], true)).toBe(-1);
	});

	it('returns the last non-terminal block index when last row is tool_use', () => {
		const running = makeBlockWithRows('b2', 'Coder', false, [
			makeRow('r2', 'Coder', makeToolUseMessage('r2', 'read_file')),
		]);
		const blocks = [makeBlock('b1', 'A', true), running];
		expect(resolveRunningBlockIndex(blocks, true)).toBe(1);
	});

	it('targets the last non-terminal block even when a later terminal block exists', () => {
		// body: non-terminal with tool_use, then terminal result
		const running = makeBlockWithRows('b1', 'Coder', false, [
			makeRow('r1', 'Coder', makeToolUseMessage('r1', 'bash')),
		]);
		const done = makeBlockWithRows('b2', 'Task', true, [makeResultRow('r2', 'Task')]);
		// resolveRunningBlockIndex should not return the terminal block
		// — getRunningBlockIndex returns 0 (last non-terminal), and its last row IS tool_use
		expect(resolveRunningBlockIndex([running, done], true)).toBe(0);
	});
});

// ── applyBlockRowVisibility ───────────────────────────────────────────────────

describe('applyBlockRowVisibility', () => {
	function makeBlock(id: string, rowCount: number): CompactLogicalBlock {
		const rows: ParsedThreadRow[] = [];
		for (let i = 0; i < rowCount; i++) {
			rows.push(makeRow(`${id}-${i}`, 'Task'));
		}
		return { id, agentLabel: 'Task', rows, isTerminal: false };
	}

	it('returns all rows and 0 hidden when block has fewer rows than maxRows', () => {
		const block = makeBlock('b', 2);
		const { visibleRows, hiddenRowCount } = applyBlockRowVisibility(block, 3);
		expect(visibleRows.length).toBe(2);
		expect(hiddenRowCount).toBe(0);
	});

	it('returns all rows and 0 hidden when block has exactly maxRows', () => {
		const block = makeBlock('b', 3);
		const { visibleRows, hiddenRowCount } = applyBlockRowVisibility(block, 3);
		expect(visibleRows.length).toBe(3);
		expect(hiddenRowCount).toBe(0);
	});

	it('keeps the last maxRows and reports the trimmed count', () => {
		const block = makeBlock('b', 5);
		const { visibleRows, hiddenRowCount } = applyBlockRowVisibility(block, 3);
		expect(visibleRows.length).toBe(3);
		expect(hiddenRowCount).toBe(2);
		// The visible rows must be the tail — the last 3.
		expect(visibleRows.map((r) => r.id)).toEqual(['b-2', 'b-3', 'b-4']);
	});

	it('preserves the final row (terminal + running border stay visible)', () => {
		const block = makeBlock('b', 10);
		const { visibleRows } = applyBlockRowVisibility(block, 3);
		expect(visibleRows[visibleRows.length - 1].id).toBe('b-9');
	});

	it('defaults to maxRows=3 when the argument is omitted', () => {
		const block = makeBlock('b', 5);
		const { visibleRows, hiddenRowCount } = applyBlockRowVisibility(block);
		expect(visibleRows.length).toBe(3);
		expect(hiddenRowCount).toBe(2);
	});

	it('returns empty visible and all-hidden when maxRows is 0', () => {
		const block = makeBlock('b', 4);
		const { visibleRows, hiddenRowCount } = applyBlockRowVisibility(block, 0);
		expect(visibleRows.length).toBe(0);
		expect(hiddenRowCount).toBe(4);
	});

	it('handles an empty-rows block gracefully', () => {
		const block: CompactLogicalBlock = {
			id: 'empty',
			agentLabel: 'Task',
			rows: [],
			isTerminal: false,
		};
		const { visibleRows, hiddenRowCount } = applyBlockRowVisibility(block, 3);
		expect(visibleRows.length).toBe(0);
		expect(hiddenRowCount).toBe(0);
	});
});
