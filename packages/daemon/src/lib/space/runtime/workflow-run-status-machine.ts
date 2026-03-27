/**
 * WorkflowRunStatusMachine
 *
 * Defines the valid status transitions for the agent-centric workflow run lifecycle.
 *
 * Lifecycle:
 *   pending        → in_progress   (startWorkflowRun promotes immediately after creation)
 *   pending        → cancelled     (error during run initialization before tasks created)
 *   in_progress    → completed     (all agents reached terminal status)
 *   in_progress    → needs_attention  (agent failed or gate blocked requiring human action)
 *   in_progress    → cancelled     (explicit cancellation via API)
 *   needs_attention → in_progress  (human resolved the blocking issue)
 *   needs_attention → cancelled    (explicit cancellation while blocked)
 *
 * Terminal states (no outbound transitions):
 *   completed — run finished successfully, immutable
 *   cancelled — run stopped, immutable
 */

import type { WorkflowRunStatus } from '@neokai/shared';

/**
 * Map from a source status to the set of allowed target statuses.
 *
 * Terminal states (completed, cancelled) have empty target sets —
 * no transitions out of them are permitted.
 */
export const VALID_TRANSITIONS: Readonly<
	Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>
> = {
	pending: new Set<WorkflowRunStatus>(['in_progress', 'cancelled']),
	in_progress: new Set<WorkflowRunStatus>(['completed', 'needs_attention', 'cancelled']),
	needs_attention: new Set<WorkflowRunStatus>(['in_progress', 'cancelled']),
	completed: new Set<WorkflowRunStatus>(),
	cancelled: new Set<WorkflowRunStatus>(),
};

/**
 * Returns true when transitioning from `from` to `to` is a valid lifecycle step.
 */
export function canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
	return VALID_TRANSITIONS[from].has(to);
}

/**
 * Throws a descriptive error when the transition is invalid.
 * No-ops when the transition is valid — callers can proceed unconditionally.
 *
 * @param from  Current status of the run.
 * @param to    Desired next status.
 * @param runId Optional run ID for a more actionable error message.
 * @throws {Error} when the transition is not permitted.
 */
export function assertValidTransition(
	from: WorkflowRunStatus,
	to: WorkflowRunStatus,
	runId?: string
): void {
	if (!canTransition(from, to)) {
		const ctx = runId ? ` (run ${runId})` : '';
		throw new Error(
			`Invalid workflow run status transition${ctx}: '${from}' → '${to}'. ` +
				`Allowed from '${from}': [${[...VALID_TRANSITIONS[from]].join(', ') || 'none'}]`
		);
	}
}
