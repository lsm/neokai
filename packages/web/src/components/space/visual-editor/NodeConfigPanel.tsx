/**
 * NodeConfigPanel
 *
 * A right-anchored slide-in panel that appears when a workflow node is selected
 * in the visual editor. Provides inline editing of all step properties using
 * the same field layout as the WorkflowStepCard expanded view.
 *
 * Features:
 * - Step Name input
 * - "Set as Start" button (disabled when node is already the start node)
 * - Agent dropdown
 * - Entry Gate selector (GateConfig)
 * - Exit Gate selector (GateConfig)
 * - Instructions textarea
 * - Delete Step button with confirmation (disabled for start node)
 */

import { useState, useEffect } from 'preact/hooks';
import type { SpaceAgent, WorkflowNodeAgent, WorkflowChannel } from '@neokai/shared';
import type { StepDraft } from '../WorkflowStepCard';
import { isMultiAgentStep } from '../WorkflowStepCard';
import { GateConfig } from './GateConfig';
import type { ConditionDraft } from './GateConfig';

// ============================================================================
// Props
// ============================================================================

export interface NodeConfigPanelProps {
	step: StepDraft;
	agents: SpaceAgent[];
	entryCondition: ConditionDraft | null;
	exitCondition: ConditionDraft | null;
	isStartNode: boolean;
	/**
	 * When true, the entry gate shows "Workflow starts here" (no selector).
	 * Mirrors the WorkflowStepCard terminal message for the first step.
	 */
	isFirstStep?: boolean;
	/**
	 * When true, the exit gate shows "Workflow ends here" (no selector).
	 * Mirrors the WorkflowStepCard terminal message for the last step.
	 */
	isLastStep?: boolean;
	onUpdate: (step: StepDraft) => void;
	onUpdateEntryCondition: (cond: ConditionDraft) => void;
	onUpdateExitCondition: (cond: ConditionDraft) => void;
	/** Designates this step as the workflow start node */
	onSetAsStart: (stepId: string) => void;
	onClose: () => void;
	/** Called when the user confirms deletion of this step */
	onDelete: (stepId: string) => void;
}

// ============================================================================
// AgentsSection — manages agents list in the config panel
// ============================================================================

interface AgentsSectionProps {
	step: StepDraft;
	agents: SpaceAgent[];
	onUpdate: (step: StepDraft) => void;
}

