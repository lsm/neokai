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
import type { SpaceAgent, WorkflowNodeAgent } from '@neokai/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import { isMultiAgentNode } from '../WorkflowNodeCard';
import { GateConfig } from './GateConfig';
import type { ConditionDraft } from './GateConfig';

// ============================================================================
// Props
// ============================================================================

export interface NodeChannelLink {
	id: string;
	label: string;
	direction: 'one-way' | 'bidirectional';
	channelCount: number;
	hasGate: boolean;
}

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
	channelLinks?: NodeChannelLink[];
	onOpenChannelLink?: (channelLinkId: string) => void;
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
	const nodeAgents = step.agents ?? [];

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

	function addAgent(agentId: string) {
		if (!agentId) return;
		const agentInfo = agents.find((a) => a.id === agentId);
		// Guard against agents with empty role strings to avoid indistinguishable slot names
		const baseRole = agentInfo?.role?.trim() || agentId;
		// Ensure the slot role is unique within this node. When the same agent is added
		// multiple times, append a numeric suffix to distinguish the slots.
		const usedRoles = new Set(nodeAgents.map((a) => a.name));
		let role = baseRole;
		for (let i = 2; usedRoles.has(role); i++) {
			role = `${baseRole}-${i}`;
		}
		const next = [...nodeAgents, { agentId, name: role }];
		onUpdate({ ...step, agents: next, agentId: '' });
	}

	function removeAgent(role: string) {
		const removed = nodeAgents.find((a) => a.name === role);
		const next = nodeAgents.filter((a) => a.name !== role);
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
			nodeAgents.map((a) =>
				a.name === role ? { ...a, instructions: instructions || undefined } : a
			)
		);
	}

	function updateAgentModel(role: string, model: string) {
		updateAgents(
			nodeAgents.map((a) => (a.name === role ? { ...a, model: model || undefined } : a))
		);
	}

	function updateAgentSystemPrompt(role: string, systemPrompt: string) {
		updateAgents(
			nodeAgents.map((a) =>
				a.name === role ? { ...a, systemPrompt: systemPrompt || undefined } : a
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
								? [{ agentId: firstId, name: firstAgentRole }]
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
						onUpdate({ ...step, agentId: newAgentId });
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
					Agents <span class="text-gray-600">({nodeAgents.length})</span>
				</label>
				{nodeAgents.length === 1 && (
					<button
						type="button"
						data-testid="switch-to-single-button"
						onClick={() =>
							onUpdate({
								...step,
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

			<div class="space-y-1.5" data-testid="agents-list">
				{nodeAgents.map((sa) => {
					const agentInfo = agents.find((a) => a.id === sa.agentId);
					const hasOverrides = !!(sa.model || sa.systemPrompt);
					const isExpanded = expandedSlots.has(sa.name);
					return (
						<div
							key={sa.name}
							class={`rounded p-2 space-y-1 border ${hasOverrides ? 'bg-amber-950/20 border-amber-700/40' : 'bg-dark-800 border-dark-600'}`}
							data-testid="agent-entry"
							data-has-overrides={hasOverrides ? 'true' : undefined}
						>
							{/* Header: role input + override badge + remove button */}
							<div class="flex items-center gap-1">
								<input
									type="text"
									data-testid="agent-role-input"
									value={sa.name}
									onInput={(e) => {
										const oldRole = sa.name;
										const newRole = (e.currentTarget as HTMLInputElement).value;
										// Keep the override section expanded after a rename by migrating the key
										setExpandedSlots((prev) => {
											if (!prev.has(oldRole)) return prev;
											const next = new Set(prev);
											next.delete(oldRole);
											next.add(newRole);
											return next;
										});
										updateAgents(
											nodeAgents.map((a) => (a.name === oldRole ? { ...a, name: newRole } : a))
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
									onClick={() => toggleSlotExpanded(sa.name)}
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
									onClick={() => removeAgent(sa.name)}
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
									updateAgentInstructions(sa.name, (e.currentTarget as HTMLInputElement).value)
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
												updateAgentModel(sa.name, (e.currentTarget as HTMLInputElement).value)
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
													sa.name,
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
	channelLinks = [],
	onOpenChannelLink,
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

				{/* Channel Links */}
				<div class="space-y-1.5">
					<div class="flex items-center justify-between">
						<label class="text-xs font-medium text-gray-400">Channel Links</label>
						<span class="text-xs text-gray-600">{channelLinks.length}</span>
					</div>
					{channelLinks.length > 0 ? (
						<div class="space-y-1.5">
							{channelLinks.map((link) => (
								<button
									key={link.id}
									type="button"
									data-testid="node-channel-link-button"
									onClick={() => onOpenChannelLink?.(link.id)}
									class="w-full rounded border border-dark-700 bg-dark-800 px-2.5 py-2 text-left hover:border-teal-600/60 hover:bg-dark-750 transition-colors"
								>
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-mono text-gray-200 truncate">{link.label}</span>
										<span class="text-[10px] text-teal-400 flex-shrink-0">
											{link.direction === 'bidirectional' ? '↔' : '→'}
										</span>
									</div>
									<div class="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
										<span>{link.channelCount} link{link.channelCount === 1 ? '' : 's'}</span>
										{link.hasGate && <span class="text-teal-400">has gate</span>}
									</div>
								</button>
							))}
						</div>
					) : (
						<p class="text-xs text-gray-600">Create links by dragging from one node to another.</p>
					)}
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
