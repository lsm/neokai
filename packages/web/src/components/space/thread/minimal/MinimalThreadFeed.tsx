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
import {
	isSDKAssistantMessage,
	isSDKResultMessage,
	isToolUseBlock,
} from '@neokai/shared/sdk/type-guards';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import MarkdownRenderer from '../../../chat/MarkdownRenderer.tsx';
import {
	buildAgentTurns,
	type CompactLogicalBlock,
	isUserRow,
} from '../compact/space-task-compact-reducer';
import { SpaceTaskThreadMessageActions } from '../SpaceTaskThreadMessageActions';
import { getAgentColor } from '../space-task-thread-agent-colors';
import type { ParsedThreadRow } from '../space-task-thread-events';
import { pushOverlayHistory } from '../../../../lib/router';
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
	/**
	 * Session id that produced this turn's reply text. Used by the
	 * "open in session" affordance so clicking the button lands the user
	 * on the right session even when multiple sessions are interleaved
	 * in the feed. Null when the underlying row had no resolvable session.
	 */
	sessionId: string | null;
	/**
	 * SDK message UUID of the row whose text was surfaced as `lastMessage`.
	 * Forwarded as `highlightMessageId` to the slide-over so that message
	 * is scrolled to + briefly highlighted on open. May be undefined when
	 * we fell back to `fallbackText` and no SDK message was available.
	 */
	highlightMessageUuid?: string;
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
	/** Recipient session id — same role as `CompletedFeedTurn.sessionId`. */
	sessionId: string | null;
	/** SDK message UUID, used to deep-link the slide-over. */
	highlightMessageUuid?: string;
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

/**
 * Extract the closing text for a turn, walking rows last-to-first.
 *
 * Two viable text sources:
 *   1. `assistant` rows — the model's `text` content blocks. Standard path.
 *   2. `result|success` rows — the SDK's end-of-exec envelope, whose top-level
 *      `result` string carries the agent's final reply. Crucial for turns where
 *      the agent emitted only `tool_use` / `thinking` blocks (e.g. Reviewer
 *      runs that verify with Bash and never write a textual reply mid-stream).
 *
 * We check both per row in walk order. Walking last-to-first naturally prefers
 * the result message when one exists, which is what we want — it's the
 * canonical "what the agent said" string for that exec session.
 *
 * Returns the surfaced row alongside the text so callers can build deep links
 * back to the original SDK message (sessionId + uuid) for the slide-over.
 */
