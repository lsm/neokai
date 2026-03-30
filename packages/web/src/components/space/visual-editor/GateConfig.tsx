/**
 * GateConfig
 *
 * Shared sub-form for configuring workflow transition conditions (entry/exit gates).
 * Extracted so both WorkflowNodeCard (list editor) and NodeConfigPanel (visual editor)
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
	always: 'None',
	human: 'Human Approval',
	condition: 'Shell Condition',
	task_result: 'Task Result',
};

const CONDITION_OPTIONS: WorkflowConditionType[] = ['always', 'human', 'condition', 'task_result'];

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
						class="sr-only"
						tabIndex={-1}
						aria-hidden="true"
					>
						{CONDITION_OPTIONS.map((t) => (
							<option key={t} value={t}>
								{CONDITION_LABELS[t]}
							</option>
						))}
					</select>

					<div class="grid grid-cols-2 gap-1.5" data-testid={testId ? `${testId}-buttons` : undefined}>
						{CONDITION_OPTIONS.map((type) => {
							const active = condition.type === type;
							return (
								<button
									key={type}
									type="button"
									data-testid={testId ? `${testId}-${type}` : undefined}
									onClick={() =>
										onChange({
											type,
											expression:
												type === 'condition' || type === 'task_result'
													? condition.type === type
														? condition.expression ?? ''
														: ''
													: undefined,
										})
									}
									class={`rounded border px-2 py-1.5 text-left text-xs transition-colors ${
										active
											? 'border-blue-500 bg-blue-500/10 text-blue-200'
											: 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500 hover:text-gray-200'
									}`}
								>
									{CONDITION_LABELS[type]}
								</button>
							);
						})}
					</div>

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
						<p class="text-xs text-gray-600">No gate. Transition fires automatically.</p>
					)}
				</>
			)}
		</div>
	);
}
