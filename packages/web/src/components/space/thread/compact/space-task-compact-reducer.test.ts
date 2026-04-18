import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import {
	buildLogicalBlocks,
	applyCompactVisibilityRules,
	shouldShowRunningIndicator,
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
