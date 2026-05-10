/**
 * Job handler for taskSchedule.fire queue.
 *
 * When a schedule fires:
 *   1. Look up the schedule — skip if not 'active', missing, or its host space
 *      is archived/missing.
 *   2. Idempotency check — skip if `schedule.pendingJobId` no longer matches
 *      this job (a previous attempt already advanced the schedule).
 *   3. Atomically: create a SpaceTask, compute the next fire time, enqueue the
 *      next fire job (cron) and write all of `lastCreatedTaskId`, `lastRunAt`,
 *      `nextRunAt`, `pendingJobId`, `status` in one SQLite transaction. If any
 *      step throws, the rollback ensures we never leave a half-fired schedule
 *      (e.g. task created but pendingJobId not advanced) — the queue's retry
 *      will then re-run the handler cleanly.
 *
 * Uses the self-scheduling pattern from github-poll.handler.ts.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { TASK_SCHEDULE_FIRE } from '../job-queue-constants';
import { Logger } from '../logger';
import { getNextRunAt } from '../space/schedule/cron-utils';
import type { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';

const log = new Logger('task-schedule-fire-handler');

export interface TaskScheduleFirePayload extends Record<string, unknown> {
	scheduleId: string;
}

export interface TaskScheduleFireResult extends Record<string, unknown> {
	scheduleId: string;
	taskId: string | null;
	skipped: boolean;
	skipReason?: string;
	nextRunAt: number | null;
}

export interface TaskScheduleFireHandlerDeps {
	db: BunDatabase;
	scheduleRepo: TaskScheduleRepository;
	jobQueue: JobQueueRepository;
	spaceRepo: SpaceRepository;
	taskRepo: SpaceTaskRepository;
}

export async function handleTaskScheduleFire(
	job: Job,
	deps: TaskScheduleFireHandlerDeps
): Promise<TaskScheduleFireResult> {
	const { scheduleId } = job.payload as TaskScheduleFirePayload;
	const { db, scheduleRepo, jobQueue, spaceRepo, taskRepo } = deps;

	const schedule = scheduleRepo.getById(scheduleId);

	// Guard: skip if schedule doesn't exist or is no longer active.
	if (!schedule || schedule.status !== 'active') {
		log.debug('task-schedule-fire: skipping inactive/missing schedule', { scheduleId });
		return {
			scheduleId,
			taskId: null,
			skipped: true,
			skipReason: 'inactive_or_missing',
			nextRunAt: null,
		};
	}

	// Guard: skip if the host space is archived or missing. Without this an
	// archived space would still spawn fresh tasks every cron tick.
	const space = spaceRepo.getSpace(schedule.spaceId);
	if (!space || space.status !== 'active') {
		log.debug('task-schedule-fire: skipping schedule for non-active space', {
			scheduleId,
			spaceId: schedule.spaceId,
			spaceStatus: space?.status,
		});
		return {
			scheduleId,
			taskId: null,
			skipped: true,
			skipReason: 'space_not_active',
			nextRunAt: null,
		};
	}

	// Idempotency fence: if `pendingJobId` no longer matches this job's id, a
	// previous successful attempt already advanced the schedule (and recorded
	// the task) — re-running here would create a duplicate. This catches the
	// case where a transient post-success error caused the queue to retry, or
	// where startup recovery re-seeded a job we ended up running too.
	if (schedule.pendingJobId !== null && schedule.pendingJobId !== job.id) {
		log.debug('task-schedule-fire: skipping — pendingJobId moved past this job', {
			scheduleId,
			jobId: job.id,
			currentPendingJobId: schedule.pendingJobId,
		});
		return {
			scheduleId,
			taskId: schedule.lastCreatedTaskId,
			skipped: true,
			skipReason: 'job_superseded',
			nextRunAt: schedule.nextRunAt,
		};
	}

	const now = Date.now();

	// Atomically create the task, compute the next fire, enqueue it, and update
	// the schedule's bookkeeping fields. SpaceTaskRepository.createTask already
	// runs synchronously against `db`, so wrapping the whole sequence in a
	// single SQLite transaction is safe — and crucial: a partial failure (e.g.
	// task inserted but no `lastRunAt` recorded) would otherwise allow the
	// retry to spawn a duplicate task.
	let taskId: string | null = null;
	let nextRunAt: number | null = null;

	try {
		const result = db.transaction(() => {
			const task = taskRepo.createTask({
				spaceId: schedule.spaceId,
				title: schedule.title,
				description: schedule.description,
				priority: schedule.priority,
				preferredWorkflowId: schedule.preferredWorkflowId,
				labels: schedule.labels,
				createdByTaskScheduleId: schedule.id,
			});

			let computedNextRunAt: number | null = null;
			let pendingJobId: string | null = null;
			let nextStatus: 'active' | 'completed' = 'completed';

			if (schedule.triggerType === 'cron' && schedule.cronExpression) {
				computedNextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone, now);

				if (computedNextRunAt !== null) {
					const nextJob = jobQueue.enqueue({
						queue: TASK_SCHEDULE_FIRE,
						payload: { scheduleId } satisfies TaskScheduleFirePayload,
						runAt: computedNextRunAt,
					});
					pendingJobId = nextJob.id;
					nextStatus = 'active';
				}
			}

			scheduleRepo.updateAfterFire(scheduleId, {
				lastCreatedTaskId: task.id,
				lastRunAt: now,
				nextRunAt: computedNextRunAt,
				status: nextStatus,
				pendingJobId,
			});

			return { taskId: task.id, nextRunAt: computedNextRunAt };
		})();

		taskId = result.taskId;
		nextRunAt = result.nextRunAt;
		log.debug('task-schedule-fire: created task', { scheduleId, taskId, nextRunAt });
	} catch (err) {
		log.error('task-schedule-fire: transaction failed', {
			scheduleId,
			error: err instanceof Error ? err.message : err,
		});
		// Re-throw so the job queue retries with backoff. The transaction
		// rolled back so no half-state was persisted; the next attempt sees
		// the same `pendingJobId === job.id` and proceeds cleanly.
		throw err;
	}

	if (taskId === null) {
		// Defensive: the transaction body always assigns taskId on the success path.
		throw new Error(`task-schedule-fire: taskId unexpectedly null for ${scheduleId}`);
	}

	return { scheduleId, taskId, skipped: false, nextRunAt };
}
