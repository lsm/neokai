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

export interface TurnSummaryBlockProps {
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

// Inline SVG icons (Heroicons v1 solid, 20×20 viewBox)
function WrenchIcon(): JSX.Element {
	// Heroicons v1 solid "cog" — represents tool/settings operations
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
				d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
				clip-rule="evenodd"
			/>
		</svg>
	);
}

function BrainIcon(): JSX.Element {
	// Heroicons v1 solid "light-bulb" — represents thinking/reasoning
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-3 w-3"
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14c.015-.34.208-.646.477-.859a4 4 0 10-4.954 0c.27.213.462.519.476.859h4.001z" />
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

export function TurnSummaryBlock({
	turn,
	onClick,
	isSelected = false,
}: TurnSummaryBlockProps): JSX.Element {
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
					{turn.agentLabel || turn.agentRole}
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
