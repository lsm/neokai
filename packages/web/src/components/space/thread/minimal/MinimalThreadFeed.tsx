/**
 * MinimalThreadFeed
 *
 * Production renderer for the "minimal" task thread mode. Maps the same
 * `parsedRows` the compact feed receives into Slack-style turn rows:
 *
 *   ▢ AGENT  9:42 PM
 *   ▢   3 tool calls · 8 messages · 47m
 *   ▢   <last assistant message>           ← completed turn (no rail)
 *
 *   ▢ AGENT  9:43 PM
 *   ▢ │ 12 tools · 2m 22s
 *   ▢ │ Bash: bun run typecheck
 *   ▢ │ Read: packages/.../space-task-runtime.ts
 *   ▢ │ Grep: provisionExistingSpaces
 *   ▢ │ Bash: git status
 *   ▢ │ • Running…                         ← active turn (coloured rail)
 *
 * No tool cards, no thinking blocks, no bracket rails. Reuses turn grouping
 * (`buildLogicalBlocks`) from the compact reducer so behaviour stays
 * consistent between modes.
 */

import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { isSDKAssistantMessage, isToolUseBlock } from '@neokai/shared/sdk/type-guards';
import { useEffect, useState } from 'preact/hooks';
import MarkdownRenderer from '../../../chat/MarkdownRenderer.tsx';
import {
	buildLogicalBlocks,
	type CompactLogicalBlock,
	isUserRow,
} from '../compact/space-task-compact-reducer';
import { getAgentColor } from '../space-task-thread-agent-colors';
import type { ParsedThreadRow } from '../space-task-thread-events';
import {
	agentInitial,
	formatClock,
	formatDuration,
	getToolDarkColor,
	shortAgentName,
} from './minimal-mock-data';

interface MinimalThreadFeedProps {
	parsedRows: ParsedThreadRow[];
	/**
	 * Whether the underlying agent session is currently executing. When true
	 * AND the last logical block is non-terminal, that block renders as the
	 * active turn (coloured rail, live tool roster, ticking elapsed clock).
	 */
	isAgentActive?: boolean;
}

interface ToolCallEntry {
	tool: string;
	preview: string;
}

interface CompletedFeedTurn {
	state: 'completed';
	id: string;
	agent: string;
	startedAt: number;
	durationSec: number;
	toolCalls: number;
	messages: number;
	lastMessage: string;
	fallback: boolean;
}

interface ActiveFeedTurn {
	state: 'active';
	id: string;
	agent: string;
	startedAt: number;
	status: string;
	toolCalls: number;
	roster: ToolCallEntry[];
}

interface MessageFeedTurn {
	state: 'message';
	id: string;
	/** Human-readable sender label (e.g. "User", "Reviewer Agent", "Neo"). */
	fromLabel: string;
	/** Recipient agent label — the session this row belongs to. */
	toLabel: string;
	/** Rendered message text (markdown when not fallback). */
	body: string;
	bodyIsFallback: boolean;
	createdAt: number;
	/** True for synthetic agent→agent / system handoffs; false for human input. */
	isSynthetic: boolean;
}

type FeedTurn = CompletedFeedTurn | ActiveFeedTurn | MessageFeedTurn;

const PREVIEW_MAX_LEN = 80;
const ROSTER_MAX_ENTRIES = 4;

