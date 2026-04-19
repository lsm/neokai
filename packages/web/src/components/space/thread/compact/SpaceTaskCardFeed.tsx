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

interface TurnGroup {
	id: string;
	index: number;
	block: AgentBlock;
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

function buildTurns(rows: ParsedThreadRow[]): TurnGroup[] {
	const blocks = buildAgentTurnBlocks(rows);
	return blocks.map((block, index) => ({
		id: `turn-${index + 1}-${block.id}`,
		index: index + 1,
		block,
	}));
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
			data-testid="compact-block"
			data-agent-label={block.label}
			data-agent-color={block.color}
		>
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
				aria-label={isClickable ? `Open ${block.label} session details` : undefined}
				onClick={isClickable ? handleOpenAgentOverlay : undefined}
				onKeyDown={isClickable ? handleHeaderKeyDown : undefined}
			>
				<span
					class="w-2 h-2 rounded-full flex-shrink-0"
					style={{ backgroundColor: block.color }}
					aria-hidden="true"
				/>
				<span
					class="text-[11px] uppercase tracking-[0.16em] font-mono font-medium flex-shrink-0"
					style={{ color: block.color }}
				>
					{shortAgentLabel(block.label)}
				</span>
			</div>

			<div class="flex gap-2 pl-1 pb-1" data-testid="compact-block-body">
				<div
					class="w-0.5 rounded-full flex-shrink-0 self-stretch opacity-40"
					style={{ backgroundColor: block.color }}
					aria-hidden="true"
					data-testid="compact-block-siderail"
				/>
				<div class="flex-1 min-w-0 space-y-1">
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
								<div
									key={`hidden-divider-${key}`}
									class="relative py-1.5"
									data-testid="compact-turn-hidden-divider"
								>
									<div class="border-t border-dark-700" aria-hidden="true" />
									<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
										<span class="px-2 text-[11px] uppercase tracking-[0.12em] text-gray-500 bg-dark-900">
											{`${hiddenCount} earlier ${hiddenCount === 1 ? 'message' : 'messages'}`}
										</span>
									</div>
								</div>,
							];
						}
						return [rowEl];
					})}
				</div>
			</div>
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
	const turns = useMemo(() => buildTurns(parsedRows), [parsedRows]);

	const runningRowId = useMemo(() => {
		if (!isAgentActive) return null;
		const tailLast = parsedRows[parsedRows.length - 1];
		if (!tailLast || !rowHasToolUse(tailLast)) return null;
		return String(tailLast.id);
	}, [isAgentActive, parsedRows]);

	return (
		<div class="space-y-2 px-4 py-2" data-testid="space-task-event-feed-compact">
			{turns.map((turn) => {
				const block = turn.block;
				const blockHiddenCount = getBlockHiddenCount(block.rows);
				const blockPinnedInitialUserRowId =
					blockHiddenCount > 0 ? getBlockPinnedInitialUserRowId(block.rows) : null;
				return (
					<div key={turn.id} class="space-y-1.5" data-testid="compact-turn-group">
						<div class="relative py-1" data-testid="compact-turn-divider">
							<div class="border-t border-dark-700" aria-hidden="true" />
							<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
								<span class="px-2 text-[11px] uppercase tracking-[0.12em] text-gray-500 bg-dark-900">
									{`Turn ${turn.index}`}
								</span>
							</div>
						</div>
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
