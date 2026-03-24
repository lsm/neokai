/**
 * WorkflowNodeCard Component
 *
 * A single node card in the workflow editor.
 * Supports collapsed (summary) and expanded (edit) modes.
 *
 * Collapsed: step number, agent name, gate type icons
 * Expanded: name input, agent dropdown, entry/exit gate selectors, instructions
 */

import type { SpaceAgent, WorkflowNodeAgent, WorkflowChannel } from '@neokai/shared';
import type { WorkflowConditionType } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { GateConfig, CONDITION_LABELS } from './visual-editor/GateConfig';
import type { ConditionDraft } from './visual-editor/GateConfig';

// ============================================================================
// Draft Types (used by WorkflowEditor + WorkflowNodeCard)
// ============================================================================

export interface NodeDraft {
	/** Stable local key for React rendering — not sent to the server */
	localId: string;
	/** Existing step ID when editing an existing workflow */
	id?: string;
	name: string;
	/** Single-agent shorthand (backward compat). When agents is provided and non-empty, agents takes precedence. */
	agentId: string;
	/** Multiple agents for parallel execution. When non-empty, takes precedence over agentId. */
	agents?: WorkflowNodeAgent[];
	/** Directed messaging topology between agents. */
	channels?: WorkflowChannel[];
	instructions: string;
}

// ============================================================================
// Multi-agent helpers
// ============================================================================

/** Returns true when this node has multiple agents configured. */
export function isMultiAgentNode(node: NodeDraft): boolean {
	return Array.isArray(node.agents) && node.agents.length > 0;
}

// Re-export ConditionDraft so existing importers don't break
export type { ConditionDraft } from './visual-editor/GateConfig';

// ============================================================================
// Icon Components
// ============================================================================

function GateIcon({ type }: { type: WorkflowConditionType }) {
	if (type === 'human') {
		return (
			<svg
				class="w-3 h-3"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				title="Human Approval"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
				/>
			</svg>
		);
	}
	if (type === 'condition') {
		return (
			<svg
				class="w-3 h-3"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				title="Shell Condition"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
				/>
			</svg>
		);
	}
	// always
	return (
		<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Automatic">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M13 5l7 7-7 7M5 5l7 7-7 7"
			/>
		</svg>
	);
}

function ChevronDown() {
	return (
		<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 9l-7 7-7-7" />
		</svg>
	);
}

function ChevronUp() {
	return (
		<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M5 15l7-7 7 7" />
		</svg>
	);
}

// ============================================================================
// MultiAgentSection — manages the agents list in expanded view
// ============================================================================

interface MultiAgentSectionProps {
	node: NodeDraft;
	agents: SpaceAgent[];
	onUpdate: (node: NodeDraft) => void;
}

