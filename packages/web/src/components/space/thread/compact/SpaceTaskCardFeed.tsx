import { useMemo } from 'preact/hooks';
import {
	isSDKRateLimitEvent,
	isSDKResultMessage,
	isSDKSystemInit,
	isSDKUserMessage,
} from '@neokai/shared/sdk/type-guards';
import type { ParsedThreadRow } from '../space-task-thread-events';
import type { UseMessageMapsResult } from '../../../../hooks/useMessageMaps';
import { SDKMessageRenderer } from '../../../sdk/SDKMessageRenderer';
import { getAgentColor } from '../space-task-thread-agent-colors';
import { spaceOverlayAgentNameSignal, spaceOverlaySessionIdSignal } from '../../../../lib/signals';
import { SpaceSystemInitCard } from './SpaceSystemInitCard';
import {
	buildLogicalBlocks,
	applyCompactVisibilityRules,
	applyBlockRowVisibility,
	resolveRunningBlockIndex,
	type CompactLogicalBlock,
} from './space-task-compact-reducer';

interface SpaceTaskCardFeedProps {
	parsedRows: ParsedThreadRow[];
	/** Current task ID — accepted for API parity with the legacy feed; not used internally. */
	taskId: string;
	maps: UseMessageMapsResult;
	/**
	 * Whether the agent session backing this task is currently active (not idle /
	 * completed / failed / interrupted). When false the running-border animation
	 * is suppressed even if non-terminal blocks are present.
	 */
	isAgentActive: boolean;
}

// ── Row-level pre-filter (structural noise only) ─────────────────────────────