function oneLine(value: string, max = PREVIEW_MAX_LEN): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (!collapsed) return '';
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function getToolUseContentBlocks(row: ParsedThreadRow) {
	if (!row.message || !isSDKAssistantMessage(row.message)) return [];
	const content = (row.message as { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is { type: 'tool_use'; name: string; input?: unknown } =>
		isToolUseBlock(block as never)
	);
}

function previewFromInput(input: Record<string, unknown>): string {
	const command = typeof input.command === 'string' ? input.command : '';
	if (command) return oneLine(command);
	const filePath = typeof input.file_path === 'string' ? input.file_path : '';
	if (filePath) return oneLine(filePath);
	const path = typeof input.path === 'string' ? input.path : '';
	if (path) return oneLine(path);
	const pattern = typeof input.pattern === 'string' ? input.pattern : '';
	if (pattern) return oneLine(pattern);
	const url = typeof input.url === 'string' ? input.url : '';
	if (url) return oneLine(url);
	const description = typeof input.description === 'string' ? input.description : '';
	if (description) return oneLine(description);
	const keys = Object.keys(input);
	if (keys.length === 0) return '';
	// Fallback: show first key=value summary so the entry isn't blank.
	const firstKey = keys[0];
	const firstVal = input[firstKey];
	if (typeof firstVal === 'string') return oneLine(`${firstKey}: ${firstVal}`);
	return `${firstKey}: …`;
}

function extractToolCallEntries(rows: ParsedThreadRow[], maxEntries: number): ToolCallEntry[] {
	const entries: ToolCallEntry[] = [];
	for (const row of rows) {
		for (const block of getToolUseContentBlocks(row)) {
			const input =
				typeof block.input === 'object' && block.input !== null
					? (block.input as Record<string, unknown>)
					: {};
			entries.push({ tool: block.name, preview: previewFromInput(input) });
		}
	}
	return entries.slice(-maxEntries);
}

function countToolCalls(rows: ParsedThreadRow[]): number {
	let n = 0;
	for (const row of rows) {
		n += getToolUseContentBlocks(row).length;
	}
	return n;
}

function extractLastAssistantText(rows: ParsedThreadRow[]): { text: string; fallback: boolean } {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (!row.message || !isSDKAssistantMessage(row.message)) continue;
		const content = (row.message as { message?: { content?: unknown } }).message?.content;
		if (!Array.isArray(content)) continue;
		const texts = content
			.filter(
				(block): block is { type: 'text'; text: string } =>
					typeof (block as { type?: unknown }).type === 'string' &&
					(block as { type?: unknown }).type === 'text' &&
					typeof (block as { text?: unknown }).text === 'string'
			)
			.map((block) => block.text.trim())
			.filter((s) => s.length > 0);
		if (texts.length > 0) return { text: texts.join('\n\n'), fallback: false };
	}
	const tailFallback = rows[rows.length - 1]?.fallbackText ?? '';
	return { text: tailFallback, fallback: true };
}

function buildCompletedTurn(
	block: CompactLogicalBlock,
	rows: ParsedThreadRow[],
	turnId: string
): CompletedFeedTurn {
	const startedAt = rows[0].createdAt;
	const lastRow = rows[rows.length - 1];
	const durationMs = Math.max(0, lastRow.createdAt - startedAt);
	const durationSec = Math.max(1, Math.round(durationMs / 1000));
	const { text, fallback } = extractLastAssistantText(rows);
	return {
		state: 'completed',
		id: turnId,
		agent: block.agentLabel,
		startedAt,
		durationSec,
		toolCalls: countToolCalls(rows),
		messages: rows.length,
		lastMessage: text,
		fallback,
	};
}

function buildActiveTurn(
	block: CompactLogicalBlock,
	rows: ParsedThreadRow[],
	turnId: string
): ActiveFeedTurn {
	return {
		state: 'active',
		id: turnId,
		agent: block.agentLabel,
		startedAt: rows[0].createdAt,
		status: 'Running…',
		toolCalls: countToolCalls(rows),
		roster: extractToolCallEntries(rows, ROSTER_MAX_ENTRIES),
	};
}

/**
 * Resolve the sender of a user-type SDK message.
 *
 * The origin field comes in two shapes in the wild:
 * - Legacy string form ("neo" / "system") — what the daemon currently writes
 *   to the DB for non-human-typed messages.
 * - Typed `SDKMessageOrigin` object form (`{ kind: 'peer'/'channel'/... }`) —
 *   what the SDK itself emits for richer provenance.
 *
 * For synthetic / replay messages without origin info, we fall back to the
 * previous agent block's label — agent→agent handoffs almost always come from
 * whichever agent ran immediately before the recipient. It's a heuristic, but
 * it produces meaningful labels in the common case where origin metadata is
 * missing.
 */
