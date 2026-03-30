import type { WorkflowChannel, WorkflowConditionType } from '@neokai/shared';
import { GateConfig } from './GateConfig';
import type { ConditionDraft } from './GateConfig';

export interface ChannelEdgeConfigPanelProps {
	index: number;
	channel: WorkflowChannel;
	shouldBeCyclic?: boolean;
	onChange: (index: number, channel: WorkflowChannel) => void;
	onDelete: (index: number) => void;
	onClose?: () => void;
	showHeader?: boolean;
	showDirectionControls?: boolean;
}

function gateToCondition(gate: WorkflowChannel['gate']): ConditionDraft {
	if (!gate || gate.type === 'always') return { type: 'always' };
	return { type: gate.type as WorkflowConditionType, expression: gate.expression };
}

function conditionToGate(cond: ConditionDraft): WorkflowChannel['gate'] {
	if (cond.type === 'always') return undefined;
	return { type: cond.type as WorkflowConditionType, expression: cond.expression };
}

function formatTo(to: string | string[]): string {
	return Array.isArray(to) ? to.join(', ') : to;
}

export function ChannelEdgeConfigPanel({
	index,
	channel,
	shouldBeCyclic = false,
	onChange,
	onDelete,
	onClose,
	showHeader = true,
	showDirectionControls = true,
}: ChannelEdgeConfigPanelProps) {
	return (
		<div
			data-testid="channel-edge-config-panel"
			class="flex flex-col gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg text-sm text-white"
		>
			{showHeader && (
				<div class="flex items-center justify-between">
					<span class="font-semibold text-white text-sm">Channel</span>
					<button
						data-testid="channel-close-button"
						class="text-gray-400 hover:text-white transition-colors"
						onClick={onClose}
						aria-label="Close"
					>
						×
					</button>
				</div>
			)}

			<div class="flex flex-col gap-1">
				<div class="flex items-center gap-2 text-xs">
					<span class="text-gray-400 w-10 shrink-0">From</span>
					<span class="font-mono bg-dark-700 rounded px-2 py-0.5 text-gray-200 truncate">
						{channel.from}
					</span>
				</div>
				<div class="flex items-center gap-2 text-xs">
					<span class="text-gray-400 w-10 shrink-0">To</span>
					<span class="font-mono bg-dark-700 rounded px-2 py-0.5 text-gray-200 truncate">
						{formatTo(channel.to)}
					</span>
				</div>
			</div>

			{showDirectionControls && (
				<div class="space-y-1">
					<label class="text-xs text-gray-400 font-medium">Direction</label>
					<select
						data-testid="channel-direction-select"
						value={channel.direction}
						onChange={(e) =>
							onChange(index, {
								...channel,
								direction: (e.currentTarget as HTMLSelectElement).value as
									| 'one-way'
									| 'bidirectional',
							})
						}
						class="sr-only"
						tabIndex={-1}
						aria-hidden="true"
					>
						<option value="one-way">One-way</option>
						<option value="bidirectional">Bidirectional</option>
					</select>
					<div class="grid grid-cols-2 gap-2">
						<button
							type="button"
							data-testid="channel-direction-one-way"
							onClick={() => onChange(index, { ...channel, direction: 'one-way' })}
							class={`rounded border px-2 py-1.5 text-xs transition-colors ${
								channel.direction === 'one-way'
									? 'border-blue-500 bg-blue-500/10 text-blue-200'
									: 'border-dark-600 bg-dark-700 text-gray-300 hover:border-dark-500'
							}`}
						>
							One-way
						</button>
						<button
							type="button"
							data-testid="channel-direction-bidirectional"
							onClick={() => onChange(index, { ...channel, direction: 'bidirectional' })}
							class={`rounded border px-2 py-1.5 text-xs transition-colors ${
								channel.direction === 'bidirectional'
									? 'border-blue-500 bg-blue-500/10 text-blue-200'
									: 'border-dark-600 bg-dark-700 text-gray-300 hover:border-dark-500'
							}`}
						>
							Bidirectional
						</button>
					</div>
				</div>
			)}

			<GateConfig
				label="Gate condition"
				condition={gateToCondition(channel.gate)}
				onChange={(cond) => onChange(index, { ...channel, gate: conditionToGate(cond) })}
				testId={`channel-edge-gate-select-${index}`}
			/>

			<label class="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					data-testid="channel-cyclic-checkbox"
					checked={!!channel.isCyclic}
					onChange={(e) =>
						onChange(index, {
							...channel,
							isCyclic: (e.currentTarget as HTMLInputElement).checked || undefined,
						})
					}
					class="rounded border-dark-600 text-blue-500 focus:ring-blue-500"
				/>
				<span class="text-xs text-gray-400">Cyclic channel</span>
			</label>
			{shouldBeCyclic && !channel.isCyclic && (
				<div
					data-testid="channel-cyclic-warning"
					class="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200"
				>
					This link closes a workflow loop. Mark it as cyclic so iteration limits and cycle gate resets work correctly.
				</div>
			)}

			<button
				data-testid="delete-channel-button"
				class="mt-1 w-full rounded px-2 py-1.5 text-xs font-medium text-red-400 border border-red-800 hover:bg-red-900/30 transition-colors"
				onClick={() => onDelete(index)}
			>
				Delete channel
			</button>
		</div>
	);
}