function isEmptyUserRow(row: ParsedThreadRow): boolean {
	if (!row.message || !isSDKUserMessage(row.message)) return false;
	const content = (row.message as { message?: { content?: unknown } }).message?.content;
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
 * Pre-filter parsed rows before block grouping. Removes structural noise that
 * should never appear in the compact view. Result rows are NOT filtered here —
 * they are always preserved so terminal blocks remain visible.
 *
 * `system:init` rows ARE kept — they render as a small "Session Started" card
 * via `SpaceSystemInitCard` so multi-agent session starts stay legible.
 *
 * User-message filtering distinguishes two kinds:
 *   - Synthetic (isSynthetic=true): agent→agent handoff messages injected by
 *     the orchestrator into a sub-agent session. These are internal plumbing
 *     and must NOT surface in the compact view.
 *   - Real (isSynthetic falsy): messages sent by a human from the UI or via
 *     RPC. These are always shown.
 */
function preFilterRows(rows: ParsedThreadRow[]): ParsedThreadRow[] {
	return rows.filter((row) => {
		if (!row.message) return true; // raw fallback rows stay
		if (isSDKRateLimitEvent(row.message)) {
			const info = row.message.rate_limit_info;
			if (info?.status !== 'rejected') return false;
		}
		// Drop synthetic user messages — these are agent→agent task injections,
		// not human input. Real user messages (isSynthetic falsy) are kept.
		if (
			isSDKUserMessage(row.message) &&
			(row.message as { isSynthetic?: boolean }).isSynthetic === true
		) {
			return false;
		}
		if (isEmptyUserRow(row)) return false;
		return true;
	});
}

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

/**
 * Pick the authoritative session id for a block — the first row carrying a
 * non-null sessionId. Most rows within a block share the same sessionId, but
 * some fallback rows (e.g. raw parse-failure rows) may have null, so we skip
 * over them and return null only when every row lacks a session.
 */
function getBlockSessionId(block: CompactLogicalBlock): string | null {
	for (const row of block.rows) {
		if (row.sessionId) return row.sessionId;
	}
	return null;
}

function getTerminalBadge(block: CompactLogicalBlock): 'DONE' | 'ERROR' | null {
	if (!block.isTerminal) return null;
	const hasError = block.rows.some((row) => {
		if (!row.message || !isSDKResultMessage(row.message)) return false;
		return row.message.subtype !== 'success';
	});
	return hasError ? 'ERROR' : 'DONE';
}

/** Max rows shown per block before older ones are hidden. */
const MAX_ROWS_PER_BLOCK = 3;

// ── Per-block rendering ──────────────────────────────────────────────────────

interface BlockSectionProps {
	block: CompactLogicalBlock;
	maps: UseMessageMapsResult;
	/** True only for the last visible block when the thread is still running. */
	isRunningBlock: boolean;
}

function renderRow(row: ParsedThreadRow, maps: UseMessageMapsResult, isRunning = false) {
	if (!row.message) {
		return (
			<div class="text-xs text-gray-500 font-mono py-1" data-testid="compact-fallback-row">
				{row.fallbackText ?? 'Unparseable row'}
			</div>
		);
	}
	// System init messages get a dedicated small card — the normal SDK pipeline
	// would render a plain inline pill in task context.
	if (isSDKSystemInit(row.message)) {
		return <SpaceSystemInitCard message={row.message} />;
	}
	const msgUuid = (row.message as { uuid?: string }).uuid ?? '';
	return (
		<SDKMessageRenderer
			message={row.message}
			sessionId={row.sessionId ?? undefined}
			toolResultsMap={maps.toolResultsMap}
			toolInputsMap={maps.toolInputsMap}
			subagentMessagesMap={maps.subagentMessagesMap}
			sessionInfo={maps.sessionInfoMap.get(msgUuid)}
			taskContext={true}
			isRunning={isRunning}
		/>
	);
}

/**
 * Renders a single logical block as a small agent-identity header followed by
 * each row's SDK message delegated to `SDKMessageRenderer`.
 *
 * This matches the normal-session rendering pipeline exactly — a tool use
 * becomes a `ToolResultCard` (bordered card with chevron), a thinking block
 * becomes a `ThinkingBlock` (bordered card), a Task tool becomes a
 * `SubagentBlock`, and a result becomes a `SDKResultMessage` card. No outer
 * wrapper is added around the group; each message renders its own chrome.
 *
 * The agent-identity header is the only space-task-specific addition — it
 * labels each logical block's agent (e.g. TASK, CODER, REVIEWER) so the
 * multi-agent context is visible at a glance.
 *
 * When `isRunningBlock` is true (the session is still executing and this is
 * the last non-terminal block), only the last row is forwarded `isRunning=true`
 * so exactly one inner non-terminal component (ThinkingBlock, ToolResultCard,
 * SubagentBlock, or assistant text bubble) renders the animated arc border.
 * Terminal result cards (SDKResultMessage) never receive the arc because
 * terminal blocks are never selected as the running block.
 */
function BlockSection({ block, maps, isRunningBlock }: BlockSectionProps) {
	const agentColor = getAgentColor(block.agentLabel);
	const terminalBadge = getTerminalBadge(block);
	const blockSessionId = getBlockSessionId(block);
	const isClickable = blockSessionId !== null;

	// Trim this turn to its most-recent rows; show the hidden-count under the header.
	const { visibleRows, hiddenRowCount: hiddenInBlock } = applyBlockRowVisibility(
		block,
		MAX_ROWS_PER_BLOCK
	);
	const lastVisibleIdx = visibleRows.length - 1;

	const handleOpenAgentOverlay = () => {
		if (!blockSessionId) return;
		spaceOverlayAgentNameSignal.value = block.agentLabel;
		spaceOverlaySessionIdSignal.value = blockSessionId;
	};

	const handleHeaderKeyDown = (e: KeyboardEvent) => {
		if (!isClickable) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleOpenAgentOverlay();
		}
	};

	return (
		<div data-testid="compact-block">
			{/* Agent identity header — clickable to open the agent slide-out.
			    Taller padding (min-h-[32px], py-2) makes the name a comfortable
			    click/tap target while keeping the small text style. */}
			<div
				class={
					'flex items-center gap-2 px-2 py-2 min-h-[32px] rounded ' +
					(isClickable
						? 'cursor-pointer hover:bg-gray-800/40 active:bg-gray-800/60 transition-colors focus:outline-none focus:bg-gray-800/40 focus:ring-1 focus:ring-gray-700'
						: '')
				}
				data-testid="compact-block-header"
				data-clickable={isClickable ? '1' : '0'}
				role={isClickable ? 'button' : undefined}
				tabIndex={isClickable ? 0 : undefined}
				aria-label={isClickable ? `Open ${block.agentLabel} session details` : undefined}
				onClick={isClickable ? handleOpenAgentOverlay : undefined}
				onKeyDown={isClickable ? handleHeaderKeyDown : undefined}
			>
				<span
					class="w-2 h-2 rounded-full flex-shrink-0"
					style={{ backgroundColor: agentColor }}
					aria-hidden="true"
				/>
				<span
					class="text-[11px] uppercase tracking-[0.16em] font-mono font-medium flex-shrink-0"
					style={{ color: agentColor }}
				>
					{shortAgentLabel(block.agentLabel)}
				</span>
				{terminalBadge && (
					<span
						class={
							'ml-1 text-[10px] uppercase tracking-[0.14em] font-mono border rounded px-1 py-px flex-shrink-0 ' +
							(terminalBadge === 'ERROR'
								? 'text-red-300 border-red-800/80 bg-red-950/30'
								: 'text-emerald-300 border-emerald-800/80 bg-emerald-950/30')
						}
						data-testid="compact-block-badge"
					>
						{terminalBadge}
					</span>
				)}
			</div>

			{/* Per-block hidden-message count — shown under the agent name */}
			{hiddenInBlock > 0 && (
				<div
					class="px-1 pb-0.5 text-[10px] font-mono"
					style={{ color: agentColor, opacity: 0.55 }}
					data-testid="compact-block-hidden-count"
				>
					↑ {hiddenInBlock} earlier {hiddenInBlock === 1 ? 'message' : 'messages'}
				</div>
			)}

			{/* Siderail + body */}
			<div class="flex gap-2 pl-1 pb-1" data-testid="compact-block-body">
				{/* Vertical colored siderail */}
				<div
					class="w-0.5 rounded-full flex-shrink-0 self-stretch opacity-40"
					style={{ backgroundColor: agentColor }}
					aria-hidden="true"
				/>
				{/* Message rows — last MAX_ROWS_PER_BLOCK only */}
				<div class="flex-1 min-w-0 space-y-1">
					{visibleRows.map((row, rowIdx) => {
						// Only the last row of the running block gets the animated border.
						const isRunningRow = isRunningBlock && rowIdx === lastVisibleIdx;
						if (isRunningRow) {
							return (
								<div key={String(row.id)} data-testid="compact-running-block">
									{renderRow(row, maps, true)}
								</div>
							);
						}
						return <div key={String(row.id)}>{renderRow(row, maps, false)}</div>;
					})}
				</div>
			</div>
		</div>
	);
}

