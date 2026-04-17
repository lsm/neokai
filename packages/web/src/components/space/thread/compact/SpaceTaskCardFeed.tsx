import { useMemo, useState } from 'preact/hooks';
import { cn } from '../../../../lib/utils';
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

interface SpaceTaskCardFeedProps {
	events: SpaceTaskThreadEvent[];
	taskId: string;
	maps: UseMessageMapsResult;
}

// ── Event pre-filter (structural noise only) ──────────────────────────────────

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
 * Pre-filter events before block grouping. Removes structural noise that
 * should never appear in any compact view. Terminal result events are NOT
 * filtered here — they are always preserved so terminal blocks remain visible.
 */
function preFilterEvents(events: SpaceTaskThreadEvent[]): SpaceTaskThreadEvent[] {
	return events.filter((event) => {
		if (event.kind === 'system' && event.systemSubtype === 'init') return false;
		if (event.kind === 'rate_limit' && !event.isError) return false;
		if (isEmptyUserEvent(event)) return false;
		return true;
	});
}

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

// ── Chevron icon ──────────────────────────────────────────────────────────────

/**
 * Expand/collapse chevron.
 *
 * Matches the visual language of ToolResultCard / SubagentBlock / ThinkingBlock
 * (inline SVG with `M19 9l-7 7-7-7`). Collapsed state rotates −90° so the
 * chevron points right (`>`); expanded state rotates to 0° (`v`).
 */
function Chevron({ expanded }: { expanded: boolean }) {
	return (
		<svg
			class={cn(
				'w-4 h-4 text-gray-500 transition-transform flex-shrink-0',
				expanded ? '' : '-rotate-90'
			)}
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
			aria-hidden="true"
		>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
		</svg>
	);
}

// ── Block card ────────────────────────────────────────────────────────────────

interface BlockCardProps {
	block: CompactLogicalBlock;
	taskId: string;
	maps: UseMessageMapsResult;
	/** True only for the last visible block when the thread is still running. */
	isRunningBlock: boolean;
}

function getTerminalBadge(block: CompactLogicalBlock): string | null {
	if (!block.isTerminal) return null;
	const hasError = block.events.some(
		(e) => e.kind === 'result' && (e.isError || e.resultSubtype !== 'success')
	);
	return hasError ? 'ERROR' : 'DONE';
}

/**
 * Renders a single logical block as a bordered rounded card with an
 * expand/collapse chevron header. The visual language matches ToolResultCard /
 * SubagentBlock / ThinkingBlock — `border rounded-lg overflow-hidden` dark card,
 * full-width clickable header, chevron with `transition-transform`.
 *
 * Expand/collapse rules:
 *   - Running block → expanded by default (user is watching live activity)
 *   - Terminal block → expanded by default (user needs to see the final result)
 *   - Other blocks → collapsed by default (user can expand on demand)
 *
 * Body content stays in the DOM even when collapsed (toggled via `hidden`
 * class), keeping existing DOM-based tests stable and enabling lossless CSS
 * transitions.
 */
function BlockCard({ block, taskId, maps, isRunningBlock }: BlockCardProps) {
	const agentColor = getAgentColor(block.agentLabel);
	const terminalBadge = getTerminalBadge(block);
	const defaultExpanded = isRunningBlock || block.isTerminal;
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	const eventCount = block.events.length;
	const eventCountLabel = eventCount === 1 ? '1 event' : `${eventCount} events`;

	const cardInner = (
		<div>
			<button
				type="button"
				onClick={() => setIsExpanded((prev) => !prev)}
				aria-expanded={isExpanded}
				data-testid="compact-card-header"
				class={cn(
					'w-full flex items-center justify-between gap-2 px-3 py-2 text-left',
					'hover:bg-white/5 transition-colors'
				)}
			>
				<div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
					{/* Agent color dot — visual anchor matching the card's agent identity. */}
					<span
						class="w-2 h-2 rounded-full flex-shrink-0"
						style={{ backgroundColor: agentColor }}
						aria-hidden="true"
					/>
					{/* Agent label — colored, monospace, uppercase, 'agent' suffix stripped. */}
					<span
						class="text-[11px] uppercase tracking-[0.16em] font-mono font-medium flex-shrink-0"
						style={{ color: agentColor }}
					>
						{shortAgentLabel(block.agentLabel)}
					</span>
					{/* Event count — light context for collapsed cards. */}
					<span class="text-[11px] text-gray-500 font-mono flex-shrink-0">{eventCountLabel}</span>
					{terminalBadge && (
						<span
							class={cn(
								'ml-1 text-[10px] uppercase tracking-[0.14em] font-mono border rounded px-1 py-px flex-shrink-0',
								terminalBadge === 'ERROR'
									? 'text-red-300 border-red-800/80 bg-red-950/30'
									: 'text-emerald-300 border-emerald-800/80 bg-emerald-950/30'
							)}
							data-testid="compact-card-badge"
						>
							{terminalBadge}
						</span>
					)}
				</div>
				<Chevron expanded={isExpanded} />
			</button>
			{/* Body: kept in DOM when collapsed (toggled via `hidden`) so existing
			    DOM-based tests stay stable and CSS transitions can be added later. */}
			<div
				class={cn('border-t border-zinc-800/80 bg-black/10', !isExpanded && 'hidden')}
				data-testid="compact-card-body"
			>
				<div class="px-2 py-1.5 space-y-0.5">
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
		</div>
	);

	if (isRunningBlock) {
		return (
			<div class="running-block" data-testid="compact-running-block">
				<div class="running-block-inner overflow-hidden">{cardInner}</div>
			</div>
		);
	}

	return (
		<div
			class="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950/60"
			data-testid="compact-card"
		>
			{cardInner}
		</div>
	);
}

// ── Main feed component ───────────────────────────────────────────────────────

/**
 * SpaceTaskCardFeed — card-style compact renderer for Space task threads.
 *
 * Each logical block (consecutive same-agent events, or a subagent session)
 * renders as a bordered rounded card with an expand/collapse chevron header —
 * matching the visual language of ToolResultCard / SubagentBlock / ThinkingBlock.
 *
 * Visibility rules (delegated to space-task-compact-reducer):
 *   - Shows at most 3 logical blocks.
 *   - Terminal blocks (containing a result event) are always visible, even when
 *     they fall outside the last-3 window — this may cause the rendered count
 *     to exceed 3.
 *   - The last visible block gets a clockwise animated chrome border when the
 *     thread is still running (non-terminal).
 *
 * Event rendering inside each card reuses `SpaceTaskThreadEventRow` in compact
 * mode, which transitively delegates to SDKMessageRenderer for text/user events
 * and to ToolIcon/summary rows for tool/thinking/system events — matching the
 * visual language of normal-session render blocks.
 */
export function SpaceTaskCardFeed({ events, taskId, maps }: SpaceTaskCardFeedProps) {
	const visibleBlocks = useMemo(() => {
		const filtered = preFilterEvents(events);
		const blocks = buildLogicalBlocks(filtered);
		return applyCompactVisibilityRules(blocks, 3);
	}, [events]);

	const isRunning = useMemo(() => shouldShowRunningIndicator(visibleBlocks), [visibleBlocks]);

	return (
		<div class="space-y-2 py-1 px-1" data-testid="space-task-event-feed-compact">
			{visibleBlocks.map((block, idx) => {
				const isLastBlock = idx === visibleBlocks.length - 1;
				return (
					<BlockCard
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
