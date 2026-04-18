import {
	isSDKAssistantMessage,
	isSDKResultMessage,
	isToolUseBlock,
} from '@neokai/shared/sdk/type-guards';
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

/**
 * Returns `true` when the row is an assistant SDK message whose content
 * contains at least one `tool_use` block.
 *
 * Used by the compact feed to decide whether the running-border indicator
 * should be shown: we only animate when the last visible event is a tool
 * invocation (where the agent is visibly "doing something"), not a plain
 * text bubble or thinking block.
 */
export function rowHasToolUse(row: ParsedThreadRow): boolean {
	if (!row.message || !isSDKAssistantMessage(row.message)) return false;
	const content = (row.message as { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => isToolUseBlock(block));
}

/**
 * Row-level visibility result for a single logical block.
 */
export interface BlockRowVisibility {
	/** Rows to render for this block, in chronological order. */
	visibleRows: ParsedThreadRow[];
	/** Count of rows trimmed off the front of the block. */
	hiddenRowCount: number;
}

/**
 * Trim a logical block's rows to the last `maxRows` so each turn stays compact
 * even when the agent emitted many events.
 *
 * Returns the visible tail plus the count of rows that were hidden from the
 * front. The caller renders `visibleRows` and, when `hiddenRowCount > 0`,
 * surfaces the count under the block's agent header so the user knows there
 * are earlier messages in this turn that were collapsed.
 *
 * The tail is always kept — this guarantees the running-border row and
 * terminal result row (which are always at the end of a block) remain visible.
 */
export function applyBlockRowVisibility(
	block: CompactLogicalBlock,
	maxRows = 3
): BlockRowVisibility {
	if (maxRows <= 0) {
		return { visibleRows: [], hiddenRowCount: block.rows.length };
	}
	if (block.rows.length <= maxRows) {
		return { visibleRows: block.rows, hiddenRowCount: 0 };
	}
	const visibleRows = block.rows.slice(block.rows.length - maxRows);
	return { visibleRows, hiddenRowCount: block.rows.length - maxRows };
}

/**
 * Resolve the running-block index for the compact feed.
 *
 * The running-border animation is shown ONLY when:
 *   1. The agent session is actively executing (`isAgentActive`), AND
 *   2. There is a non-terminal visible block at the tail, AND
 *   3. The last row of that block is a `tool_use` event — i.e. the agent is
 *      currently invoking a tool (read file, bash, MCP call, …). Plain text
 *      messages, thinking blocks, and result cards do not qualify.
 *
 * Returns the index of the tail block when all conditions hold, or -1 when
 * the running indicator should be hidden.
 */
export function resolveRunningBlockIndex(
	visibleBlocks: CompactLogicalBlock[],
	isAgentActive: boolean
): number {
	if (!isAgentActive) return -1;
	const idx = getRunningBlockIndex(visibleBlocks);
	if (idx < 0) return -1;
	const block = visibleBlocks[idx];
	const lastRow = block.rows[block.rows.length - 1];
	if (!lastRow || !rowHasToolUse(lastRow)) return -1;
	return idx;
}
