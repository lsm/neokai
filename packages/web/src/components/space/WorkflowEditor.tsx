/**
 * WorkflowEditor Component
 *
 * Create or edit a workflow definition.
 *
 * Features:
 * - Name and description fields
 * - Vertical step list with expandable WorkflowStepCards
 * - Add Step button
 * - "Start from template" options
 * - Save / Cancel
 */

import { useState } from 'preact/hooks';
import type { SpaceWorkflow, SpaceAgent } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { WorkflowStepCard } from './WorkflowStepCard';
import type { StepDraft, ConditionDraft } from './WorkflowStepCard';
import { WorkflowRulesEditor } from './WorkflowRulesEditor';
import type { RuleDraft } from './WorkflowRulesEditor';
import { rulesToDrafts } from './WorkflowRulesEditor';

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
	stepRoles: string[]; // agent role names to look up from agent list
}

export const TEMPLATES: WorkflowTemplate[] = [
	{
		label: 'Coding (Plan → Code)',
		description: 'Planner agent designs the approach, then coder implements.',
		stepRoles: ['planner', 'coder'],
	},
	{
		label: 'Research (Plan → Research)',
		description: 'Planner agent scopes the research, then general agent executes it.',
		stepRoles: ['planner', 'general'],
	},
	{
		label: 'Quick Fix (Code only)',
		description: 'Single coder step for focused, scope-limited changes.',
		stepRoles: ['coder'],
	},
];

// ============================================================================
// Helpers
// ============================================================================

function makeLocalId(): string {
	return generateUUID();
}

function makeEmptyStep(): StepDraft {
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
	return agents.filter(
		(a) => a.name.toLowerCase() !== 'leader' && a.role.toLowerCase() !== 'leader'
	);
}

/**
 * Derive ordered steps and positional transition conditions from an existing
 * workflow. Graph traversal follows startNodeId through outgoing transitions.
 * Orphaned steps (not reachable from startNodeId) are appended at the end.
 *
 * Defined outside the component so it is not recreated on each render and
 * is clearly a pure initialization helper, not a reactive dependency.
 *
 * NOTE (Milestone 5): `StepDraft` only carries `agentId` (single-agent format).
 * Multi-agent steps (`agents[]`) and `channels[]` are silently dropped when a workflow
 * is loaded into the editor. Saving such a workflow through the UI would overwrite those
 * fields with the single-agent representation. There is no UI to create multi-agent steps
 * yet, so the practical risk is limited to API-created workflows opened in this editor.
 */
