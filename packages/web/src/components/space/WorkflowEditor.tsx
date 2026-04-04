/**
 * WorkflowEditor Component
 *
 * Create or edit a workflow definition.
 *
 * Features:
 * - Name and description fields
 * - Vertical step list with expandable WorkflowNodeCards
 * - Add Step button
 * - "Start from template" options
 * - Save / Cancel
 */

import { useMemo, useState } from 'preact/hooks';
import type {
	SpaceWorkflow,
	SpaceAgent,
	WorkflowChannel,
	WorkflowNodeAgent,
	Gate,
} from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { WorkflowNodeCard } from './WorkflowNodeCard';
import type { NodeDraft, ConditionDraft, AgentTaskState } from './WorkflowNodeCard';
import { WorkflowRulesEditor } from './WorkflowRulesEditor';
import type { RuleDraft } from './WorkflowRulesEditor';
import { ChannelEditor } from './ChannelEditor';

// ============================================================================
// Tags constants
// ============================================================================

const TAG_SUGGESTIONS = ['coding', 'review', 'research', 'design', 'deployment'];

// ============================================================================
// Template Definitions
// ============================================================================

export interface WorkflowTemplate {
	label: string;
	description: string;
	/** Template start node name. */
	startStepName?: string;
	/** Template end node name. */
	endStepName?: string;
	/** Legacy shorthand for single-agent linear templates. */
	stepRoles?: string[]; // agent role names to look up from agent list
	/** Rich step definitions for multi-agent templates. */
	steps?: WorkflowTemplateStep[];
	/** Optional workflow-level channels to seed with the template. */
	channels?: WorkflowChannel[];
	/** Optional first-class workflow gates to seed with the template. */
	gates?: Gate[];
	/** Optional tags to seed with the template. */
	tags?: string[];
}

export interface WorkflowTemplateStep {
	/** Display name for the node. */
	name: string;
	/** Single-agent role/name lookup key. Ignored when agentSlots is provided. */
	role?: string;
	/** Explicit agent ID to use (skips role lookup when set). */
	agentId?: string;
	/** Multi-agent slot definitions for parallel node execution. */
	agentSlots?: WorkflowTemplateAgentSlot[];
	/** Optional default node system prompt. */
	systemPrompt?: string;
	/** Optional default node instructions. */
	instructions?: string;
}

export interface WorkflowTemplateAgentSlot {
	/** Unique slot name inside the node (e.g. "Reviewer 1"). */
	name: string;
	/** Agent role/name lookup key used to assign the slot. */
	role: string;
	/** Explicit agent ID to use for this slot (skips role lookup when set). */
	agentId?: string;
	/** Optional default slot system prompt. */
	systemPrompt?: string;
	/** Optional default slot instructions. */
	instructions?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function makeLocalId(): string {
	return generateUUID();
}

function makeEmptyStep(): NodeDraft {
	return { localId: makeLocalId(), name: '', agentId: '', instructions: '' };
}

function makeDefaultCondition(): ConditionDraft {
	return { type: 'always' };
}

/**
 * Filter agents for step assignment: exclude any agent whose name or role is
 * 'leader' (case-insensitive). The 'leader' role is reserved for the
 * orchestration layer and must not be assigned to workflow steps.
 */
export function filterAgents(agents: SpaceAgent[]): SpaceAgent[] {
	return agents.filter((a) => a.name.toLowerCase() !== 'leader');
}

function capitalizeRole(role: string): string {
	return role.charAt(0).toUpperCase() + role.slice(1);
}

function normalizeAgentLookup(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ');
}

const TEMPLATE_ROLE_ALIASES: Record<string, string[]> = {
	planner: ['planner', 'plan'],
	coder: ['coder', 'code', 'developer', 'engineer'],
	reviewer: ['reviewer', 'review'],
	research: ['research', 'researcher'],
	qa: ['qa', 'quality', 'tester', 'test'],
	general: ['general', 'done', 'summary'],
};

const TEMPLATE_FALLBACK_USAGE_KEY = '__template-fallback__';

function resolveTemplateAgent(
	roleOrName: string,
	agents: SpaceAgent[],
	usageByRole: Map<string, number>
): SpaceAgent | undefined {
	const key = normalizeAgentLookup(roleOrName);
	if (!key) return undefined;

	const aliases = TEMPLATE_ROLE_ALIASES[key] ?? [key];
	const aliasSet = new Set(aliases);
	const matches = agents.filter((a) => {
		const normalizedName = normalizeAgentLookup(a.name);
		if (!normalizedName) return false;
		if (normalizedName === key) return true;
		if (normalizedName.includes(key)) return true;
		const tokens = normalizedName.split(' ');
		return tokens.some((token) => aliasSet.has(token));
	});

	if (matches.length === 0) return undefined;

	// Prefer distinct matches for repeated slots of the same role, then fall back
	// to the last available match if there are more slots than agents.
	const used = usageByRole.get(key) ?? 0;
	usageByRole.set(key, used + 1);
	return matches[Math.min(used, matches.length - 1)];
}

function getTemplateStepDefs(template: WorkflowTemplate): WorkflowTemplateStep[] {
	if (Array.isArray(template.steps) && template.steps.length > 0) {
		return template.steps;
	}

	const stepRoles = template.stepRoles ?? [];
	return stepRoles.map((role) => ({ name: capitalizeRole(role), role }));
}

function extractInstructionText(
	value:
		| string
		| null
		| undefined
		| {
				mode: string;
				value?: string | null;
		  }
): string | undefined {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}
	if (!value || typeof value !== 'object') return undefined;
	if (typeof value.value !== 'string') return undefined;
	const trimmed = value.value.trim();
	return trimmed ? trimmed : undefined;
}

