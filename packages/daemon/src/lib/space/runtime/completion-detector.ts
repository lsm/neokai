/**
 * CompletionDetector
 *
 * Determines whether a workflow run is complete by inspecting
 * `NodeExecution` records instead of `SpaceTask` records.
 *
 * Completion conditions (all-agents-done safety net):
 * 1. At least one node execution exists — workflow has started.
 * 2. Every node execution has a terminal status (done or cancelled).
 *
 * End-node short-circuit:
 * When `endNodeId` is provided, the detector checks if the end node's
 * execution has reached a terminal status. If so, the run is complete
 * regardless of other nodes' statuses (they will be cancelled by the runtime).
 *
 * Terminal statuses: `done`, `cancelled`.
 * Non-terminal statuses (block completion): `pending`, `in_progress`, `blocked`.
 */

import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';

// Re-export for backward compatibility — TERMINAL_TASK_STATUSES is the old name
/** @deprecated Use TERMINAL_NODE_EXECUTION_STATUSES from node-execution-manager instead */
export const TERMINAL_TASK_STATUSES = TERMINAL_NODE_EXECUTION_STATUSES;

export interface CompletionOptions {
	/** Workflow run to inspect */
	workflowRunId: string;
	/**
	 * Optional end node ID for deterministic completion.
	 * When provided, the run is complete when the end node's execution
	 * reaches a terminal status, regardless of other nodes.
	 */
	endNodeId?: string;
}

export class CompletionDetector {
	constructor(private readonly nodeExecutionRepo: NodeExecutionRepository) {}

	/**
	 * Returns true when the workflow run is complete.
	 *
	 * Two completion strategies:
	 *
	 * 1. **End-node short-circuit** (when `options.endNodeId` is provided):
	 *    The run is complete when the end node's execution reaches a terminal
	 *    status (`done` or `cancelled`). This is the primary completion path
	 *    for workflows with a defined end node.
	 *
	 * 2. **All-agents-done fallback**:
	 *    The run is complete when every node execution in the run has a
	 *    terminal status. This acts as a safety net for workflows without
	 *    an end node or for edge cases.
	 *
	 * Both strategies require at least one node execution to exist
	 * ("no executions" → false — workflow hasn't started).
	 */
	isComplete(options: CompletionOptions): boolean {
		const { workflowRunId, endNodeId } = options;

		const executions = this.nodeExecutionRepo.listByWorkflowRun(workflowRunId);

		// Workflow has not started yet — no node executions created
		if (executions.length === 0) return false;

		// End-node short-circuit: if the end node's execution is terminal,
		// the run is complete regardless of other nodes' statuses.
		if (endNodeId) {
			const endNodeExecution = executions.find((e) => e.workflowNodeId === endNodeId);
			if (endNodeExecution && TERMINAL_NODE_EXECUTION_STATUSES.has(endNodeExecution.status)) {
				return true;
			}
		}

		// All-agents-done fallback: every execution must be terminal
		if (executions.some((e) => !TERMINAL_NODE_EXECUTION_STATUSES.has(e.status))) return false;

		return true;
	}
}
