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
import type { SpaceAgent } from '@neokai/shared';
import type { StepDraft } from '../WorkflowStepCard';
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

				{/* Agent */}
				<div class="space-y-1.5">
					<label class="text-xs font-medium text-gray-400">Agent</label>
					<select
						data-testid="agent-select"
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
					terminalMessage={isFirstStep ? 'Workflow starts here' : undefined}
				/>

				{/* Exit Gate */}
				<GateConfig
					label="Exit Gate"
					condition={exitCondition ?? { type: 'always' }}
					onChange={onUpdateExitCondition}
					terminalMessage={isLastStep ? 'Workflow ends here' : undefined}
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
