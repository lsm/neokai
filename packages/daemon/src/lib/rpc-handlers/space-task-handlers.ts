/**
 * Space Task RPC Handlers
 *
 * RPC handlers for SpaceTask CRUD operations:
 * - spaceTask.create - Create a task in a Space
 * - spaceTask.list   - List tasks in a Space
 * - spaceTask.get    - Get a task by ID
 * - spaceTask.update - Update task fields (metadata and status with transition validation)
 */

import type { MessageHub } from '@neokai/shared';
import type { CreateSpaceTaskParams, UpdateSpaceTaskParams } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { Logger } from '../logger';

const log = new Logger('space-task-handlers');

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

		let task;

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
				// Intercept review → done when the task is paused at a completion action.
				// Instead of directly transitioning to done, resume the completion action
				// loop from pendingActionIndex — the loop determines the final status.
				if (
					spaceRuntimeService &&
					currentTask.status === 'review' &&
					updateParams.status === 'done' &&
					currentTask.pendingCheckpointType === 'completion_action'
				) {
					const resumed = await spaceRuntimeService.resumeCompletionActions(spaceId, taskId, {
						approvalReason: updateParams.approvalReason ?? null,
					});
					if (resumed) {
						task = resumed;
						// Status is excluded — the resume path already set the final status
						// (done / blocked / review). approvalReason has already been
						// persisted by the runtime on the terminal `done` transition, so
						// drop it here to avoid a redundant write. Forward any OTHER
						// caller-supplied fields (e.g. `result`, a corrected title) so
						// they land alongside the resumed task. The resume path emits
						// internally, so we only emit again when extra fields merged.
						const {
							status: _s,
							approvalReason: _ar,
							cancelReason: _cr,
							...otherFields
						} = updateParams;
						if (Object.keys(otherFields).length > 0) {
							task = await taskManager.updateTask(taskId, otherFields);
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
					}
					// null = state inconsistency (task deleted, workflow edited, race).
					// Throw rather than silently falling through to a raw setTaskStatus
					// that would bypass completion actions.
					throw new Error(
						`Cannot resume completion actions for task ${taskId} — ` +
							'task state is inconsistent (see daemon logs for details)'
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
						currentTask.status === 'review' && updateParams.status === 'done' ? 'human' : undefined,
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

		return task;
	});
}
