import { generateUUID } from '@neokai/shared';
import type { Gate, GateConditionCheck, WorkflowChannel } from '@neokai/shared';

type ChannelGateMode =
	| 'none'
	| 'human'
	| 'condition'
	| 'task_result'
	| 'check'
	| 'count';

const GATE_MODE_LABELS: Record<ChannelGateMode, string> = {
	none: 'None',
	human: 'Human Approval',
	condition: 'Shell Condition',
	task_result: 'Task Result',
	check: 'Field Check',
	count: 'Vote Count',
};

export interface ChannelEdgeConfigPanelProps {
	index: number;
	channel: WorkflowChannel;
	gates: Gate[];
	shouldBeCyclic?: boolean;
	onChange: (index: number, channel: WorkflowChannel) => void;
	onDelete: (index: number) => void;
	onGatesChange: (gates: Gate[]) => void;
	onClose?: () => void;
	showHeader?: boolean;
	showDirectionControls?: boolean;
}

function formatTo(to: string | string[]): string {
	return Array.isArray(to) ? to.join(', ') : to;
}

function resolveGateMode(channel: WorkflowChannel, gate: Gate | undefined): ChannelGateMode {
	if (gate) {
		if (gate.condition.type === 'count') return 'count';
		if (gate.condition.type === 'check') {
			const op = gate.condition.op ?? '==';
			if (gate.condition.field === 'approved' && op === '==' && gate.condition.value === true) {
				return 'human';
			}
			if (gate.condition.field === 'result' && op === '==' && typeof gate.condition.value === 'string') {
				return 'task_result';
			}
			return 'check';
		}
		return 'check';
	}

	return 'none';
}

function buildBaseGate(id: string, channel: WorkflowChannel, condition: Gate['condition'], resetOnCycle = false): Gate {
	return {
		id,
		condition,
		data: {},
		allowedWriterRoles: ['*'],
		description:
			channel.label ?? `${channel.from} ${channel.direction === 'bidirectional' ? '↔' : '→'} ${formatTo(channel.to)}`,
		resetOnCycle,
	};
}

function buildHumanGate(id: string, channel: WorkflowChannel, resetOnCycle = false): Gate {
	return {
		...buildBaseGate(id, channel, { type: 'check', field: 'approved', op: '==', value: true }, resetOnCycle),
		data: { approved: false },
	};
}

function buildTaskResultGate(id: string, channel: WorkflowChannel, expectedValue: string, resetOnCycle = false): Gate {
	return {
		...buildBaseGate(id, channel, {
			type: 'check',
			field: 'result',
			op: '==',
			value: expectedValue || 'passed',
		}, resetOnCycle),
		data: {},
	};
}

function buildFieldCheckGate(
	id: string,
	channel: WorkflowChannel,
	field: string,
	op: GateConditionCheck['op'],
	value: unknown,
	resetOnCycle = false
): Gate {
	return {
		...buildBaseGate(id, channel, {
			type: 'check',
			field: field || 'status',
			op: op ?? 'exists',
			value: op === 'exists' ? undefined : value,
		}, resetOnCycle),
		data: {},
	};
}

function buildCountGate(
	id: string,
	channel: WorkflowChannel,
	field: string,
	matchValue: string,
	min: number,
	resetOnCycle: boolean,
	existingData?: Record<string, unknown>
): Gate {
	const countField = field || 'votes';
	const priorValue =
		existingData && typeof existingData[countField] === 'object' && existingData[countField] !== null
			? existingData[countField]
			: {};
	return {
		...buildBaseGate(id, channel, {
			type: 'count',
			field: countField,
			matchValue: matchValue || 'approved',
			min: Math.max(1, Number.isFinite(min) ? min : 1),
		}),
		data: { [countField]: priorValue },
		resetOnCycle,
	};
}

function replaceGate(gates: Gate[], nextGate: Gate): Gate[] {
	const existingIndex = gates.findIndex((gate) => gate.id === nextGate.id);
	if (existingIndex === -1) return [...gates, nextGate];
	return gates.map((gate) => (gate.id === nextGate.id ? nextGate : gate));
}