function extractSenderLabel(
	message: SDKMessage,
	previousAgentLabel: string | null
): { label: string; isSynthetic: boolean } {
	const m = message as SDKMessage & {
		origin?: unknown;
		isSynthetic?: boolean;
		isReplay?: boolean;
	};
	const isSynthetic = !!m.isSynthetic || !!m.isReplay;
	const origin = m.origin;

	if (typeof origin === 'string') {
		if (origin === 'neo') return { label: 'Neo', isSynthetic: true };
		if (origin === 'system') return { label: 'System', isSynthetic: true };
		if (origin === 'human') return { label: 'User', isSynthetic: false };
	}

	if (typeof origin === 'object' && origin !== null) {
		const o = origin as { kind?: string; from?: string; name?: string; server?: string };
		if (o.kind === 'human') return { label: 'User', isSynthetic: false };
		if (o.kind === 'peer') {
			return { label: o.name ?? o.from ?? previousAgentLabel ?? 'Peer Agent', isSynthetic: true };
		}
		if (o.kind === 'channel') return { label: o.server ?? 'Channel', isSynthetic: true };
		if (o.kind === 'task-notification') return { label: 'Task', isSynthetic: true };
		if (o.kind === 'coordinator') return { label: 'Coordinator', isSynthetic: true };
	}

	if (isSynthetic && previousAgentLabel) {
		return { label: previousAgentLabel, isSynthetic: true };
	}
	if (isSynthetic) return { label: 'Agent', isSynthetic: true };
	return { label: 'User', isSynthetic: false };
}

/**
 * Extract a user-type message's text body. Concatenates all text blocks; falls
 * back to the row's fallbackText when the message can't be parsed.
 */
function extractUserMessageText(row: ParsedThreadRow): { body: string; fallback: boolean } {
	if (!row.message) {
		return { body: row.fallbackText ?? '', fallback: true };
	}
	const apiMessage = (row.message as { message?: { content?: unknown } }).message;
	const content = apiMessage?.content;
	if (typeof content === 'string') return { body: content.trim(), fallback: false };
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const b = block as { type?: unknown; text?: unknown };
			if (b.type === 'text' && typeof b.text === 'string') {
				parts.push(b.text);
			}
		}
		const joined = parts.join('\n\n').trim();
		return { body: joined, fallback: false };
	}
	return { body: '', fallback: false };
}

function buildMessageTurn(
	row: ParsedThreadRow,
	previousAgentLabel: string | null
): MessageFeedTurn {
	const { label: fromLabel, isSynthetic } = extractSenderLabel(
		row.message ?? ({} as SDKMessage),
		previousAgentLabel
	);
	const { body, fallback } = extractUserMessageText(row);
	return {
		state: 'message',
		id: `msg-${String(row.id)}`,
		fromLabel,
		toLabel: row.label,
		body,
		bodyIsFallback: fallback,
		createdAt: row.createdAt,
		isSynthetic,
	};
}

/**
 * Build the ordered turn list for the minimal feed.
 *
 * Walks `buildLogicalBlocks` output but splits each block on user-type rows:
 * - Each user/synthetic row becomes its own `MessageFeedTurn`, surfaced as a
 *   distinct row showing FROM → TO and the message body.
 * - Consecutive non-user rows (assistant + result) form `CompletedFeedTurn`s.
 * - The very last agent turn upgrades to `ActiveFeedTurn` when the underlying
 *   block is non-terminal AND `isAgentActive` is true.
 */
function buildFeedTurns(parsedRows: ParsedThreadRow[], isAgentActive: boolean): FeedTurn[] {
	const blocks = buildLogicalBlocks(parsedRows);
	if (blocks.length === 0) return [];

	const turns: FeedTurn[] = [];
	// Store mutable cross-iteration state in an object so TS doesn't
	// over-narrow the closure-captured fields to `never` after the loop.
	const trailing: {
		idx: number;
		rows: ParsedThreadRow[];
		block: CompactLogicalBlock | null;
	} = { idx: -1, rows: [], block: null };
	let previousAgentLabel: string | null = null;

	for (const block of blocks) {
		let pendingAgentRows: ParsedThreadRow[] = [];
		const flushAgent = () => {
			if (pendingAgentRows.length === 0) return;
			const turnId = `${block.id}:${String(pendingAgentRows[0].id)}`;
			turns.push(buildCompletedTurn(block, pendingAgentRows, turnId));
			trailing.idx = turns.length - 1;
			trailing.rows = pendingAgentRows;
			trailing.block = block;
			pendingAgentRows = [];
		};

		for (const row of block.rows) {
			if (isUserRow(row)) {
				flushAgent();
				turns.push(buildMessageTurn(row, previousAgentLabel));
				continue;
			}
			pendingAgentRows.push(row);
		}
		flushAgent();
		previousAgentLabel = block.agentLabel;
	}

	// Upgrade the last agent turn to active when the trailing block is
	// non-terminal and the session is reportedly running.
	if (isAgentActive && trailing.idx >= 0 && trailing.block && !trailing.block.isTerminal) {
		const completed = turns[trailing.idx] as CompletedFeedTurn;
		turns[trailing.idx] = buildActiveTurn(trailing.block, trailing.rows, completed.id);
	}

	return turns;
}

