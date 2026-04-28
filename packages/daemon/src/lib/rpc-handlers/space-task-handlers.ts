/**
 * Space Task RPC Handlers
 *
 * RPC handlers for SpaceTask CRUD operations:
 * - spaceTask.create - Create a task in a Space
 * - spaceTask.list   - List tasks in a Space
 * - spaceTask.get    - Get a task by ID
 * - spaceTask.update - Update task fields (metadata and status with transition validation)
 */

import type {
	CreateSpaceTaskParams,
	MessageHub,
	SpaceTask,
	SpaceTaskStatus,
	UpdateSpaceTaskParams,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import { Logger } from '../logger';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';

const log = new Logger('space-task-handlers');

function isWorkflowRecoveryTransition(
	from: SpaceTaskStatus,
	to: SpaceTaskStatus
): to is 'open' | 'in_progress' {
	return (
		(from === 'done' || from === 'blocked' || from === 'cancelled') &&
		(to === 'open' || to === 'in_progress')
	);
}

/**
 * Factory that creates a SpaceTaskManager bound to a specific spaceId.
 * Injected so tests can substitute a mock manager.
 */
export type SpaceTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceTaskHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	taskManagerFactory: SpaceTaskManagerFactory,
	daemonHub: DaemonHub,
	spaceRuntimeService?: SpaceRuntimeService
): void {
	// ─── spaceTask.create ───────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.create', async (data) => {
		const params = data as CreateSpaceTaskParams;

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.title || params.title.trim() === '') {
			throw new Error('title is required');
		}
		// description is required but may be an empty string — reject only null/undefined
		if (params.description === undefined || params.description === null) {
			throw new Error('description must not be null');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		const { spaceId, ...rest } = params;
		const task = await taskManager.createTask(rest);

		daemonHub
			.emit('space.task.created', {
				sessionId: 'global',
				spaceId,
				taskId: task.id,
				task,
			})
			.catch((err) => {
				log.warn('Failed to emit space.task.created:', err);
			});

		return task;
	});

	// ─── spaceTask.list ─────────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.list', async (data) => {
		const params = data as { spaceId: string; includeArchived?: boolean };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		return taskManager.listTasks(params.includeArchived ?? false);
	});

	// ─── spaceTask.get ──────────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.get', async (data) => {
		const params = data as { spaceId: string; taskId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		// Verify space exists (consistent with create/list validation pattern)
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		const task = await taskManager.getTask(params.taskId);
		if (!task) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		return task;
	});

	// ─── spaceTask.update ───────────────────────────────────────────────────────
	messageHub.onRequest('spaceTask.update', async (data) => {
		const params = data as { spaceId: string; taskId: string } & UpdateSpaceTaskParams;

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.taskId) {
			throw new Error('taskId is required');
		}

		const { spaceId, taskId, ...updateParams } = params;

		// Verify space exists — consistent with create/list/get validation.
		// Without this check, a bad spaceId would surface as "Task not found" rather
		// than "Space not found", which is misleading.
		const space = await spaceManager.getSpace(spaceId);
		if (!space) {
			throw new Error(`Space not found: ${spaceId}`);
		}

		const taskManager = taskManagerFactory(spaceId);

		let task: SpaceTask;
		let emitTaskUpdated = true;

		// Route to setTaskStatus only when the status is actually changing.
		// Sending the current status as part of a broader metadata update must not
		// trigger a transition check (same→same is not in the transition table and
		// would throw a misleading "Invalid status transition" error).
		if (updateParams.status !== undefined) {
			// Fetch the current task to compare status before routing
			const currentTask = await taskManager.getTask(taskId);
			if (!currentTask) {
				throw new Error(`Task not found: ${taskId}`);
			}

			if (updateParams.status !== currentTask.status) {
				if (
					currentTask.workflowRunId &&
					isWorkflowRecoveryTransition(currentTask.status, updateParams.status)
				) {
					if (!spaceRuntimeService) {
						throw new Error(
							`Cannot recover workflow-backed task ${taskId}: SpaceRuntimeService is unavailable.`
						);
					}
					task = await spaceRuntimeService.recoverWorkflowBackedTask(
						spaceId,
						taskId,
						updateParams.status
					);
					emitTaskUpdated = false;

					const {
						status: _s,
						result: _r,
						approvalReason: _ar,
						cancelReason: _cr,
						...otherFields
					} = updateParams;
					if (Object.keys(otherFields).length > 0) {
						task = await taskManager.updateTask(taskId, otherFields);
						emitTaskUpdated = true;
					}
				} else {
					// Reject bare transitions into `review`. Every task that lands in
					// `review` MUST carry the pending-completion fields so
					// `PendingTaskCompletionBanner` renders and approvals route through
					// `PostApprovalRouter`. Callers must use `spaceTask.submitForReview`
					// (UI) or the agent `submit_for_approval` tool — both go through
					// `SpaceTaskManager.submitTaskForReview` which writes the metadata
					// atomically. Without this guard a stray `update({status:'review'})`
					// would re-introduce the banner-less generic-button flow.
					if (updateParams.status === 'review') {
						throw new Error(
							`spaceTask.update cannot transition a task into 'review' directly. ` +
								`Use spaceTask.submitForReview (or the agent submit_for_approval tool) ` +
								`so the pending-completion fields get stamped and the approval banner renders.`
						);
					}
					// Reject bare transitions into `approved`. The `approved` status
					// is owned by the post-approval pipeline:
					//   - human approvals → `spaceTask.approvePendingCompletion`,
					//     which dispatches `PostApprovalRouter` (it calls
					//     `setTaskStatus(approved)` with the right metadata).
					//   - agent approvals → the runtime's reactive
					//     `reportedStatus='done'` handler, again routing through
					//     `PostApprovalRouter`.
					// A bare `update({status:'approved'})` would skip the awareness
					// event, the post-approval dispatch, and the approval-source
					// stamping — the same kind of gap the `→ review` guard above
					// closes on the entry side.
					if (updateParams.status === 'approved') {
						throw new Error(
							`spaceTask.update cannot transition a task into 'approved' directly. ` +
								`Use spaceTask.approvePendingCompletion (UI Approve banner) or let the ` +
								`runtime's post-approval router handle the transition — both stamp the ` +
								`approval metadata and dispatch the configured post-approval step.`
						);
					}
					// Status is changing — validate via setTaskStatus (enforces transitions).
					// `approvalReason` is stamped on review→done; `cancelReason` is
					// persisted into the same underlying column for review→cancelled
					// transitions (and other terminal rejections). We map both onto the
					// manager's `approvalReason` option because the DB schema keeps a
					// single `approval_reason` column doubling as audit trail for
					// approvals *and* rejections.
					const mappedReason =
						updateParams.status === 'cancelled'
							? (updateParams.cancelReason ?? updateParams.approvalReason ?? undefined)
							: (updateParams.approvalReason ?? undefined);

					task = await taskManager.setTaskStatus(taskId, updateParams.status, {
						result: updateParams.result ?? undefined,
						// Human-initiated approval when transitioning from review → done
						approvalSource:
							currentTask.status === 'review' && updateParams.status === 'done'
								? 'human'
								: undefined,
						approvalReason: mappedReason,
					});

					// When the transition alone cannot carry the rejection reason (e.g.
					// review → cancelled — setTaskStatus only stamps approvalReason on
					// review→done), apply it in a follow-up write. Keeps the audit trail
					// complete regardless of direction.
					if (
						updateParams.status === 'cancelled' &&
						(updateParams.cancelReason ?? updateParams.approvalReason)
					) {
						task = await taskManager.updateTask(taskId, {
							approvalReason: updateParams.cancelReason ?? updateParams.approvalReason ?? null,
						});
					}

					// When a status transition is combined with other field updates
					// (e.g. taskAgentSessionId), those fields are silently dropped by
					// setTaskStatus. Apply them in a follow-up updateTask call so
					// callers can atomically set status + metadata in one RPC.
					const {
						status: _s,
						result: _r,
						approvalReason: _ar,
						cancelReason: _cr,
						...otherFields
					} = updateParams;
					if (Object.keys(otherFields).length > 0) {
						task = await taskManager.updateTask(taskId, otherFields);
					}
				}
			} else {
				// Status is the same — treat as a regular field update.
				// updateParams still contains the unchanged status field; SpaceTaskManager.updateTask
				// strips it internally (guard: params.status !== task.status is false) so no
				// transition check fires and the status column is left untouched in the DB.
				task = await taskManager.updateTask(taskId, updateParams);
			}
		} else {
			// No status field — general field update
			task = await taskManager.updateTask(taskId, updateParams);
		}

		if (emitTaskUpdated) {
			daemonHub
				.emit('space.task.updated', {
					sessionId: 'global',
					spaceId,
					taskId,
					task,
				})
				.catch((err) => {
					log.warn('Failed to emit space.task.updated:', err);
				});
		}

		return task;
	});

	// ─── spaceTask.recoverWorkflow ────────────────────────────────────────────
	messageHub.onRequest('spaceTask.recoverWorkflow', async (data) => {
		const params = data as {
			spaceId: string;
			taskId: string;
			status: 'open' | 'in_progress';
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.taskId) throw new Error('taskId is required');
		if (params.status !== 'open' && params.status !== 'in_progress') {
			throw new Error(`status must be 'open' or 'in_progress'`);
		}
		if (!spaceRuntimeService) {
			throw new Error(
				`Cannot recover workflow-backed task ${params.taskId}: SpaceRuntimeService is unavailable.`
			);
		}

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		return spaceRuntimeService.recoverWorkflowBackedTask(
			params.spaceId,
			params.taskId,
			params.status
		);
	});

	// ─── spaceTask.submitForReview ──────────────────────────────────────────────
	// User-initiated counterpart to the agent `submit_for_approval` tool. Both
	// paths converge on `SpaceTaskManager.submitTaskForReview`, which atomically
	// transitions the task into `review` and stamps the pending-completion
	// fields that drive `PendingTaskCompletionBanner`. Without this RPC the UI
	// "Submit for Review" button degraded to a bare status update — landing the
	// task in `review` with no banner, no metadata, and a generic Approve button
	// that bypassed `PostApprovalRouter`. After unification, every task in
	// `review` is banner-eligible regardless of who submitted it.
	//
	// `pendingCompletionSubmittedByNodeId` is set to `null` for user-initiated
	// submissions — same semantics as a Task Agent self-submit. The post-
	// approval router treats both identically (no waiting end-node session to
	// resume; awareness events are best-effort).
	messageHub.onRequest('spaceTask.submitForReview', async (data) => {
		const params = data as {
			spaceId: string;
			taskId: string;
			reason?: string | null;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.taskId) throw new Error('taskId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		const task = await taskManager.submitTaskForReview(params.taskId, {
			submittedByNodeId: null,
			reason: params.reason ?? null,
		});

		daemonHub
			.emit('space.task.updated', {
				sessionId: 'global',
				spaceId: params.spaceId,
				taskId: params.taskId,
				task,
			})
			.catch((err) => {
				log.warn('Failed to emit space.task.updated:', err);
			});

		return task;
	});

	// ─── spaceTask.approvePendingCompletion ─────────────────────────────────────
	// Design v2 (Task #39): human approval / rejection for tasks paused at a
	// `submit_for_approval` checkpoint (`pendingCheckpointType === 'task_completion'`).
	//
	// - `approved: true`  → transitions the task review → done, stamps approval
	//   metadata, clears pending-completion fields, and fires `space.task.updated`.
	// - `approved: false` → transitions the task back to in_progress so the end-node
	//   agent can revise its output; clears pending-completion fields. The optional
	//   `reason` is written to `approvalReason` as a rejection rationale.
	//
	// The handler refuses to operate on tasks that are not paused at a
	// `task_completion` checkpoint to avoid accidentally closing in-flight work.
	messageHub.onRequest('spaceTask.approvePendingCompletion', async (data) => {
		const params = data as {
			spaceId: string;
			taskId: string;
			approved: boolean;
			reason?: string | null;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.taskId) throw new Error('taskId is required');
		if (typeof params.approved !== 'boolean') throw new Error('approved must be a boolean');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const taskManager = taskManagerFactory(params.spaceId);
		const currentTask = await taskManager.getTask(params.taskId);
		if (!currentTask) {
			throw new Error(`Task not found: ${params.taskId}`);
		}

		if (currentTask.pendingCheckpointType !== 'task_completion') {
			throw new Error(
				`Task ${params.taskId} is not awaiting submit_for_approval review ` +
					`(pendingCheckpointType=${currentTask.pendingCheckpointType ?? 'null'}).`
			);
		}

		if (currentTask.status !== 'review') {
			throw new Error(
				`Task ${params.taskId} is not in 'review' status ` + `(current: ${currentTask.status}).`
			);
		}

		let task: SpaceTask;
		if (params.approved) {
			if (!spaceRuntimeService) {
				throw new Error(
					'spaceRuntimeService is required to approve pending completion — post-approval routing is the sole approval path.'
				);
			}
			// Delegate to the PostApprovalRouter. It transitions review → approved
			// (via SpaceTaskManager.setTaskStatus), emits [TASK_APPROVED], and
			// dispatches the configured post-approval step (no-route → done,
			// inline Task Agent, or spawn fresh node-agent).
			//
			// The router's review→approved `setTaskStatus` call carries both
			// concerns in a single SQL UPDATE: it stamps `approvalReason`
			// (from `contextExtras`) and the centralised "exit review" cleanup
			// nulls the pending-completion fields. No pre-call cleanup is
			// needed — what used to be a 3-write sequence (clear + flip + ack)
			// collapses into one atomic write inside the router.
			await spaceRuntimeService.dispatchPostApproval(params.spaceId, params.taskId, 'human', {
				approvalReason: params.reason ?? null,
			});
			// Re-read the task so the caller sees the post-router state.
			const refreshed = await taskManager.getTask(params.taskId);
			if (!refreshed) throw new Error(`Task not found: ${params.taskId}`);
			task = refreshed;
		} else {
			// review → in_progress (reject). Reason captured as `approvalReason`
			// for audit. `setTaskStatus` nulls the pending-completion fields in
			// the same UPDATE (centralised "exit review" cleanup), so the
			// follow-up `updateTask` only stamps the rejection reason.
			task = await taskManager.setTaskStatus(params.taskId, 'in_progress');
			task = await taskManager.updateTask(params.taskId, {
				approvalReason: params.reason ?? null,
			});
		}

		daemonHub
			.emit('space.task.updated', {
				sessionId: 'global',
				spaceId: params.spaceId,
				taskId: params.taskId,
				task,
			})
			.catch((err) => {
				log.warn('Failed to emit space.task.updated:', err);
			});

		return task;
	});
}