function modeButtonClass(active: boolean): string {
	return active
		? 'border-blue-500 bg-blue-500/10 text-blue-200'
		: 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500 hover:text-gray-200';
}

export function ChannelEdgeConfigPanel({
	index,
	channel,
	gates,
	shouldBeCyclic = false,
	onChange,
	onDelete,
	onGatesChange,
	onClose,
	showHeader = true,
	showDirectionControls = true,
}: ChannelEdgeConfigPanelProps) {
	const currentGate = channel.gateId ? gates.find((gate) => gate.id === channel.gateId) : undefined;
	const gateMode = resolveGateMode(channel, currentGate);
	const currentCheckGate = currentGate?.condition.type === 'check' ? currentGate.condition : undefined;
	const currentCountGate = currentGate?.condition.type === 'count' ? currentGate.condition : undefined;

	function updateChannel(nextChannel: WorkflowChannel) {
		onChange(index, nextChannel);
	}

	function clearGate() {
		updateChannel({
			...channel,
			gateId: undefined,
		});
	}

	function upsertRealGate(nextGate: Gate) {
		onGatesChange(replaceGate(gates, nextGate));
		updateChannel({
			...channel,
			gateId: nextGate.id,
		});
	}

	function switchGateMode(nextMode: ChannelGateMode) {
		const gateId = currentGate?.id ?? `gate-${generateUUID()}`;

		switch (nextMode) {
			case 'none':
				clearGate();
				return;
			case 'human':
				upsertRealGate(buildHumanGate(gateId, channel, shouldBeCyclic));
				return;
			case 'condition':
				upsertRealGate(
					buildBaseGate(gateId, channel, { type: 'check', field: 'condition_result', op: 'exists' }, shouldBeCyclic)
				);
				return;
			case 'task_result': {
				const expected =
					currentCheckGate?.field === 'result' && typeof currentCheckGate.value === 'string'
						? currentCheckGate.value
						: 'passed';
				upsertRealGate(buildTaskResultGate(gateId, channel, expected, shouldBeCyclic));
				return;
			}
			case 'check': {
				const field =
					currentCheckGate && currentCheckGate.field !== 'approved' && currentCheckGate.field !== 'result'
						? currentCheckGate.field
						: 'status';
				const op =
					currentCheckGate && currentCheckGate.field !== 'approved' && currentCheckGate.field !== 'result'
						? (currentCheckGate.op ?? 'exists')
						: 'exists';
				const value =
					currentCheckGate && currentCheckGate.field !== 'approved' && currentCheckGate.field !== 'result'
						? currentCheckGate.value
						: undefined;
				upsertRealGate(buildFieldCheckGate(gateId, channel, field, op, value, shouldBeCyclic));
				return;
			}
			case 'count': {
				upsertRealGate(
					buildCountGate(
						gateId,
						channel,
						currentCountGate?.field ?? 'votes',
						typeof currentCountGate?.matchValue === 'string'
							? currentCountGate.matchValue
							: 'approved',
						currentCountGate?.min ?? 3,
						currentGate?.resetOnCycle ?? true,
						currentGate?.data
					)
				);
			}
		}
	}

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
					<div class="grid grid-cols-2 gap-2">
						<button
							type="button"
							data-testid="channel-direction-one-way"
							onClick={() => updateChannel({ ...channel, direction: 'one-way' })}
							class={`rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(
								channel.direction === 'one-way'
							)}`}
						>
							One-way
						</button>
						<button
							type="button"
							data-testid="channel-direction-bidirectional"
							onClick={() => updateChannel({ ...channel, direction: 'bidirectional' })}
							class={`rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(
								channel.direction === 'bidirectional'
							)}`}
						>
							Bidirectional
						</button>
					</div>
				</div>
			)}

			<div class="space-y-1.5">
				<label class="text-xs font-medium text-gray-400">Gate condition</label>
				<div class="grid grid-cols-2 gap-1.5">
					{(['none', 'human', 'condition', 'task_result', 'check', 'count'] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							data-testid={`channel-edge-gate-select-${index}-${mode}`}
							onClick={() => switchGateMode(mode)}
							class={`rounded border px-2 py-1.5 text-left text-xs transition-colors ${modeButtonClass(
								gateMode === mode
							)}`}
						>
							{GATE_MODE_LABELS[mode]}
						</button>
					))}
				</div>

				{gateMode === 'condition' && (
					<div class="space-y-1">
						<p class="text-xs text-gray-600">
							Gate is configured as a field check condition. Edit the gate details via the gate editor.
						</p>
					</div>
				)}

				{gateMode === 'task_result' && (
					<div class="space-y-1">
						<input
							type="text"
							data-testid={`channel-edge-gate-select-${index}-task-result-input`}
							placeholder="e.g. passed, failed"
							value={
								currentCheckGate?.field === 'result' && typeof currentCheckGate.value === 'string'
									? currentCheckGate.value
									: ''
							}
							onInput={(e) => {
								const value = (e.currentTarget as HTMLInputElement).value;
								const gateId = currentGate?.id ?? `gate-${generateUUID()}`;
								upsertRealGate(buildTaskResultGate(gateId, channel, value, shouldBeCyclic));
							}}
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
						/>
						<p class="text-xs text-gray-600">Gate opens when the reported task result matches this value.</p>
					</div>
				)}

				{gateMode === 'human' && (
					<p class="text-xs text-gray-600">Gate opens when explicit approval is recorded.</p>
				)}

				{gateMode === 'check' && (
					<div class="space-y-2">
						<div class="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
							<input
								type="text"
								data-testid={`channel-edge-gate-select-${index}-check-field`}
								placeholder="field"
								value={
									currentCheckGate && currentCheckGate.field !== 'approved' && currentCheckGate.field !== 'result'
										? currentCheckGate.field
										: ''
								}
								onInput={(e) =>
									upsertRealGate(
										buildFieldCheckGate(
											currentGate?.id ?? `gate-${generateUUID()}`,
											channel,
											(e.currentTarget as HTMLInputElement).value,
											currentCheckGate?.op ?? 'exists',
											currentCheckGate?.value
										)
									)
								}
								class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
							<select
								data-testid={`channel-edge-gate-select-${index}-check-op`}
								value={currentCheckGate?.op ?? 'exists'}
								onChange={(e) =>
									upsertRealGate(
										buildFieldCheckGate(
											currentGate?.id ?? `gate-${generateUUID()}`,
											channel,
											currentCheckGate?.field ?? 'status',
											(e.currentTarget as HTMLSelectElement).value as GateConditionCheck['op'],
											currentCheckGate?.value
										)
									)
								}
								class="text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
							>
								<option value="exists">Exists</option>
								<option value="==">Equals</option>
								<option value="!=">Not Equal</option>
							</select>
						</div>
						{(currentCheckGate?.op ?? 'exists') !== 'exists' && (
							<input
								type="text"
								data-testid={`channel-edge-gate-select-${index}-check-value`}
								placeholder="expected value"
								value={typeof currentCheckGate?.value === 'string' ? currentCheckGate.value : ''}
								onInput={(e) =>
									upsertRealGate(
										buildFieldCheckGate(
											currentGate?.id ?? `gate-${generateUUID()}`,
											channel,
											currentCheckGate?.field ?? 'status',
											currentCheckGate?.op ?? '==',
											(e.currentTarget as HTMLInputElement).value
										)
									)
								}
								class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
						)}
						<p class="text-xs text-gray-600">Use a field check when the gate depends on structured runtime data.</p>
					</div>
				)}

				{gateMode === 'count' && (
					<div class="space-y-2">
						<div class="grid grid-cols-2 gap-2">
							<input
								type="text"
								data-testid={`channel-edge-gate-select-${index}-count-field`}
								placeholder="field"
								value={currentCountGate?.field ?? 'votes'}
								onInput={(e) =>
									upsertRealGate(
										buildCountGate(
											currentGate?.id ?? `gate-${generateUUID()}`,
											channel,
											(e.currentTarget as HTMLInputElement).value,
											typeof currentCountGate?.matchValue === 'string'
												? currentCountGate.matchValue
												: 'approved',
											currentCountGate?.min ?? 3,
											currentGate?.resetOnCycle ?? true,
											currentGate?.data
										)
									)
								}
								class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
							<input
								type="text"
								data-testid={`channel-edge-gate-select-${index}-count-match`}
								placeholder="match value"
								value={typeof currentCountGate?.matchValue === 'string' ? currentCountGate.matchValue : 'approved'}
								onInput={(e) =>
									upsertRealGate(
										buildCountGate(
											currentGate?.id ?? `gate-${generateUUID()}`,
											channel,
											currentCountGate?.field ?? 'votes',
											(e.currentTarget as HTMLInputElement).value,
											currentCountGate?.min ?? 3,
											currentGate?.resetOnCycle ?? true,
											currentGate?.data
										)
									)
								}
								class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
						</div>
						<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
							<div class="space-y-1">
								<label class="text-[11px] uppercase tracking-[0.12em] text-gray-500">Minimum matches</label>
								<input
									type="number"
									min={1}
									step={1}
									data-testid={`channel-edge-gate-select-${index}-count-min`}
									value={currentCountGate?.min ?? 3}
									onInput={(e) =>
										upsertRealGate(
											buildCountGate(
												currentGate?.id ?? `gate-${generateUUID()}`,
												channel,
												currentCountGate?.field ?? 'votes',
												typeof currentCountGate?.matchValue === 'string'
													? currentCountGate.matchValue
													: 'approved',
												Number((e.currentTarget as HTMLInputElement).value),
												currentGate?.resetOnCycle ?? true,
												currentGate?.data
											)
										)
									}
									class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500"
								/>
							</div>
							<label class="mt-4 flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									data-testid={`channel-edge-gate-select-${index}-count-reset`}
									checked={currentGate?.resetOnCycle ?? true}
									onChange={(e) =>
										upsertRealGate(
											buildCountGate(
												currentGate?.id ?? `gate-${generateUUID()}`,
												channel,
												currentCountGate?.field ?? 'votes',
												typeof currentCountGate?.matchValue === 'string'
													? currentCountGate.matchValue
													: 'approved',
												currentCountGate?.min ?? 3,
												(e.currentTarget as HTMLInputElement).checked,
												currentGate?.data
											)
										)
									}
									class="rounded border-dark-600 text-blue-500 focus:ring-blue-500"
								/>
								<span class="text-xs text-gray-400">Reset on loop</span>
							</label>
						</div>
						<p class="text-xs text-gray-600">
							Counts entries in a shared map. This is the correct gate for reviewer quorum like 3 approvals before QA.
						</p>
					</div>
				)}

				{gateMode === 'none' && (
					<p class="text-xs text-gray-600">No gate. This link is always open.</p>
				)}
			</div>

			{shouldBeCyclic && (
				<div
					data-testid="channel-cyclic-info"
					class="rounded border border-blue-700/60 bg-blue-950/30 px-3 py-2 text-[11px] text-blue-200"
				>
					<div class="mb-1.5">This link closes a workflow loop.</div>
					<label class="flex items-center gap-2">
						<span class="text-blue-300">Max cycles</span>
						<input
							data-testid="channel-max-cycles-input"
							type="number"
							min={1}
							max={100}
							value={channel.maxCycles ?? 5}
							class="w-16 rounded bg-dark-800 border border-blue-700/40 px-2 py-0.5 text-[11px] text-blue-100"
							onChange={(e) => {
								const val = parseInt((e.target as HTMLInputElement).value, 10);
								if (!isNaN(val) && val >= 1) {
									onChange(index, { ...channel, maxCycles: val });
								}
							}}
						/>
					</label>
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
