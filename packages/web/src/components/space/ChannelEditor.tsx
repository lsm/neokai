/**
 * ChannelEditor
 *
 * Unified CRUD editor for WorkflowChannel entries with gate configuration.
 * Supports all 4 gate condition types: always, human, condition, task_result.
 *
 * This component manages workflow-level channels (not node-level).
 * Channels connect agents by role name across nodes in the workflow graph.
 *
 * Usage:
 *   <ChannelEditor channels={channels} onChange={setChannels} agentRoles={roles} />
 */

import { useState, useCallback, useEffect } from 'preact/hooks';
import type { WorkflowChannel } from '@neokai/shared';

// ============================================================================
// Types
// ============================================================================

export interface ChannelEditorProps {
	/** Workflow-level channels */
	channels: WorkflowChannel[];
	onChange: (channels: WorkflowChannel[]) => void;
	/** Known agent role names for from/to dropdowns (from step.agents[].name) */
	agentRoles?: string[];
	/** Index of the channel to pre-expand (e.g. when selected via canvas click) */
	highlightIndex?: number | null;
}

// ============================================================================
// Gate type helpers
// ============================================================================

type GateType = 'always' | 'human' | 'condition' | 'task_result';

const GATE_TYPE_TO_ID: Record<Exclude<GateType, 'always'>, string> = {
	human: 'human-approval',
	condition: 'custom-condition',
	task_result: 'task-result',
};

function gateIdToType(gateId?: string): GateType {
	if (!gateId) return 'always';
	if (gateId === 'human-approval') return 'human';
	if (gateId === 'task-result') return 'task_result';
	return 'condition';
}

const GATE_TYPE_LABELS: Record<GateType, string> = {
	always: 'Automatic',
	human: 'Human Approval',
	condition: 'Custom Condition',
	task_result: 'Task Result',
};

// ============================================================================
// Helpers
// ============================================================================

function formatTo(to: string | string[]): string {
	return Array.isArray(to) ? to.join(', ') : to;
}

function parseToField(raw: string): string | string[] {
	const parts = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length > 1 ? parts : (parts[0] ?? '');
}

// ============================================================================
// ChannelEntry — single expandable channel row
// ============================================================================

interface ChannelEntryProps {
	channel: WorkflowChannel;
	index: number;
	agentRoles: string[];
	expanded: boolean;
	highlighted: boolean;
	onToggle: () => void;
	onChange: (index: number, channel: WorkflowChannel) => void;
	onDelete: (index: number) => void;
}

