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
 * Rules (applied together):
 * 1. Show at most `maxBlocks` of the most-recent blocks.
 * 2. Always show terminal blocks (blocks containing a result message), even
 *    when they fall outside the `maxBlocks` window — this may cause the
 *    rendered count to exceed `maxBlocks`.
 *
 * @param allBlocks  All logical blocks in chronological order.
 * @param maxBlocks  Maximum blocks to show before terminal-block addition (default: 3).
 */
export function applyCompactVisibilityRules(
	allBlocks: CompactLogicalBlock[],
	maxBlocks = 3
): CompactLogicalBlock[] {
	if (allBlocks.length <= maxBlocks) return allBlocks;

	const lastNStart = Math.max(0, allBlocks.length - maxBlocks);
	const lastNSet = new Set<number>();
	for (let i = lastNStart; i < allBlocks.length; i++) {
		lastNSet.add(i);
	}

	return allBlocks.filter((block, idx) => lastNSet.has(idx) || block.isTerminal);
}

/**
 * Whether the running-state indicator should be displayed.
 *
 * Returns `true` when `visibleBlocks` is non-empty and the last block is
 * non-terminal (i.e. no result message has appeared yet — the task is still
 * executing). The indicator is scoped to the last visible block only.
 */
export function shouldShowRunningIndicator(visibleBlocks: CompactLogicalBlock[]): boolean {
	if (visibleBlocks.length === 0) return false;
	const lastBlock = visibleBlocks[visibleBlocks.length - 1];
	return !lastBlock.isTerminal;
}
