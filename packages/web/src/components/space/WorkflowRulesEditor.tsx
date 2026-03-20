/**
 * WorkflowRulesEditor Component
 *
 * Manages workflow-level rules: name, content (markdown), and optional
 * step-scoped application.
 *
 * - Lists existing rules with name and truncated content preview
 * - "Add Rule" button appends a blank rule
 * - Each rule has: Name input, Content textarea, "Applies to" multi-select, Remove button
 * - "Applies to" shows step display names but stores step IDs
 *   (IDs survive renames; empty selection = applies to all steps)
 */

import type { WorkflowRule, WorkflowStep } from '@neokai/shared';

// ============================================================================
// Types
// ============================================================================

/** Draft rule used during editing — id is optional for newly created rules */
export interface RuleDraft {
	/** Stable local key for React reconciliation */
	localId: string;
	/** Persisted ID (undefined for new rules) */
	id?: string;
	name: string;
	content: string;
	/** Step IDs this rule applies to. Empty = all steps. */
	appliesTo: string[];
}

// ============================================================================
// Helpers
// ============================================================================

export function makeEmptyRule(): RuleDraft {
	return {
		localId: crypto.randomUUID(),
		name: '',
		content: '',
		appliesTo: [],
	};
}

/** Convert saved WorkflowRules to drafts */
export function rulesToDrafts(rules: WorkflowRule[]): RuleDraft[] {
	return rules.map((r) => ({
		localId: crypto.randomUUID(),
		id: r.id,
		name: r.name,
		content: r.content,
		appliesTo: r.appliesTo ?? [],
	}));
}

// ============================================================================
// Sub-component: step multi-select
// ============================================================================

interface StepMultiSelectProps {
	steps: WorkflowStep[];
	selected: string[];
	onChange: (ids: string[]) => void;
}

function StepMultiSelect({ steps, selected, onChange }: StepMultiSelectProps) {
	if (steps.length === 0) {
		return (
			<span class="text-xs text-gray-600 italic">
				No steps defined — rule will apply to all steps
			</span>
		);
	}

	function toggle(id: string) {
		if (selected.includes(id)) {
			onChange(selected.filter((s) => s !== id));
		} else {
			onChange([...selected, id]);
		}
	}

	return (
		<div class="flex flex-wrap gap-1.5">
			{steps.map((step, i) => {
				const isSelected = selected.includes(step.id);
				const label = step.name || `Step ${i + 1}`;
				return (
					<button
						key={step.id}
						type="button"
						onClick={() => toggle(step.id)}
						class={[
							'text-xs px-2 py-0.5 rounded border transition-colors',
							isSelected
								? 'bg-blue-800/40 border-blue-700/60 text-blue-200'
								: 'bg-dark-800 border-dark-600 text-gray-400 hover:border-dark-500 hover:text-gray-300',
						].join(' ')}
					>
						{label}
					</button>
				);
			})}
		</div>
	);
}

// ============================================================================
// Sub-component: single rule card
// ============================================================================

interface RuleCardProps {
	rule: RuleDraft;
	steps: WorkflowStep[];
	onUpdate: (rule: RuleDraft) => void;
	onRemove: () => void;
}

function RuleCard({ rule, steps, onUpdate, onRemove }: RuleCardProps) {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-4 space-y-3">
			<div class="flex items-center justify-between gap-2">
				<input
					type="text"
					value={rule.name}
					onInput={(e) => onUpdate({ ...rule, name: (e.currentTarget as HTMLInputElement).value })}
					placeholder="Rule name (e.g. Follow TypeScript conventions)"
					class="flex-1 text-sm bg-dark-900 border border-dark-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
				/>
				<button
					type="button"
					onClick={onRemove}
					class="flex-shrink-0 text-gray-600 hover:text-red-400 transition-colors p-1"
					title="Remove rule"
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

			<textarea
				value={rule.content}
				onInput={(e) =>
					onUpdate({ ...rule, content: (e.currentTarget as HTMLTextAreaElement).value })
				}
				placeholder="Describe the rule in detail. Markdown is supported."
				rows={3}
				class="w-full text-sm bg-dark-900 border border-dark-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
			/>

			<div class="space-y-1.5">
				<p class="text-xs text-gray-500">
					Applies to <span class="text-gray-600">(empty = all steps)</span>
				</p>
				<StepMultiSelect
					steps={steps}
					selected={rule.appliesTo}
					onChange={(ids) => onUpdate({ ...rule, appliesTo: ids })}
				/>
			</div>
		</div>
	);
}

// ============================================================================
// Main component
// ============================================================================

interface WorkflowRulesEditorProps {
	rules: RuleDraft[];
	steps: WorkflowStep[];
	onChange: (rules: RuleDraft[]) => void;
}

export function WorkflowRulesEditor({ rules, steps, onChange }: WorkflowRulesEditorProps) {
	function addRule() {
		onChange([...rules, makeEmptyRule()]);
	}

	function updateRule(index: number, updated: RuleDraft) {
		onChange(rules.map((r, i) => (i === index ? updated : r)));
	}

	function removeRule(index: number) {
		onChange(rules.filter((_, i) => i !== index));
	}

	return (
		<div class="space-y-3">
			<div class="flex items-center justify-between">
				<h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Rules</h2>
				<span class="text-xs text-gray-600">
					{rules.length} {rules.length === 1 ? 'rule' : 'rules'}
				</span>
			</div>

			{rules.length === 0 && (
				<p class="text-xs text-gray-600 text-center py-4">
					No rules yet. Rules guide agent behaviour throughout the workflow.
				</p>
			)}

			<div class="space-y-2">
				{rules.map((rule, i) => (
					<RuleCard
						key={rule.localId}
						rule={rule}
						steps={steps}
						onUpdate={(updated) => updateRule(i, updated)}
						onRemove={() => removeRule(i)}
					/>
				))}
			</div>

			<button
				type="button"
				onClick={addRule}
				class="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-dark-600 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:border-dark-500 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 4v16m8-8H4"
					/>
				</svg>
				Add Rule
			</button>
		</div>
	);
}
