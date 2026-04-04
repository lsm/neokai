/**
 * NodeConfigPanel
 *
 * A right-anchored slide-in panel that appears when a workflow node is selected
 * in the visual editor. Provides inline editing of all node properties using
 * the same field layout as the WorkflowNodeCard expanded view.
 *
 * Features:
 * - Node Name input
 * - "Set as Start" button (disabled when the node is already the start node)
 * - "Set as End" button (toggle to designate/end node designation)
 * - Agent dropdown
 * - Model dropdown for single-agent and multi-agent nodes
 * - System prompt inline editor (node-level override)
 * - Instructions inline textarea
 * - Delete Node button with confirmation (disabled for start node)
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { Gate, SpaceAgent, WorkflowChannel, WorkflowNodeAgent } from '@neokai/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import { isMultiAgentNode, extractOverrideValue, buildOverride } from '../WorkflowNodeCard';
import { OverrideModeSelector } from '../WorkflowNodeCard';
import { WorkflowModelSelect } from './WorkflowModelSelect';
import { ChannelRelationConfigPanel } from './ChannelRelationConfigPanel';
import { GateEditorPanel } from './GateEditorPanel';

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
	isStartNode: boolean;
	isEndNode: boolean;
	onUpdate: (step: NodeDraft) => void;
	/** Designates this step as the workflow start node */
	onSetAsStart: (stepId: string) => void;
	/** Designates this step as the workflow end node */
	onSetAsEnd: (stepId: string) => void;
	channelLinks?: NodeChannelLink[];
	onOpenChannelLink?: (channelLinkId: string) => void;
	selectedChannelRelation?: {
		title: string;
		description: string;
		forwardLinks: Array<{ index: number; channel: WorkflowChannel }>;
		reverseLinks?: Array<{ index: number; channel: WorkflowChannel }>;
		canConvertToBidirectional?: boolean;
	};
	channelRelationGates?: Gate[];
	onUpdateChannelLink?: (index: number, channel: WorkflowChannel) => void;
	onDeleteChannelLink?: (index: number) => void;
	onUpdateChannelGates?: (gates: Gate[]) => void;
	onConvertChannelRelationToBidirectional?: () => void;
	onCloseChannelLink?: () => void;
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
	onEditSlotPrompts?: (role: string) => void;
	onEditSinglePrompts?: () => void;
}

