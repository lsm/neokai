/**
 * MinimalStyleExploration
 *
 * Standalone visual exploration of 6 distinct visual directions for the
 * "minimal" space task thread mode. Each style renders the same mock data
 * — two completed turns (CODER, REVIEWER) and one active CODER turn — so
 * the directions can be compared side-by-side.
 *
 * Pure mock data, no real WebSocket / store wiring. Drop into any page or
 * dev route to view.
 */

import { getAgentColor } from '../space-task-thread-agent-colors';
import type { CompletedTurn, MinimalTurn, ToolCallEntry } from './minimal-mock-data';
import {
	agentInitial,
	formatClock,
	formatCost,
	formatDuration,
	formatTokens,
	MOCK_TURNS,
	shortAgentName,
} from './minimal-mock-data';

/* ── shared building blocks ──────────────────────────────────────────────── */

function StatsLine({ turn }: { turn: CompletedTurn }) {
	const { stats, durationSec } = turn;
	return (
		<>
			{stats.toolCalls} tool calls · {stats.messages} messages · {stats.userInputs} user
			{stats.userInputs === 1 ? ' input' : ' inputs'} · {formatTokens(stats.tokens)} tokens ·{' '}
			{formatCost(stats.costUsd)} · {formatDuration(durationSec)}
		</>
	);
}

function RosterEntry({ entry, isLatest }: { entry: ToolCallEntry; isLatest: boolean }) {
	return (
		<div
			class={`flex items-baseline gap-2 font-mono text-xs leading-5 ${
				isLatest ? 'text-gray-100 minimal-roster-fade-in' : 'text-gray-400'
			}`}
		>
			<span class="text-blue-300 font-semibold shrink-0">{entry.tool}:</span>
			<span class="truncate">{entry.preview}</span>
		</div>
	);
}

function LiveDot({ color }: { color: string }) {
	return (
		<span class="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium">
			<span
				class="inline-block h-2 w-2 rounded-full minimal-live-dot"
				style={{ backgroundColor: color }}
			/>
			<span style={{ color }}>Live</span>
		</span>
	);
}

/* ── Style 1: Slack ──────────────────────────────────────────────────────── */

