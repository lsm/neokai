/**
 * Job handler for taskSchedule.fire queue.
 *
 * When a schedule fires:
 *   1. Look up the schedule — skip if not 'active'.
 *   2. Create a SpaceTask using the template fields.
 *   3. If cron: compute nextRunAt, re-enqueue self, update schedule.
 *   4. If at: mark schedule 'completed'.
 *
 * Uses the self-scheduling pattern from github-poll.handler.ts.
 */

import { TASK_SCHEDULE_FIRE } from '../job-queue-constants';
import { Logger } from '../logger';
import { getNextRunAt } from '../space/schedule/cron-utils';
import type { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';

const log = new Logger('task-schedule-fire-handler');

export interface TaskScheduleFirePayload extends Record<string, unknown> {
	scheduleId: string;
}

export interface TaskScheduleFireResult extends Record<string, unknown> {
	scheduleId: string;
	taskId: string | null;
	skipped: boolean;
	nextRunAt: number | null;
}

export interface TaskScheduleFireHandlerDeps {
	scheduleRepo: TaskScheduleRepository;
	jobQueue: JobQueueRepository;
	/** Factory that returns a SpaceTaskManager bound to a given spaceId. */
	taskManagerFactory: (spaceId: string) => SpaceTaskManager;
}

export async function handleTaskScheduleFire(
	payload: TaskScheduleFirePayload,
	deps: TaskScheduleFireHandlerDeps
): Promise<TaskScheduleFireResult> {
	const { scheduleId } = payload;
	const { scheduleRepo, jobQueue, taskManagerFactory } = deps;

	const schedule = scheduleRepo.getById(scheduleId);

	// Guard: skip if schedule doesn't exist or is no longer active.
	if (!schedule || schedule.status !== 'active') {
		log.debug('task-schedule-fire: skipping inactive/missing schedule', { scheduleId });
		return { scheduleId, taskId: null, skipped: true, nextRunAt: null };
	}

	// 1. Create the SpaceTask from the template.
	let taskId: string | null = null;
	try {
		const taskManager = taskManagerFactory(schedule.spaceId);
		const task = await taskManager.createTask({
			title: schedule.title,
			description: schedule.description,
			priority: schedule.priority,
			preferredWorkflowId: schedule.preferredWorkflowId,
			labels: schedule.labels,
			createdByTaskScheduleId: schedule.id,
		});
		taskId = task.id;
		log.debug('task-schedule-fire: created task', { scheduleId, taskId });
	} catch (err) {
		log.error('task-schedule-fire: failed to create task', {
			scheduleId,
			error: err instanceof Error ? err.message : err,
		});
		// Re-throw so the job queue can retry with backoff.
		throw err;
	}

	const now = Date.now();

	// 2. Reschedule (cron) or complete (at).
	if (schedule.triggerType === 'cron' && schedule.cronExpression) {
		const nextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone, now);

		let pendingJobId: string | null = null;
		if (nextRunAt !== null) {
			const nextJob = jobQueue.enqueue({
				queue: TASK_SCHEDULE_FIRE,
				payload: { scheduleId } satisfies TaskScheduleFirePayload,
				runAt: nextRunAt,
			});
			pendingJobId = nextJob.id;
		}

		scheduleRepo.updateAfterFire(scheduleId, {
			lastCreatedTaskId: taskId!,
			lastRunAt: now,
			nextRunAt: nextRunAt ?? null,
			status: 'active',
			pendingJobId,
		});

		return { scheduleId, taskId, skipped: false, nextRunAt };
	}

	// One-shot ('at'): mark as completed.
	scheduleRepo.updateAfterFire(scheduleId, {
		lastCreatedTaskId: taskId!,
		lastRunAt: now,
		nextRunAt: null,
		status: 'completed',
		pendingJobId: null,
	});

	return { scheduleId, taskId, skipped: false, nextRunAt: null };
}
