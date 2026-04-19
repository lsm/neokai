import { useMemo } from 'preact/hooks';
import { isSDKSystemInit, isSDKUserMessage } from '@neokai/shared/sdk/type-guards';
import type { ParsedThreadRow } from '../space-task-thread-events';
import type { UseMessageMapsResult } from '../../../../hooks/useMessageMaps';
import { spaceOverlayAgentNameSignal, spaceOverlaySessionIdSignal } from '../../../../lib/signals';
import { SDKMessageRenderer } from '../../../sdk/SDKMessageRenderer';
import { getAgentColor } from '../space-task-thread-agent-colors';
import { SpaceSystemInitCard } from './SpaceSystemInitCard';
import { rowHasToolUse } from './space-task-compact-reducer';

interface SpaceTaskCardFeedProps {
	parsedRows: ParsedThreadRow[];
	/** Current task ID — accepted for API parity with the legacy feed; not used internally. */
	taskId: string;
	maps: UseMessageMapsResult;
	/**
	 * Whether the agent session backing this task is currently active (not idle /
	 * completed / failed / interrupted). Used to gate the running border on the
	 * last visible row when that row is a tool_use assistant message.
	 */
	isAgentActive: boolean;
}

interface AgentBlock {
	id: string;
	label: string;
	color: string;
	sessionId: string | null;
	rows: ParsedThreadRow[];
}