/** Convert a persisted workflow into a template picker entry. */
export function workflowToTemplate(workflow: SpaceWorkflow): WorkflowTemplate {
	const startNodeName = workflow.nodes.find((node) => node.id === workflow.startNodeId)?.name;
	const endNodeName = workflow.nodes.find((node) => node.id === workflow.endNodeId)?.name;

	const steps: WorkflowTemplateStep[] = workflow.nodes.map((node) => {
		if ((node.agents?.length ?? 0) > 1) {
			return {
				name: node.name,
				agentSlots: (node.agents ?? []).map((agent) => ({
					name: agent.name || agent.agentId,
					role: agent.name || agent.agentId,
					agentId: agent.agentId,
					systemPrompt: extractInstructionText(agent.systemPrompt),
					instructions: extractInstructionText(agent.instructions),
				})),
				instructions: node.instructions,
			};
		}

		const primary = node.agents?.[0];
		return {
			name: node.name,
			role: primary?.name ?? primary?.agentId ?? '',
			agentId: primary?.agentId,
			systemPrompt: extractInstructionText(primary?.systemPrompt),
			instructions: node.instructions,
		};
	});

	return {
		label: workflow.name,
		description: workflow.description ?? '',
		startStepName: startNodeName,
		endStepName: endNodeName,
		steps,
		channels: (workflow.channels ?? []).map((channel) => ({
			...channel,
			to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
		})),
		gates: (workflow.gates ?? []).map((gate) => ({
			...gate,
			fields: [...(gate.fields ?? [])],
		})),
		tags: [...(workflow.tags ?? [])],
	};
}

/**
 * Convert daemon-provided built-in template workflows into editor template entries.
 */
export function getAvailableTemplates(workflows: SpaceWorkflow[]): WorkflowTemplate[] {
	return workflows
		.map((workflow) => workflowToTemplate(workflow))
		.filter((template) => Boolean(template.startStepName?.trim() && template.endStepName?.trim()));
}

/**
 * Build workflow node drafts from a template definition.
 * Supports both legacy single-agent stepRoles and multi-agent steps.
 */
