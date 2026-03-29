import type { WorkflowChannel, WorkflowConditionType } from '@neokai/shared';
import { GateConfig } from './GateConfig';
import type { ConditionDraft } from './GateConfig';

export interface ChannelEdgeConfigPanelProps {
	index: number;
	channel: WorkflowChannel;
	onChange: (index: number, channel: WorkflowChannel) => void;
	onDelete: (index: number) => void;
	onClose: () => void;
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
	onChange,
	onDelete,
	onClose,
}: ChannelEdgeConfigPanelProps) {
	return (
		<div
			data-testid="channel-edge-config-panel"
			class="flex flex-col gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg text-sm text-white"
		>
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
					class="w-full bg-dark-700 border border-dark-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
				>
					<option value="one-way">One-way</option>
					<option value="bidirectional">Bidirectional</option>
				</select>
			</div>

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