function normalizeAgentKey(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

function buildAgentTurnBlocks(rows: ParsedThreadRow[]): AgentBlock[] {
	if (rows.length === 0) return [];

	const grouped = new Map<
		string,
		AgentBlock & {
			startCreatedAt: number;
			startRowId: string;
			sequence: number;
		}
	>();
	let sequence = 0;

	for (const row of rows) {
		const sessionKey = row.sessionId ?? `label:${normalizeAgentKey(row.label)}`;
		const turnKey =
			typeof row.turnIndex === 'number' && Number.isFinite(row.turnIndex) ? row.turnIndex : 1;
		const key = `${sessionKey}::turn:${turnKey}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.rows.push(row);
			if (row.createdAt < existing.startCreatedAt) {
				existing.startCreatedAt = row.createdAt;
				existing.startRowId = String(row.id);
			}
			continue;
		}

		grouped.set(key, {
			id: String(row.id),
			label: row.label,
			color: getAgentColor(row.label),
			sessionId: row.sessionId ?? null,
			rows: [row],
			startCreatedAt: row.createdAt,
			startRowId: String(row.id),
			sequence: sequence++,
		});
	}

	return Array.from(grouped.values())
		.sort((a, b) => {
			if (a.startCreatedAt !== b.startCreatedAt) {
				return a.startCreatedAt - b.startCreatedAt;
			}
			return a.sequence - b.sequence;
		})
		.map(
			({
				startCreatedAt: _startCreatedAt,
				startRowId: _startRowId,
				sequence: _sequence,
				...block
			}) => block
		);
}

function getBlockHiddenCount(rows: ParsedThreadRow[]): number {
	let hiddenCount = 0;
	for (const row of rows) {
		const hidden = row.turnHiddenMessageCount ?? 0;
		if (hidden > hiddenCount) hiddenCount = hidden;
	}
	return hiddenCount;
}

function getBlockPinnedInitialUserRowId(rows: ParsedThreadRow[]): string | null {
	const initialUser = rows.find((row) => row.message !== null && isSDKUserMessage(row.message));
	return initialUser ? String(initialUser.id) : null;
}

function renderRow(row: ParsedThreadRow, maps: UseMessageMapsResult, isRunning = false) {
	if (!row.message) {
		return (
			<div class="text-xs text-gray-500 font-mono py-1" data-testid="compact-fallback-row">
				{row.fallbackText ?? 'Unparseable row'}
			</div>
		);
	}

	// Keep task init rows compact/expandable in task context.
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
			showSubagentMessages={true}
			isRunning={isRunning}
		/>
	);
}

function renderAgentBlock(
	block: AgentBlock,
	maps: UseMessageMapsResult,
	runningRowId: string | null,
	pinnedInitialUserRowId: string | null,
	hiddenCount: number
) {
	const isClickable = !!block.sessionId;

	const handleOpenAgentOverlay = () => {
		if (!block.sessionId) return;
		spaceOverlayAgentNameSignal.value = block.label;
		spaceOverlaySessionIdSignal.value = block.sessionId;
	};

	const handleHeaderKeyDown = (e: KeyboardEvent) => {
		if (!isClickable) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleOpenAgentOverlay();
		}
	};

	return (
		<div
			key={block.id}
			class="relative pt-2 pb-1"
			data-testid="compact-block"
			data-agent-label={block.label}
			data-agent-color={block.color}
		>
			{/* ⌐ bracket — single stroke that caps the top then runs down the side,
			    rounded at the inside corner so the arm curves smoothly into the rail. */}
			<div
				class="absolute top-0 left-0 bottom-1 border-l-2 border-t-2 rounded-tl-md pointer-events-none"
				style={{
					borderColor: block.color,
					width: 'clamp(96px, 30%, 180px)',
				}}
				aria-hidden="true"
				data-testid="compact-block-bracket"
			/>

			{renderAgentHeaderPill(block, isClickable, handleOpenAgentOverlay, handleHeaderKeyDown)}

			<div class="pl-4 pt-0.5 space-y-1" data-testid="compact-block-body">
				{block.rows.flatMap((row) => {
					const key = String(row.id);
					const rowNode = renderRow(row, maps, key === runningRowId);
					const rowEl =
						key === runningRowId ? (
							<div key={`row-${key}`} data-testid="compact-running-block">
								{rowNode}
							</div>
						) : (
							<div key={`row-${key}`}>{rowNode}</div>
						);
					if (
						hiddenCount > 0 &&
						pinnedInitialUserRowId !== null &&
						key === pinnedInitialUserRowId
					) {
						return [
							rowEl,
							renderHiddenDivider(
								key,
								hiddenCount,
								block.label,
								isClickable,
								handleOpenAgentOverlay
							),
						];
					}
					return [rowEl];
				})}
			</div>
		</div>
	);
}

function renderAgentHeaderPill(
	block: AgentBlock,
	isClickable: boolean,
	onOpen: () => void,
	onKeyDown: (e: KeyboardEvent) => void
) {
	const label = shortAgentLabel(block.label);
	// Pill fills the arm's width minus `m-2` on the left; right edge is flush.
	const pillBase =
		'flex items-center justify-center w-full px-2.5 py-1 rounded-full border text-[11px] uppercase tracking-[0.12em] font-mono font-semibold whitespace-nowrap transition-colors';
	const pillInteractive =
		'cursor-pointer border-dark-600 bg-dark-850 hover:border-gray-500 hover:bg-dark-800 focus:outline-none focus:ring-1 focus:ring-gray-500';
	const pillStatic = 'border-dark-700 bg-dark-850';

	const pill = !isClickable ? (
		<span class={`${pillBase} ${pillStatic}`} data-testid="compact-block-header" data-clickable="0">
			<span class="truncate" style={{ color: block.color }}>
				{label}
			</span>
		</span>
	) : (
		<button
			type="button"
			class={`${pillBase} ${pillInteractive}`}
			data-testid="compact-block-header"
			data-clickable="1"
			aria-label={`Open ${block.label} session details`}
			onClick={onOpen}
			onKeyDown={onKeyDown}
		>
			<span class="truncate" style={{ color: block.color }}>
				{label}
			</span>
		</button>
	);

	return (
		<div
			class="mt-1 pl-2 pr-0"
			style={{ width: 'clamp(96px, 30%, 180px)' }}
			data-testid="compact-block-header-slot"
		>
			{pill}
		</div>
	);
}

function renderHiddenDivider(
	rowKey: string,
	hiddenCount: number,
	agentLabel: string,
	isClickable: boolean,
	onOpen: () => void
) {
	const label = `${hiddenCount} earlier ${hiddenCount === 1 ? 'message' : 'messages'}`;
	const pillBase =
		'relative z-10 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] uppercase tracking-[0.12em] font-mono whitespace-nowrap transition-colors ';
	const pillInteractive =
		'cursor-pointer border-dark-600 bg-dark-850 text-gray-300 hover:border-gray-500 hover:bg-dark-800 hover:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-500';
	const pillStatic = 'border-dark-700 bg-dark-850 text-gray-400';
	return (
		<div
			key={`hidden-divider-${rowKey}`}
			class="relative flex items-center justify-center py-2"
			data-testid="compact-turn-hidden-divider"
		>
			<div
				class="absolute inset-x-0 top-1/2 border-t border-dashed border-dark-700"
				aria-hidden="true"
			/>
			{isClickable ? (
				<button
					type="button"
					class={pillBase + pillInteractive}
					onClick={onOpen}
					data-testid="compact-turn-hidden-divider-button"
					aria-label={`${label}. Open ${agentLabel} chat to view earlier messages.`}
				>
					<svg
						class="w-3 h-3"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M4 10l4-4 4 4" />
					</svg>
					<span>{label}</span>
					<span class="text-gray-500">· open chat</span>
				</button>
			) : (
				<span class={pillBase + pillStatic}>
					<svg
						class="w-3 h-3"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M4 10l4-4 4 4" />
					</svg>
					<span>{label}</span>
				</span>
			)}
		</div>
	);
}

/**
 * SpaceTaskCardFeed — compact renderer grouped by agent turn blocks.
 *
 * Rendering policy:
 * - Render the compact server-provided row set.
 * - Group rows by (agent session, turnIndex) so interleaved messages from the
 *   same agent turn are rendered in one block.
 * - Order blocks by turn start time (earliest row in each block).
 * - Render each block as a clickable agent card with color header/siderail.
 */
export function SpaceTaskCardFeed({
	parsedRows,
	taskId: _taskId,
	maps,
	isAgentActive,
}: SpaceTaskCardFeedProps) {
	const blocks = useMemo(() => buildAgentTurnBlocks(parsedRows), [parsedRows]);

	const runningRowId = useMemo(() => {
		if (!isAgentActive) return null;
		const tailLast = parsedRows[parsedRows.length - 1];
		if (!tailLast || !rowHasToolUse(tailLast)) return null;
		return String(tailLast.id);
	}, [isAgentActive, parsedRows]);

	return (
		<div class="px-4 py-2" data-testid="space-task-event-feed-compact">
			{blocks.map((block, index) => {
				const blockHiddenCount = getBlockHiddenCount(block.rows);
				const blockPinnedInitialUserRowId =
					blockHiddenCount > 0 ? getBlockPinnedInitialUserRowId(block.rows) : null;
				return (
					<div key={block.id} class={index > 0 ? 'mt-1' : ''} data-testid="compact-turn-group">
						{renderAgentBlock(
							block,
							maps,
							runningRowId,
							blockPinnedInitialUserRowId,
							blockHiddenCount
						)}
					</div>
				);
			})}
		</div>
	);
}
