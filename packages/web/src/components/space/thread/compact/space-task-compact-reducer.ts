import { isSDKResultMessage } from '@neokai/shared/sdk/type-guards';
import type { ParsedThreadRow } from '../space-task-thread-events';

/**
 * A logical block groups consecutive parsed thread rows from the same agent.
 *
 * The compact renderer feeds each row's full SDK message through
 * `SDKMessageRenderer` so the visual language matches normal chat sessions —
 * tool uses become `ToolResultCard`s, thinking becomes `ThinkingBlock`s,
 * sub-agent task calls become `SubagentBlock`s, etc.
 *
 * Grouping + visibility is still useful here:
 * - A sub-agent session's entire contribution (all its rows) counts as one block.
 * - Terminal blocks (containing a result message) are always visible regardless
 *   of the block-count limit.
 * - At most MAX_COMPACT_BLOCKS of the most-recent non-terminal blocks are shown.
 */
export interface CompactLogicalBlock {
	/** Stable ID derived from the first row in the block. */
	id: string;
	/** Agent label for this block (e.g. "Task Agent", "Coder Agent"). */
	agentLabel: string;
	/** Rows in this block, in chronological order. */
	rows: ParsedThreadRow[];
	/**
	 * True when the block contains at least one SDK result message.
	 * Terminal blocks are always included in the compact view regardless of
	 * the block limit.
	 */
	isTerminal: boolean;
}

function normalizeAgentKey(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowIsTerminal(row: ParsedThreadRow): boolean {
	return row.message !== null && isSDKResultMessage(row.message);
}

/**
 * Group consecutive parsed rows by agent label into logical blocks.
 *
 * Consecutive rows from the same agent form one block. When a different agent
 * begins, a new block starts. A block is marked terminal when it contains at
 * least one SDK result message.
 *
 * Sub-agent sequences — all rows emitted by a spawned sub-agent session — form
 * a single block because they share the same agent label.
 */
export function buildLogicalBlocks(rows: ParsedThreadRow[]): CompactLogicalBlock[] {
	const blocks: CompactLogicalBlock[] = [];

	for (const row of rows) {
		const last = blocks[blocks.length - 1];
		const isSameAgent =
			last !== undefined && normalizeAgentKey(last.agentLabel) === normalizeAgentKey(row.label);
		const terminal = rowIsTerminal(row);

		if (isSameAgent) {
			last.rows.push(row);
			if (terminal) last.isTerminal = true;
		} else {
			blocks.push({
				id: String(row.id),
				agentLabel: row.label,
				rows: [row],
				isTerminal: terminal,
			});
		}
	}

	return blocks;
}

/**
 * Apply compact visibility rules to a list of logical blocks.
 *
 * Algorithm:
 * 1. Identify the "terminal tail" — the contiguous run of terminal blocks at
 *    the very end of allBlocks. These are the task's final result/error ending
 *    blocks and are always shown regardless of the maxBlocks limit.
 * 2. From the remaining "body" (everything before the terminal tail), show the
 *    last `maxBlocks` blocks.
 * 3. Special case: if ALL blocks are terminal (task fully done), show only the
 *    last maxBlocks blocks.
 *
 * This correctly handles multi-iteration tasks where many historical DONE
 * blocks exist — only the most recent body blocks + the current terminal tail
 * are shown, not every historical terminal block.
 *
 * @param allBlocks  All logical blocks in chronological order.
 * @param maxBlocks  Maximum body blocks to show (default: 3).
 */
export function applyCompactVisibilityRules(
	allBlocks: CompactLogicalBlock[],
	maxBlocks = 3
): CompactLogicalBlock[] {
	if (allBlocks.length === 0) return [];
	if (allBlocks.length <= maxBlocks) return allBlocks;

	// Find the start of the terminal tail: the contiguous run of terminal blocks
	// at the very end. These "ending blocks" are always kept.
	let terminalTailStart = allBlocks.length;
	while (terminalTailStart > 0 && allBlocks[terminalTailStart - 1].isTerminal) {
		terminalTailStart--;
	}

	const terminalTail = allBlocks.slice(terminalTailStart);
	const body = allBlocks.slice(0, terminalTailStart);

	if (body.length === 0) {
		// All blocks are terminal (task fully done) — show last maxBlocks only.
		return allBlocks.slice(allBlocks.length - maxBlocks);
	}

	// Show the last maxBlocks blocks from the body, then append the terminal tail.
	const bodyWindow = body.slice(Math.max(0, body.length - maxBlocks));
	return [...bodyWindow, ...terminalTail];
}

/**
 * Whether the running-state indicator should be displayed.
 *
 * Returns `true` when `visibleBlocks` contains at least one non-terminal block
 * (the task is still executing). Use `getRunningBlockIndex` to find which
 * block should receive the animated chrome.
 */
export function shouldShowRunningIndicator(visibleBlocks: CompactLogicalBlock[]): boolean {
	return visibleBlocks.some((b) => !b.isTerminal);
}

/**
 * Returns the index of the last non-terminal block in `visibleBlocks`, or -1
 * if all blocks are terminal. This is the block that should receive the
 * animated running-state chrome.
 */
export function getRunningBlockIndex(visibleBlocks: CompactLogicalBlock[]): number {
	for (let i = visibleBlocks.length - 1; i >= 0; i--) {
		if (!visibleBlocks[i].isTerminal) return i;
	}
	return -1;
}
