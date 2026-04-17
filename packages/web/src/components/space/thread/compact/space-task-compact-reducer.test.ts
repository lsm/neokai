import { describe, expect, it } from 'vitest';
import {
	buildLogicalBlocks,
	applyCompactVisibilityRules,
	shouldShowRunningIndicator,
	type CompactLogicalBlock,
} from './space-task-compact-reducer';
import type { SpaceTaskThreadEvent } from '../space-task-thread-events';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
	id: string,
	label: string,
	kind: SpaceTaskThreadEvent['kind'] = 'text',
	extra: Partial<SpaceTaskThreadEvent> = {}
): SpaceTaskThreadEvent {
	return {
		id,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		sessionId: null,
		createdAt: Date.now(),
		kind,
		title: kind,
		summary: `${label} ${kind}`,
		...extra,
	};
}

function makeResultEvent(
	id: string,
	label: string,
	subtype: 'success' | 'error' = 'success'
): SpaceTaskThreadEvent {
	return makeEvent(id, label, 'result', {
		resultSubtype: subtype,
		isError: subtype !== 'success',
	});
}

// ── buildLogicalBlocks ────────────────────────────────────────────────────────

describe('buildLogicalBlocks', () => {
	it('returns empty array for no events', () => {
		expect(buildLogicalBlocks([])).toEqual([]);
	});

	it('groups single-agent consecutive events into one block', () => {
		const events = [
			makeEvent('e1', 'Task Agent', 'thinking'),
			makeEvent('e2', 'Task Agent', 'tool'),
			makeEvent('e3', 'Task Agent', 'text'),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].agentLabel).toBe('Task Agent');
		expect(blocks[0].events).toHaveLength(3);
		expect(blocks[0].isTerminal).toBe(false);
	});

	it('creates separate blocks when agents alternate', () => {
		const events = [
			makeEvent('e1', 'Task Agent', 'text'),
			makeEvent('e2', 'Coder Agent', 'tool'),
			makeEvent('e3', 'Reviewer Agent', 'text'),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].agentLabel).toBe('Task Agent');
		expect(blocks[1].agentLabel).toBe('Coder Agent');
		expect(blocks[2].agentLabel).toBe('Reviewer Agent');
	});

	it('groups interleaved same-agent runs into separate blocks', () => {
		// Task Agent → Coder Agent → Task Agent (different consecutive groups)
		const events = [
			makeEvent('e1', 'Task Agent', 'thinking'),
			makeEvent('e2', 'Coder Agent', 'tool'),
			makeEvent('e3', 'Task Agent', 'text'),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].agentLabel).toBe('Task Agent');
		expect(blocks[0].events).toHaveLength(1);
		expect(blocks[2].agentLabel).toBe('Task Agent');
		expect(blocks[2].events).toHaveLength(1);
	});

	it('marks a block terminal when it contains a result event', () => {
		const events = [
			makeEvent('e1', 'Task Agent', 'text'),
			makeResultEvent('e2', 'Task Agent', 'success'),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].isTerminal).toBe(true);
	});

	it('marks block terminal for error result as well', () => {
		const events = [makeResultEvent('e1', 'Task Agent', 'error')];
		const blocks = buildLogicalBlocks(events);
		expect(blocks[0].isTerminal).toBe(true);
	});

	it('does not mark non-result events as terminal', () => {
		const events = [
			makeEvent('e1', 'Task Agent', 'thinking'),
			makeEvent('e2', 'Task Agent', 'tool'),
			makeEvent('e3', 'Task Agent', 'rate_limit', { isError: true }),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks[0].isTerminal).toBe(false);
	});

	it('assigns the first event id as the block id', () => {
		const events = [
			makeEvent('first-event', 'Task Agent', 'text'),
			makeEvent('second-event', 'Task Agent', 'tool'),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks[0].id).toBe('first-event');
	});

	it('treats agent label comparison as case-insensitive and trims whitespace', () => {
		const events = [
			makeEvent('e1', 'Task Agent', 'thinking'),
			makeEvent('e2', '  task agent  ', 'tool'), // extra whitespace, different case
		];
		const blocks = buildLogicalBlocks(events);
		// Normalised to same key → single block
		expect(blocks).toHaveLength(1);
		expect(blocks[0].events).toHaveLength(2);
	});

	it('treats a subagent sequence as one block (same agent label)', () => {
		// All Coder Agent events (spawned sub-agent) → single logical block
		const events = [
			makeEvent('c1', 'Coder Agent', 'thinking'),
			makeEvent('c2', 'Coder Agent', 'tool'),
			makeEvent('c3', 'Coder Agent', 'text'),
			makeEvent('c4', 'Coder Agent', 'result', { resultSubtype: 'success' }),
		];
		const blocks = buildLogicalBlocks(events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].events).toHaveLength(4);
		expect(blocks[0].isTerminal).toBe(true);
	});
});

// ── applyCompactVisibilityRules ───────────────────────────────────────────────

function makeBlock(id: string, agentLabel: string, isTerminal = false): CompactLogicalBlock {
	return {
		id,
		agentLabel,
		events: [],
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

	it('always includes terminal blocks even when outside the last-N window', () => {
		// 5 blocks; terminal at position 0 (outside last-3 window)
		const blocks = [
			makeBlock('b1', 'A', true), // terminal, outside window
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C'),
			makeBlock('b4', 'D'),
			makeBlock('b5', 'E'),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		// Last 3: b3,b4,b5 PLUS terminal b1
		expect(result.map((b) => b.id)).toEqual(['b1', 'b3', 'b4', 'b5']);
	});

	it('includes terminal block already within the last-N window (no duplication)', () => {
		const blocks = [
			makeBlock('b1', 'A'),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C', true), // terminal, inside window
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		// All 3 fit in the window; no duplication
		expect(result).toHaveLength(3);
	});

	it('preserves chronological order when terminal blocks are injected', () => {
		const blocks = [
			makeBlock('b1', 'A', true), // terminal, early
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C'),
			makeBlock('b4', 'D'),
			makeBlock('b5', 'E'),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		const ids = result.map((b) => b.id);
		// b1 should come before b3 (chronological order preserved)
		expect(ids.indexOf('b1')).toBeLessThan(ids.indexOf('b3'));
	});

	it('handles multiple terminal blocks across the list', () => {
		const blocks = [
			makeBlock('b1', 'A', true),
			makeBlock('b2', 'B'),
			makeBlock('b3', 'C', true),
			makeBlock('b4', 'D'),
			makeBlock('b5', 'E'),
			makeBlock('b6', 'F'),
		];
		const result = applyCompactVisibilityRules(blocks, 3);
		// Last 3: b4,b5,b6 PLUS terminals b1,b3
		expect(result.map((b) => b.id)).toEqual(['b1', 'b3', 'b4', 'b5', 'b6']);
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

	it('only considers the last block, ignoring earlier ones', () => {
		const blocks = [
			makeBlock('b1', 'A', false), // non-terminal
			makeBlock('b2', 'B', true), // terminal
		];
		// Last block is terminal → no indicator
		expect(shouldShowRunningIndicator(blocks)).toBe(false);
	});

	it('shows indicator when multiple blocks end with non-terminal', () => {
		const blocks = [
			makeBlock('b1', 'A', true), // terminal (but not last)
			makeBlock('b2', 'B', false), // non-terminal (last)
		];
		expect(shouldShowRunningIndicator(blocks)).toBe(true);
	});
});