function MultiAgentSection({ node, agents, onUpdate }: MultiAgentSectionProps) {
	const nodeAgents = node.agents ?? [];

	function updateAgents(next: WorkflowNodeAgent[]) {
		onUpdate({ ...node, agents: next, agentId: '' });
	}

	function addAgent(agentId: string) {
		if (!agentId) return;
		const agentInfo = agents.find((a) => a.id === agentId);
		const role = agentInfo?.role ?? agentId;
		updateAgents([...nodeAgents, { agentId, role }]);
	}

	function removeAgent(role: string) {
		const removed = nodeAgents.find((a) => a.role === role);
		const next = nodeAgents.filter((a) => a.role !== role);
		if (next.length === 0) {
			// Switch back to single-agent mode: restore agentId from the removed agent and
			// clear channels (orphaned channels on a single-agent node are semantically invalid)
			onUpdate({
				...node,
				agents: undefined,
				agentId: removed?.agentId ?? '',
				channels: undefined,
			});
		} else {
			updateAgents(next);
		}
	}

	function updateAgentInstructions(role: string, instructions: string) {
		updateAgents(
			nodeAgents.map((a) =>
				a.role === role ? { ...a, instructions: instructions || undefined } : a
			)
		);
	}

	// All agents are available; same agent may be added multiple times with different roles.
	const availableAgents = agents;

	return (
		<div class="space-y-2">
			<div class="flex items-center justify-between">
				<label class="text-xs font-medium text-gray-400">
					Agents <span class="text-gray-600">({nodeAgents.length})</span>
				</label>
				{nodeAgents.length === 1 && (
					<button
						type="button"
						onClick={() =>
							onUpdate({
								...node,
								agents: undefined,
								agentId: nodeAgents[0]?.agentId ?? '',
								channels: undefined,
							})
						}
						class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
					>
						Switch to single
					</button>
				)}
			</div>

			{/* Agent list */}
			<div class="space-y-1.5">
				{nodeAgents.map((sa) => {
					const agentInfo = agents.find((a) => a.id === sa.agentId);
					return (
						<div key={sa.role} class="bg-dark-800 border border-dark-600 rounded p-2 space-y-1">
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-gray-200">
									{agentInfo?.name ?? sa.agentId}
									{agentInfo && <span class="text-gray-500 ml-1">({sa.role})</span>}
								</span>
								<button
									type="button"
									onClick={() => removeAgent(sa.role)}
									class="text-gray-600 hover:text-red-400 transition-colors"
									title="Remove agent"
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
							<input
								type="text"
								value={sa.instructions ?? ''}
								onInput={(e) =>
									updateAgentInstructions(sa.role, (e.currentTarget as HTMLInputElement).value)
								}
								placeholder="Per-agent instructions (optional)…"
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
						</div>
					);
				})}
			</div>

			{/* Add agent dropdown */}
			{availableAgents.length > 0 && (
				<select
					value=""
					onChange={(e) => {
						addAgent((e.currentTarget as HTMLSelectElement).value);
						(e.currentTarget as HTMLSelectElement).value = '';
					}}
					class="w-full text-xs bg-dark-800 border border-dark-600 border-dashed rounded px-2 py-1.5 text-gray-500 focus:outline-none focus:border-blue-500"
				>
					<option value="">+ Add agent…</option>
					{availableAgents.map((a) => (
						<option key={a.id} value={a.id}>
							{a.name} ({a.role})
						</option>
					))}
				</select>
			)}

			{/* Channels section */}
			<ChannelsSection node={node} agents={agents} onUpdate={onUpdate} />
		</div>
	);
}

// ============================================================================
// ChannelsSection — manages messaging topology channels
// ============================================================================

interface ChannelsSectionProps {
	node: NodeDraft;
	agents: SpaceAgent[];
	onUpdate: (node: NodeDraft) => void;
}

/** Human-readable label for a channel direction. */
function channelDirectionLabel(direction: 'one-way' | 'bidirectional'): string {
	return direction === 'bidirectional' ? '↔' : '→';
}

/** Format a to value for display. */
function formatTo(to: string | string[]): string {
	return Array.isArray(to) ? `[${to.join(', ')}]` : to;
}

function ChannelsSection({ node, agents, onUpdate }: ChannelsSectionProps) {
	const channels = node.channels ?? [];
	const nodeAgents = node.agents ?? [];

	// Collect known roles from node agents (+ wildcard)
	const knownRoles = [
		'*',
		...nodeAgents.map((sa) => agents.find((a) => a.id === sa.agentId)?.role ?? sa.agentId),
	];

	function updateChannels(next: WorkflowChannel[]) {
		onUpdate({ ...node, channels: next.length > 0 ? next : undefined });
	}

	function removeChannel(index: number) {
		updateChannels(channels.filter((_, i) => i !== index));
	}

	function addChannel(
		from: string,
		to: string,
		direction: 'one-way' | 'bidirectional',
		label?: string
	) {
		if (!from || !to) return;
		// Support comma-separated multi-select for fan-out
		const toValue: string | string[] = to.includes(',')
			? to
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: to;
		updateChannels([...channels, { from, to: toValue, direction, label: label || undefined }]);
	}

	return (
		<div class="space-y-2 pt-2 border-t border-dark-700">
			<label class="text-xs font-medium text-gray-400">
				Channels <span class="text-gray-600 font-normal">(messaging topology)</span>
			</label>

			{channels.length === 0 && (
				<p class="text-xs text-gray-600">No channels — agents are isolated.</p>
			)}

			{/* Channel list */}
			<div class="space-y-1">
				{channels.map((ch, i) => (
					<div
						key={i}
						class="flex items-center gap-2 bg-dark-800 border border-dark-600 rounded px-2 py-1.5"
					>
						<span class="text-xs text-gray-300 font-mono flex-1">
							{ch.from} {channelDirectionLabel(ch.direction)} {formatTo(ch.to)}
							{ch.label && <span class="text-gray-500 ml-1">"{ch.label}"</span>}
						</span>
						<button
							type="button"
							onClick={() => removeChannel(i)}
							class="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
							title="Remove channel"
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
				))}
			</div>

			{/* Add channel form */}
			<AddChannelForm knownRoles={knownRoles} onAdd={addChannel} />
		</div>
	);
}

