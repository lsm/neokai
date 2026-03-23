/**
 * GateConfig
 *
 * Shared sub-form for configuring workflow transition conditions (entry/exit gates).
 * Extracted so both WorkflowStepCard (list editor) and NodeConfigPanel (visual editor)
 * can reuse the same UI without duplication.
 */

import type { WorkflowConditionType } from '@neokai/shared';

// ============================================================================
// Types
// ============================================================================

export interface ConditionDraft {
	type: WorkflowConditionType;
	/** Expression: shell command for 'condition' type, match value for 'task_result' type */
	expression?: string;
}

export const CONDITION_LABELS: Record<WorkflowConditionType, string> = {
	always: 'Automatic',
	human: 'Human Approval',
	condition: 'Shell Condition',
	task_result: 'Task Result',
};

// ============================================================================
// GateConfig Component
// ============================================================================

interface GateConfigProps {
	condition: ConditionDraft;
	onChange: (cond: ConditionDraft) => void;
	label: string;
	/** Message shown when the gate is not configurable (first/last step boundary) */
	terminalMessage?: string;
	/** Optional test ID for the gate type select */
	testId?: string;
}

export function GateConfig({
	condition,
	onChange,
	label,
	terminalMessage,
	testId,
}: GateConfigProps) {
	return (
		<div class="space-y-1.5">
			<label class="text-xs font-medium text-gray-400">{label}</label>
			{terminalMessage ? (
				<p class="text-xs text-gray-600 italic">{terminalMessage}</p>
			) : (
				<>
					<select
						data-testid={testId}
						value={condition.type}
						onChange={(e) => {
							const type = (e.currentTarget as HTMLSelectElement).value as WorkflowConditionType;
							onChange({
								type,
								expression: type === 'condition' || type === 'task_result' ? '' : undefined,
							});
						}}
						class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
					>
						{(Object.keys(CONDITION_LABELS) as WorkflowConditionType[]).map((t) => (
							<option key={t} value={t}>
								{CONDITION_LABELS[t]}
							</option>
						))}
					</select>

					{(condition.type === 'condition' || condition.type === 'task_result') && (
						<div class="space-y-1">
							<input
								type="text"
								required
								placeholder={
									condition.type === 'task_result'
										? 'e.g. passed, failed'
										: 'e.g. bun test && git diff --quiet'
								}
								value={condition.expression ?? ''}
								onInput={(e) =>
									onChange({
										...condition,
										expression: (e.currentTarget as HTMLInputElement).value,
									})
								}
								class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
							/>
							<p class="text-xs text-gray-600">
								{condition.type === 'task_result'
									? 'Fires when the task result matches this value.'
									: 'Transition fires when the shell command exits with code 0.'}
							</p>
						</div>
					)}

					{condition.type === 'human' && (
						<p class="text-xs text-gray-600">Transition requires explicit human approval.</p>
					)}

					{condition.type === 'always' && (
						<p class="text-xs text-gray-600">Transition fires automatically.</p>
					)}
				</>
			)}
		</div>
	);
}