export function buildTemplateNodes(template: WorkflowTemplate, agents: SpaceAgent[]): NodeDraft[] {
	const usageByRole = new Map<string, number>();
	const stepDefs = getTemplateStepDefs(template);

	return stepDefs.map((step, index) => {
		const name = step.name?.trim() || `Step ${index + 1}`;

		if (Array.isArray(step.agentSlots) && step.agentSlots.length > 0) {
			const agentSlots: WorkflowNodeAgent[] = step.agentSlots.map((slot, slotIndex) => {
				const assigned =
					(slot.agentId ? agents.find((agent) => agent.id === slot.agentId) : undefined) ??
					resolveTemplateAgent(slot.role, agents, usageByRole) ??
					(() => {
						const fallbackUsed = usageByRole.get(TEMPLATE_FALLBACK_USAGE_KEY) ?? 0;
						usageByRole.set(TEMPLATE_FALLBACK_USAGE_KEY, fallbackUsed + 1);
						if (agents.length === 0) return undefined;
						return agents[Math.min(fallbackUsed, agents.length - 1)];
					})();
				return {
					agentId: assigned?.id ?? '',
					name: slot.name?.trim() || `${capitalizeRole(slot.role)} ${slotIndex + 1}`,
					systemPrompt: slot.systemPrompt?.trim()
						? { mode: 'override' as const, value: slot.systemPrompt.trim() }
						: undefined,
					instructions: slot.instructions?.trim()
						? { mode: 'override' as const, value: slot.instructions.trim() }
						: undefined,
				};
			});

			return {
				localId: makeLocalId(),
				name,
				agentId: '',
				agents: agentSlots,
				systemPrompt: step.systemPrompt?.trim()
					? { mode: 'override' as const, value: step.systemPrompt.trim() }
					: undefined,
				instructions: step.instructions?.trim() ?? '',
			};
		}

		const role = step.role?.trim() ?? '';
		const assigned =
			(step.agentId ? agents.find((agent) => agent.id === step.agentId) : undefined) ??
			(role ? resolveTemplateAgent(role, agents, usageByRole) : undefined) ??
			(() => {
				const fallbackUsed = usageByRole.get(TEMPLATE_FALLBACK_USAGE_KEY) ?? 0;
				usageByRole.set(TEMPLATE_FALLBACK_USAGE_KEY, fallbackUsed + 1);
				if (agents.length === 0) return undefined;
				return agents[Math.min(fallbackUsed, agents.length - 1)];
			})();
		return {
			localId: makeLocalId(),
			name,
			agentId: assigned?.id ?? '',
			systemPrompt: step.systemPrompt?.trim()
				? { mode: 'override' as const, value: step.systemPrompt.trim() }
				: undefined,
			instructions: step.instructions?.trim() ?? '',
		};
	});
}

/**
 * Derive ordered steps and positional transition conditions from an existing
 * workflow. Graph traversal follows startNodeId through outgoing transitions.
 * Orphaned steps (not reachable from startNodeId) are appended at the end.
 *
 * Defined outside the component so it is not recreated on each render and
 * is clearly a pure initialization helper, not a reactive dependency.
 *
 * NOTE (Milestone 5): `NodeDraft` only carries `agentId` (single-agent format).
 * Multi-agent steps (`agents[]`) and `channels[]` are silently dropped when a workflow
 * is loaded into the editor. Saving such a workflow through the UI would overwrite those
 * fields with the single-agent representation. There is no UI to create multi-agent steps
 * yet, so the practical risk is limited to API-created workflows opened in this editor.
 */
export function initFromWorkflow(wf: SpaceWorkflow): {
	steps: NodeDraft[];
	transitions: ConditionDraft[];
	rules: RuleDraft[];
	tags: string[];
	channels: WorkflowChannel[];
	gates: Gate[];
	endNodeId: string | undefined;
} {
	// Use node order from wf.nodes, placing startNodeId first if possible.
	const stepMap = new Map(wf.nodes.map((s) => [s.id, s]));
	const ordered: NodeDraft[] = [];
	const visited = new Set<string>();

	// Place startNode first
	const startNode = stepMap.get(wf.startNodeId);
	if (startNode) {
		visited.add(startNode.id);
		ordered.push({
			localId: makeLocalId(),
			id: startNode.id,
			name: startNode.name,
			agentId: startNode.agents?.[0]?.agentId ?? '',
			systemPrompt:
				startNode.agents?.[0]?.systemPrompt && typeof startNode.agents[0].systemPrompt !== 'string'
					? startNode.agents[0].systemPrompt
					: typeof startNode.agents?.[0]?.systemPrompt === 'string'
						? { mode: 'override' as const, value: startNode.agents[0].systemPrompt }
						: undefined,
			instructions: startNode.instructions ?? '',
			agents: startNode.agents && startNode.agents.length > 1 ? startNode.agents : undefined,
		});
	}

	// Append remaining nodes in original order
	for (const s of wf.nodes) {
		if (!visited.has(s.id)) {
			ordered.push({
				localId: makeLocalId(),
				id: s.id,
				name: s.name,
				agentId: s.agents?.[0]?.agentId ?? '',
				systemPrompt:
					s.agents?.[0]?.systemPrompt && typeof s.agents[0].systemPrompt !== 'string'
						? s.agents[0].systemPrompt
						: typeof s.agents?.[0]?.systemPrompt === 'string'
							? { mode: 'override' as const, value: s.agents[0].systemPrompt }
							: undefined,
				instructions: s.instructions ?? '',
				agents: s.agents && s.agents.length > 1 ? s.agents : undefined,
			});
		}
	}

	// Default all inter-step conditions to 'always' (transitions removed)
	const conditions: ConditionDraft[] = ordered.slice(0, -1).map(() => ({ type: 'always' }));

	return {
		steps: ordered,
		transitions: conditions,
		rules: [],
		tags: wf.tags ?? [],
		channels: wf.channels ?? [],
		gates: wf.gates ?? [],
		endNodeId: wf.endNodeId,
	};
}