interface AddChannelFormProps {
	knownRoles: string[];
	onAdd: (from: string, to: string, direction: 'one-way' | 'bidirectional', label?: string) => void;
}

function AddChannelForm({ knownRoles, onAdd }: AddChannelFormProps) {
	return (
		<details class="group">
			<summary class="text-xs text-blue-400 hover:text-blue-300 cursor-pointer list-none">
				+ Add channel
			</summary>
			<ChannelFormBody knownRoles={knownRoles} onAdd={onAdd} />
		</details>
	);
}

interface ChannelFormBodyProps {
	knownRoles: string[];
	onAdd: (from: string, to: string, direction: 'one-way' | 'bidirectional', label?: string) => void;
}

function ChannelFormBody({ knownRoles, onAdd }: ChannelFormBodyProps) {
	// We use a form inside details to avoid useState — just read values on submit
	function handleSubmit(e: Event) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;
		const from = (form.elements.namedItem('from') as HTMLSelectElement).value;
		const to = (form.elements.namedItem('to') as HTMLInputElement).value.trim();
		const direction = (form.elements.namedItem('direction') as HTMLSelectElement).value as
			| 'one-way'
			| 'bidirectional';
		const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim();
		onAdd(from, to, direction, label || undefined);
		form.reset();
	}

	return (
		<form
			onSubmit={handleSubmit}
			class="mt-2 space-y-2 bg-dark-800 border border-dark-600 rounded p-2"
		>
			<div class="flex gap-2">
				<select
					name="from"
					class="flex-1 text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500"
				>
					<option value="">From…</option>
					{knownRoles.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
				<select
					name="direction"
					class="text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500"
				>
					<option value="one-way">→ one-way</option>
					<option value="bidirectional">↔ bidirectional</option>
				</select>
			</div>
			<input
				name="to"
				type="text"
				placeholder="To role(s) — comma-separated for fan-out, * for all"
				class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
			/>
			<input
				name="label"
				type="text"
				placeholder="Label (optional)"
				class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
			/>
			<button
				type="submit"
				class="w-full text-xs py-1 rounded bg-dark-700 hover:bg-dark-600 text-gray-300 transition-colors"
			>
				Add
			</button>
		</form>
	);
}

// ============================================================================
// Main Component
// ============================================================================

interface WorkflowNodeCardProps {
	node: NodeDraft;
	nodeIndex: number;
	isFirst: boolean;
	isLast: boolean;
	expanded: boolean;
	/** Condition on the transition coming INTO this node. Null for the first node. */
	entryCondition: ConditionDraft | null;
	/** Condition on the transition going OUT from this node. Null for the last node. */
	exitCondition: ConditionDraft | null;
	/** All space agents, excluding 'leader' */
	agents: SpaceAgent[];
	onToggleExpand: () => void;
	onUpdate: (node: NodeDraft) => void;
	/** Called when entry condition changes — updates transition[nodeIndex-1] */
	onUpdateEntryCondition: (cond: ConditionDraft) => void;
	/** Called when exit condition changes — updates transition[nodeIndex] */
	onUpdateExitCondition: (cond: ConditionDraft) => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onRemove: () => void;
	/** When true, the Remove button is disabled (e.g. only one node remains) */
	disableRemove?: boolean;
}

