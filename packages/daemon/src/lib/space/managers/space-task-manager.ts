/**
 * SpaceTaskManager - Space task management with status transitions
 *
 * Handles:
 * - Creating space tasks with dependency validation
 * - Status transitions (open -> in_progress -> done/blocked/cancelled -> archived)
 * - Task assignment and progress tracking
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	CreateSpaceTaskParams,
	SpaceApprovalSource,
	SpaceBlockReason,
	SpaceTask,
	SpaceTaskStatus,
	UpdateSpaceTaskParams,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';

/**
 * Valid task status transitions for space tasks
 * Maps current status -> allowed next statuses
 */
export const VALID_SPACE_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
	open: ['in_progress', 'blocked', 'done', 'cancelled'],
	// `in_progress → approved` is the end-node `approve_task` path (PR 2/5 of
	// the task-agent-as-post-approval-executor refactor). It replaces the
	// `in_progress → done` shortcut that the completion-action pipeline used
	// to take.
	in_progress: ['open', 'review', 'approved', 'done', 'blocked', 'cancelled'],
	// `review → approved` is the human-approves-the-work path — the
	// `approvePendingCompletion` RPC handler takes a task out of `review`
	// into `approved` so the post-approval router can dispatch.
	review: ['done', 'approved', 'in_progress', 'cancelled', 'archived'],
	// `approved → done` is driven by `mark_complete` (post-approval agent)
	// or the runtime fallback on session termination. `approved → blocked`
	// is intentionally absent in Stage 2: a failing post-approval session
	// leaves the task in `approved` with `postApprovalBlockedReason` set
	// and surfaces via `PendingPostApprovalBanner`.
	approved: ['done', 'in_progress', 'archived'],
	done: ['in_progress', 'archived'], // Reactivate or archive
	blocked: ['open', 'in_progress', 'archived'], // Restart allowed + archive
	cancelled: ['open', 'in_progress', 'done', 'archived'], // Restart, complete, or archive
	archived: [], // True terminal state — no going back
};

/**
 * Check if a space task status transition is valid
 */