function AgentsSection({
	step,
	agents,
	onUpdate,
	onEditSlotPrompts,
	onEditSinglePrompts,
}: AgentsSectionProps) {
	const multi = isMultiAgentNode(step);
	const nodeAgents = step.agents ?? [];
	const singleSlot = nodeAgents.length === 1 ? nodeAgents[0] : undefined;
	const selectedSingleAgentId = singleSlot?.agentId ?? step.agentId;
	const selectedSingleModel = singleSlot?.model ?? step.model;
	const selectedSingleSystemPrompt = singleSlot?.systemPrompt ?? step.systemPrompt;

	function updateAgents(next: WorkflowNodeAgent[]) {
		onUpdate({ ...step, agents: next, agentId: '' });
	}

	function addAgent(agentId: string) {
		if (!agentId) return;
		const agentInfo = agents.find((a) => a.id === agentId);
		// Use agent name as the base role name for the slot
		const baseRole = agentInfo?.name?.trim() || agentId;
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
		if (next.length <= 1) {
			// Switch back to single-agent mode when <=1 slots remain.
			// Preserve model/systemPrompt from the surviving slot when present.
			const survivor = next[0] ?? removed;
			const survivorInstructions =
				step.instructions || extractOverrideValue(survivor?.instructions);
			onUpdate({
				...step,
				agents: undefined,
				agentId: survivor?.agentId ?? '',
				model: survivor?.model,
				systemPrompt: survivor?.systemPrompt,
				instructions: survivorInstructions,
				channels: undefined,
			});
		} else {
			updateAgents(next);
		}
	}

	function updateAgentId(role: string, agentId: string) {
		updateAgents(nodeAgents.map((a) => (a.name === role ? { ...a, agentId } : a)));
	}

	function updateAgentModel(role: string, model: string | undefined) {
		updateAgents(
			nodeAgents.map((a) => (a.name === role ? { ...a, model: model || undefined } : a))
		);
	}

	const updateSingleAgentId = useCallback(
		(newAgentId: string) => {
			if (singleSlot) {
				updateAgentId(singleSlot.name, newAgentId);
				return;
			}
			onUpdate({ ...step, agentId: newAgentId });
		},
		[singleSlot, step, onUpdate]
	);

	const updateSingleModel = useCallback(
		(model: string | undefined) => {
			if (singleSlot) {
				updateAgentModel(singleSlot.name, model);
				return;
			}
			onUpdate({ ...step, model });
		},
		[singleSlot, step, onUpdate]
	);

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
							const usedRoles = new Set<string>();
							const buildUniqueRole = (base: string): string => {
								const sanitizedBase = base.trim() || 'agent';
								let role = sanitizedBase;
								for (let i = 2; usedRoles.has(role); i++) {
									role = `${sanitizedBase}-${i}`;
								}
								usedRoles.add(role);
								return role;
							};

							const primaryAgentId = selectedSingleAgentId || '';
							const primaryBaseRole =
								singleSlot?.name ||
								agents.find((a) => a.id === primaryAgentId)?.name ||
								primaryAgentId ||
								'agent';
							const primarySlot: WorkflowNodeAgent = {
								agentId: primaryAgentId,
								name: buildUniqueRole(primaryBaseRole),
								model: selectedSingleModel,
								systemPrompt:
									typeof selectedSingleSystemPrompt !== 'string'
										? selectedSingleSystemPrompt
										: undefined,
							};

							const secondaryAgent = agents.find((a) => a.id !== primaryAgentId) ?? agents[0];
							const secondarySlot: WorkflowNodeAgent = {
								agentId: secondaryAgent?.id ?? '',
								name: buildUniqueRole(secondaryAgent?.name ?? 'agent'),
							};

							onUpdate({
								...step,
								agents: [primarySlot, secondarySlot],
								agentId: '',
								model: undefined,
								systemPrompt: undefined,
								channels: undefined,
							});
						}}
						class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
					>
						+ Add agent
					</button>
				</div>
				<select
					data-testid="agent-select"
					value={selectedSingleAgentId}
					onChange={(e) => updateSingleAgentId((e.currentTarget as HTMLSelectElement).value)}
					class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
				>
					<option value="">— Select agent —</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>
							{a.name}
						</option>
					))}
				</select>
				<div class="space-y-1">
					<label class="text-xs font-medium text-gray-400">
						LLM Model <span class="font-normal text-gray-600">(optional override)</span>
					</label>
					<WorkflowModelSelect
						testId="single-agent-model-input"
						value={selectedSingleModel}
						onChange={updateSingleModel}
					/>
				</div>
				<button
					type="button"
					data-testid="edit-single-prompts-button"
					onClick={() => onEditSinglePrompts?.()}
					class="w-full text-xs border border-dark-700 rounded px-2 py-1.5 text-gray-300 hover:border-dark-500 hover:bg-dark-700/40 transition-colors"
				>
					Edit Prompts
				</button>
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
			</div>

			<div class="space-y-1.5" data-testid="agents-list">
				{nodeAgents.map((sa) => {
					const agentInfo = agents.find((a) => a.id === sa.agentId);
					return (
						<div
							key={sa.name}
							class="rounded p-2 space-y-1 border bg-dark-800 border-dark-600"
							data-testid="agent-entry"
						>
							{/* Header: role input + remove button */}
							<div class="flex items-center gap-1">
								<input
									type="text"
									data-testid="agent-role-input"
									value={sa.name}
									onInput={(e) => {
										const newRole = (e.currentTarget as HTMLInputElement).value;
										updateAgents(
											nodeAgents.map((a) => (a.name === sa.name ? { ...a, name: newRole } : a))
										);
									}}
									placeholder="node role"
									class="flex-1 text-xs font-mono bg-dark-900 border border-dark-700 rounded px-1.5 py-0.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600 min-w-0"
								/>
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
							<div class="space-y-1">
								<label class="text-[11px] font-medium uppercase tracking-[0.16em] text-gray-500">
									Agent
								</label>
								<select
									data-testid="agent-slot-select"
									value={sa.agentId}
									onChange={(e) =>
										updateAgentId(sa.name, (e.currentTarget as HTMLSelectElement).value)
									}
									class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
								>
									<option value="">— Select agent —</option>
									{agents.map((agent) => (
										<option key={agent.id} value={agent.id}>
											{agent.name}
										</option>
									))}
								</select>
								<p class="text-[11px] text-gray-600">{agentInfo?.name ?? sa.agentId}</p>
							</div>
							<div class="space-y-1">
								<label class="text-[11px] font-medium uppercase tracking-[0.16em] text-gray-500">
									Model
								</label>
								<WorkflowModelSelect
									testId="agent-slot-model-input"
									value={sa.model}
									onChange={(model) => updateAgentModel(sa.name, model)}
								/>
							</div>
							<button
								type="button"
								data-testid="edit-slot-prompts-button"
								onClick={() => onEditSlotPrompts?.(sa.name)}
								class="w-full text-xs border border-dark-700 rounded px-2 py-1.5 text-gray-300 hover:border-dark-500 hover:bg-dark-700/40 transition-colors"
							>
								Edit Prompts
							</button>
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
							{a.name}
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

type PanelView =
	| { kind: 'main' }
	| { kind: 'channel-links' }
	| { kind: 'gate-editor'; gateId: string }
	| { kind: 'single-prompts' }
	| { kind: 'slot-prompts'; role: string };

export function NodeConfigPanel({
	step,
	agents,
	isStartNode,
	isEndNode,
	onUpdate,
	onSetAsStart,
	onSetAsEnd,
	channelLinks = [],
	onOpenChannelLink,
	selectedChannelRelation,
	channelRelationGates = [],
	onUpdateChannelLink,
	onDeleteChannelLink,
	onUpdateChannelGates,
	onConvertChannelRelationToBidirectional,
	onCloseChannelLink,
	onClose,
	onDelete,
}: NodeConfigPanelProps) {
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [panelView, setPanelView] = useState<PanelView>({ kind: 'main' });
	const [singlePromptMode, setSinglePromptMode] = useState<'override' | 'expand'>('override');

	// Reset confirmation dialog when the selected step changes so a previously
	// open confirmation on one node doesn't bleed through to the next node.
	useEffect(() => {
		setConfirmingDelete(false);
		setPanelView({ kind: 'main' });
	}, [step.localId]);

	useEffect(() => {
		if (panelView.kind !== 'single-prompts') return;
		const singleSlot = (step.agents ?? []).length === 1 ? step.agents?.[0] : undefined;
		const singleSystemPrompt = singleSlot?.systemPrompt ?? step.systemPrompt;
		const mode =
			(typeof singleSystemPrompt !== 'string' ? singleSystemPrompt?.mode : 'override') ??
			'override';
		setSinglePromptMode(mode);
	}, [panelView.kind, step.localId]);

	useEffect(() => {
		if (selectedChannelRelation) {
			// Only navigate to channel-links from main view — don't override
			// gate-editor view which is a deeper navigation (main → channel-links → gate-editor).
			// Gate updates cause selectedChannelRelation to change reference,
			// which would otherwise snap the panel back to channel-links.
			setPanelView((prev) => (prev.kind === 'gate-editor' ? prev : { kind: 'channel-links' }));
			return;
		}
		setPanelView((prev) =>
			prev.kind === 'channel-links' || prev.kind === 'gate-editor' ? { kind: 'main' } : prev
		);
	}, [selectedChannelRelation]);

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

	const renderHeader = () => {
		if (panelView.kind === 'main') {
			return (
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
						{isEndNode && (
							<span
								data-testid="end-node-badge"
								class="text-xs font-bold text-purple-400 uppercase tracking-wider flex-shrink-0"
							>
								END
							</span>
						)}
						<h3 class="text-sm font-semibold text-gray-100 truncate">
							{step.name || 'Unnamed Node'}
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
			);
		}

		const title =
			panelView.kind === 'channel-links'
				? 'Channel Links'
				: panelView.kind === 'gate-editor'
					? 'Gate Editor'
					: panelView.kind === 'single-prompts'
						? 'Prompts'
						: panelView.kind === 'slot-prompts'
							? 'Slot Prompts'
							: step.name || 'Unnamed Node';

		return (
			<div class="flex items-center justify-between px-4 py-3 border-b border-dark-700 flex-shrink-0">
				<div class="flex items-center gap-2 min-w-0">
					<button
						type="button"
						data-testid="node-panel-back-button"
						onClick={() => {
							if (panelView.kind === 'gate-editor') {
								setPanelView({ kind: 'channel-links' });
								return;
							}
							if (panelView.kind === 'slot-prompts') {
								setPanelView({ kind: 'main' });
								return;
							}
							if (panelView.kind === 'single-prompts') {
								setPanelView({ kind: 'main' });
								return;
							}
							if (panelView.kind === 'channel-links') {
								onCloseChannelLink?.();
							}
							setPanelView({ kind: 'main' });
						}}
						class="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-dark-700 transition-colors flex-shrink-0"
						title="Back"
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M15 19l-7-7 7-7"
							/>
						</svg>
					</button>
					<h3 class="text-sm font-semibold text-gray-100 truncate">{title}</h3>
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
		);
	};

	const renderPanelBody = () => {
		if (panelView.kind === 'gate-editor') {
			const editingGate = channelRelationGates.find((g) => g.id === panelView.gateId);
			if (!editingGate) return null;
			return (
				<GateEditorPanel
					gate={editingGate}
					onChange={(updated) => {
						onUpdateChannelGates?.(
							channelRelationGates.map((g) => (g.id === updated.id ? updated : g))
						);
					}}
					onBack={() => setPanelView({ kind: 'channel-links' })}
					embedded
				/>
			);
		}

		if (panelView.kind === 'single-prompts') {
			const nodeAgents = step.agents ?? [];
			const singleSlot = nodeAgents.length === 1 ? nodeAgents[0] : undefined;
			const singleAgentId = singleSlot?.agentId ?? step.agentId;
			const singleAgent = agents.find((agent) => agent.id === singleAgentId);
			const singleSystemPrompt = singleSlot?.systemPrompt ?? step.systemPrompt;
			const singleInstructions =
				step.instructions || extractOverrideValue(singleSlot?.instructions);

			const updateSingleInstructions = (value: string) => {
				if (singleSlot) {
					onUpdate({
						...step,
						instructions: value,
						agents: nodeAgents.map((agent) =>
							agent.name === singleSlot.name ? { ...agent, instructions: undefined } : agent
						),
						agentId: '',
					});
					return;
				}
				onUpdate({
					...step,
					instructions: value,
				});
			};

			const updateSingleSystemPrompt = (value: string, mode: 'override' | 'expand') => {
				if (singleSlot) {
					onUpdate({
						...step,
						agents: nodeAgents.map((agent) =>
							agent.name === singleSlot.name
								? { ...agent, systemPrompt: buildOverride(value, mode) }
								: agent
						),
						agentId: '',
					});
					return;
				}
				onUpdate({
					...step,
					systemPrompt: buildOverride(value, mode),
				});
			};

			return (
				<div class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
					<div class="rounded border border-dark-700 bg-dark-850 px-3 py-2 text-xs text-gray-400 space-y-1">
						<p>
							<span class="text-gray-500">Agent:</span>{' '}
							{(singleAgent?.name ?? singleAgentId) || '—'}
						</p>
					</div>
					<div class="space-y-1">
						<label class="text-xs font-medium text-gray-400">Instructions</label>
						<textarea
							data-testid="single-prompts-instructions"
							value={singleInstructions}
							onInput={(e) =>
								updateSingleInstructions((e.currentTarget as HTMLTextAreaElement).value)
							}
							rows={4}
							placeholder="Node instructions passed to the single agent…"
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
					<div class="space-y-1">
						<div class="flex items-center justify-between">
							<label class="text-xs font-medium text-gray-400">System Prompt</label>
							<OverrideModeSelector
								mode={singlePromptMode}
								onChange={(mode) => {
									setSinglePromptMode(mode);
									updateSingleSystemPrompt(extractOverrideValue(singleSystemPrompt), mode);
								}}
							/>
						</div>
						<textarea
							data-testid="single-prompts-system-prompt"
							value={extractOverrideValue(singleSystemPrompt)}
							onInput={(e) =>
								updateSingleSystemPrompt(
									(e.currentTarget as HTMLTextAreaElement).value,
									singlePromptMode
								)
							}
							rows={6}
							placeholder="Override system prompt (leave blank to use agent default)…"
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
				</div>
			);
		}

		if (panelView.kind === 'slot-prompts') {
			const slot = (step.agents ?? []).find((agent) => agent.name === panelView.role);
			if (!slot) return null;
			const slotAgent = agents.find((agent) => agent.id === slot.agentId);
			const instructionsMode =
				(typeof slot.instructions !== 'string' ? slot.instructions?.mode : 'override') ??
				'override';
			const systemPromptMode =
				(typeof slot.systemPrompt !== 'string' ? slot.systemPrompt?.mode : 'override') ??
				'override';

			const updateSlot = (nextSlot: WorkflowNodeAgent) => {
				onUpdate({
					...step,
					agents: (step.agents ?? []).map((agent) =>
						agent.name === panelView.role ? nextSlot : agent
					),
					agentId: '',
				});
			};

			return (
				<div class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
					<div class="rounded border border-dark-700 bg-dark-850 px-3 py-2 text-xs text-gray-400 space-y-1">
						<p>
							<span class="text-gray-500">Role:</span> {slot.name}
						</p>
						<p>
							<span class="text-gray-500">Agent:</span> {slotAgent?.name ?? slot.agentId}
						</p>
					</div>
					<div class="space-y-1">
						<label class="text-xs font-medium text-gray-400">
							LLM Model <span class="font-normal text-gray-600">(optional override)</span>
						</label>
						<WorkflowModelSelect
							testId="slot-prompts-model-input"
							value={slot.model}
							onChange={(model) => updateSlot({ ...slot, model: model || undefined })}
						/>
					</div>
					<div class="space-y-1">
						<div class="flex items-center justify-between">
							<label class="text-xs font-medium text-gray-400">Instructions</label>
							<OverrideModeSelector
								mode={instructionsMode}
								onChange={(mode) =>
									updateSlot({
										...slot,
										instructions: buildOverride(extractOverrideValue(slot.instructions), mode),
									})
								}
							/>
						</div>
						<textarea
							data-testid="slot-prompts-instructions"
							value={extractOverrideValue(slot.instructions)}
							onInput={(e) =>
								updateSlot({
									...slot,
									instructions: buildOverride(
										(e.currentTarget as HTMLTextAreaElement).value,
										instructionsMode
									),
								})
							}
							rows={4}
							placeholder="Per-slot instructions (optional)…"
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
					<div class="space-y-1">
						<div class="flex items-center justify-between">
							<label class="text-xs font-medium text-gray-400">System Prompt</label>
							<OverrideModeSelector
								mode={systemPromptMode}
								onChange={(mode) =>
									updateSlot({
										...slot,
										systemPrompt: buildOverride(extractOverrideValue(slot.systemPrompt), mode),
									})
								}
							/>
						</div>
						<textarea
							data-testid="slot-prompts-system-prompt"
							value={extractOverrideValue(slot.systemPrompt)}
							onInput={(e) =>
								updateSlot({
									...slot,
									systemPrompt: buildOverride(
										(e.currentTarget as HTMLTextAreaElement).value,
										systemPromptMode
									),
								})
							}
							rows={6}
							placeholder="Override system prompt (leave blank to use agent default)…"
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
				</div>
			);
		}

		if (panelView.kind === 'channel-links' && selectedChannelRelation) {
			return (
				<ChannelRelationConfigPanel
					title={selectedChannelRelation.title}
					description={selectedChannelRelation.description}
					forwardLinks={selectedChannelRelation.forwardLinks}
					reverseLinks={selectedChannelRelation.reverseLinks}
					canConvertToBidirectional={selectedChannelRelation.canConvertToBidirectional}
					onConvertToBidirectional={onConvertChannelRelationToBidirectional}
					gates={channelRelationGates}
					onGatesChange={(nextGates) => onUpdateChannelGates?.(nextGates)}
					onEditGate={(gateId) => setPanelView({ kind: 'gate-editor', gateId })}
					onChange={(index, channel) => onUpdateChannelLink?.(index, channel)}
					onDelete={(index) => onDeleteChannelLink?.(index)}
					onClose={onClose}
					embedded
				/>
			);
		}

		return (
			<div class="flex-1 overflow-y-auto px-4 py-4 space-y-5">
				<div class="space-y-1.5">
					<label class="text-xs font-medium text-gray-400">Node Name</label>
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

				{!isStartNode && (
					<button
						data-testid="set-as-start-button"
						onClick={() => onSetAsStart(step.localId)}
						class="w-full text-xs font-medium py-1.5 px-3 rounded border border-green-700 text-green-400 hover:bg-green-900/30 transition-colors"
					>
						Set as Start Node
					</button>
				)}
				{!isEndNode && (
					<button
						data-testid="set-as-end-button"
						onClick={() => onSetAsEnd(step.localId)}
						class="w-full text-xs font-medium py-1.5 px-3 rounded border border-purple-700 text-purple-400 hover:bg-purple-900/30 transition-colors"
					>
						Set as End Node
					</button>
				)}
				{isEndNode && (
					<button
						data-testid="unset-as-end-button"
						onClick={() => onSetAsEnd(step.localId)}
						class="w-full text-xs font-medium py-1.5 px-3 rounded border border-purple-700/50 text-purple-500/60 hover:bg-purple-900/20 transition-colors"
					>
						Unset End Node
					</button>
				)}

				<AgentsSection
					step={step}
					agents={agents}
					onUpdate={onUpdate}
					onEditSinglePrompts={() => setPanelView({ kind: 'single-prompts' })}
					onEditSlotPrompts={(role) => setPanelView({ kind: 'slot-prompts', role })}
				/>

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
									onClick={() => {
										setPanelView({ kind: 'channel-links' });
										onOpenChannelLink?.(link.id);
									}}
									class="w-full rounded border border-dark-700 bg-dark-800 px-2.5 py-2 text-left hover:border-teal-600/60 hover:bg-dark-750 transition-colors"
								>
									<div class="flex items-center justify-between gap-2">
										<div class="min-w-0">
											<div class="text-xs font-mono text-gray-200 truncate">{link.label}</div>
											<div class="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
												<span>
													{link.channelCount} link{link.channelCount === 1 ? '' : 's'}
												</span>
												{link.hasGate && <span class="text-teal-400">has gate</span>}
											</div>
										</div>
										<svg
											class="w-4 h-4 text-gray-500 flex-shrink-0"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M9 5l7 7-7 7"
											/>
										</svg>
									</div>
								</button>
							))}
						</div>
					) : (
						<p class="text-xs text-gray-600">Create links by dragging from one node to another.</p>
					)}
				</div>
			</div>
		);
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
			{renderHeader()}
			{renderPanelBody()}

			{/* Footer — Delete button */}
			<div class="px-4 py-3 border-t border-dark-700 flex-shrink-0">
				{confirmingDelete ? (
					<div class="space-y-2">
						<p class="text-xs text-gray-400">Delete this node? This cannot be undone.</p>
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
						title={isStartNode ? 'Designate another node as start before deleting' : 'Delete node'}
						class="w-full text-xs py-1.5 px-3 rounded border border-red-900 text-red-500 hover:bg-red-900/30 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
					>
						Delete Node
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