export function WorkflowNodeCard({
	node,
	nodeIndex,
	isFirst,
	isLast,
	expanded,
	entryCondition,
	exitCondition,
	agents,
	onToggleExpand,
	onUpdate,
	onUpdateEntryCondition,
	onUpdateExitCondition,
	onMoveUp,
	onMoveDown,
	onRemove,
	disableRemove = false,
}: WorkflowNodeCardProps) {
	const multi = isMultiAgentNode(node);
	const agentName = agents.find((a) => a.id === node.agentId)?.name ?? node.agentId;

	return (
		<div class="border border-dark-700 rounded-lg overflow-hidden">
			{/* Collapsed header — always visible */}
			<div
				class={cn(
					'flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none',
					expanded ? 'bg-dark-800 border-b border-dark-700' : 'bg-dark-850 hover:bg-dark-800'
				)}
				onClick={onToggleExpand}
			>
				{/* Step number */}
				<span class="w-5 h-5 flex items-center justify-center rounded-full bg-dark-700 text-xs font-semibold text-gray-400 flex-shrink-0">
					{nodeIndex + 1}
				</span>

				{/* Step info */}
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-1.5 min-w-0 flex-wrap">
						<span class="text-xs font-medium text-gray-200 truncate">
							{node.name || 'Unnamed Node'}
						</span>
						<span class="text-xs text-gray-600 flex-shrink-0">·</span>
						{multi ? (
							<span class="flex items-center gap-1 flex-wrap">
								{node.agents!.map((a) => {
									const name = agents.find((ag) => ag.id === a.agentId)?.name ?? a.agentId;
									return (
										<span
											key={a.agentId}
											class="text-xs bg-dark-700 border border-dark-600 text-gray-300 rounded px-1 py-0.5"
										>
											{name}
										</span>
									);
								})}
							</span>
						) : (
							<span class="text-xs text-gray-500 truncate flex-shrink-0">{agentName || '—'}</span>
						)}
					</div>
				</div>

				{/* Gate icons */}
				<div class="flex items-center gap-1 text-gray-600 flex-shrink-0">
					{entryCondition && entryCondition.type !== 'always' && (
						<span title={`Entry: ${CONDITION_LABELS[entryCondition.type]}`}>
							<GateIcon type={entryCondition.type} />
						</span>
					)}
					{exitCondition && exitCondition.type !== 'always' && (
						<span title={`Exit: ${CONDITION_LABELS[exitCondition.type]}`}>
							<GateIcon type={exitCondition.type} />
						</span>
					)}
				</div>

				{/* Controls */}
				<div class="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
					<button
						onClick={onMoveUp}
						disabled={isFirst}
						class="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
						title="Move up"
					>
						<ChevronUp />
					</button>
					<button
						onClick={onMoveDown}
						disabled={isLast}
						class="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
						title="Move down"
					>
						<ChevronDown />
					</button>
					<button
						onClick={onRemove}
						disabled={disableRemove}
						class="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
						title="Remove node"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				{/* Expand chevron */}
				<span class="text-gray-600 flex-shrink-0">
					{expanded ? <ChevronUp /> : <ChevronDown />}
				</span>
			</div>

			{/* Expanded body */}
			{expanded && (
				<div class="px-4 py-4 bg-dark-900 space-y-4">
					{/* Name */}
					<div class="space-y-1">
						<label class="text-xs font-medium text-gray-400">Node Name</label>
						<input
							type="text"
							value={node.name}
							onInput={(e) =>
								onUpdate({ ...node, name: (e.currentTarget as HTMLInputElement).value })
							}
							placeholder="e.g. Plan the approach"
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
						/>
					</div>

					{/* Agent(s) */}
					{multi ? (
						<MultiAgentSection node={node} agents={agents} onUpdate={onUpdate} />
					) : (
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<label class="text-xs font-medium text-gray-400">Agent</label>
								<button
									type="button"
									onClick={() => {
										const firstId = node.agentId;
										const firstAgentRole = firstId
											? (agents.find((a) => a.id === firstId)?.role ?? firstId)
											: '';
										const existing: WorkflowNodeAgent[] = firstId
											? [{ agentId: firstId, role: firstAgentRole }]
											: [];
										onUpdate({ ...node, agents: existing, agentId: '' });
									}}
									class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
								>
									+ Add agent
								</button>
							</div>
							<select
								value={node.agentId}
								onChange={(e) =>
									onUpdate({ ...node, agentId: (e.currentTarget as HTMLSelectElement).value })
								}
								class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
							>
								<option value="">— Select agent —</option>
								{agents.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
										{` (${a.role})`}
									</option>
								))}
							</select>
						</div>
					)}

					{/* Entry Gate */}
					<GateConfig
						label="Entry Gate"
						condition={entryCondition ?? { type: 'always' }}
						onChange={onUpdateEntryCondition}
						terminalMessage={isFirst ? 'Workflow starts here' : undefined}
					/>

					{/* Exit Gate */}
					<GateConfig
						label="Exit Gate"
						condition={exitCondition ?? { type: 'always' }}
						onChange={onUpdateExitCondition}
						terminalMessage={isLast ? 'Workflow ends here' : undefined}
					/>

					{/* Instructions */}
					<div class="space-y-1">
						<label class="text-xs font-medium text-gray-400">
							Instructions <span class="font-normal text-gray-600">(optional)</span>
						</label>
						<textarea
							value={node.instructions}
							onInput={(e) =>
								onUpdate({
									...node,
									instructions: (e.currentTarget as HTMLTextAreaElement).value,
								})
							}
							placeholder="Node-specific instructions appended to the agent's system prompt…"
							rows={4}
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
				</div>
			)}
		</div>
	);
}
