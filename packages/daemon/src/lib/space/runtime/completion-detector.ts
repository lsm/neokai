/**
 * CompletionDetector
 *
 * Determines whether all agents in a workflow run have reached a terminal
 * status. Uses a single direct query on space_tasks by workflow_run_id.
 *
 * Terminal statuses: done, blocked, cancelled, archived.
 * Non-terminal statuses (block completion): open, in_progress.
 */

import type { SpaceTaskStatus } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';

/**
 * Task statuses that represent a terminal (done) state for a workflow agent.
 * A run is complete only when every task is in one of these statuses.
 *
 * Terminal statuses (new schema): `done`, `blocked`, `cancelled`, `archived`.
 * `blocked` is terminal for completion purposes — it halts progress and requires human action.
 */
export const TERMINAL_TASK_STATUSES = new Set<SpaceTaskStatus>([
	'done',
	'blocked',
	'cancelled',
	'archived',
]);

export class CompletionDetector {
	constructor(private readonly taskRepo: SpaceTaskRepository) {}

	/**
	 * Returns true when the workflow run is complete.
	 *
	 * Completion conditions (all must hold):
	 * 1. At least one task exists — workflow has started ("no tasks" → false).
	 * 2. Every task has a terminal status — none in open/in_progress.
	 *
	 * Note: the pending-but-blocked node activation guard (which previously checked
	 * channel targets against activated workflow nodes) has been removed as part of
	 * the schema migration that dropped `workflow_node_id` from `space_tasks`.
	 * A replacement guard using `endNodeId` will be added in a subsequent task.
	 *
	 * @param workflowRunId  Workflow run to inspect.
	 */
	isComplete(workflowRunId: string): boolean {
		// Consider all tasks in the run (archived tasks are excluded by the repository).
		const tasks = this.taskRepo.listByWorkflowRun(workflowRunId);

		// Workflow has not started yet — no node tasks created
		if (tasks.length === 0) return false;

		// Any non-terminal task prevents completion
		if (tasks.some((t) => !TERMINAL_TASK_STATUSES.has(t.status))) return false;

		return true;
	}
}