function AgentsSection({ step, agents, onUpdate }: AgentsSectionProps) {
	const multi = isMultiAgentStep(step);
	const stepAgents = step.agents ?? [];

	function updateAgents(next: WorkflowNodeAgent[]) {
		onUpdate({ ...step, agents: next, agentId: '' });
	}

	/**
	 * Auto-create Task Agent channels for a step that just got agents assigned.
	 * Called from event handlers (agent dropdown onChange, addAgent) to avoid
	 * mount-time side effects that corrupt existing workflow data.
	 */
	function buildTaskAgentChannels(agentsToChannel: WorkflowNodeAgent[]): WorkflowChannel[] {
		return agentsToChannel.map((sa) => {
			const agentInfo = agents.find((a) => a.id === sa.agentId);
			const role = agentInfo?.role ?? sa.agentId;
			return { from: 'task-agent', to: role, direction: 'bidirectional' };
		});
	}

	function addAgent(agentId: string) {
		if (!agentId) return;
		if (stepAgents.some((a) => a.agentId === agentId)) return;
		const next = [...stepAgents, { agentId }];
		// Merge agents + channels into a single onUpdate call to avoid stale-reference overwrites
		const newChannels = step.channels === undefined ? buildTaskAgentChannels(next) : step.channels;
		onUpdate({ ...step, agents: next, agentId: '', channels: newChannels });
	}

	function removeAgent(agentId: string) {
		const next = stepAgents.filter((a) => a.agentId !== agentId);
		if (next.length === 0) {
			// Switch back to single-agent mode: restore agentId from the removed agent and
			// clear channels (orphaned channels on a single-agent step are semantically invalid)
			onUpdate({ ...step, agents: undefined, agentId, channels: undefined });
		} else {
			updateAgents(next);
		}
	}

	function updateAgentInstructions(agentId: string, instructions: string) {
		updateAgents(
			stepAgents.map((a) =>
				a.agentId === agentId ? { ...a, instructions: instructions || undefined } : a
			)
		);
	}

	const usedIds = new Set(stepAgents.map((a) => a.agentId));
	const availableAgents = agents.filter((a) => !usedIds.has(a.id));

	if (!multi) {
		// Single-agent mode
		return (
			<div class="space-y-1.5">
				<div class="flex items-center justify-between">
					<label class="text-xs font-medium text-gray-400">Agent</label>
					<button
						type="button"
						data-testid="add-agent-button"
						onClick={() => {
							const firstId = step.agentId;
							const existing: WorkflowNodeAgent[] = firstId ? [{ agentId: firstId }] : [];
							onUpdate({ ...step, agents: existing, agentId: '' });
						}}
						class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
					>
						+ Add agent
					</button>
				</div>
				<select
					data-testid="agent-select"
					value={step.agentId}
					onChange={(e) => {
						const newAgentId = (e.currentTarget as HTMLSelectElement).value;
						const nextStep = { ...step, agentId: newAgentId };
						// Auto-create task-agent channel when a single agent is assigned
						if (newAgentId && step.channels === undefined) {
							const agentInfo = agents.find((a) => a.id === newAgentId);
							if (agentInfo) {
								nextStep.channels = [
									{ from: 'task-agent', to: agentInfo.role, direction: 'bidirectional' },
								];
							}
						}
						onUpdate(nextStep);
					}}
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
		);
	}

	// Multi-agent mode
	return (
		<div class="space-y-2">
			<div class="flex items-center justify-between">
				<label class="text-xs font-medium text-gray-400">
					Agents <span class="text-gray-600">({stepAgents.length})</span>
				</label>
				{stepAgents.length === 1 && (
					<button
						type="button"
						data-testid="switch-to-single-button"
						onClick={() =>
							onUpdate({
								...step,
								agents: undefined,
								agentId: stepAgents[0]?.agentId ?? '',
								channels: undefined,
							})
						}
						class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
					>
						Switch to single
					</button>
				)}
			</div>

			<div class="space-y-1.5" data-testid="agents-list">
				{stepAgents.map((sa) => {
					const agentInfo = agents.find((a) => a.id === sa.agentId);
					return (
						<div
							key={sa.agentId}
							class="bg-dark-800 border border-dark-600 rounded p-2 space-y-1"
							data-testid="agent-entry"
						>
							<div class="flex items-center justify-between">
								<span class="text-xs font-medium text-gray-200">
									{agentInfo?.name ?? sa.agentId}
									{agentInfo && <span class="text-gray-500 ml-1">({agentInfo.role})</span>}
								</span>
								<button
									type="button"
									data-testid="remove-agent-button"
									onClick={() => removeAgent(sa.agentId)}
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
								data-testid="agent-instructions-input"
								value={sa.instructions ?? ''}
								onInput={(e) =>
									updateAgentInstructions(sa.agentId, (e.currentTarget as HTMLInputElement).value)
								}
								placeholder="Per-agent instructions (optional)…"
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
						</div>
					);
				})}
			</div>

			{availableAgents.length > 0 && (
				<select
					data-testid="add-agent-select"
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
		</div>
	);
}

// ============================================================================
// ChannelsPanelSection — manages messaging channels in the config panel
// ============================================================================

interface ChannelsPanelSectionProps {
	step: StepDraft;
	agents: SpaceAgent[];
	onUpdate: (step: StepDraft) => void;
}

function ChannelsPanelSection({ step, agents, onUpdate }: ChannelsPanelSectionProps) {
	const channels = step.channels ?? [];
	const stepAgents = step.agents ?? [];

	// Collect known roles from step agents (+ wildcard)
	const knownRoles = [
		'*',
		...stepAgents.map((sa) => agents.find((a) => a.id === sa.agentId)?.role ?? sa.agentId),
	];

	const [newFrom, setNewFrom] = useState('');
	const [newTo, setNewTo] = useState('');
	const [newDirection, setNewDirection] = useState<'one-way' | 'bidirectional'>('one-way');
	const [newLabel, setNewLabel] = useState('');

	// Reset add-channel form fields when the selected node changes, so stale values
	// from one node don't bleed into the form for the next selected node.
	useEffect(() => {
		setNewFrom('');
		setNewTo('');
		setNewDirection('one-way');
		setNewLabel('');
	}, [step.localId]);

	function updateChannels(next: WorkflowChannel[]) {
		onUpdate({ ...step, channels: next.length > 0 ? next : undefined });
	}

	function removeChannel(index: number) {
		updateChannels(channels.filter((_, i) => i !== index));
	}

	function addChannel() {
		if (!newFrom || !newTo) return;
		const toValue: string | string[] = newTo.includes(',')
			? newTo
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: newTo.trim();
		const ch: WorkflowChannel = {
			from: newFrom,
			to: toValue,
			direction: newDirection,
			label: newLabel.trim() || undefined,
		};
		updateChannels([...channels, ch]);
		setNewFrom('');
		setNewTo('');
		setNewDirection('one-way');
		setNewLabel('');
	}

	const formatTo = (to: string | string[]) => (Array.isArray(to) ? `[${to.join(', ')}]` : to);

	return (
		<div class="space-y-2 pt-3 border-t border-dark-700" data-testid="channels-section">
			<label class="text-xs font-medium text-gray-400">
				Channels <span class="text-gray-600 font-normal">(messaging topology)</span>
			</label>

			{channels.length === 0 && (
				<p class="text-xs text-gray-600">No channels — agents are isolated.</p>
			)}

			<div class="space-y-1" data-testid="channels-list">
				{channels.map((ch, i) => (
					<div
						key={i}
						class="flex items-center gap-2 bg-dark-800 border border-dark-600 rounded px-2 py-1.5"
						data-testid="channel-entry"
					>
						<span class="text-xs text-gray-300 font-mono flex-1">
							{ch.from} {ch.direction === 'bidirectional' ? '↔' : '→'} {formatTo(ch.to)}
							{ch.label && <span class="text-gray-500 ml-1">"{ch.label}"</span>}
						</span>
						<button
							type="button"
							data-testid="remove-channel-button"
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
			<div
				class="space-y-2 bg-dark-800 border border-dark-600 rounded p-2"
				data-testid="add-channel-form"
			>
				<div class="flex gap-2">
					<select
						data-testid="channel-from-select"
						value={newFrom}
						onChange={(e) => setNewFrom((e.currentTarget as HTMLSelectElement).value)}
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
						data-testid="channel-direction-select"
						value={newDirection}
						onChange={(e) =>
							setNewDirection(
								(e.currentTarget as HTMLSelectElement).value as 'one-way' | 'bidirectional'
							)
						}
						class="text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500"
					>
						<option value="one-way">→ one-way</option>
						<option value="bidirectional">↔ bidirectional</option>
					</select>
				</div>
				<input
					data-testid="channel-to-input"
					type="text"
					value={newTo}
					onInput={(e) => setNewTo((e.currentTarget as HTMLInputElement).value)}
					placeholder="To role(s) — comma-separated, * for all"
					class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
				/>
				<input
					data-testid="channel-label-input"
					type="text"
					value={newLabel}
					onInput={(e) => setNewLabel((e.currentTarget as HTMLInputElement).value)}
					placeholder="Label (optional)"
					class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
				/>
				<button
					type="button"
					data-testid="add-channel-button"
					onClick={addChannel}
					disabled={!newFrom || !newTo}
					class="w-full text-xs py-1 rounded bg-dark-700 hover:bg-dark-600 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 transition-colors"
				>
					Add channel
				</button>
			</div>
		</div>
	);
}

// ============================================================================
// Component
// ============================================================================

export function NodeConfigPanel({
	step,
	agents,
	entryCondition,
	exitCondition,
	isStartNode,
	isFirstStep = false,
	isLastStep = false,
	onUpdate,
	onUpdateEntryCondition,
	onUpdateExitCondition,
	onSetAsStart,
	onClose,
	onDelete,
}: NodeConfigPanelProps) {
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	// Reset confirmation dialog when the selected step changes so a previously
	// open confirmation on one node doesn't bleed through to the next node.
	useEffect(() => {
		setConfirmingDelete(false);
	}, [step.localId]);

	const handleDeleteClick = () => {
		if (isStartNode) return; // defence-in-depth: button is also disabled
		setConfirmingDelete(true);
	};

	const handleDeleteConfirm = () => {
		setConfirmingDelete(false);
		onDelete(step.localId);
	};

	const handleDeleteCancel = () => {
		setConfirmingDelete(false);
	};

	return (
		<div
			data-testid="node-config-panel"
			style={{
				position: 'absolute',
				top: 0,
				right: 0,
				bottom: 0,
				width: 320,
				display: 'flex',
				flexDirection: 'column',
				zIndex: 20,
			}}
			class="bg-dark-900 border-l border-dark-700 shadow-xl animate-slideInRight"
		>
			{/* Header */}
			<div class="flex items-center justify-between px-4 py-3 border-b border-dark-700 flex-shrink-0">
				<div class="flex items-center gap-2 min-w-0">
					{isStartNode && (
						<span
							data-testid="start-node-badge"
							class="text-xs font-bold text-green-400 uppercase tracking-wider flex-shrink-0"
						>
							START
						</span>
					)}
					<h3 class="text-sm font-semibold text-gray-100 truncate">
						{step.name || 'Unnamed Step'}
					</h3>
				</div>
				<button
					data-testid="close-button"
					onClick={onClose}
					class="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-dark-700 transition-colors flex-shrink-0"
					title="Close panel"
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

			{/* Scrollable body */}
			<div class="flex-1 overflow-y-auto px-4 py-4 space-y-5">
				{/* Step Name */}
				<div class="space-y-1.5">
					<label class="text-xs font-medium text-gray-400">Step Name</label>
					<input
						data-testid="step-name-input"
						type="text"
						value={step.name}
						onInput={(e) =>
							onUpdate({ ...step, name: (e.currentTarget as HTMLInputElement).value })
						}
						placeholder="e.g. Plan the approach"
						class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
					/>
				</div>

				{/* Set as Start button */}
				{!isStartNode && (
					<button
						data-testid="set-as-start-button"
						onClick={() => onSetAsStart(step.localId)}
						class="w-full text-xs font-medium py-1.5 px-3 rounded border border-green-700 text-green-400 hover:bg-green-900/30 transition-colors"
					>
						Set as Start Node
					</button>
				)}

				{/* Agent(s) */}
				<AgentsSection step={step} agents={agents} onUpdate={onUpdate} />

				{/* Channels (shown when node has agents or has existing channels) */}
				{(!!step.agentId || isMultiAgentStep(step) || step.channels) && (
					<ChannelsPanelSection step={step} agents={agents} onUpdate={onUpdate} />
				)}

				{/* Entry Gate */}
				<GateConfig
					label="Entry Gate"
					condition={entryCondition ?? { type: 'always' }}
					onChange={onUpdateEntryCondition}
					terminalMessage={isFirstStep ? 'Workflow starts here' : undefined}
					testId="entry-gate-select"
				/>

				{/* Exit Gate */}
				<GateConfig
					label="Exit Gate"
					condition={exitCondition ?? { type: 'always' }}
					onChange={onUpdateExitCondition}
					terminalMessage={isLastStep ? 'Workflow ends here' : undefined}
					testId="exit-gate-select"
				/>

				{/* Instructions */}
				<div class="space-y-1.5">
					<label class="text-xs font-medium text-gray-400">
						Instructions <span class="font-normal text-gray-600">(optional)</span>
					</label>
					<textarea
						data-testid="instructions-textarea"
						value={step.instructions}
						onInput={(e) =>
							onUpdate({
								...step,
								instructions: (e.currentTarget as HTMLTextAreaElement).value,
							})
						}
						placeholder="Step-specific instructions appended to the agent's system prompt…"
						rows={5}
						class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
					/>
				</div>
			</div>

			{/* Footer — Delete button */}
			<div class="px-4 py-3 border-t border-dark-700 flex-shrink-0">
				{confirmingDelete ? (
					<div class="space-y-2">
						<p class="text-xs text-gray-400">Delete this step? This cannot be undone.</p>
						<div class="flex gap-2">
							<button
								data-testid="delete-confirm-button"
								onClick={handleDeleteConfirm}
								class="flex-1 text-xs py-1.5 px-3 rounded bg-red-700 hover:bg-red-600 text-white font-medium transition-colors"
							>
								Delete
							</button>
							<button
								data-testid="delete-cancel-button"
								onClick={handleDeleteCancel}
								class="flex-1 text-xs py-1.5 px-3 rounded border border-dark-600 text-gray-400 hover:text-gray-200 hover:bg-dark-700 transition-colors"
							>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<button
						data-testid="delete-step-button"
						onClick={handleDeleteClick}
						disabled={isStartNode}
						title={isStartNode ? 'Designate another node as start before deleting' : 'Delete step'}
						class="w-full text-xs py-1.5 px-3 rounded border border-red-900 text-red-500 hover:bg-red-900/30 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
					>
						Delete Step
					</button>
				)}
				{isStartNode && !confirmingDelete && (
					<p class="text-xs text-gray-600 mt-1.5 text-center">
						Designate another node as start before deleting.
					</p>
				)}
			</div>
		</div>
	);
}