export function initFromWorkflow(wf: SpaceWorkflow): {
	steps: StepDraft[];
	transitions: ConditionDraft[];
	rules: RuleDraft[];
	tags: string[];
} {
	const stepMap = new Map(wf.nodes.map((s) => [s.id, s]));
	const ordered: StepDraft[] = [];
	const visited = new Set<string>();
	let currentId: string | undefined = wf.startNodeId;

	while (currentId && !visited.has(currentId)) {
		visited.add(currentId);
		const s = stepMap.get(currentId);
		if (s) {
			ordered.push({
				localId: makeLocalId(),
				id: s.id,
				name: s.name,
				agentId: s.agentId ?? '',
				instructions: s.instructions ?? '',
			});
		}
		const outgoing = wf.transitions
			.filter((t) => t.from === currentId)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		currentId = outgoing[0]?.to;
	}

	for (const s of wf.nodes) {
		if (!visited.has(s.id)) {
			ordered.push({
				localId: makeLocalId(),
				id: s.id,
				name: s.name,
				agentId: s.agentId ?? '',
				instructions: s.instructions ?? '',
			});
		}
	}

	const conditions: ConditionDraft[] = [];
	for (let i = 0; i < ordered.length - 1; i++) {
		const fromId = ordered[i].id;
		const toId = ordered[i + 1].id;
		const t = wf.transitions.find((tr) => tr.from === fromId && tr.to === toId);
		conditions.push(
			t?.condition
				? { type: t.condition.type, expression: t.condition.expression }
				: { type: 'always' }
		);
	}

	return {
		steps: ordered,
		transitions: conditions,
		rules: rulesToDrafts(wf.rules ?? []),
		tags: wf.tags ?? [],
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

	const [name, setName] = useState(workflow?.name ?? '');
	const [description, setDescription] = useState(workflow?.description ?? '');
	const [steps, setSteps] = useState<StepDraft[]>(initial?.steps ?? [makeEmptyStep()]);
	const [transitions, setTransitions] = useState<ConditionDraft[]>(initial?.transitions ?? []);
	const [rules, setRules] = useState<RuleDraft[]>(initial?.rules ?? []);
	const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
	const [tagInput, setTagInput] = useState('');
	const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showTemplates, setShowTemplates] = useState(false);

	const agents = filterAgents(spaceStore.agents.value);

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

	function updateStep(index: number, step: StepDraft) {
		setSteps((prev) => prev.map((s, i) => (i === index ? step : s)));
	}

	function updateEntryCondition(index: number, cond: ConditionDraft) {
		// entry condition of step[i] = transitions[i-1]
		if (index === 0) return;
		setTransitions((prev) => prev.map((t, i) => (i === index - 1 ? cond : t)));
	}

	function updateExitCondition(index: number, cond: ConditionDraft) {
		// exit condition of step[i] = transitions[i]
		if (index === steps.length - 1) return;
		setTransitions((prev) => prev.map((t, i) => (i === index ? cond : t)));
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
		const newSteps: StepDraft[] = template.stepRoles.map((role) => {
			const found = agents.find(
				(a) => a.name.toLowerCase() === role || a.role.toLowerCase() === role
			);
			return {
				localId: makeLocalId(),
				name: role.charAt(0).toUpperCase() + role.slice(1),
				agentId: found?.id ?? '',
				instructions: '',
			};
		});

		setSteps(newSteps);
		setTransitions(newSteps.slice(1).map(() => makeDefaultCondition()));
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

			// Map from the display ID used in WorkflowRulesEditor (s.id ?? s.localId)
			// to the final persisted step ID, so appliesTo references survive the save.
			const displayIdToStepId = new Map<string, string>(
				steps.map((s, i) => [s.id ?? s.localId, stepIds[i]])
			);

			const builtNodes = steps.map((s, i) => ({
				id: stepIds[i],
				name: s.name || `Step ${i + 1}`,
				agentId: s.agentId ?? '',
				instructions: s.instructions || undefined,
			}));

			const builtTransitions = transitions.map((cond, i) => ({
				from: stepIds[i],
				to: stepIds[i + 1],
				condition:
					cond.type === 'always'
						? undefined
						: {
								type: cond.type,
								expression: cond.expression,
							},
				order: i,
			}));

			// Build rules — filter out completely blank drafts
			const filteredRuleDrafts = rules.filter((r) => r.name.trim() || r.content.trim());

			if (isEditing && workflow) {
				// Update needs full WorkflowRule objects with IDs
				const updateRules = filteredRuleDrafts.map((r) => ({
					id: r.id ?? generateUUID(),
					name: r.name.trim() || 'Untitled Rule',
					content: r.content,
					// Remap display IDs (localId for new steps) to final persisted step IDs
					appliesTo: r.appliesTo.map((id) => displayIdToStepId.get(id) ?? id),
				}));
				await spaceStore.updateWorkflow(workflow.id, {
					name: name.trim(),
					description: description.trim() || null,
					nodes: builtNodes,
					transitions: builtTransitions,
					startNodeId: stepIds[0],
					rules: updateRules,
					tags,
				});
			} else {
				// Create uses WorkflowRuleInput (no id)
				const createRules = filteredRuleDrafts.map((r) => ({
					name: r.name.trim() || 'Untitled Rule',
					content: r.content,
					// Remap display IDs (localId for new steps) to final persisted step IDs
					appliesTo: r.appliesTo.map((id) => displayIdToStepId.get(id) ?? id),
				}));
				await spaceStore.createWorkflow({
					name: name.trim(),
					description: description.trim() || undefined,
					nodes: builtNodes,
					transitions: builtTransitions,
					startNodeId: stepIds[0],
					rules: createRules,
					tags,
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
								{TEMPLATES.map((tpl) => (
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
						{steps.map((step, i) => (
							<WorkflowStepCard
								key={step.localId}
								step={step}
								stepIndex={i}
								isFirst={i === 0}
								isLast={i === steps.length - 1}
								expanded={expandedIndex === i}
								entryCondition={i > 0 ? (transitions[i - 1] ?? { type: 'always' }) : null}
								exitCondition={i < steps.length - 1 ? (transitions[i] ?? { type: 'always' }) : null}
								agents={agents}
								onToggleExpand={() => setExpandedIndex((prev) => (prev === i ? null : i))}
								onUpdate={(s) => updateStep(i, s)}
								onUpdateEntryCondition={(c) => updateEntryCondition(i, c)}
								onUpdateExitCondition={(c) => updateExitCondition(i, c)}
								onMoveUp={() => moveStep(i, 'up')}
								onMoveDown={() => moveStep(i, 'down')}
								onRemove={() => removeStep(i)}
								disableRemove={steps.length === 1}
							/>
						))}
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
						agentId: s.agentId ?? '',
						instructions: s.instructions,
					}))}
					onChange={setRules}
				/>
			</div>
		</div>
	);
}
