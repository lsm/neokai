/**
 * TurnSummaryBlock
 *
 * A compact card rendering a single agent turn with:
 *  - Title bar: agent name (role-colored), last action badge, turn duration
 *  - Stats badges: tool calls, thinking blocks, assistant messages (hide zeros)
 *  - Fixed-height preview area (~80px) with SDKMessageRenderer
 *  - Active indicator: pulsing left border when turn.isActive
 *  - Selected state: highlighted border when isSelected
 */

import type { JSX } from 'preact';
import { ROLE_COLORS } from '../../lib/task-constants';
import { SDKMessageRenderer } from '../sdk/SDKMessageRenderer';
import type { TurnBlock } from '../../hooks/useTurnBlocks';

interface Props {
	turn: TurnBlock;
	onClick: (turn: TurnBlock) => void;
	isSelected?: boolean;
}

// ---------------------------------------------------------------------------
// Duration helpers
// ---------------------------------------------------------------------------

function formatDuration(startMs: number, endMs: number): string {
	const diffSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
	if (diffSec < 60) return `${diffSec}s`;
	const m = Math.floor(diffSec / 60);
	const s = diffSec % 60;
	return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatBadge({
	icon,
	count,
	label,
}: {
	icon: JSX.Element;
	count: number;
	label: string;
}): JSX.Element | null {
	if (count === 0) return null;
	return (
		<span
			title={label}
			class="inline-flex items-center gap-1 rounded-full bg-dark-700 px-2 py-0.5 text-xs text-gray-400"
		>
			{icon}
			{count}
		</span>
	);
}

// Inline SVG icons (no external dep needed)
function WrenchIcon(): JSX.Element {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-3 w-3"
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M5.293 3.293a1 1 0 011.414 0L10 6.586l3.293-3.293a1 1 0 111.414 1.414L11.414 8l3.293 3.293a1 1 0 01-1.414 1.414L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414L8.586 8 5.293 4.707a1 1 0 010-1.414z"
				clip-rule="evenodd"
			/>
		</svg>
	);
}

function BrainIcon(): JSX.Element {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-3 w-3"
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 14a6 6 0 110-12 6 6 0 010 12z" />
		</svg>
	);
}

function ChatIcon(): JSX.Element {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-3 w-3"
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
				clip-rule="evenodd"
			/>
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TurnSummaryBlock({ turn, onClick, isSelected = false }: Props): JSX.Element {
	const roleConfig = ROLE_COLORS[turn.agentRole] ?? {
		border: 'border-l-gray-500',
		label: turn.agentRole,
		labelColor: 'text-gray-400',
	};

	const duration =
		turn.endTime === null ? 'running...' : formatDuration(turn.startTime, turn.endTime);

	// Left border: active uses pulsing color, selected uses ring highlight, default is muted
	const leftBorderClass = turn.isActive
		? `border-l-2 ${roleConfig.border} animate-pulse`
		: `border-l-2 ${roleConfig.border}`;

	const selectedRingClass = isSelected ? 'ring-1 ring-blue-500' : '';

	return (
		<div
			data-testid="turn-block"
			role="button"
			tabIndex={0}
			class={[
				'relative cursor-pointer rounded-md border border-dark-700 bg-dark-800 p-3 transition-colors hover:bg-dark-750',
				leftBorderClass,
				selectedRingClass,
				turn.isError ? 'border-red-800' : '',
			]
				.filter(Boolean)
				.join(' ')}
			onClick={() => onClick(turn)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onClick(turn);
				}
			}}
		>
			{/* Active indicator overlay */}
			{turn.isActive && (
				<span
					data-testid="turn-block-active"
					class="absolute left-0 top-0 h-full w-0.5 animate-pulse rounded-l-md bg-current opacity-80"
					style={{ color: 'inherit' }}
					aria-label="Active turn"
				/>
			)}

			{/* Title bar */}
			<div class="flex items-center gap-2 overflow-hidden">
				<span
					data-testid="turn-block-agent-name"
					class={`truncate text-sm font-semibold ${roleConfig.labelColor}`}
				>
					{roleConfig.label || turn.agentRole}
				</span>

				{turn.lastAction && (
					<span class="shrink-0 rounded bg-dark-700 px-1.5 py-0.5 text-xs text-gray-400">
						{turn.lastAction}
					</span>
				)}

				<span class="ml-auto shrink-0 text-xs text-gray-500">{duration}</span>
			</div>

			{/* Stats badges */}
			<div data-testid="turn-block-stats" class="mt-1.5 flex flex-wrap gap-1.5">
				<StatBadge icon={<WrenchIcon />} count={turn.toolCallCount} label="Tool calls" />
				<StatBadge icon={<BrainIcon />} count={turn.thinkingCount} label="Thinking blocks" />
				<StatBadge icon={<ChatIcon />} count={turn.assistantCount} label="Assistant messages" />
			</div>

			{/* Error message */}
			{turn.isError && turn.errorMessage && (
				<div class="mt-1.5 rounded bg-red-950 px-2 py-1 text-xs text-red-400">
					{turn.errorMessage}
				</div>
			)}

			{/* Preview area */}
			<div
				data-testid="turn-block-preview"
				class="mt-2 max-h-20 overflow-y-auto text-xs [&_*]:text-xs"
			>
				{turn.previewMessage ? (
					<SDKMessageRenderer message={turn.previewMessage} taskContext={true} />
				) : (
					<span class="text-gray-600">No messages</span>
				)}
			</div>
		</div>
	);
}
