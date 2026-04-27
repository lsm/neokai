/**
 * Per-node timeout resolution.
 *
 * The runtime no longer knows the agent role taxonomy. Per-slot timeout
 * overrides come from the workflow definition itself (`WorkflowNodeAgent.timeoutMs`).
 * If a slot does not declare one, the caller falls back to
 * `DEFAULT_NODE_TIMEOUT_MS` from `./constants`.
 *
 * This module intentionally stays small and pure — no role tables, no
 * registry, no string-keyed lookups. The only inputs are the workflow
 * definition and the running execution.
 */

import type { SpaceWorkflow } from '@neokai/shared';

/**
 * Minimal shape needed to resolve a timeout for a running node execution.
 * Keeping this interface local avoids importing the larger `NodeExecution`
 * type just to read two fields.
 */
export interface TimeoutExecutionRef {
	workflowNodeId: string;
	agentName: string | null;
}

/**
 * Resolve the timeout (in ms) declared by the workflow definition for the
 * agent slot matching this execution.
 *
 * Returns `undefined` when:
 *   - the workflow has no node with the execution's `workflowNodeId`, or
 *   - the matched node has no agent slot whose `name` matches `agentName`, or
 *   - the matched slot does not declare a `timeoutMs`.
 *
 * The caller is expected to fall back to `DEFAULT_NODE_TIMEOUT_MS` when this
 * returns `undefined`. Returning `undefined` (rather than the default) keeps
 * this helper free of policy and lets the call site decide how to handle the
 * "no override" case.
 */
export function resolveTimeoutForExecution(
	execution: TimeoutExecutionRef,
	workflow: Pick<SpaceWorkflow, 'nodes'>
): number | undefined {
	const node = workflow.nodes.find((n) => n.id === execution.workflowNodeId);
	if (!node) return undefined;

	const agentName = execution.agentName;
	if (!agentName) return undefined;

	const slot = node.agents.find((a) => a.name === agentName);
	if (!slot) return undefined;

	const timeoutMs = slot.timeoutMs;
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return undefined;
	}
	return timeoutMs;
}
