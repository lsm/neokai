/**
 * NodeConfigPanel
 *
 * A right-anchored slide-in panel that appears when a workflow node is selected
 * in the visual editor. Provides inline editing of all step properties using
 * the same field layout as the WorkflowNodeCard expanded view.
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

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { SpaceAgent, WorkflowNodeAgent, WorkflowChannel } from '@neokai/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import { isMultiAgentNode } from '../WorkflowNodeCard';
import { GateConfig } from './GateConfig';
import type { ConditionDraft } from './GateConfig';

// ============================================================================
// Props
// ============================================================================

export interface NodeConfigPanelProps {
	step: NodeDraft;
	agents: SpaceAgent[];
	entryCondition: ConditionDraft | null;
	exitCondition: ConditionDraft | null;
	isStartNode: boolean;
	/**
	 * When true, the entry gate shows "Workflow starts here" (no selector).
	 * Mirrors the WorkflowNodeCard terminal message for the first step.
	 */
	isFirstStep?: boolean;
	/**
	 * When true, the exit gate shows "Workflow ends here" (no selector).
	 * Mirrors the WorkflowNodeCard terminal message for the last step.
	 */
	isLastStep?: boolean;
	onUpdate: (step: NodeDraft) => void;
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
	step: NodeDraft;
	agents: SpaceAgent[];
	onUpdate: (step: NodeDraft) => void;
}