export function isValidSpaceTaskTransition(from: SpaceTaskStatus, to: SpaceTaskStatus): boolean {
	return VALID_SPACE_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export class SpaceTaskManager {
	private taskRepo: SpaceTaskRepository;

	constructor(
		private db: BunDatabase,
		private spaceId: string,
		private reactiveDb?: ReactiveDatabase
	) {
		this.taskRepo = new SpaceTaskRepository(db, reactiveDb);
	}

	/**
	 * Create a task in this space
	 */
	async createTask(params: Omit<CreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
		// Validate dependency task IDs exist in this space
		if (params.dependsOn && params.dependsOn.length > 0) {
			await this.validateDependencyIds(params.dependsOn);
		}

		return this.taskRepo.createTask({ ...params, spaceId: this.spaceId });
	}

	/**
	 * Get a task by ID (validates it belongs to this space)
	 */
	async getTask(taskId: string): Promise<SpaceTask | null> {
		const task = this.taskRepo.getTask(taskId);
		if (task && task.spaceId === this.spaceId) {
			return task;
		}
		return null;
	}

	/**
	 * Get a task by its space-scoped numeric ID (e.g. task #5)
	 */
	async getTaskByNumber(taskNumber: number): Promise<SpaceTask | null> {
		return this.taskRepo.getTaskByNumber(this.spaceId, taskNumber);
	}

	/**
	 * List tasks in this space
	 */
	async listTasks(includeArchived = false): Promise<SpaceTask[]> {
		return this.taskRepo.listBySpace(this.spaceId, includeArchived);
	}

	/**
	 * List tasks by status
	 */
	async listTasksByStatus(status: SpaceTaskStatus): Promise<SpaceTask[]> {
		return this.taskRepo.listByStatus(this.spaceId, status);
	}

	/**
	 * List tasks belonging to a specific workflow run
	 */
	async listTasksByWorkflowRun(workflowRunId: string): Promise<SpaceTask[]> {
		return this.taskRepo.listByWorkflowRun(workflowRunId);
	}

	/**
	 * Update task status with validation
	 */
	async setTaskStatus(
		taskId: string,
		newStatus: SpaceTaskStatus,
		options?: {
			result?: string;
			blockReason?: SpaceBlockReason;
			approvalSource?: SpaceApprovalSource;
			// `null` explicitly clears a prior value; `undefined` leaves any
			// existing approvalReason untouched on transitions that carry the
			// stamp forward (see the approved → done mirror below).
			approvalReason?: string | null;
		}
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		if (!isValidSpaceTaskTransition(task.status, newStatus)) {
			throw new Error(
				`Invalid status transition from '${task.status}' to '${newStatus}'. ` +
					`Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
		}

		const updates: Parameters<SpaceTaskRepository['updateTask']>[1] = { status: newStatus };

		if (newStatus === 'done' || newStatus === 'blocked') {
			if (options?.result) updates.result = options.result;
		}

		// Stamp blockReason when entering blocked, clear when leaving
		if (newStatus === 'blocked') {
			updates.blockReason = options?.blockReason ?? null;
		}

		// Stamp approval metadata when transitioning from review → done
		if (task.status === 'review' && newStatus === 'done') {
			updates.approvalSource = options?.approvalSource ?? null;
			updates.approvalReason = options?.approvalReason ?? null;
			updates.approvedAt = Date.now();
		}

		// Stamp approval metadata when transitioning into the `approved` status
		// (in_progress → approved, review → approved). Post-approval routing uses
		// this as the canonical mid-lifecycle stamp before the Task Agent / spawned
		// sub-session transitions the task forward to `done` via `mark_complete`.
		if (newStatus === 'approved') {
			updates.approvalSource = options?.approvalSource ?? null;
			updates.approvalReason = options?.approvalReason ?? null;
			updates.approvedAt = Date.now();
		}

		// Mirror the approval stamp on approved → done (via `mark_complete`),
		// carrying through the original approvalSource so the audit trail is
		// preserved once the task reaches its terminal state.
		if (task.status === 'approved' && newStatus === 'done') {
			if (options?.approvalSource !== undefined) {
				updates.approvalSource = options.approvalSource;
			}
			if (options?.approvalReason !== undefined) {
				updates.approvalReason = options.approvalReason;
			}
		}

		// Clear result when restarting or deprioritizing.
		// Covers blocked, cancelled, done → reactivation, and in_progress → open (pause).
		if (
			(task.status === 'blocked' && (newStatus === 'open' || newStatus === 'in_progress')) ||
			(task.status === 'cancelled' && (newStatus === 'open' || newStatus === 'in_progress')) ||
			(task.status === 'done' && newStatus === 'in_progress') ||
			(task.status === 'in_progress' && newStatus === 'open')
		) {
			updates.result = null;
			// Clear block reason and approval metadata on reactivation
			updates.blockReason = null;
			updates.approvalSource = null;
			updates.approvalReason = null;
			updates.approvedAt = null;
		}

		// Clear pending-completion fields on any transition out of `review`.
		//
		// Mirrors (and replaces) the explicit follow-up `updateTask` cleanups
		// formerly issued by `approvePendingCompletion` (both branches) and the
		// agent `approve_task` tool. Centralising here closes the exit-side
		// counterpart of the unified `submitTaskForReview` entry: every task
		// landing in `review` carries the pending-* fields, and every task
		// leaving `review` (for any reason — Approve via banner, Reopen, Archive,
		// review→done by RPC) gets those fields nulled in the same SQL UPDATE
		// that flips the status. No banner-on-non-review state can persist.
		if (task.status === 'review' && newStatus !== 'review') {
			updates.pendingCheckpointType = null;
			updates.pendingCompletionSubmittedByNodeId = null;
			updates.pendingCompletionSubmittedAt = null;
			updates.pendingCompletionReason = null;
		}

		// Clear post-approval tracking fields on any transition out of `approved`.
		//
		// Mirrors (and replaces) the follow-up `updateTask` formerly issued by
		// the agent `mark_complete` tool. After this change, the `approved →
		// done` transition writes status='done' and nulls the post-approval
		// fields in a single repository UPDATE — closing the race window where
		// a reader could observe `status='done'` with stale
		// `postApprovalSessionId`/`postApprovalStartedAt`/`postApprovalBlockedReason`.
		// Also covers UI-driven escape hatches (`approved → in_progress`,
		// `approved → archived`) which previously left these fields lingering.
		if (task.status === 'approved' && newStatus !== 'approved') {
			updates.postApprovalSessionId = null;
			updates.postApprovalStartedAt = null;
			updates.postApprovalBlockedReason = null;
		}

		const updated = this.taskRepo.updateTask(taskId, updates);
		if (!updated) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updated;
	}

	// updateTaskProgress has been removed — progress tracking moved to node-level executions

	/**
	 * Start a task (mark as in_progress)
	 */
	async startTask(taskId: string): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'in_progress');
	}

	/**
	 * Submit a task for human review.
	 *
	 * Single entry point for both the agent `submit_for_approval` tool and the
	 * UI "Submit for Review" button. Atomically transitions a task into `review`
	 * and stamps the pending-completion metadata that drives the
	 * `PendingTaskCompletionBanner` — meaning every task that lands in `review`
	 * is guaranteed to carry the banner-eligible fields.
	 *
	 * Three callers, one set of writes:
	 *   - End-node `submit_for_approval` (passes a real `submittedByNodeId`)
	 *   - Task Agent `submit_for_approval` (passes `null` — orchestrator has no
	 *     workflow node)
	 *   - UI "Submit for Review" RPC (passes `null` — user-initiated)
	 *
	 * Atomicity is load-bearing: the entire write — `status='review'` plus the
	 * pending-completion fields — is issued as a single `taskRepo.updateTask`
	 * call (one SQL UPDATE). A two-step write (`setTaskStatus` + a follow-up
	 * pending-* update) would expose the exact banner-less in-between state
	 * this PR is meant to eliminate: any concurrent reader landing between the
	 * two writes would see `status='review' / pendingCheckpointType=null`. The
	 * transition is validated inline against `isValidSpaceTaskTransition` so an
	 * illegal source status (`done`, `archived`, …) throws before the write.
	 */
	async submitTaskForReview(
		taskId: string,
		opts: {
			/**
			 * Workflow node ID of the submitting agent, or `null` when there is no
			 * waiting end-node session (Task Agent self-submit, UI submit). Used by
			 * `PostApprovalRouter` to distinguish agent-initiated vs user-initiated
			 * approvals when emitting awareness events.
			 */
			submittedByNodeId: string | null;
			/** Optional human-readable reason; surfaces in the approval banner. */
			reason: string | null;
		}
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Inline transition validation. Mirrors the check in `setTaskStatus` —
		// kept here (rather than delegating) so the status flip and the pending-*
		// stamp can happen in a single SQL UPDATE. Re-submitting while already in
		// `review` is intentionally idempotent for multi-cycle workflows: each cycle
		// refreshes the pending-completion metadata instead of failing with a
		// misleading `review → review` transition error.
		if (task.status !== 'review' && !isValidSpaceTaskTransition(task.status, 'review')) {
			throw new Error(
				`Invalid status transition from '${task.status}' to 'review'. ` +
					`Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
		}

		// Single atomic write: status flip + pending-completion stamp in one
		// repository UPDATE. No reader can observe `status='review'` without the
		// pending-* fields populated, which is the whole point of this helper.
		const updated = this.taskRepo.updateTask(taskId, {
			status: 'review',
			pendingCheckpointType: 'task_completion',
			pendingCompletionSubmittedByNodeId: opts.submittedByNodeId,
			pendingCompletionSubmittedAt: Date.now(),
			pendingCompletionReason: opts.reason,
		});
		if (!updated) {
			throw new Error(`Failed to submit task for review: ${taskId}`);
		}
		return updated;
	}

	/**
	 * Complete a task
	 */
	async completeTask(taskId: string, result: string): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'done', { result });
	}

	/**
	 * Fail a task (mark as blocked)
	 */
	async failTask(
		taskId: string,
		error?: string,
		blockReason?: SpaceBlockReason
	): Promise<SpaceTask> {
		return this.setTaskStatus(taskId, 'blocked', {
			...(error ? { result: error } : {}),
			blockReason,
		});
	}

	/**
	 * Cancel a task and cascade to pending dependents
	 */
	async cancelTask(taskId: string): Promise<SpaceTask> {
		const all = await this.cancelTaskCascade(taskId);
		return all[0];
	}

	/**
	 * Cancel task and cascade to pending dependents recursively
	 */
	async cancelTaskCascade(taskId: string): Promise<SpaceTask[]> {
		return this.doCancelCascade(taskId, []);
	}

	private async doCancelCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
		const result = await this.setTaskStatus(taskId, 'cancelled');
		acc.push(result);

		const pendingTasks = await this.listTasksByStatus('open');
		for (const t of pendingTasks) {
			if (t.dependsOn?.includes(taskId)) {
				await this.doCancelCascade(t.id, acc);
			}
		}

		return acc;
	}

	/**
	 * Promote draft tasks created by a planning task to pending
	 */
	async promoteDraftTasks(creatorTaskId: string): Promise<number> {
		return this.taskRepo.promoteDraftTasksByCreator(creatorTaskId);
	}

	/**
	 * Archive a task - transitions to 'archived' status and sets archivedAt timestamp.
	 * Validates that the current status allows transitioning to 'archived'.
	 */
	async archiveTask(taskId: string): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		if (!isValidSpaceTaskTransition(task.status, 'archived')) {
			throw new Error(
				`Cannot archive task in '${task.status}' status. ` +
					`Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
			);
		}

		const updated = this.taskRepo.archiveTask(taskId);
		if (!updated) {
			throw new Error(`Failed to archive task: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Delete a task
	 */
	async deleteTask(taskId: string): Promise<boolean> {
		const task = await this.getTask(taskId);
		if (!task) {
			return false;
		}

		return this.taskRepo.deleteTask(taskId);
	}

	/**
	 * Update task fields directly (non-status fields).
	 * For status transitions use setTaskStatus instead.
	 */
	async updateTask(taskId: string, params: UpdateSpaceTaskParams): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		// Status changes must go through setTaskStatus for transition validation
		if (params.status !== undefined && params.status !== task.status) {
			throw new Error('Use setTaskStatus to change task status — it enforces valid transitions');
		}

		// Validate dependency IDs if being updated
		if (params.dependsOn !== undefined) {
			await this.validateDependencyIds(params.dependsOn, taskId);
		}

		// Strip status from the update params so the repo call is clean
		const { status: _status, ...repoParams } = params;
		const updated = this.taskRepo.updateTask(taskId, repoParams);
		if (!updated) {
			throw new Error(`Failed to update task: ${taskId}`);
		}

		return updated;
	}

	/**
	 * Retry a failed, cancelled, or done task.
	 * Done/cancelled tasks are reactivated to in_progress; blocked tasks reset to open.
	 * Optionally updates the description on retry.
	 *
	 * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
	 */
	async retryTask(taskId: string, options?: { description?: string }): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const retryableStatuses: SpaceTaskStatus[] = ['blocked', 'cancelled', 'done'];
		if (!retryableStatuses.includes(task.status)) {
			throw new Error(
				`Cannot retry task in '${task.status}' status. Task must be in 'blocked', 'cancelled', or 'done' status.`
			);
		}

		// Transition to in_progress for done/cancelled (reactivation), open for blocked
		const targetStatus: SpaceTaskStatus =
			task.status === 'done' || task.status === 'cancelled' ? 'in_progress' : 'open';
		// Transition first — if this fails, the description is untouched (no partial state)
		const retried = await this.setTaskStatus(taskId, targetStatus);

		// Apply optional description update after successful status transition
		if (options?.description !== undefined) {
			return this.updateTask(taskId, { description: options.description });
		}

		return retried;
	}

	/**
	 * Reassign a task to a different agent.
	 * Only allowed for tasks in 'open', 'blocked', 'cancelled', or 'done' status.
	 *
	 * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
	 * TODO: Update callers to use new status values — customAgentId/assignedAgent fields removed.
	 */
	async reassignTask(
		taskId: string,
		_customAgentId?: string | null,
		_assignedAgent?: string
	): Promise<SpaceTask> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const allowedStatuses: SpaceTaskStatus[] = ['open', 'blocked', 'cancelled', 'done'];
		if (!allowedStatuses.includes(task.status)) {
			throw new Error(
				`Cannot reassign task in '${task.status}' status. Task must be in 'open', 'blocked', 'cancelled', or 'done' status.`
			);
		}

		// Agent assignment fields removed from SpaceTask — return task unchanged
		return task;
	}

	/**
	 * Check if all dependencies for a task are met (completed)
	 */
	async areDependenciesMet(task: SpaceTask): Promise<boolean> {
		if (!task.dependsOn || task.dependsOn.length === 0) {
			return true;
		}

		for (const depId of task.dependsOn) {
			const dep = await this.getTask(depId);
			if (!dep || dep.status !== 'done') {
				return false;
			}
		}

		return true;
	}

	/**
	 * Block all open tasks that depend on the given task with 'dependency_failed'.
	 * Recurses: if task B depends on A and task C depends on B, blocking A
	 * cascades to both B and C.
	 */
	async blockDependentTasks(taskId: string): Promise<SpaceTask[]> {
		return this.doBlockCascade(taskId, []);
	}

	private async doBlockCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
		const openTasks = await this.listTasksByStatus('open');
		for (const t of openTasks) {
			// Skip tasks already blocked by a prior recursive path in this cascade
			if (acc.some((a) => a.id === t.id)) continue;
			if (t.dependsOn?.includes(taskId)) {
				const blocked = await this.setTaskStatus(t.id, 'blocked', {
					blockReason: 'dependency_failed',
					result: `Dependency task ${taskId} failed or was cancelled`,
				});
				acc.push(blocked);
				await this.doBlockCascade(t.id, acc);
			}
		}
		return acc;
	}

	/**
	 * Validate that dependency IDs exist in this space and don't create cycles.
	 * @param depIds - dependency task IDs to validate
	 * @param taskId - the task being created/updated (omit for new tasks)
	 */
	private async validateDependencyIds(depIds: string[], taskId?: string): Promise<void> {
		for (const depId of depIds) {
			if (taskId && depId === taskId) {
				throw new Error('A task cannot depend on itself');
			}
			const dep = await this.getTask(depId);
			if (!dep) {
				throw new Error(`Dependency task not found in space: ${depId}`);
			}
		}

		// Cycle detection: build adjacency from existing tasks + proposed deps
		if (taskId && depIds.length > 0) {
			const allTasks = await this.listTasks(true);
			const adj = new Map<string, string[]>();
			for (const t of allTasks) {
				if (t.id === taskId) {
					adj.set(t.id, [...depIds]); // use proposed deps
				} else {
					adj.set(t.id, [...(t.dependsOn ?? [])]);
				}
			}
			if (this.hasCycle(adj)) {
				throw new Error('Adding these dependencies would create a circular dependency');
			}
		}
	}

	/**
	 * DFS cycle detection on a directed graph.
	 * Returns true if any cycle exists.
	 */
	private hasCycle(adj: Map<string, string[]>): boolean {
		const WHITE = 0;
		const GRAY = 1;
		const BLACK = 2;
		const color = new Map<string, number>();
		for (const id of adj.keys()) {
			color.set(id, WHITE);
		}

		const dfs = (node: string): boolean => {
			color.set(node, GRAY);
			for (const neighbor of adj.get(node) ?? []) {
				const c = color.get(neighbor);
				if (c === GRAY) return true; // back edge → cycle
				if (c === WHITE && dfs(neighbor)) return true;
			}
			color.set(node, BLACK);
			return false;
		};

		for (const id of adj.keys()) {
			if (color.get(id) === WHITE && dfs(id)) return true;
		}
		return false;
	}
}
