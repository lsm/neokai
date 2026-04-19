import { useMemo } from 'preact/hooks';
import { isSDKResultMessage, isSDKSystemInit } from '@neokai/shared/sdk/type-guards';
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
	rows: ParsedThreadRow[];
}

function normalizeAgentKey(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shortAgentLabel(label: string): string {
	return label.replace(/\s+agent$/i, '').toUpperCase();
}

function isTurnTerminalRow(row: ParsedThreadRow): boolean {
	if (!row.message) return false;
	return isSDKResultMessage(row.message);
}

function buildTurns(rows: ParsedThreadRow[]): TurnGroup[] {
	if (rows.length === 0) return [];

	const turns: TurnGroup[] = [];
	let currentRows: ParsedThreadRow[] = [];
	let currentStartId: string | number = rows[0].id;
	let turnIndex = 1;

	for (const row of rows) {
		if (currentRows.length === 0) {
			currentStartId = row.id;
		}

		currentRows.push(row);

		if (isTurnTerminalRow(row)) {
			turns.push({
				id: `turn-${turnIndex}-${String(currentStartId)}`,
				index: turnIndex,
				rows: currentRows,
			});
			turnIndex += 1;
			currentRows = [];
		}
	}

	if (currentRows.length > 0) {
		turns.push({
			id: `turn-${turnIndex}-${String(currentStartId)}`,
			index: turnIndex,
			rows: currentRows,
		});
	}

	return turns;
}

function buildAgentBlocks(rows: ParsedThreadRow[]): AgentBlock[] {
	if (rows.length === 0) return [];

	const blocks: AgentBlock[] = [];
	for (const row of rows) {
		const last = blocks[blocks.length - 1];
		const rowKey = `${normalizeAgentKey(row.label)}::${row.sessionId ?? ''}`;
		const lastKey =
			last === undefined ? null : `${normalizeAgentKey(last.label)}::${last.sessionId ?? ''}`;
		if (last && lastKey === rowKey) {
			last.rows.push(row);
			continue;
		}

		blocks.push({
			id: String(row.id),
			label: row.label,
			color: getAgentColor(row.label),
			sessionId: row.sessionId ?? null,
			rows: [row],
		});
	}

	return blocks;
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
	runningRowId: string | null
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
					{block.rows.map((row) => {
						const key = String(row.id);
						const rowNode = renderRow(row, maps, key === runningRowId);
						if (key === runningRowId) {
							return (
								<div key={key} data-testid="compact-running-block">
									{rowNode}
								</div>
							);
						}
						return <div key={key}>{rowNode}</div>;
					})}
				</div>
			</div>
		</div>
	);
}

/**
 * SpaceTaskCardFeed — compact renderer grouped by turn and then agent block.
 *
 * Rendering policy:
 * - Render whole history (no tail truncation).
 * - Group rows into "turns" using terminal result/error messages as boundaries.
 *   Turn N includes rows up to and including the terminal result/error row.
 * - Within each turn, group consecutive rows by agent/session into clickable
 *   agent blocks with color headers/siderails.
 */
export function SpaceTaskCardFeed({
	parsedRows,
	taskId: _taskId,
	maps,
	isAgentActive,
}: SpaceTaskCardFeedProps) {
	const turns = useMemo(() => buildTurns(parsedRows), [parsedRows]);
	const allRows = useMemo(() => turns.flatMap((turn) => turn.rows), [turns]);

	const runningRowId = useMemo(() => {
		if (!isAgentActive) return null;
		const tailLast = allRows[allRows.length - 1];
		if (!tailLast || !rowHasToolUse(tailLast)) return null;
		return String(tailLast.id);
	}, [isAgentActive, allRows]);

	return (
		<div class="space-y-2 px-4 py-2" data-testid="space-task-event-feed-compact">
			{turns.map((turn) => {
				const blocks = buildAgentBlocks(turn.rows);
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
						{blocks.map((block) => renderAgentBlock(block, maps, runningRowId))}
					</div>
				);
			})}
		</div>
	);
}