function extractLastAssistantText(rows: ParsedThreadRow[]): {
	text: string;
	fallback: boolean;
	sourceRow: ParsedThreadRow | null;
} {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (!row.message) continue;

		// Result-success rows carry the agent's final reply on `.result`.
		if (isSDKResultMessage(row.message) && row.message.subtype === 'success') {
			const result = (row.message as { result?: unknown }).result;
			if (typeof result === 'string' && result.trim().length > 0) {
				return { text: result.trim(), fallback: false, sourceRow: row };
			}
			continue;
		}

		if (!isSDKAssistantMessage(row.message)) continue;
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
		if (texts.length > 0) return { text: texts.join('\n\n'), fallback: false, sourceRow: row };
	}
	const tail = rows[rows.length - 1] ?? null;
	const tailFallback = tail?.fallbackText ?? '';
	return { text: tailFallback, fallback: true, sourceRow: tail };
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
	const { text, fallback, sourceRow } = extractLastAssistantText(rows);
	const highlightSource = sourceRow ?? lastRow;
	const highlightUuid =
		highlightSource?.message &&
		typeof (highlightSource.message as { uuid?: unknown }).uuid === 'string'
			? ((highlightSource.message as { uuid: string }).uuid as string)
			: undefined;
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
		sessionId: highlightSource?.sessionId ?? lastRow.sessionId,
		highlightMessageUuid: highlightUuid,
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
	const highlightUuid =
		row.message && typeof (row.message as { uuid?: unknown }).uuid === 'string'
			? ((row.message as { uuid: string }).uuid as string)
			: undefined;
	return {
		state: 'message',
		id: `msg-${String(row.id)}`,
		fromLabel,
		toLabel: row.label,
		body,
		bodyIsFallback: fallback,
		createdAt: row.createdAt,
		isSynthetic,
		sessionId: row.sessionId,
		highlightMessageUuid: highlightUuid,
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
	const blocks = buildAgentTurns(parsedRows);
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

	// Drop empty completed turns. With result-message-aware text extraction in
	// place, the only way a completed turn ends up with no body is if it's an
	// agent-phase fragment that got cut off by another agent's rows before its
	// own exec's result message arrived — its actual reply lives in a sibling
	// turn from the same agent. Showing the fragment as its own header-only row
	// (e.g. "REVIEWER 12:29 PM · 3 messages · 9s" with nothing under it) is
	// noise; the reply is rendered in the sibling that holds the result text.
	return turns.filter((t) => {
		if (t.state !== 'completed') return true;
		return t.lastMessage.length > 0;
	});

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

/**
 * Body for a completed agent turn — wraps the meta-line + reply text in a
 * left-aligned chat bubble that sizes to content up to a max-width cap.
 *
 * Why bubble-style at all: agent replies are often long markdown blobs
 * (review summaries, hand-off briefs) that look like transcripts when
 * rendered as plain flush-left rows. A subtle bubble (`bg-dark-800`, one
 * shade lighter than the synthetic bubble's `bg-dark-900`) re-establishes
 * the conversational rhythm and differentiates "agent's own reply" from
 * "synthetic handoff" without competing with the human bubble's blue.
 *
 * Width strategy: stacked under the agent header (no avatar offset on the
 * left), so `w-fit` lets short replies hug their content, `max-w-full`
 * fills the row on mobile, and `md:max-w-[70%]` caps the width on desktop
 * to keep long markdown readable instead of stretching edge-to-edge.
 */
function CompletedBody({ turn }: { turn: CompletedFeedTurn }) {
	const openSession = turn.sessionId
		? () => {
				// `pushOverlayHistory` reads the highlight signal; passing the message
				// uuid scrolls the slide-over straight to this turn's surfaced reply.
				pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid);
			}
		: undefined;
	return (
		<div class="mt-1.5 w-fit max-w-full md:max-w-[70%]">
			<div
				class="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2"
				data-testid="minimal-thread-agent-bubble"
			>
				<div class="text-[11px] text-gray-500">
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
			</div>
			<SpaceTaskThreadMessageActions
				timestamp={turn.startedAt}
				copyText={turn.lastMessage}
				align="left"
				onOpenSession={openSession}
			/>
		</div>
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

/**
 * Agent turn — Slack-style stacked layout. The header (avatar + name +
 * timestamp-when-active) sits on its own row; the body (bubble or active
 * rail) drops below the header at the full container width, aligned with
 * the avatar's left edge.
 *
 * Why stacked instead of avatar-on-the-left-of-body: agent replies are
 * frequently long markdown blobs. With the body indented under a flex
 * column to the right of the avatar, the bubble is forced into a narrower
 * sub-column (~48px lost to the avatar + gap) AND the legacy 85% cap left
 * dead space on the right. Stacking lets the body use the full row width
 * on mobile and feels closer to Slack/Reddit/Discord post layouts than
 * iMessage chat bubbles — a better fit for "agent post with long output".
 */
function AgentTurnRow({ turn }: { turn: CompletedFeedTurn | ActiveFeedTurn }) {
	const color = getAgentColor(turn.agent);
	const initial = agentInitial(turn.agent);
	return (
		<div
			data-testid="minimal-thread-turn"
			data-agent-label={turn.agent}
			data-agent-color={color}
			data-turn-state={turn.state}
		>
			{/* Header — avatar, agent name, and (active turns only) live clock. */}
			<div class="flex items-center gap-3">
				<div
					class="h-9 w-9 shrink-0 rounded-md flex items-center justify-center text-sm font-bold text-dark-950"
					style={{ backgroundColor: color }}
					aria-hidden="true"
				>
					{initial}
				</div>
				<span class="font-semibold" style={{ color }}>
					{shortAgentName(turn.agent)}
				</span>
				{/* Active turns keep the header timestamp — they don't have an
				    actions row below (no copy button while running). Completed
				    turns surface time + copy under the bubble via
				    SpaceTaskThreadMessageActions, so the header timestamp would
				    duplicate that. */}
				{turn.state === 'active' ? (
					<span class="text-xs text-gray-500">{formatClock(turn.startedAt)}</span>
				) : null}
			</div>
			{/* Body — full-width on mobile, capped on desktop for readability. */}
			{turn.state === 'active' ? (
				<ActiveBody turn={turn} color={color} />
			) : (
				<CompletedBody turn={turn} />
			)}
		</div>
	);
}

/**
 * Human user input — iMessage-style blue bubble, right-aligned. No header
 * decoration: the user IS the human, the recipient is implicit (this is the
 * recipient agent's session view).
 */
function HumanMessageTurn({ turn }: { turn: MessageFeedTurn }) {
	const recipientColor = getAgentColor(turn.toLabel);
	return (
		<div
			class="flex justify-end"
			data-testid="minimal-thread-turn"
			data-turn-state="message"
			data-message-kind="human"
			data-agent-label={turn.toLabel}
			data-agent-color={recipientColor}
			data-from-label={turn.fromLabel}
			data-to-label={turn.toLabel}
		>
			<div class="max-w-[85%] md:max-w-[70%] w-auto">
				<div
					class="bg-blue-500 text-white rounded-[20px] px-4 py-2 leading-relaxed break-words"
					data-testid="minimal-thread-human-bubble"
				>
					{turn.body ? (
						<p class="whitespace-pre-wrap break-words">{turn.body}</p>
					) : (
						<p class="opacity-70 italic">(empty message)</p>
					)}
				</div>
				<div class="text-xs text-gray-500 text-right mt-1">{formatClock(turn.createdAt)}</div>
			</div>
		</div>
	);
}

/**
 * Synthetic / agent→agent handoff — blockquote-style. A thick purple left
 * bar replaces the card chrome the assistant bubble uses, giving synthetic
 * messages clear visual contrast: the assistant's reply is "speech in a
 * card", the synthetic message is "a quoted-in voice from elsewhere."
 *
 * Right-aligned within the parent (matches the iMessage-style human bubble
 * placement so "incoming to this session" is consistent across both
 * non-assistant message kinds), with:
 *   • Caption row above the body: small icon + `Synthetic` label + FROM → TO
 *     route badge.
 *   • Body collapsed to ~20 lines with a gradient fade against the page bg
 *     and a `Show more` / `Show less` toggle.
 *   • Action row below: timestamp + copy + open-in-session buttons.
 */

// Default visible height for synthetic message bodies before the user expands.
const SYNTHETIC_PREVIEW_LINE_COUNT = 20;
// Approximate rendered line height for `text-sm` prose with `leading-relaxed`
// (matches the global `.prose p { line-height: 1.7 }` rule in styles.css for
// 14px body text → ~24px per line). Used to gate the "Show more" button.
const SYNTHETIC_LINE_HEIGHT_PX = 24;

function SyntheticMessageTurn({ turn }: { turn: MessageFeedTurn }) {
	const fromColor = getAgentColor(turn.fromLabel);
	const toColor = getAgentColor(turn.toLabel);
	const fromShort = shortAgentName(turn.fromLabel);
	const toShort = shortAgentName(turn.toLabel);

	const [isExpanded, setIsExpanded] = useState(false);
	const [needsTruncation, setNeedsTruncation] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const previewMaxHeight = SYNTHETIC_PREVIEW_LINE_COUNT * SYNTHETIC_LINE_HEIGHT_PX;

	// Re-measure after every body change. MarkdownRenderer parses async, so the
	// final height isn't known on first paint — re-run on a microtask delay
	// after content updates so the "Show more" button appears once parsing is
	// done. useLayoutEffect runs synchronously before paint for the initial
	// render; the timeout covers the deferred markdown render that follows.
	useLayoutEffect(() => {
		const measure = () => {
			if (!contentRef.current) return;
			setNeedsTruncation(contentRef.current.scrollHeight > previewMaxHeight);
		};
		measure();
		const handle = window.setTimeout(measure, 100);
		return () => window.clearTimeout(handle);
	}, [turn.body, previewMaxHeight]);

	return (
		<div
			class="flex justify-end"
			data-testid="minimal-thread-turn"
			data-turn-state="message"
			data-message-kind="synthetic"
			data-agent-label={turn.toLabel}
			data-agent-color={toColor}
			data-from-label={turn.fromLabel}
			data-to-label={turn.toLabel}
		>
			<div class="max-w-[85%] md:max-w-[70%] w-auto">
				{/* Blockquote-style — thick purple left bar instead of a card.
				    Differentiates synthetic blocks from the assistant's
				    `bg-dark-800` reply bubbles by switching visual idiom from
				    "speech bubble" to "quoted-in voice". */}
				<div
					class="border-l-4 border-purple-500 pl-3"
					data-testid="minimal-thread-synthetic-bubble"
				>
					{/* Caption — `Synthetic` label + FROM → TO route badge. */}
					<div class="flex items-center gap-2 flex-wrap mb-1.5">
						<svg
							class="w-4 h-4 flex-shrink-0 text-purple-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
							/>
						</svg>
						<span
							class="text-sm font-semibold text-purple-400"
							data-testid="minimal-thread-synthetic-badge"
						>
							Synthetic
						</span>
						<span class="text-gray-600 text-xs" aria-hidden="true">
							·
						</span>
						<span
							class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium px-1.5 py-px rounded bg-dark-800"
							data-testid="minimal-thread-agent-route-badge"
							aria-label={`From ${turn.fromLabel} agent to ${turn.toLabel} agent`}
						>
							<span style={{ color: fromColor }}>{fromShort}</span>
							<span class="text-gray-600" aria-hidden="true">
								→
							</span>
							<span style={{ color: toColor }}>{toShort}</span>
						</span>
					</div>

					{/* Body — same 20-line cap + gradient fade as before, just
					    without the card wrapper. */}
					<div class="relative">
						<div
							class={!isExpanded && needsTruncation ? 'overflow-hidden' : ''}
							style={
								!isExpanded && needsTruncation ? { maxHeight: `${previewMaxHeight}px` } : undefined
							}
						>
							<div ref={contentRef} data-testid="minimal-thread-synthetic-body">
								{turn.body ? (
									turn.bodyIsFallback ? (
										<p class="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap break-words">
											{turn.body}
										</p>
									) : (
										<MarkdownRenderer
											content={turn.body}
											class="text-sm leading-relaxed [&_h1]:!text-purple-400 [&_h2]:!text-purple-400 [&_h3]:!text-purple-400 [&_h4]:!text-purple-400 [&_h5]:!text-purple-400 [&_h6]:!text-purple-400"
										/>
									)
								) : (
									<p class="text-xs text-gray-500 italic">(empty message)</p>
								)}
							</div>
						</div>

						{/* Gradient fade hint — masks the cut-off against the
						    page's `bg-dark-900` (which the surrounding feed
						    inherits from `SpaceIsland`). */}
						{needsTruncation && !isExpanded && (
							<div
								class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-dark-900 to-transparent pointer-events-none"
								aria-hidden="true"
							/>
						)}

						{/* Show more / Show less toggle — minimal pill, no card
						    chrome / separator border now that the wrapper is
						    open on all sides. */}
						{needsTruncation && (
							<button
								type="button"
								onClick={() => setIsExpanded((v) => !v)}
								class="mt-2 inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md transition-colors hover:bg-dark-800 text-purple-300"
								data-testid="minimal-thread-synthetic-toggle"
							>
								{isExpanded ? (
									<>
										<svg
											class="w-3.5 h-3.5"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											aria-hidden="true"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M5 15l7-7 7 7"
											/>
										</svg>
										Show less
									</>
								) : (
									<>
										<svg
											class="w-3.5 h-3.5"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											aria-hidden="true"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M19 9l-7 7-7-7"
											/>
										</svg>
										Show more
									</>
								)}
							</button>
						)}
					</div>
				</div>

				{/* Chat-style action row — timestamp + copy button under the
				    block, right-aligned to track the right-anchored content. */}
				<SpaceTaskThreadMessageActions
					timestamp={turn.createdAt}
					copyText={turn.body ?? ''}
					align="right"
					onOpenSession={
						turn.sessionId
							? () =>
									pushOverlayHistory(
										turn.sessionId as string,
										turn.toLabel,
										turn.highlightMessageUuid
									)
							: undefined
					}
				/>
			</div>
		</div>
	);
}

function MinimalTurnRow({ turn }: { turn: FeedTurn }) {
	if (turn.state === 'message') {
		return turn.isSynthetic ? (
			<SyntheticMessageTurn turn={turn} />
		) : (
			<HumanMessageTurn turn={turn} />
		);
	}
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