/**
 * Force a re-render every second so live-elapsed values derived from
 * `Date.now() - startedAt` stay current. Single timer per component
 * instance — cheap, and only mounted while there is an active turn.
 */
function useSecondsTick(): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((n) => (n + 1) | 0), 1000);
		return () => clearInterval(id);
	}, []);
}

/* ── visual building blocks ──────────────────────────────────────────────── */

function PulseDot({ color }: { color: string }) {
	return (
		<span
			class="inline-block h-2 w-2 rounded-full minimal-thread-live-dot shrink-0"
			style={{ backgroundColor: color }}
		/>
	);
}

function StatusPill({ color, status }: { color: string; status: string }) {
	return (
		<span class="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium">
			<PulseDot color={color} />
			<span style={{ color }}>{status}</span>
		</span>
	);
}

function RosterEntry({ entry, isLatest }: { entry: ToolCallEntry; isLatest: boolean }) {
	const toolColor = getToolDarkColor(entry.tool);
	return (
		<div
			class={`flex items-baseline gap-2 font-mono text-xs leading-5 ${
				isLatest ? 'minimal-thread-roster-fade-in' : ''
			}`}
			data-testid="minimal-thread-roster-entry"
		>
			<span class={`${toolColor} font-semibold shrink-0`}>{entry.tool}:</span>
			<span class={`truncate ${isLatest ? 'text-gray-100' : 'text-gray-400'}`}>
				{entry.preview}
			</span>
		</div>
	);
}

function CompletedBody({ turn }: { turn: CompletedFeedTurn }) {
	return (
		<>
			<div class="text-[11px] text-gray-500 mt-0.5">
				{turn.toolCalls} {turn.toolCalls === 1 ? 'tool call' : 'tool calls'} · {turn.messages}{' '}
				{turn.messages === 1 ? 'message' : 'messages'} · {formatDuration(turn.durationSec)}
			</div>
			{turn.lastMessage ? (
				<div class="mt-1.5 text-sm text-gray-100 leading-relaxed [&_a]:text-blue-400">
					{turn.fallback ? (
						<p class="whitespace-pre-wrap break-words">{turn.lastMessage}</p>
					) : (
						<MarkdownRenderer content={turn.lastMessage} />
					)}
				</div>
			) : null}
		</>
	);
}

function ActiveBody({ turn, color }: { turn: ActiveFeedTurn; color: string }) {
	useSecondsTick();
	const elapsedSec = Math.max(0, Math.round((Date.now() - turn.startedAt) / 1000));
	return (
		<div
			class="mt-1.5 pl-3 border-l-2"
			style={{ borderColor: color }}
			data-testid="minimal-thread-active-rail"
		>
			<div class="text-[11px] text-gray-500 mt-0.5">
				{turn.toolCalls} {turn.toolCalls === 1 ? 'tool' : 'tools'} · {formatDuration(elapsedSec)}
			</div>
			{turn.roster.length > 0 ? (
				<div class="mt-2 space-y-0.5">
					{turn.roster.map((entry, i) => (
						<RosterEntry
							key={`${entry.tool}-${i}`}
							entry={entry}
							isLatest={i === turn.roster.length - 1}
						/>
					))}
				</div>
			) : null}
			<div class="mt-1.5">
				<StatusPill color={color} status={turn.status} />
			</div>
		</div>
	);
}