// ── Main feed component ──────────────────────────────────────────────────────

/**
 * SpaceTaskCardFeed — compact renderer for Space task threads that reuses the
 * normal-session rendering pipeline.
 *
 * Each parsed row's SDK message is delegated to `SDKMessageRenderer` (the same
 * router used by `ChatContainer`), which dispatches to the appropriate block
 * component — `ToolResultCard`, `ThinkingBlock`, `SubagentBlock`,
 * `SDKResultMessage`, `SDKAssistantMessage`, `SDKUserMessage`, etc. — so the
 * visual language matches a normal chat session exactly.
 *
 * The only space-task-specific additions are:
 *   - Visibility rules from `space-task-compact-reducer` (max 3 recent logical
 *     blocks, terminal blocks always kept).
 *   - A small agent-identity header above each logical block so multi-agent
 *     context (Task / Coder / Reviewer / …) is readable at a glance.
 *   - `.running-block` chrome wrapping the last individual event message of
 *     the tail block while the thread is still executing (non-terminal last block).
 */
export function SpaceTaskCardFeed({
	parsedRows,
	taskId: _taskId,
	maps,
	isAgentActive,
}: SpaceTaskCardFeedProps) {
	const visibleBlocks = useMemo(() => {
		const filtered = preFilterRows(parsedRows);
		const allBlocks = buildLogicalBlocks(filtered);
		return applyCompactVisibilityRules(allBlocks, 3);
	}, [parsedRows]);

	// Running border: shown ONLY when the agent session is actively executing
	// AND the last visible block is non-terminal AND its last row is a tool_use
	// event (the agent is currently invoking a tool — read/write/bash/MCP call).
	// Plain text and thinking-only rows do not qualify. See
	// `resolveRunningBlockIndex` for the full rule set.
	const runningBlockIdx = useMemo(
		() => resolveRunningBlockIndex(visibleBlocks, isAgentActive),
		[isAgentActive, visibleBlocks]
	);

	return (
		// Horizontal padding (px-4) matches SpaceTaskPane's header padding so the
		// compact thread content aligns with the pane title bar above it.
		<div class="space-y-2 px-4 py-2" data-testid="space-task-event-feed-compact">
			{visibleBlocks.map((block, idx) => (
				<BlockSection
					key={block.id}
					block={block}
					maps={maps}
					isRunningBlock={idx === runningBlockIdx}
				/>
			))}
		</div>
	);
}
