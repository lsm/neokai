/**
 * Helpers for surfacing the currently-pending completion action on a paused
 * SpaceTask. The `pendingAction` field is a read-path enrichment — derived from
 * the workflow definition at response time rather than persisted on the task
 * row. Keeping the derivation centralized lets the various read surfaces
 * (`get_task_detail`, `list_tasks`, future named queries) share one
 * implementation.
 */

import type { SpaceTask } from '@neokai/shared';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';

/**
 * Return a new `SpaceTask` object with `pendingAction` populated when the task
 * is paused at a completion action and the backing workflow can be resolved.
 *
 * Returns the task unchanged when:
 * - `pendingCheckpointType !== 'completion_action'` (task isn't paused at a
 *   completion action — may be paused at a gate instead, or not paused at all)
 * - `pendingActionIndex` is null
 * - the task has no `workflowRunId`
 * - the run, workflow, end node, or action at the index can't be resolved
 *   (e.g. the workflow was edited between pause and read)
 *
 * Script bodies, instruction prompts, and MCP tool args are intentionally
 * omitted — UIs can fetch workflow detail for those.
 */
export function enrichTaskWithPendingAction(
	task: SpaceTask,
	workflowRunRepo: SpaceWorkflowRunRepository,
	workflowManager: SpaceWorkflowManager
): SpaceTask {
	if (task.pendingCheckpointType !== 'completion_action') return task;
	if (task.pendingActionIndex == null) return task;
	if (!task.workflowRunId) return task;

	const run = workflowRunRepo.getRun(task.workflowRunId);
	if (!run) return task;

	const workflow = workflowManager.getWorkflow(run.workflowId);
	if (!workflow) return task;

	const endNode = workflow.nodes.find((n) => n.id === workflow.endNodeId);
	const actions = endNode?.completionActions;
	if (!actions || task.pendingActionIndex >= actions.length) return task;

	const action = actions[task.pendingActionIndex];

	return {
		...task,
		pendingAction: {
			id: action.id,
			name: action.name,
			description: action.description,
			type: action.type,
			requiredLevel: action.requiredLevel,
		},
	};
}
