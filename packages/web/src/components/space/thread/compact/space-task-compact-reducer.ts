import type { SpaceTaskThreadEvent } from '../space-task-thread-events';

/**
 * A logical block groups consecutive thread events from the same agent.
 *
 * In the compact renderer:
 * - A subagent session's entire contribution (all its events) counts as one block.
 * - Terminal blocks (containing a result event) are always visible regardless of
 *   the block-count limit.
 * - At most MAX_COMPACT_BLOCKS of the most-recent non-terminal blocks are shown.
 */
export interface CompactLogicalBlock {
	/** Stable ID derived from the first event in the block. */
	id: string;
	/** Agent label for this block (e.g. "Task Agent", "Coder Agent"). */
	agentLabel: string;
	/** Events in this block, in chronological order. */
	events: SpaceTaskThreadEvent[];
	/**
	 * True when the block contains at least one result event (kind === 'result').
	 * Terminal blocks are always included in the compact view regardless of
	 * the block limit.
	 */
	isTerminal: boolean;
}

function normalizeAgentKey(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Group consecutive thread events by agent label into logical blocks.
 *
 * Consecutive events from the same agent form one block. When a different agent
 * begins, a new block starts. A block is marked terminal when it contains at
 * least one result event (kind === 'result').
 *
 * Subagent sequences — all events emitted by a spawned sub-agent session — form
 * a single block because they share the same agent label.
 */
export function buildLogicalBlocks(events: SpaceTaskThreadEvent[]): CompactLogicalBlock[] {
	const blocks: CompactLogicalBlock[] = [];

	for (const event of events) {
		const last = blocks[blocks.length - 1];
		const isSameAgent =
			last !== undefined && normalizeAgentKey(last.agentLabel) === normalizeAgentKey(event.label);

		if (isSameAgent) {
			last.events.push(event);
			if (event.kind === 'result') last.isTerminal = true;
		} else {
			blocks.push({
				id: event.id,
				agentLabel: event.label,
				events: [event],
				isTerminal: event.kind === 'result',
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
 * 2. Always show terminal blocks (blocks containing a result event), even when
 *    they fall outside the `maxBlocks` window — this may cause the rendered
 *    count to exceed `maxBlocks`.
 *
 * @param allBlocks  All logical blocks in chronological order.
 * @param maxBlocks  Maximum blocks to show before terminal-block addition (default: 3).
 */
export function applyCompactVisibilityRules(
	allBlocks: CompactLogicalBlock[],
	maxBlocks = 3
): CompactLogicalBlock[] {
	if (allBlocks.length <= maxBlocks) return allBlocks;

	// Compute the "last N" index window.
	const lastNStart = Math.max(0, allBlocks.length - maxBlocks);
	const lastNSet = new Set<number>();
	for (let i = lastNStart; i < allBlocks.length; i++) {
		lastNSet.add(i);
	}

	// Keep: any block within the last-N window, OR any terminal block outside it.
	return allBlocks.filter((block, idx) => lastNSet.has(idx) || block.isTerminal);
}

/**
 * Whether the running-state indicator should be displayed.
 *
 * Returns `true` when `visibleBlocks` is non-empty and the last block is
 * non-terminal (i.e. no result event has appeared yet — the task is still
 * executing). The indicator is scoped to the last visible block only.
 */
export function shouldShowRunningIndicator(visibleBlocks: CompactLogicalBlock[]): boolean {
	if (visibleBlocks.length === 0) return false;
	const lastBlock = visibleBlocks[visibleBlocks.length - 1];
	return !lastBlock.isTerminal;
}
