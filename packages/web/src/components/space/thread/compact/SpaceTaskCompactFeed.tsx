import { useMemo } from 'preact/hooks';
import type { SpaceTaskThreadEvent } from '../space-task-thread-events';
import type { UseMessageMapsResult } from '../../../../hooks/useMessageMaps';
import { SpaceTaskThreadEventRow } from '../SpaceTaskThreadEventRow';
import { getAgentColor } from '../space-task-thread-agent-colors';
import {
	buildLogicalBlocks,
	applyCompactVisibilityRules,
	shouldShowRunningIndicator,
	type CompactLogicalBlock,
} from './space-task-compact-reducer';

interface SpaceTaskCompactFeedProps {
	events: SpaceTaskThreadEvent[];
	taskId: string;
	maps: UseMessageMapsResult;
}

function isEmptyUserEvent(event: SpaceTaskThreadEvent): boolean {
	if (event.kind !== 'user') return false;
	const content = (event.message as { message?: { content?: unknown } } | null | undefined)?.message
		?.content;
	if (typeof content === 'string') return content.trim().length === 0;
	if (Array.isArray(content)) {
		return !content.some((block) => {
			if (!block || typeof block !== 'object') return false;
			const b = block as { type?: unknown; text?: unknown };
			return b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0;
		});
	}
	return true;
}

/**
 * Pre-filter events before block grouping.
 *
 * Removes structural noise that should never appear in any compact view.
 * Terminal result events (kind === 'result') are deliberately NOT filtered here —
 * they are always preserved so terminal blocks remain visible.
 */
function preFilterEvents(events: SpaceTaskThreadEvent[]): SpaceTaskThreadEvent[] {
	return events.filter((event) => {
		// Remove system-init noise (session bootstrap, not user-visible activity).
		if (event.kind === 'system' && event.systemSubtype === 'init') return false;
		// Remove non-error rate-limit notices (informational, not actionable).
		if (event.kind === 'rate_limit' && !event.isError) return false;
		// Remove empty user message placeholders.
		if (isEmptyUserEvent(event)) return false;
		return true;
	});
}

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

// ── Logical block view ────────────────────────────────────────────────────────

interface LogicalBlockViewProps {
	block: CompactLogicalBlock;
	taskId: string;
	maps: UseMessageMapsResult;
	/** True only for the last visible block when the thread is still running. */
	isRunningBlock: boolean;
}

function LogicalBlockView({ block, taskId, maps, isRunningBlock }: LogicalBlockViewProps) {
	const agentColor = getAgentColor(block.agentLabel);

	const content = (
		<div class="px-1 py-0.5">
			{/* Agent identity header — preserves visual agent identity in compact mode. */}
			<span
				class="inline-block pt-1 pb-0.5 text-[11px] tracking-[0.16em] font-mono uppercase"
				style={{ color: agentColor }}
			>
				{shortAgentLabel(block.agentLabel)}
			</span>
			{/* Events belonging to this logical block. */}
			<div class="space-y-0.5">
				{block.events.map((event, idx) => (
					<SpaceTaskThreadEventRow
						key={`${event.id}-${idx}`}
						event={event}
						mode="compact"
						showTaskTitle={event.taskId !== taskId}
						maps={maps}
						showAgentLabel={false}
					/>
				))}
			</div>
		</div>
	);

	if (isRunningBlock) {
		return (
			<div class="running-block" data-testid="compact-running-block">
				<div class="running-block-inner">{content}</div>
			</div>
		);
	}

	return <div>{content}</div>;
}

// ── Main feed component ───────────────────────────────────────────────────────

/**
 * SpaceTaskCompactFeed — compact renderer for Space task threads.
 *
 * Visibility rules:
 * - Shows at most 3 logical blocks (consecutive same-agent event groups).
 * - Always includes terminal blocks (result events) even if they fall outside
 *   the 3-block window, which may cause the rendered count to exceed 3.
 * - Renders a clockwise animated chrome border on the last visible block when
 *   that block is non-terminal (task still executing).
 *
 * Reuses SpaceTaskThreadEventRow for individual event display, sharing the same
 * visual language as the legacy feed and normal-session message rendering.
 */
export function SpaceTaskCompactFeed({ events, taskId, maps }: SpaceTaskCompactFeedProps) {
	const visibleBlocks = useMemo(() => {
		const filtered = preFilterEvents(events);
		const blocks = buildLogicalBlocks(filtered);
		return applyCompactVisibilityRules(blocks, 3);
	}, [events]);

	const isRunning = useMemo(() => shouldShowRunningIndicator(visibleBlocks), [visibleBlocks]);

	return (
		<div class="space-y-2 py-1" data-testid="space-task-event-feed-compact">
			{visibleBlocks.map((block, idx) => {
				const isLastBlock = idx === visibleBlocks.length - 1;
				return (
					<LogicalBlockView
						key={block.id}
						block={block}
						taskId={taskId}
						maps={maps}
						isRunningBlock={isRunning && isLastBlock}
					/>
				);
			})}
		</div>
	);
}