function ChannelEntry({
	channel,
	index,
	agentRoles,
	expanded,
	highlighted,
	onToggle,
	onChange,
	onDelete,
}: ChannelEntryProps) {
	const hasGate = !!channel.gateId;
	const directionSymbol = channel.direction === 'bidirectional' ? '↔' : '→';
	const toText = formatTo(channel.to);

	function updateField<K extends keyof WorkflowChannel>(key: K, value: WorkflowChannel[K]) {
		onChange(index, { ...channel, [key]: value });
	}

	const borderClass = highlighted
		? 'border-teal-500 ring-1 ring-teal-500/40'
		: hasGate
			? 'border-teal-700/50 bg-teal-950/20'
			: 'border-dark-600 bg-dark-800';

	return (
		<div
			class={`rounded border ${borderClass}`}
			data-testid="channel-entry"
			data-has-gate={hasGate ? 'true' : undefined}
			data-channel-index={index}
		>
			{/* Summary row */}
			<div class="flex items-center gap-2 px-2 py-1.5">
				<button
					type="button"
					onClick={onToggle}
					class="flex-1 flex items-center gap-2 text-left min-w-0"
					data-testid="channel-toggle-button"
				>
					<span class="text-xs text-gray-300 font-mono truncate">
						<span class="text-gray-400">{channel.from}</span>
						<span class="text-teal-500 mx-1">{directionSymbol}</span>
						<span class="text-gray-400">{toText}</span>
					</span>
					{hasGate && (
						<span
							class="text-xs text-teal-400 bg-teal-900/40 border border-teal-700/50 rounded px-1 py-0.5 flex-shrink-0"
							data-testid="gate-badge"
						>
							{GATE_TYPE_LABELS[gateIdToType(channel.gateId)]}
						</span>
					)}
					{channel.label && (
						<span class="text-xs text-gray-600 italic truncate flex-shrink-0">
							&ldquo;{channel.label}&rdquo;
						</span>
					)}
				</button>
				<button
					type="button"
					onClick={onToggle}
					class="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0"
					title={expanded ? 'Collapse' : 'Edit'}
					data-testid="channel-expand-button"
					aria-expanded={expanded}
				>
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						{expanded ? (
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M5 15l7-7 7 7"
							/>
						) : (
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M19 9l-7 7-7-7"
							/>
						)}
					</svg>
				</button>
				<button
					type="button"
					onClick={() => onDelete(index)}
					class="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
					title="Delete channel"
					data-testid="delete-channel-button"
				>
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>

			{/* Edit form */}
			{expanded && (
				<div
					class="px-2 pb-2 space-y-2 border-t border-dark-700 pt-2"
					data-testid="channel-edit-form"
				>
					{/* From */}
					<div class="space-y-0.5">
						<label class="text-xs text-gray-500">From</label>
						{agentRoles.length > 0 ? (
							<select
								data-testid="channel-from-select"
								value={channel.from}
								onChange={(e) => updateField('from', (e.currentTarget as HTMLSelectElement).value)}
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
							>
								<option value="">— Select source —</option>
								<option value="task-agent">task-agent</option>
								<option value="*">* (all agents)</option>
								{agentRoles.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						) : (
							<input
								type="text"
								data-testid="channel-from-input"
								value={channel.from}
								onInput={(e) => updateField('from', (e.currentTarget as HTMLInputElement).value)}
								placeholder="e.g. task-agent, coder, *"
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
							/>
						)}
					</div>

					{/* Direction */}
					<div class="space-y-0.5">
						<label class="text-xs text-gray-500">Direction</label>
						<select
							data-testid="channel-direction-select"
							value={channel.direction}
							onChange={(e) =>
								updateField(
									'direction',
									(e.currentTarget as HTMLSelectElement).value as 'one-way' | 'bidirectional'
								)
							}
							class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
						>
							<option value="one-way">→ One-way</option>
							<option value="bidirectional">↔ Bidirectional</option>
						</select>
					</div>

					{/* To */}
					<div class="space-y-0.5">
						<label class="text-xs text-gray-500">To (comma-separated for fan-out)</label>
						{agentRoles.length > 0 && typeof channel.to === 'string' ? (
							<select
								data-testid="channel-to-select"
								value={channel.to}
								onChange={(e) => updateField('to', (e.currentTarget as HTMLSelectElement).value)}
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
							>
								<option value="">— Select target —</option>
								<option value="task-agent">task-agent</option>
								<option value="*">* (all agents)</option>
								{agentRoles.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						) : (
							<input
								type="text"
								data-testid="channel-to-input"
								value={formatTo(channel.to)}
								onInput={(e) =>
									updateField('to', parseToField((e.currentTarget as HTMLInputElement).value))
								}
								placeholder="e.g. reviewer, coder (comma for fan-out)"
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
							/>
						)}
					</div>

					{/* Label */}
					<div class="space-y-0.5">
						<label class="text-xs text-gray-500">Label (optional)</label>
						<input
							type="text"
							data-testid="channel-label-input"
							value={channel.label ?? ''}
							onInput={(e) =>
								updateField('label', (e.currentTarget as HTMLInputElement).value || undefined)
							}
							placeholder="e.g. PR ready for review"
							class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
						/>
					</div>

					{/* Gate Condition */}
					<div class="space-y-0.5">
						<label class="text-xs text-gray-500">Gate Condition</label>
						<select
							data-testid={`channel-gate-select-${index}`}
							value={gateIdToType(channel.gateId)}
							onChange={(e) => {
								const type = (e.currentTarget as HTMLSelectElement).value as GateType;
								updateField(
									'gateId',
									type === 'always'
										? undefined
										: GATE_TYPE_TO_ID[type as Exclude<GateType, 'always'>]
								);
							}}
							class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
						>
							<option value="always">Automatic (always open)</option>
							<option value="human">Human Approval</option>
							<option value="condition">Custom Condition</option>
							<option value="task_result">Task Result</option>
						</select>
					</div>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// AddChannelForm — inline form to add a new channel
// ============================================================================

interface AddChannelFormProps {
	agentRoles: string[];
	onAdd: (channel: WorkflowChannel) => void;
}

function AddChannelForm({ agentRoles, onAdd }: AddChannelFormProps) {
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const [direction, setDirection] = useState<'one-way' | 'bidirectional'>('one-way');
	const [label, setLabel] = useState('');

	function handleAdd() {
		if (!from.trim() || !to.trim()) return;
		onAdd({
			from: from.trim(),
			to: parseToField(to),
			direction,
			label: label.trim() || undefined,
		});
		setFrom('');
		setTo('');
		setDirection('one-way');
		setLabel('');
	}

	const disabled = !from.trim() || !to.trim();

	return (
		<div
			class="space-y-2 bg-dark-850 border border-dashed border-dark-600 rounded p-2"
			data-testid="add-channel-form"
		>
			<p class="text-xs text-gray-600 font-medium">Add channel</p>
			<div class="flex gap-2">
				{agentRoles.length > 0 ? (
					<select
						data-testid="new-channel-from-select"
						value={from}
						onChange={(e) => setFrom((e.currentTarget as HTMLSelectElement).value)}
						class="flex-1 text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
					>
						<option value="">From…</option>
						<option value="task-agent">task-agent</option>
						<option value="*">* (all)</option>
						{agentRoles.map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				) : (
					<input
						type="text"
						data-testid="new-channel-from-input"
						value={from}
						onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)}
						placeholder="From…"
						class="flex-1 text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
					/>
				)}
				<select
					data-testid="new-channel-direction-select"
					value={direction}
					onChange={(e) =>
						setDirection(
							(e.currentTarget as HTMLSelectElement).value as 'one-way' | 'bidirectional'
						)
					}
					class="text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
				>
					<option value="one-way">→</option>
					<option value="bidirectional">↔</option>
				</select>
			</div>
			{agentRoles.length > 0 ? (
				<select
					data-testid="new-channel-to-select"
					value={to}
					onChange={(e) => setTo((e.currentTarget as HTMLSelectElement).value)}
					class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
				>
					<option value="">To…</option>
					<option value="task-agent">task-agent</option>
					<option value="*">* (all)</option>
					{agentRoles.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
			) : (
				<input
					type="text"
					data-testid="new-channel-to-input"
					value={to}
					onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)}
					placeholder="To… (comma-separated for fan-out)"
					class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
				/>
			)}
			<input
				type="text"
				data-testid="new-channel-label-input"
				value={label}
				onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)}
				placeholder="Label (optional)"
				class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-teal-500"
			/>
			<button
				type="button"
				data-testid="add-channel-submit-button"
				onClick={handleAdd}
				disabled={disabled}
				class="w-full text-xs py-1 rounded bg-teal-700/50 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed text-teal-300 transition-colors"
			>
				Add Channel
			</button>
		</div>
	);
}

// ============================================================================
// ChannelEditor
// ============================================================================

export function ChannelEditor({
	channels,
	onChange,
	agentRoles = [],
	highlightIndex = null,
}: ChannelEditorProps) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	// Auto-expand the highlighted channel (e.g. selected from canvas)
	useEffect(() => {
		if (highlightIndex !== null) {
			setExpandedIndex(highlightIndex);
		}
	}, [highlightIndex]);

	const handleToggle = useCallback((index: number) => {
		setExpandedIndex((prev) => (prev === index ? null : index));
	}, []);

	const handleChange = useCallback(
		(index: number, updated: WorkflowChannel) => {
			const next = channels.map((ch, i) => (i === index ? updated : ch));
			onChange(next);
		},
		[channels, onChange]
	);

	const handleDelete = useCallback(
		(index: number) => {
			const next = channels.filter((_, i) => i !== index);
			onChange(next);
			setExpandedIndex((prev) => {
				if (prev === null) return null;
				if (prev === index) return null;
				if (prev > index) return prev - 1;
				return prev;
			});
		},
		[channels, onChange]
	);

	const handleAdd = useCallback(
		(channel: WorkflowChannel) => {
			onChange([...channels, channel]);
			// Auto-expand the newly added channel
			setExpandedIndex(channels.length);
		},
		[channels, onChange]
	);

	return (
		<div class="space-y-2" data-testid="channel-editor">
			{channels.length === 0 && (
				<p class="text-xs text-gray-600 text-center py-2">No channels — agents are isolated.</p>
			)}

			<div class="space-y-1.5" data-testid="channels-list">
				{channels.map((ch, i) => (
					<ChannelEntry
						key={i}
						channel={ch}
						index={i}
						agentRoles={agentRoles}
						expanded={expandedIndex === i}
						highlighted={highlightIndex === i && expandedIndex !== i}
						onToggle={() => handleToggle(i)}
						onChange={handleChange}
						onDelete={handleDelete}
					/>
				))}
			</div>

			<AddChannelForm agentRoles={agentRoles} onAdd={handleAdd} />
		</div>
	);
}