function AgentTurnRow({ turn }: { turn: CompletedFeedTurn | ActiveFeedTurn }) {
	const color = getAgentColor(turn.agent);
	const initial = agentInitial(turn.agent);
	return (
		<div
			class="flex gap-3"
			data-testid="minimal-thread-turn"
			data-agent-label={turn.agent}
			data-agent-color={color}
			data-turn-state={turn.state}
		>
			<div
				class="h-9 w-9 shrink-0 rounded-md flex items-center justify-center text-sm font-bold text-dark-950"
				style={{ backgroundColor: color }}
				aria-hidden="true"
			>
				{initial}
			</div>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-3">
					<span class="font-semibold" style={{ color }}>
						{shortAgentName(turn.agent)}
					</span>
					<span class="text-xs text-gray-500">{formatClock(turn.startedAt)}</span>
				</div>
				{turn.state === 'active' ? (
					<ActiveBody turn={turn} color={color} />
				) : (
					<CompletedBody turn={turn} />
				)}
			</div>
		</div>
	);
}

function MessageTurnRow({ turn }: { turn: MessageFeedTurn }) {
	const fromColor = getAgentColor(turn.fromLabel);
	const toColor = getAgentColor(turn.toLabel);
	const fromInitial = agentInitial(turn.fromLabel);
	return (
		<div
			class="flex gap-3"
			data-testid="minimal-thread-turn"
			data-agent-label={turn.toLabel}
			data-agent-color={toColor}
			data-turn-state="message"
			data-from-label={turn.fromLabel}
			data-to-label={turn.toLabel}
		>
			<div
				class="h-9 w-9 shrink-0 rounded-md flex items-center justify-center text-sm font-bold text-dark-950"
				style={{ backgroundColor: fromColor }}
				aria-hidden="true"
			>
				{fromInitial}
			</div>
			<div class="min-w-0 flex-1" data-testid="minimal-thread-message-turn">
				<div class="flex items-center gap-2 flex-wrap">
					<span class="font-semibold" style={{ color: fromColor }}>
						{shortAgentName(turn.fromLabel)}
					</span>
					<span class="text-gray-600 text-xs" aria-hidden="true">
						→
					</span>
					<span class="text-xs uppercase tracking-wider font-medium" style={{ color: toColor }}>
						{shortAgentName(turn.toLabel)}
					</span>
					{turn.isSynthetic ? (
						<span
							class="text-[10px] px-1.5 py-px rounded bg-dark-800 text-gray-500 uppercase tracking-wider"
							title="System-generated handoff (not human input)"
						>
							handoff
						</span>
					) : null}
					<span class="text-xs text-gray-500">{formatClock(turn.createdAt)}</span>
				</div>
				{turn.body ? (
					<div class="mt-1.5 text-sm text-gray-100 leading-relaxed [&_a]:text-blue-400">
						{turn.bodyIsFallback ? (
							<p class="whitespace-pre-wrap break-words">{turn.body}</p>
						) : (
							<MarkdownRenderer content={turn.body} />
						)}
					</div>
				) : (
					<div class="mt-1.5 text-xs text-gray-500 italic">(empty message)</div>
				)}
			</div>
		</div>
	);
}

function MinimalTurnRow({ turn }: { turn: FeedTurn }) {
	if (turn.state === 'message') return <MessageTurnRow turn={turn} />;
	return <AgentTurnRow turn={turn} />;
}

/* ── public component ────────────────────────────────────────────────────── */

export function MinimalThreadFeed({ parsedRows, isAgentActive = false }: MinimalThreadFeedProps) {
	const turns = buildFeedTurns(parsedRows, isAgentActive);
	if (turns.length === 0) return null;

	return (
		<>
			<style>{ANIMATIONS_CSS}</style>
			<div class="px-4 py-4 space-y-6" data-testid="space-task-event-feed-minimal">
				{turns.map((turn) => (
					<MinimalTurnRow key={turn.id} turn={turn} />
				))}
			</div>
		</>
	);
}

/* ── animations (scoped via local <style> tag) ───────────────────────────── */

const ANIMATIONS_CSS = `
@keyframes minimal-thread-roster-fade-in-kf {
	from { opacity: 0; transform: translateY(2px); }
	to   { opacity: 1; transform: translateY(0); }
}
.minimal-thread-roster-fade-in {
	animation: minimal-thread-roster-fade-in-kf 250ms ease-out;
}
@keyframes minimal-thread-live-pulse-kf {
	0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.0); transform: scale(1); }
	50%      { box-shadow: 0 0 0 4px rgba(255,255,255,0.08); transform: scale(1.08); }
}
.minimal-thread-live-dot {
	animation: minimal-thread-live-pulse-kf 1.6s ease-in-out infinite;
}
`;
