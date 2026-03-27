/**
 * CompletionDetector
 *
 * Determines whether all agents in a workflow run have reached a terminal
 * status. Uses a single direct query on space_tasks by workflow_run_id.
 *
 * Terminal statuses: completed, needs_attention, cancelled, rate_limited, usage_limited.
 * Non-terminal statuses (block completion): draft, pending, in_progress, review.
 */

import type { SpaceTaskStatus, WorkflowChannel, WorkflowNode } from '@neokai/shared';
import { resolveNodeAgents } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';

/**
 * Task statuses that represent a terminal (done) state for a workflow agent.
 * A run is complete only when every task is in one of these statuses.
 */
export const TERMINAL_TASK_STATUSES = new Set<SpaceTaskStatus>([
	'completed',
	'needs_attention',
	'cancelled',
	'rate_limited',
	'usage_limited',
]);

export class CompletionDetector {
	constructor(private readonly taskRepo: SpaceTaskRepository) {}

	/**
	 * Returns true when the workflow run is complete.
	 *
	 * Completion conditions (all must hold):
	 * 1. At least one task exists — workflow has started ("no tasks" → false).
	 * 2. Every task has a terminal status — none in draft/pending/in_progress/review.
	 * 3. Pending-but-blocked guard (only when channels + nodes are provided):
	 *    no outbound channel targets a node that has not yet been activated.
	 *    An unactivated downstream node means activation is still pending,
	 *    so the run is NOT complete.
	 *
	 * Nodes with no tasks are excluded from the check — they were never activated
	 * and are not treated as blocking unless a channel explicitly points to them.
	 *
	 * @param workflowRunId  Workflow run to inspect.
	 * @param channels       Workflow-level channel declarations. When provided
	 *                       together with `nodes`, enables the pending-but-blocked
	 *                       node activation guard.
	 * @param nodes          All nodes in the workflow definition. Required when
	 *                       `channels` is provided for the guard to function.
	 */
	isComplete(
		workflowRunId: string,
		channels: WorkflowChannel[] = [],
		nodes: WorkflowNode[] = []
	): boolean {
		// Only consider node-agent tasks (those with workflowNodeId set).
		// The orchestration task (Task Agent's own task) has workflowNodeId = null
		// and is still in_progress while this check runs — it must be excluded.
		const tasks = this.taskRepo
			.listByWorkflowRun(workflowRunId)
			.filter((t) => t.workflowNodeId != null);

		// Workflow has not started yet — no node tasks created
		if (tasks.length === 0) return false;

		// Any non-terminal task prevents completion
		if (tasks.some((t) => !TERMINAL_TASK_STATUSES.has(t.status))) return false;

		// Pending-but-blocked guard: check whether any channel targets an
		// unactivated node. If so, the run is not yet complete.
		if (channels.length > 0 && nodes.length > 0) {
			const activatedNodeIds = new Set(
				tasks.map((t) => t.workflowNodeId).filter((id): id is string => id != null)
			);

			for (const channel of channels) {
				const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
				for (const target of targets) {
					const targetNodeId = this.resolveTargetNodeId(target, nodes);
					if (targetNodeId !== undefined && !activatedNodeIds.has(targetNodeId)) {
						return false;
					}
				}
			}
		}

		return true;
	}

	/**
	 * Resolves a channel `to` address string to the target node's ID.
	 *
	 * Handles three address formats:
	 * - `"*"` — wildcard broadcast; returns undefined (skipped in guard).
	 * - `"nodeId/agentName"` — cross-node DM; the nodeId prefix is the target.
	 * - plain string — either a node name (fan-out) or an agent name (within/
	 *   cross-node DM); scanned against `nodes`.
	 *
	 * Returns undefined when the address is a wildcard or cannot be resolved.
	 */
	private resolveTargetNodeId(to: string, nodes: WorkflowNode[]): string | undefined {
		if (to === '*') return undefined;

		// Cross-node format: "nodeId/agentName"
		const slashIdx = to.indexOf('/');
		if (slashIdx !== -1) {
			return to.substring(0, slashIdx);
		}

		// Plain name — match by node name (fan-out) or agent name within a node
		for (const node of nodes) {
			if (node.name === to) return node.id;
			const agents = resolveNodeAgents(node);
			if (agents.some((a) => a.name === to)) return node.id;
		}

		return undefined;
	}
}