// ============================================================================
// Component
// ============================================================================

interface WorkflowEditorProps {
	/** Existing workflow to edit. Undefined = create new. */
	workflow?: SpaceWorkflow;
	onSave: () => void;
	onCancel: () => void;
}

export function WorkflowEditor({ workflow, onSave, onCancel }: WorkflowEditorProps) {
	const isEditing = !!workflow;

	const initial = workflow ? initFromWorkflow(workflow) : null;

	const [endNodeId, setEndNodeId] = useState<string | undefined>(workflow?.endNodeId);

	const [name, setName] = useState(workflow?.name ?? '');
	const [description, setDescription] = useState(workflow?.description ?? '');
	const [steps, setSteps] = useState<NodeDraft[]>(initial?.steps ?? [makeEmptyStep()]);
	const [transitions, setTransitions] = useState<ConditionDraft[]>(initial?.transitions ?? []);
	const [channels, setChannels] = useState<WorkflowChannel[]>(initial?.channels ?? []);
	const [gates, setGates] = useState<Gate[]>(initial?.gates ?? []);
	const [rules, setRules] = useState<RuleDraft[]>(initial?.rules ?? []);
	const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
	const [tagInput, setTagInput] = useState('');
	const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showTemplates, setShowTemplates] = useState(false);

	const agents = filterAgents(spaceStore.agents.value);
	const availableTemplates = useMemo(
		() => getAvailableTemplates(spaceStore.workflowTemplates.value),
		[spaceStore.workflowTemplates.value]
	);
	const nodeExecutionsByNodeId = spaceStore.nodeExecutionsByNodeId.value;

	// Determine which workflow run to use for completion indicators.
	// Prefer an active run; fall back to the most recently updated run.
	// When no run exists yet (e.g. new workflow), relevantRunId is null.
	const relevantRunId = (() => {
		if (!workflow?.id) return null;
		const runs = spaceStore.workflowRuns.value.filter((r) => r.workflowId === workflow.id);
		if (!runs.length) return null;
		const active = runs.find((r) => r.status === 'pending' || r.status === 'in_progress');
		if (active) return active.id;
		return [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
	})();

	// ---- Step operations ----

	function addStep() {
		setSteps((prev) => [...prev, makeEmptyStep()]);
		setTransitions((prev) => [...prev, makeDefaultCondition()]);
		setExpandedIndex(steps.length); // expand the new step
	}

	function removeStep(index: number) {
		setSteps((prev) => prev.filter((_, i) => i !== index));
		setTransitions((prev) => {
			// When removing step[i]:
			// - For first step (index=0): remove transition[0] — drop the gate after it
			// - For any other step: remove transition[i-1] — drop the gate before it
			if (prev.length === 0) return prev;
			if (index === 0) return prev.slice(1);
			return prev.filter((_, ti) => ti !== index - 1);
		});
		setExpandedIndex((prev) => {
			if (prev === null) return null;
			if (prev === index) return null;
			if (prev > index) return prev - 1;
			return prev;
		});
	}

	function moveStep(index: number, direction: 'up' | 'down') {
		const other = direction === 'up' ? index - 1 : index + 1;
		if (other < 0 || other >= steps.length) return;

		setSteps((prev) => {
			const next = [...prev];
			[next[index], next[other]] = [next[other], next[index]];
			return next;
		});

		// Gate conditions are positional — transitions[i] represents the gate
		// between position i and position i+1. Reordering adjacent steps does
		// not change which positions exist, so transitions stay in place.
		// This is consistent regardless of which positions are swapped.

		setExpandedIndex(other);
	}

	function updateStep(index: number, step: NodeDraft) {
		setSteps((prev) => prev.map((s, i) => (i === index ? step : s)));
	}

	// ---- Tags ----

	function addTag(value: string) {
		const trimmed = value.trim().toLowerCase();
		if (trimmed && !tags.includes(trimmed)) {
			setTags((prev) => [...prev, trimmed]);
		}
	}

	function removeTag(tag: string) {
		setTags((prev) => prev.filter((t) => t !== tag));
	}

	function handleTagInputKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addTag(tagInput);
			setTagInput('');
		} else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
			removeTag(tags[tags.length - 1]);
		}
	}

	// ---- Template ----

	function applyTemplate(template: WorkflowTemplate) {
		const newSteps: NodeDraft[] = buildTemplateNodes(template, agents);
		if (newSteps.length === 0) return;

		const templateStartName = template.startStepName?.trim();
		const templateEndName = template.endStepName?.trim();
		if (!templateStartName || !templateEndName) {
			setError(`Template "${template.label}" is missing required start/end node metadata.`);
			return;
		}

		const resolvedStartLocalId =
			newSteps.find((step) => step.name === templateStartName)?.localId ?? '';
		const resolvedEndLocalId =
			newSteps.find((step) => step.name === templateEndName)?.localId ?? '';

		if (!resolvedStartLocalId || !resolvedEndLocalId) {
			setError(`Template "${template.label}" is missing required start/end node metadata.`);
			return;
		}

		setSteps(newSteps);
		setEndNodeId(resolvedEndLocalId);
		setTransitions(newSteps.slice(1).map(() => makeDefaultCondition()));
		setChannels(
			(template.channels ?? []).map((channel) => ({
				...channel,
				to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
			}))
		);
		setGates(
			(template.gates ?? []).map((gate) => ({
				...gate,
				fields: [...(gate.fields ?? [])],
			}))
		);
		if (template.tags) {
			setTags([...template.tags]);
		}
		setExpandedIndex(0);
		setShowTemplates(false);
		if (!name) setName(template.label);
	}

	// ---- Save ----

	async function handleSave() {
		if (!name.trim()) {
			setError('Workflow name is required.');
			return;
		}
		if (steps.length === 0) {
			setError('A workflow must have at least one step.');
			return;
		}

		// Validate each step has an agent assigned
		for (let i = 0; i < steps.length; i++) {
			if (!steps[i].agentId) {
				setError(`Step ${i + 1} requires an agent.`);
				setExpandedIndex(i);
				return;
			}
		}

		// Validate condition-type transitions have a non-empty shell expression
		for (let i = 0; i < transitions.length; i++) {
			if (transitions[i].type === 'condition' && !transitions[i].expression?.trim()) {
				setError(
					`Transition after step ${i + 1} requires a shell expression when using Shell Condition type.`
				);
				setExpandedIndex(i); // expand the step whose exit gate is the problem
				return;
			}
		}

		setSaving(true);
		setError(null);

		try {
			// Generate IDs for new steps
			const stepIds = steps.map((s) => s.id ?? generateUUID());
			const localIdToPersistedId = new Map(
				steps.map((step, index) => [step.localId, stepIds[index]])
			);
			const resolvedEndNodeId = endNodeId
				? (localIdToPersistedId.get(endNodeId) ?? endNodeId)
				: stepIds[stepIds.length - 1];

			const builtNodes = steps.map((s, i) => {
				const nodeAgents: WorkflowNodeAgent[] =
					s.agents && s.agents.length > 0
						? s.agents
						: s.agentId
							? [{ agentId: s.agentId, name: s.name || `Step ${i + 1}` }]
							: [];
				// For single-agent nodes, apply node-level systemPrompt override to the agent
				if (nodeAgents.length === 1 && s.systemPrompt && !s.agents?.length) {
					nodeAgents[0] = { ...nodeAgents[0], systemPrompt: s.systemPrompt };
				}
				return {
					id: stepIds[i],
					name: s.name || `Step ${i + 1}`,
					agents: nodeAgents,
					instructions: s.instructions || undefined,
				};
			});

			if (isEditing && workflow) {
				await spaceStore.updateWorkflow(workflow.id, {
					name: name.trim(),
					description: description.trim() || null,
					nodes: builtNodes,
					startNodeId: stepIds[0],
					endNodeId: resolvedEndNodeId,
					tags,
					channels: channels.length > 0 ? channels : [],
					gates: gates.length > 0 ? gates : [],
				});
			} else {
				await spaceStore.createWorkflow({
					name: name.trim(),
					description: description.trim() || undefined,
					nodes: builtNodes,
					startNodeId: stepIds[0],
					endNodeId: resolvedEndNodeId,
					tags,
					channels: channels.length > 0 ? channels : undefined,
					gates: gates.length > 0 ? gates : undefined,
				});
			}

			onSave();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save workflow.');
		} finally {
			setSaving(false);
		}
	}

	return (
		<div class="flex flex-col h-full overflow-hidden">
			{/* Header */}
			<div class="flex items-center gap-3 px-6 py-4 border-b border-dark-700 flex-shrink-0">
				<button
					onClick={onCancel}
					class="text-gray-500 hover:text-gray-300 transition-colors"
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
				<h1 class="text-sm font-semibold text-gray-100">
					{isEditing ? 'Edit Workflow' : 'New Workflow'}
				</h1>
				<div class="flex-1" />
				<button
					onClick={onCancel}
					class="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
				>
					Cancel
				</button>
				<button
					onClick={handleSave}
					disabled={saving}
					class="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
				>
					{saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Workflow'}
				</button>
			</div>

			{/* Scrollable body */}
			<div class="flex-1 overflow-y-auto p-6 space-y-6">
				{/* Error */}
				{error && (
					<div class="bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3">
						<p class="text-xs text-red-300">{error}</p>
					</div>
				)}

				{/* Name & Description */}
				<div class="space-y-4">
					<div class="space-y-1.5">
						<label class="text-xs font-medium text-gray-400">Workflow Name</label>
						<input
							type="text"
							value={name}
							onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
							placeholder="e.g. Feature Development"
							class="w-full text-sm bg-dark-850 border border-dark-700 rounded-lg px-3 py-2 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
						/>
					</div>
					<div class="space-y-1.5">
						<label class="text-xs font-medium text-gray-400">
							Description <span class="font-normal text-gray-600">(optional)</span>
						</label>
						<textarea
							value={description}
							onInput={(e) => setDescription((e.currentTarget as HTMLTextAreaElement).value)}
							placeholder="What does this workflow accomplish?"
							rows={2}
							class="w-full text-sm bg-dark-850 border border-dark-700 rounded-lg px-3 py-2 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
				</div>

				{/* Template picker */}
				{!isEditing && (
					<div>
						<button
							onClick={() => setShowTemplates((v) => !v)}
							class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
						>
							{showTemplates ? 'Hide templates ↑' : 'Start from template ↓'}
						</button>
						{showTemplates && (
							<div class="mt-3 grid grid-cols-1 gap-2">
								{availableTemplates.length === 0 && (
									<div class="px-4 py-3 bg-dark-850 border border-dark-700 rounded-lg">
										<p class="text-xs text-gray-500">
											No built-in templates are available for this space yet.
										</p>
									</div>
								)}
								{availableTemplates.map((tpl) => (
									<button
										key={tpl.label}
										onClick={() => applyTemplate(tpl)}
										class="text-left px-4 py-3 bg-dark-850 border border-dark-700 rounded-lg hover:border-dark-600 hover:bg-dark-800 transition-colors"
									>
										<p class="text-xs font-medium text-gray-200">{tpl.label}</p>
										<p class="text-xs text-gray-600 mt-0.5">{tpl.description}</p>
									</button>
								))}
							</div>
						)}
					</div>
				)}

				{/* Steps */}
				<div>
					<div class="flex items-center justify-between mb-3">
						<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Steps</h2>
						<span class="text-xs text-gray-600">
							{steps.length} step{steps.length !== 1 ? 's' : ''}
						</span>
					</div>

					{steps.length === 0 && (
						<p class="text-xs text-gray-600 text-center py-6">
							No steps yet. Add a step or start from a template.
						</p>
					)}

					<div class="space-y-2">
						{steps.map((step, i) => {
							// Derive per-agent completion states from node execution data for this node,
							// scoped to the most relevant workflow run to avoid mixing state from
							// past runs with the current one.
							const allNodeExecs = step.id ? (nodeExecutionsByNodeId.get(step.id) ?? []) : [];
							const nodeExecs = relevantRunId
								? allNodeExecs.filter((e) => e.workflowRunId === relevantRunId)
								: allNodeExecs;
							const nodeTaskStates: AgentTaskState[] = nodeExecs.map((e) => ({
								agentName: e.agentName ?? null,
								status: e.status,
								completionSummary: e.result ?? null,
							}));
							return (
								<WorkflowNodeCard
									key={step.localId}
									node={step}
									nodeIndex={i}
									isFirst={i === 0}
									isLast={i === steps.length - 1}
									expanded={expandedIndex === i}
									agents={agents}
									onToggleExpand={() => setExpandedIndex((prev) => (prev === i ? null : i))}
									onUpdate={(s) => updateStep(i, s)}
									onMoveUp={() => moveStep(i, 'up')}
									onMoveDown={() => moveStep(i, 'down')}
									onRemove={() => removeStep(i)}
									disableRemove={steps.length === 1}
									nodeTaskStates={nodeTaskStates.length > 0 ? nodeTaskStates : undefined}
								/>
							);
						})}
					</div>

					<button
						onClick={addStep}
						class="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-dark-600 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:border-dark-500 transition-colors"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 4v16m8-8H4"
							/>
						</svg>
						Add Step
					</button>
				</div>

				{/* Channels */}
				<div class="space-y-3">
					<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Channels</h2>
					<ChannelEditor
						channels={channels}
						onChange={setChannels}
						agentRoles={agents.map((a) => a.name).filter(Boolean)}
					/>
				</div>

				{/* Tags */}
				<div class="space-y-3">
					<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Tags</h2>
					<div class="flex flex-wrap gap-1.5 items-center min-h-[2rem] bg-dark-850 border border-dark-700 rounded-lg px-3 py-1.5">
						{tags.map((tag) => (
							<span
								key={tag}
								class="flex items-center gap-1 text-xs bg-dark-700 border border-dark-600 text-gray-300 rounded px-2 py-0.5"
							>
								{tag}
								<button
									type="button"
									onClick={() => removeTag(tag)}
									class="text-gray-500 hover:text-red-400 transition-colors ml-0.5"
									aria-label={`Remove tag ${tag}`}
								>
									×
								</button>
							</span>
						))}
						<input
							type="text"
							value={tagInput}
							placeholder={tags.length === 0 ? 'Add tags (press Enter or comma)…' : ''}
							onInput={(e) => setTagInput((e.currentTarget as HTMLInputElement).value)}
							onKeyDown={handleTagInputKeyDown}
							onBlur={() => {
								// Split on commas so pasting "coding,review" and blurring works correctly
								if (tagInput.trim()) {
									tagInput.split(',').forEach((t) => addTag(t));
									setTagInput('');
								}
							}}
							class="flex-1 min-w-[8rem] bg-transparent text-sm text-gray-200 outline-none placeholder-gray-700"
						/>
					</div>
					{/* Suggestions */}
					<div class="flex flex-wrap gap-1.5">
						{TAG_SUGGESTIONS.filter((s) => !tags.includes(s)).map((s) => (
							<button
								key={s}
								type="button"
								onClick={() => addTag(s)}
								class="text-xs text-gray-600 hover:text-gray-300 border border-dark-700 hover:border-dark-500 rounded px-2 py-0.5 transition-colors"
							>
								+ {s}
							</button>
						))}
					</div>
				</div>

				{/* Rules */}
				<WorkflowRulesEditor
					rules={rules}
					steps={steps.map((s, i) => ({
						id: s.id ?? s.localId,
						name: s.name || `Step ${i + 1}`,
						agents: s.agents ?? [],
					}))}
					onChange={setRules}
				/>
			</div>
		</div>
	);
}
