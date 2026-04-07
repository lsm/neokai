/**
 * ChannelInfoPanel
 *
 * Read-only info panel shown when a channel edge is selected in the runtime canvas.
 * Displays: source node → target node, direction, gate type, runtime status.
 */

import type { JSX } from 'preact';
import type { ResolvedWorkflowChannel } from './visual-editor/EdgeRenderer';
import { cn } from '../../lib/utils';

interface ChannelInfoPanelProps {
	channel: ResolvedWorkflowChannel;
	fromNodeName: string;
	toNodeName: string;
	onClose: () => void;
	class?: string;
}

const GATE_TYPE_LABELS: Record<string, string> = {
	human: 'Human Approval',
	condition: 'Shell Condition',
	task_result: 'Task Result',
	check: 'Check',
	count: 'Vote Count',
};

const RUNTIME_STATUS_CONFIG = {
	open: { label: 'Open', dotClass: 'bg-green-400', textClass: 'text-green-400' },
	waiting_human: {
		label: 'Waiting for Approval',
		dotClass: 'bg-amber-400 animate-pulse',
		textClass: 'text-amber-400',
	},
	blocked: { label: 'Blocked', dotClass: 'bg-red-400', textClass: 'text-red-400' },
};

export function ChannelInfoPanel({
	channel,
	fromNodeName,
	toNodeName,
	onClose,
	class: className,
}: ChannelInfoPanelProps): JSX.Element {
	const status = channel.runtimeStatus;
	const statusConfig = status ? RUNTIME_STATUS_CONFIG[status] : null;
	const gateLabel =
		channel.gateLabel ?? (channel.gateType ? GATE_TYPE_LABELS[channel.gateType] : null);
	const isBidirectional = channel.direction === 'bidirectional';

	return (
		<div
			class={cn(
				'absolute bottom-0 left-0 right-0 z-20',
				'bg-dark-900/95 border-t border-dark-700',
				'px-4 py-3',
				className
			)}
			data-testid="channel-info-panel"
		>
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0 space-y-2">
					{/* Connection */}
					<div class="flex items-center gap-2 text-sm">
						<span class="font-medium text-gray-100 truncate max-w-[120px]" title={fromNodeName}>
							{fromNodeName}
						</span>
						<span class="text-gray-500 flex-shrink-0">{isBidirectional ? '⇄' : '→'}</span>
						<span class="font-medium text-gray-100 truncate max-w-[120px]" title={toNodeName}>
							{toNodeName}
						</span>
						{channel.isCyclic && <span class="text-xs text-amber-500 flex-shrink-0">↩ loop</span>}
					</div>

					<div class="flex flex-wrap items-center gap-3">
						{/* Gate type badge */}
						{gateLabel && (
							<span
								class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
								style={{
									borderColor: channel.gateColor ?? '#374151',
									color: channel.gateColor ?? '#9ca3af',
									backgroundColor: `${channel.gateColor ?? '#374151'}18`,
								}}
							>
								{channel.hasScript && <span class="mr-1 opacity-70">{'</>'}</span>}
								{gateLabel}
							</span>
						)}

						{/* Runtime status */}
						{statusConfig && (
							<div class="flex items-center gap-1.5">
								<span
									class={cn(
										'inline-block w-2 h-2 rounded-full flex-shrink-0',
										statusConfig.dotClass
									)}
								/>
								<span class={cn('text-xs', statusConfig.textClass)}>{statusConfig.label}</span>
							</div>
						)}

						{!gateLabel && !statusConfig && <span class="text-xs text-gray-500">No gate</span>}
					</div>
				</div>

				<button
					type="button"
					onClick={onClose}
					class="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
					aria-label="Close channel info"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>
		</div>
	);
}
