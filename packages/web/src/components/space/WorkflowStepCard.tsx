/**
 * WorkflowStepCard Component
 *
 * A single step card in the workflow editor.
 * Supports collapsed (summary) and expanded (edit) modes.
 *
 * Collapsed: step number, agent name, gate type icons
 * Expanded: name input, agent dropdown, entry/exit gate selectors, instructions
 */

import type { SpaceAgent } from '@neokai/shared';
import type { WorkflowConditionType } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { GateConfig, CONDITION_LABELS } from './visual-editor/GateConfig';
import type { ConditionDraft } from './visual-editor/GateConfig';

// ============================================================================
// Draft Types (used by WorkflowEditor + WorkflowStepCard)
// ============================================================================

export interface StepDraft {
	/** Stable local key for React rendering — not sent to the server */
	localId: string;
	/** Existing step ID when editing an existing workflow */
	id?: string;
	name: string;
	agentId: string;
	instructions: string;
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
// Main Component
// ============================================================================

interface WorkflowStepCardProps {
	step: StepDraft;
	stepIndex: number;
	isFirst: boolean;
	isLast: boolean;
	expanded: boolean;
	/** Condition on the transition coming INTO this step. Null for the first step. */
	entryCondition: ConditionDraft | null;
	/** Condition on the transition going OUT from this step. Null for the last step. */
	exitCondition: ConditionDraft | null;
	/** All space agents, excluding 'leader' */
	agents: SpaceAgent[];
	onToggleExpand: () => void;
	onUpdate: (step: StepDraft) => void;
	/** Called when entry condition changes — updates transition[stepIndex-1] */
	onUpdateEntryCondition: (cond: ConditionDraft) => void;
	/** Called when exit condition changes — updates transition[stepIndex] */
	onUpdateExitCondition: (cond: ConditionDraft) => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onRemove: () => void;
	/** When true, the Remove button is disabled (e.g. only one step remains) */
	disableRemove?: boolean;
}

export function WorkflowStepCard({
	step,
	stepIndex,
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
}: WorkflowStepCardProps) {
	const agentName = agents.find((a) => a.id === step.agentId)?.name ?? step.agentId;

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
					{stepIndex + 1}
				</span>

				{/* Step info */}
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-1.5 min-w-0">
						<span class="text-xs font-medium text-gray-200 truncate">
							{step.name || 'Unnamed Step'}
						</span>
						<span class="text-xs text-gray-600 flex-shrink-0">·</span>
						<span class="text-xs text-gray-500 truncate flex-shrink-0">{agentName || '—'}</span>
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
						title="Remove step"
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
						<label class="text-xs font-medium text-gray-400">Step Name</label>
						<input
							type="text"
							value={step.name}
							onInput={(e) =>
								onUpdate({ ...step, name: (e.currentTarget as HTMLInputElement).value })
							}
							placeholder="e.g. Plan the approach"
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
						/>
					</div>

					{/* Agent */}
					<div class="space-y-1">
						<label class="text-xs font-medium text-gray-400">Agent</label>
						<select
							value={step.agentId}
							onChange={(e) =>
								onUpdate({ ...step, agentId: (e.currentTarget as HTMLSelectElement).value })
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
							value={step.instructions}
							onInput={(e) =>
								onUpdate({
									...step,
									instructions: (e.currentTarget as HTMLTextAreaElement).value,
								})
							}
							placeholder="Step-specific instructions appended to the agent's system prompt…"
							rows={4}
							class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
						/>
					</div>
				</div>
			)}
		</div>
	);
}
