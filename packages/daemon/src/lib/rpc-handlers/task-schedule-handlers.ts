/**
 * Task Schedule RPC Handlers
 *
 * Exposes CRUD operations for TaskSchedule over the MessageHub:
 *   taskSchedule.create  — create schedule + enqueue first job
 *   taskSchedule.list    — list schedules for a space
 *   taskSchedule.get     — get schedule by id
 *   taskSchedule.update  — edit template/cron (cancel old job, enqueue new)
 *   taskSchedule.pause   — cancel pending job, set paused
 *   taskSchedule.resume  — re-enqueue, set active
 *   taskSchedule.delete  — cancel pending job + delete schedule row
 */

import type { MessageHub } from '@neokai/shared';
import type {
	TaskScheduleStatus,
	TaskScheduleTriggerType,
	SpaceTaskPriority,
} from '@neokai/shared';
import { Logger } from '../logger';
import { isValidCronExpression, getNextRunAt } from '../space/schedule/cron-utils';
import { TASK_SCHEDULE_FIRE } from '../job-queue-constants';
import type { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { SpaceManager } from '../space/managers/space-manager';
import type { TaskScheduleFirePayload } from '../job-handlers/task-schedule-fire.handler';

const log = new Logger('task-schedule-handlers');

export interface TaskScheduleHandlerDeps {
	scheduleRepo: TaskScheduleRepository;
	jobQueue: JobQueueRepository;
	spaceManager: SpaceManager;
}

export function setupTaskScheduleHandlers(
	messageHub: MessageHub,
	deps: TaskScheduleHandlerDeps
): void {
	const { scheduleRepo, jobQueue, spaceManager } = deps;

	// ─── taskSchedule.create ───────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.create', async (data) => {
		const params = data as {
			spaceId: string;
			title: string;
			description?: string;
			priority?: SpaceTaskPriority;
			preferredWorkflowId?: string | null;
			labels?: string[];
			triggerType: TaskScheduleTriggerType;
			cronExpression?: string | null;
			runAt?: number | null;
			timezone?: string;
			createdByAgent?: string | null;
			createdBySession?: string | null;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.title?.trim()) throw new Error('title is required');
		if (!params.triggerType) throw new Error('triggerType is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		// Validate trigger config.
		if (params.triggerType === 'cron') {
			if (!params.cronExpression) throw new Error('cronExpression is required for cron triggers');
			if (!isValidCronExpression(params.cronExpression)) {
				throw new Error(`Invalid cron expression: ${params.cronExpression}`);
			}
		} else if (params.triggerType === 'at') {
			if (!params.runAt) throw new Error('runAt is required for at triggers');
			if (params.runAt < Date.now()) throw new Error('runAt must be in the future');
		}

		// Compute first nextRunAt.
		const tz = params.timezone ?? 'UTC';
		let nextRunAt: number | null;
		if (params.triggerType === 'cron') {
			nextRunAt = getNextRunAt(params.cronExpression!, tz);
		} else {
			nextRunAt = params.runAt!;
		}

		if (nextRunAt === null) {
			throw new Error('Could not compute next run time from the provided expression');
		}

		// Create the schedule row.
		const schedule = scheduleRepo.create({
			spaceId: params.spaceId,
			title: params.title,
			description: params.description,
			priority: params.priority,
			preferredWorkflowId: params.preferredWorkflowId,
			labels: params.labels,
			triggerType: params.triggerType,
			cronExpression: params.cronExpression,
			runAt: params.runAt,
			timezone: tz,
			nextRunAt,
			createdByAgent: params.createdByAgent,
			createdBySession: params.createdBySession,
		});

		// Enqueue the first job.
		const job = jobQueue.enqueue({
			queue: TASK_SCHEDULE_FIRE,
			payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
			runAt: nextRunAt,
		});

		// Store the pending job ID on the schedule.
		scheduleRepo.updatePendingJobId(schedule.id, job.id);
		const updated = scheduleRepo.getById(schedule.id);

		log.debug('taskSchedule.create', { scheduleId: schedule.id, nextRunAt, jobId: job.id });
		return { schedule: updated };
	});

	// ─── taskSchedule.list ─────────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.list', async (data) => {
		const params = data as { spaceId: string; status?: TaskScheduleStatus };
		if (!params.spaceId) throw new Error('spaceId is required');

		const schedules = scheduleRepo.listBySpace(params.spaceId, params.status);
		return { schedules };
	});

	// ─── taskSchedule.get ──────────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.get', async (data) => {
		const params = data as { scheduleId: string };
		if (!params.scheduleId) throw new Error('scheduleId is required');

		const schedule = scheduleRepo.getById(params.scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${params.scheduleId}`);
		return { schedule };
	});

	// ─── taskSchedule.update ───────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.update', async (data) => {
		const params = data as {
			scheduleId: string;
			title?: string;
			description?: string;
			priority?: SpaceTaskPriority;
			preferredWorkflowId?: string | null;
			labels?: string[];
			cronExpression?: string | null;
			runAt?: number | null;
			timezone?: string;
		};

		if (!params.scheduleId) throw new Error('scheduleId is required');

		const schedule = scheduleRepo.getById(params.scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${params.scheduleId}`);

		// If updating cron or runAt, validate.
		if (params.cronExpression !== undefined && params.cronExpression !== null) {
			if (!isValidCronExpression(params.cronExpression)) {
				throw new Error(`Invalid cron expression: ${params.cronExpression}`);
			}
		}
		if (params.runAt !== undefined && params.runAt !== null) {
			if (params.runAt < Date.now()) throw new Error('runAt must be in the future');
		}

		// Apply the update.
		scheduleRepo.update(params.scheduleId, {
			title: params.title,
			description: params.description,
			priority: params.priority,
			preferredWorkflowId: params.preferredWorkflowId,
			labels: params.labels,
			cronExpression: params.cronExpression,
			runAt: params.runAt,
			timezone: params.timezone,
		});

		// If the schedule is active and timing changed, cancel the old job and re-enqueue.
		const updatedSchedule = scheduleRepo.getById(params.scheduleId)!;
		const timingChanged =
			params.cronExpression !== undefined ||
			params.runAt !== undefined ||
			params.timezone !== undefined;

		if (updatedSchedule.status === 'active' && timingChanged) {
			// Cancel the old pending job if present.
			if (updatedSchedule.pendingJobId) {
				jobQueue.deleteJob(updatedSchedule.pendingJobId);
			}

			const tz = updatedSchedule.timezone;
			let nextRunAt: number | null;
			if (updatedSchedule.triggerType === 'cron' && updatedSchedule.cronExpression) {
				nextRunAt = getNextRunAt(updatedSchedule.cronExpression, tz);
			} else if (updatedSchedule.triggerType === 'at' && updatedSchedule.runAt) {
				nextRunAt = updatedSchedule.runAt;
			} else {
				nextRunAt = null;
			}

			let pendingJobId: string | null = null;
			if (nextRunAt !== null) {
				const job = jobQueue.enqueue({
					queue: TASK_SCHEDULE_FIRE,
					payload: { scheduleId: params.scheduleId } satisfies TaskScheduleFirePayload,
					runAt: nextRunAt,
				});
				pendingJobId = job.id;
			}

			scheduleRepo.update(params.scheduleId, { nextRunAt: nextRunAt ?? undefined });
			scheduleRepo.updatePendingJobId(params.scheduleId, pendingJobId);
		}

		const final = scheduleRepo.getById(params.scheduleId);
		return { schedule: final };
	});

	// ─── taskSchedule.pause ────────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.pause', async (data) => {
		const params = data as { scheduleId: string };
		if (!params.scheduleId) throw new Error('scheduleId is required');

		const schedule = scheduleRepo.getById(params.scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${params.scheduleId}`);
		if (schedule.status !== 'active') {
			throw new Error(`Schedule is not active (current: ${schedule.status})`);
		}

		// Cancel the pending job.
		if (schedule.pendingJobId) {
			jobQueue.deleteJob(schedule.pendingJobId);
		}
		scheduleRepo.updatePendingJobId(params.scheduleId, null);
		scheduleRepo.updateStatus(params.scheduleId, 'paused');

		const updated = scheduleRepo.getById(params.scheduleId);
		return { schedule: updated };
	});

	// ─── taskSchedule.resume ───────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.resume', async (data) => {
		const params = data as { scheduleId: string };
		if (!params.scheduleId) throw new Error('scheduleId is required');

		const schedule = scheduleRepo.getById(params.scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${params.scheduleId}`);
		if (schedule.status !== 'paused') {
			throw new Error(`Schedule is not paused (current: ${schedule.status})`);
		}

		// Compute next run.
		const tz = schedule.timezone;
		let nextRunAt: number | null;
		if (schedule.triggerType === 'cron' && schedule.cronExpression) {
			nextRunAt = getNextRunAt(schedule.cronExpression, tz);
		} else if (schedule.triggerType === 'at' && schedule.runAt) {
			nextRunAt = schedule.runAt < Date.now() ? null : schedule.runAt;
		} else {
			nextRunAt = null;
		}

		// If nextRunAt is null for an 'at' trigger that already passed, mark completed.
		if (nextRunAt === null && schedule.triggerType === 'at') {
			scheduleRepo.updateStatus(params.scheduleId, 'completed');
			const updated = scheduleRepo.getById(params.scheduleId);
			return { schedule: updated };
		}

		let pendingJobId: string | null = null;
		if (nextRunAt !== null) {
			const job = jobQueue.enqueue({
				queue: TASK_SCHEDULE_FIRE,
				payload: { scheduleId: params.scheduleId } satisfies TaskScheduleFirePayload,
				runAt: nextRunAt,
			});
			pendingJobId = job.id;
		}

		scheduleRepo.update(params.scheduleId, { nextRunAt: nextRunAt ?? undefined });
		scheduleRepo.updatePendingJobId(params.scheduleId, pendingJobId);
		scheduleRepo.updateStatus(params.scheduleId, 'active');

		const updated = scheduleRepo.getById(params.scheduleId);
		return { schedule: updated };
	});

	// ─── taskSchedule.delete ───────────────────────────────────────────────────

	messageHub.onRequest('taskSchedule.delete', async (data) => {
		const params = data as { scheduleId: string };
		if (!params.scheduleId) throw new Error('scheduleId is required');

		const schedule = scheduleRepo.getById(params.scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${params.scheduleId}`);

		// Cancel the pending job.
		if (schedule.pendingJobId) {
			jobQueue.deleteJob(schedule.pendingJobId);
		}

		scheduleRepo.delete(params.scheduleId);
		log.debug('taskSchedule.delete', { scheduleId: params.scheduleId });
		return { success: true };
	});
}