function AgentsSection({ step, agents, onUpdate }: AgentsSectionProps) {
	const multi = isMultiAgentNode(step);
	const stepAgents = step.agents ?? [];

	// Track which slots have their override fields expanded (keyed by role)
	const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set());

	const toggleSlotExpanded = useCallback((role: string) => {
		setExpandedSlots((prev) => {
			const next = new Set(prev);
			if (next.has(role)) next.delete(role);
			else next.add(role);
			return next;
		});
	}, []);

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
			return { from: 'task-agent', to: sa.role, direction: 'bidirectional' };
		});
	}

	function addAgent(agentId: string) {
		if (!agentId) return;
		const agentInfo = agents.find((a) => a.id === agentId);
		const baseRole = agentInfo?.role ?? agentId;
		// Ensure the slot role is unique within this node. When the same agent is added
		// multiple times, append a numeric suffix to distinguish the slots.
		const usedRoles = new Set(stepAgents.map((a) => a.role));
		let role = baseRole;
		for (let i = 2; usedRoles.has(role); i++) {
			role = `${baseRole}-${i}`;
		}
		const next = [...stepAgents, { agentId, role }];
		// Merge agents + channels into a single onUpdate call to avoid stale-reference overwrites
		const newChannels = step.channels === undefined ? buildTaskAgentChannels(next) : step.channels;
		onUpdate({ ...step, agents: next, agentId: '', channels: newChannels });
	}

	function removeAgent(role: string) {
		const removed = stepAgents.find((a) => a.role === role);
		const next = stepAgents.filter((a) => a.role !== role);
		if (next.length === 0) {
			// Switch back to single-agent mode: restore agentId from the removed agent and
			// clear channels (orphaned channels on a single-agent step are semantically invalid)
			onUpdate({
				...step,
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
			stepAgents.map((a) =>
				a.role === role ? { ...a, instructions: instructions || undefined } : a
			)
		);
	}

	function updateAgentModel(role: string, model: string) {
		updateAgents(
			stepAgents.map((a) => (a.role === role ? { ...a, model: model || undefined } : a))
		);
	}

	function updateAgentSystemPrompt(role: string, systemPrompt: string) {
		updateAgents(
			stepAgents.map((a) =>
				a.role === role ? { ...a, systemPrompt: systemPrompt || undefined } : a
			)
		);
	}

	// All agents are available; same agent may be added multiple times with different roles.
	const availableAgents = agents;

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
							const firstAgentRole = firstId
								? (agents.find((a) => a.id === firstId)?.role ?? firstId)
								: '';
							const existing: WorkflowNodeAgent[] = firstId
								? [{ agentId: firstId, role: firstAgentRole }]
								: [];
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
					const hasOverrides = !!(sa.model || sa.systemPrompt);
					const isExpanded = expandedSlots.has(sa.role);
					return (
						<div
							key={sa.role}
							class={`rounded p-2 space-y-1 border ${hasOverrides ? 'bg-amber-950/20 border-amber-700/40' : 'bg-dark-800 border-dark-600'}`}
							data-testid="agent-entry"
							data-has-overrides={hasOverrides ? 'true' : undefined}
						>
							{/* Header: role input + override badge + remove button */}
							<div class="flex items-center gap-1">
								<input
									type="text"
									data-testid="agent-role-input"
									value={sa.role}
									onInput={(e) => {
										/* role editing is reflected in display only; updating kept simple */
										const newRole = (e.currentTarget as HTMLInputElement).value;
										updateAgents(
											stepAgents.map((a) => (a.role === sa.role ? { ...a, role: newRole } : a))
										);
									}}
									placeholder="slot role"
									class="flex-1 text-xs font-mono bg-dark-900 border border-dark-700 rounded px-1.5 py-0.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600 min-w-0"
								/>
								{hasOverrides && (
									<span
										data-testid="override-badge"
										class="text-xs text-amber-400 bg-amber-900/40 border border-amber-700/50 rounded px-1 py-0.5 flex-shrink-0"
									>
										overrides
									</span>
								)}
								<button
									type="button"
									data-testid="toggle-overrides-button"
									onClick={() => toggleSlotExpanded(sa.role)}
									class="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0"
									title={isExpanded ? 'Hide overrides' : 'Edit overrides'}
									aria-expanded={isExpanded}
								>
									<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										{isExpanded ? (
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
									data-testid="remove-agent-button"
									onClick={() => removeAgent(sa.role)}
									class="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
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
							{/* Agent name (readonly) */}
							<p class="text-xs text-gray-500">{agentInfo?.name ?? sa.agentId}</p>
							{/* Per-agent instructions */}
							<input
								type="text"
								data-testid="agent-instructions-input"
								value={sa.instructions ?? ''}
								onInput={(e) =>
									updateAgentInstructions(sa.role, (e.currentTarget as HTMLInputElement).value)
								}
								placeholder="Per-agent instructions (optional)…"
								class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
							{/* Expandable overrides section */}
							{isExpanded && (
								<div class="space-y-1 pt-1 border-t border-dark-700" data-testid="slot-overrides">
									<p class="text-xs text-gray-500 font-medium">Slot overrides</p>
									<div class="space-y-0.5">
										<label class="text-xs text-gray-600">Model</label>
										<input
											type="text"
											data-testid="agent-model-input"
											value={sa.model ?? ''}
											onInput={(e) =>
												updateAgentModel(sa.role, (e.currentTarget as HTMLInputElement).value)
											}
											placeholder="e.g. claude-opus-4-6 (leave blank to use default)"
											class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700"
										/>
									</div>
									<div class="space-y-0.5">
										<label class="text-xs text-gray-600">System Prompt</label>
										<textarea
											data-testid="agent-system-prompt-input"
											value={sa.systemPrompt ?? ''}
											onInput={(e) =>
												updateAgentSystemPrompt(
													sa.role,
													(e.currentTarget as HTMLTextAreaElement).value
												)
											}
											placeholder="Override system prompt (leave blank to use agent default)…"
											rows={3}
											class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
										/>
									</div>
								</div>
							)}
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
	step: NodeDraft;
	agents: SpaceAgent[];
	onUpdate: (step: NodeDraft) => void;
}

function ChannelsPanelSection({ step, onUpdate }: ChannelsPanelSectionProps) {
	const channels = step.channels ?? [];
	const stepAgents = step.agents ?? [];

	// Collect known roles from step agents (+ wildcard)
	const knownRoles = ['*', ...stepAgents.map((sa) => sa.role)];

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
				{(!!step.agentId || isMultiAgentNode(step) || step.channels) && (
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