function SlackStyle({ turns }: { turns: MinimalTurn[] }) {
	return (
		<div class="space-y-5">
			{turns.map((turn) => {
				const color = getAgentColor(turn.agent);
				const initial = agentInitial(turn.agent);
				return (
					<div key={turn.id} class="flex gap-3">
						<div
							class="h-9 w-9 shrink-0 rounded-md flex items-center justify-center text-sm font-bold text-dark-950"
							style={{ backgroundColor: color }}
						>
							{initial}
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex items-baseline gap-2">
								<span class="font-semibold text-gray-100" style={{ color }}>
									{shortAgentName(turn.agent)}
								</span>
								<span class="text-xs text-gray-500">{formatClock(turn.startedAt)}</span>
								{turn.state === 'active' && <LiveDot color={color} />}
							</div>
							{turn.state === 'completed' ? (
								<>
									<div class="text-xs text-gray-500 mt-0.5">
										<StatsLine turn={turn} />
									</div>
									<p class="mt-1.5 text-sm text-gray-100 leading-relaxed">{turn.lastMessage}</p>
								</>
							) : (
								<div class="mt-2 space-y-0.5">
									{turn.roster.map((entry, i) => (
										<RosterEntry
											key={`${entry.tool}-${i}`}
											entry={entry}
											isLatest={i === turn.roster.length - 1}
										/>
									))}
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/* ── Style 2: Compact row ────────────────────────────────────────────────── */

function CompactRowStyle({ turns }: { turns: MinimalTurn[] }) {
	return (
		<div class="divide-y divide-dark-700 rounded-md border border-dark-700 overflow-hidden">
			{turns.map((turn) => {
				const color = getAgentColor(turn.agent);
				return (
					<div
						key={turn.id}
						class="flex items-center gap-3 px-3 py-2 text-sm font-mono whitespace-nowrap overflow-hidden"
					>
						<span
							class="px-1.5 py-0.5 rounded text-[11px] font-bold tracking-wide text-dark-950 shrink-0"
							style={{ backgroundColor: color }}
						>
							{shortAgentName(turn.agent)}
						</span>
						{turn.state === 'completed' ? (
							<>
								<span class="text-xs text-gray-400 shrink-0">
									{turn.stats.toolCalls} calls · {turn.stats.messages} msg ·{' '}
									{formatTokens(turn.stats.tokens)} tok · {formatCost(turn.stats.costUsd)}
								</span>
								<span class="text-gray-100 truncate">"{turn.lastMessage}"</span>
							</>
						) : (
							<>
								<LiveDot color={color} />
								<span class="text-xs text-gray-400 shrink-0">running ·</span>
								<span class="text-gray-100 truncate">
									{turn.roster
										.slice(-3)
										.map((e) => `${e.tool}: ${e.preview}`)
										.join('  →  ')}
								</span>
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}

/* ── Style 3: Card per turn ──────────────────────────────────────────────── */

function CardStyle({ turns }: { turns: MinimalTurn[] }) {
	return (
		<div class="space-y-3">
			{turns.map((turn) => {
				const color = getAgentColor(turn.agent);
				return (
					<div
						key={turn.id}
						class="rounded-lg bg-dark-850 border border-dark-700 overflow-hidden"
						style={{ borderLeft: `3px solid ${color}` }}
					>
						<div class="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-dark-700/70">
							<span class="font-semibold text-sm" style={{ color }}>
								{shortAgentName(turn.agent)}
							</span>
							<div class="flex items-center gap-2">
								<span class="text-[11px] text-gray-500">{formatClock(turn.startedAt)}</span>
								{turn.state === 'active' && <LiveDot color={color} />}
							</div>
						</div>
						{turn.state === 'completed' ? (
							<>
								<div class="px-4 pt-2.5 flex flex-wrap gap-1.5">
									<Badge label={`${turn.stats.toolCalls} tools`} />
									<Badge label={`${turn.stats.messages} msg`} />
									<Badge label={`${turn.stats.userInputs} input`} />
									<Badge label={`${formatTokens(turn.stats.tokens)} tok`} />
									<Badge label={formatCost(turn.stats.costUsd)} />
									<Badge label={formatDuration(turn.durationSec)} />
								</div>
								<p class="px-4 pb-3.5 pt-2 text-sm text-gray-100 leading-relaxed">
									{turn.lastMessage}
								</p>
							</>
						) : (
							<div class="px-4 py-3 space-y-1">
								{turn.roster.map((entry, i) => (
									<RosterEntry
										key={`${entry.tool}-${i}`}
										entry={entry}
										isLatest={i === turn.roster.length - 1}
									/>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

function Badge({ label }: { label: string }) {
	return (
		<span class="text-[11px] px-2 py-0.5 rounded-full bg-dark-800 text-gray-300 border border-dark-700">
			{label}
		</span>
	);
}

/* ── Style 4: Timeline / dot ─────────────────────────────────────────────── */

function TimelineStyle({ turns }: { turns: MinimalTurn[] }) {
	return (
		<div class="relative pl-6">
			{/* vertical line */}
			<div class="absolute left-[7px] top-2 bottom-2 w-px bg-dark-700" />
			<div class="space-y-6">
				{turns.map((turn) => {
					const color = getAgentColor(turn.agent);
					const isActive = turn.state === 'active';
					return (
						<div key={turn.id} class="relative">
							<span
								class={`absolute -left-[22px] top-1.5 h-3.5 w-3.5 rounded-full ring-4 ring-dark-950 ${
									isActive ? 'minimal-live-dot' : ''
								}`}
								style={{ backgroundColor: color }}
							/>
							<div class="flex items-baseline gap-2 flex-wrap">
								<span class="font-semibold text-sm" style={{ color }}>
									{shortAgentName(turn.agent)}
								</span>
								<span class="text-[11px] text-gray-500">{formatClock(turn.startedAt)}</span>
								{turn.state === 'completed' ? (
									<span class="text-xs text-gray-400">
										<StatsLine turn={turn} />
									</span>
								) : (
									<LiveDot color={color} />
								)}
							</div>
							{turn.state === 'completed' ? (
								<p class="mt-1.5 text-sm text-gray-100 leading-relaxed pl-0">{turn.lastMessage}</p>
							) : (
								<div class="mt-2 space-y-0.5">
									{turn.roster.map((entry, i) => (
										<RosterEntry
											key={`${entry.tool}-${i}`}
											entry={entry}
											isLatest={i === turn.roster.length - 1}
										/>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/* ── Style 5: Bubble / chat ──────────────────────────────────────────────── */

function BubbleStyle({ turns }: { turns: MinimalTurn[] }) {
	return (
		<div class="space-y-5">
			{turns.map((turn) => {
				const color = getAgentColor(turn.agent);
				return (
					<div key={turn.id}>
						<div class="flex items-baseline gap-2 mb-1.5 px-1">
							<span class="text-xs font-semibold tracking-wide" style={{ color }}>
								{shortAgentName(turn.agent)}
							</span>
							<span class="text-[11px] text-gray-500">{formatClock(turn.startedAt)}</span>
							{turn.state === 'active' && <LiveDot color={color} />}
						</div>
						{turn.state === 'completed' ? (
							<>
								<div
									class="inline-block max-w-full rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed"
									style={{
										backgroundColor: `${color}20`,
										border: `1px solid ${color}40`,
										color: '#f3f4f6',
									}}
								>
									{turn.lastMessage}
								</div>
								<div class="mt-1.5 px-1 text-[11px] text-gray-500">
									<StatsLine turn={turn} />
								</div>
							</>
						) : (
							<div
								class="inline-block max-w-full rounded-2xl rounded-tl-sm px-4 py-3 space-y-1"
								style={{
									backgroundColor: `${color}15`,
									border: `1px dashed ${color}55`,
								}}
							>
								{turn.roster.map((entry, i) => (
									<RosterEntry
										key={`${entry.tool}-${i}`}
										entry={entry}
										isLatest={i === turn.roster.length - 1}
									/>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/* ── Style 6: Terminal / log ─────────────────────────────────────────────── */

function TerminalStyle({ turns }: { turns: MinimalTurn[] }) {
	return (
		<div class="rounded-md border border-dark-700 bg-black/40 px-4 py-3 font-mono text-[13px] leading-6">
			{turns.map((turn, idx) => {
				const color = getAgentColor(turn.agent);
				const tag = `[${shortAgentName(turn.agent)}]`;
				return (
					<div key={turn.id} class={idx > 0 ? 'mt-3' : ''}>
						<div class="flex flex-wrap items-baseline gap-2">
							<span class="font-bold" style={{ color }}>
								{tag}
							</span>
							<span class="text-gray-500">{formatClock(turn.startedAt)}</span>
							{turn.state === 'completed' ? (
								<span class="text-gray-400">
									{turn.stats.toolCalls} calls · {formatTokens(turn.stats.tokens)} tok ·{' '}
									{formatCost(turn.stats.costUsd)} · {formatDuration(turn.durationSec)}
								</span>
							) : (
								<>
									<span class="text-gray-400">running…</span>
									<LiveDot color={color} />
								</>
							)}
						</div>
						{turn.state === 'completed' ? (
							<div class="pl-4 text-gray-100 whitespace-pre-wrap">{turn.lastMessage}</div>
						) : (
							<div class="pl-4 space-y-0.5">
								{turn.roster.map((entry, i) => (
									<div
										key={`${entry.tool}-${i}`}
										class={`${
											i === turn.roster.length - 1
												? 'text-gray-100 minimal-roster-fade-in'
												: 'text-gray-500'
										}`}
									>
										<span class="text-blue-300">$</span> {entry.tool.toLowerCase()}{' '}
										<span class="text-gray-300">{entry.preview}</span>
									</div>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/* ── exploration page ────────────────────────────────────────────────────── */

interface StyleSpec {
	id: string;
	name: string;
	description: string;
	render: (turns: MinimalTurn[]) => preact.JSX.Element;
}

const STYLES: StyleSpec[] = [
	{
		id: 'slack',
		name: '1. Slack-style',
		description:
			'Avatar tile + name on top + stats subline + final message as plain prose. Familiar and information-dense without feeling busy.',
		render: (turns) => <SlackStyle turns={turns} />,
	},
	{
		id: 'compact-row',
		name: '2. Compact row',
		description:
			'One tight row per turn: tag → stats → quoted message. Maximum density; great for long histories where you mostly want to skim.',
		render: (turns) => <CompactRowStyle turns={turns} />,
	},
	{
		id: 'card',
		name: '3. Card per turn',
		description:
			'Each turn is a self-contained card with a coloured left rail, header row, badge stats and the message as the body.',
		render: (turns) => <CardStyle turns={turns} />,
	},
	{
		id: 'timeline',
		name: '4. Timeline / dot',
		description:
			'Vertical thread of coloured dots. Inline header with stats, message indented underneath. Reads like a changelog.',
		render: (turns) => <TimelineStyle turns={turns} />,
	},
	{
		id: 'bubble',
		name: '5. Bubble / chat',
		description:
			'Tinted bubble per turn, name tag above. Stats live as a faded subline between bubbles. Most conversational.',
		render: (turns) => <BubbleStyle turns={turns} />,
	},
	{
		id: 'terminal',
		name: '6. Terminal / log',
		description:
			'Monospace log lines: [AGENT] timestamp stats, then indented prose. Calm and technical, fits long-running automation.',
		render: (turns) => <TerminalStyle turns={turns} />,
	},
];

export function MinimalStyleExploration() {
	return (
		<>
			<style>{ANIMATIONS_CSS}</style>
			<div class="min-h-screen bg-dark-950 text-gray-100">
				<header class="border-b border-dark-700 px-6 py-5">
					<h1 class="text-xl font-semibold text-gray-50">
						Minimal thread mode — style explorations
					</h1>
					<p class="text-sm text-gray-400 mt-1">
						Six distinct visual directions for a group-chat-style task thread. Same mock data (CODER
						→ REVIEWER → CODER active) rendered in each. No bracket rails, no expanded tool cards,
						no thinking blocks.
					</p>
				</header>
				<main class="px-6 py-6 grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-[1600px] mx-auto">
					{STYLES.map((style) => (
						<section
							key={style.id}
							class="rounded-lg border border-dark-700 bg-dark-900 overflow-hidden flex flex-col"
						>
							<div class="px-4 py-3 border-b border-dark-700 bg-dark-850">
								<h2 class="text-sm font-semibold text-gray-100">{style.name}</h2>
								<p class="text-xs text-gray-400 mt-0.5">{style.description}</p>
							</div>
							<div class="p-5 flex-1">{style.render(MOCK_TURNS)}</div>
						</section>
					))}
				</main>
				<footer class="px-6 py-4 text-xs text-gray-500 border-t border-dark-700">
					Static mock data — see{' '}
					<code class="text-gray-300">
						packages/web/src/components/space/thread/minimal/minimal-mock-data.ts
					</code>
				</footer>
			</div>
		</>
	);
}

/* ── animations (scoped via local <style> tag) ───────────────────────────── */

const ANIMATIONS_CSS = `
@keyframes minimal-roster-fade-in-kf {
	from { opacity: 0; transform: translateY(2px); }
	to   { opacity: 1; transform: translateY(0); }
}
.minimal-roster-fade-in {
	animation: minimal-roster-fade-in-kf 250ms ease-out;
}
@keyframes minimal-live-pulse {
	0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.0); transform: scale(1); }
	50%      { box-shadow: 0 0 0 4px rgba(255,255,255,0.08); transform: scale(1.08); }
}
.minimal-live-dot {
	animation: minimal-live-pulse 1.6s ease-in-out infinite;
}
`;
