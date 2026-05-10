/**
 * ScheduleService — shared business logic for TaskSchedule lifecycle.
 *
 * Wraps the repository + job queue so that the validation, enqueue, and
 * pendingJobId bookkeeping happens in one place. Both the RPC handlers
 * (`task-schedule-handlers.ts`) and the agent MCP tools (`space-agent-tools.ts`)
 * call into this service so a bug fix or behavior change happens once.
 *
 * Atomicity: create + first enqueue + pending-job linkage run inside a single
 * SQLite transaction. If the enqueue throws (e.g. transient DB error), the
 * schedule row is rolled back so the caller never sees an `active` schedule
 * with no pending job.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	SpaceTaskPriority,
	TaskSchedule,
	TaskScheduleStatus,
	TaskScheduleTriggerType,
} from '@neokai/shared';
import type { TaskScheduleRepository } from '../../../storage/repositories/task-schedule-repository';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository';
import { getNextRunAt, isValidCronExpression } from './cron-utils';
import { TASK_SCHEDULE_FIRE } from '../../job-queue-constants';
import type { TaskScheduleFirePayload } from '../../job-handlers/task-schedule-fire.handler';

export interface CreateScheduleInput {
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
}

export interface UpdateScheduleInput {
	title?: string;
	description?: string;
	priority?: SpaceTaskPriority;
	preferredWorkflowId?: string | null;
	labels?: string[];
	cronExpression?: string | null;
	runAt?: number | null;
	timezone?: string;
}

export interface ScheduleServiceDeps {
	db: BunDatabase;
	scheduleRepo: TaskScheduleRepository;
	jobQueue: JobQueueRepository;
}

export class ScheduleService {
	constructor(private readonly deps: ScheduleServiceDeps) {}

	// ─── Validation helpers ──────────────────────────────────────────────────

	/**
	 * Validate trigger config for a CREATE — rejects missing/invalid cron and
	 * past `runAt`. Throws on validation failure so callers can return a clean
	 * error to the user.
	 */
	private validateCreateTrigger(input: CreateScheduleInput): void {
		if (!input.spaceId) throw new Error('spaceId is required');
		if (!input.title?.trim()) throw new Error('title is required');
		if (!input.triggerType) throw new Error('triggerType is required');

		if (input.triggerType === 'cron') {
			if (!input.cronExpression) throw new Error('cronExpression is required for cron triggers');
			if (!isValidCronExpression(input.cronExpression)) {
				throw new Error(`Invalid cron expression: ${input.cronExpression}`);
			}
		} else if (input.triggerType === 'at') {
			if (!input.runAt) throw new Error('runAt is required for at triggers');
			if (input.runAt < Date.now()) throw new Error('runAt must be in the future');
		}
	}

	/**
	 * Compute the first nextRunAt for a freshly-created schedule. Throws if the
	 * cron expression cannot produce a future run.
	 */
	private computeInitialNextRun(input: CreateScheduleInput, tz: string): number {
		let nextRunAt: number | null;
		if (input.triggerType === 'cron') {
			// validateCreateTrigger guarantees cronExpression is set + valid here.
			nextRunAt = getNextRunAt(input.cronExpression as string, tz);
		} else {
			nextRunAt = input.runAt as number;
		}
		if (nextRunAt === null) {
			throw new Error('Could not compute next run time from the provided expression');
		}
		return nextRunAt;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/**
	 * Create a schedule and enqueue its first fire job atomically.
	 *
	 * If enqueue fails (or any step after the schedule INSERT throws), the
	 * surrounding transaction rolls back, so callers either get a fully-wired
	 * schedule (row + job + pendingJobId) or a clean failure.
	 */
	createSchedule(input: CreateScheduleInput): TaskSchedule {
		this.validateCreateTrigger(input);

		const tz = input.timezone ?? 'UTC';
		const nextRunAt = this.computeInitialNextRun(input, tz);

		const { db, scheduleRepo, jobQueue } = this.deps;

		// Wrap create + enqueue + updatePendingJobId in a single SQLite
		// transaction so a failure in any step rolls back the schedule row.
		// `db.transaction(...)` returns a callable that runs the body atomically;
		// calling it `()` immediately executes inside a BEGIN/COMMIT.
		const scheduleId = db.transaction(() => {
			const schedule = scheduleRepo.create({
				spaceId: input.spaceId,
				title: input.title,
				description: input.description,
				priority: input.priority,
				preferredWorkflowId: input.preferredWorkflowId,
				labels: input.labels,
				triggerType: input.triggerType,
				cronExpression: input.cronExpression,
				runAt: input.runAt,
				timezone: tz,
				nextRunAt,
				createdByAgent: input.createdByAgent,
				createdBySession: input.createdBySession,
			});

			const job = jobQueue.enqueue({
				queue: TASK_SCHEDULE_FIRE,
				payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
				runAt: nextRunAt,
			});

			scheduleRepo.updatePendingJobId(schedule.id, job.id);
			return schedule.id;
		})();

		return scheduleRepo.getById(scheduleId) as TaskSchedule;
	}

	/**
	 * Update a schedule's template and/or trigger config.
	 *
	 * Rejects edits that would leave the schedule in an unfireable state — in
	 * particular, setting `cronExpression: null` on a `cron` schedule. If the
	 * timing fields change and the schedule is `active`, the existing pending
	 * job is cancelled and a fresh one enqueued.
	 */
	updateSchedule(scheduleId: string, input: UpdateScheduleInput): TaskSchedule {
		const { scheduleRepo, jobQueue } = this.deps;

		const existing = scheduleRepo.getById(scheduleId);
		if (!existing) throw new Error(`Schedule not found: ${scheduleId}`);

		// Trigger-config consistency: a `cron` schedule must always have a cron
		// expression. Setting it to `null` would orphan the schedule.
		if (
			existing.triggerType === 'cron' &&
			'cronExpression' in input &&
			input.cronExpression === null
		) {
			throw new Error(
				'Cannot clear cronExpression on a cron schedule. Delete and recreate, or change triggerType.'
			);
		}

		// Validate cron expression / runAt if supplied.
		if (input.cronExpression !== undefined && input.cronExpression !== null) {
			if (!isValidCronExpression(input.cronExpression)) {
				throw new Error(`Invalid cron expression: ${input.cronExpression}`);
			}
		}
		if (input.runAt !== undefined && input.runAt !== null) {
			if (input.runAt < Date.now()) throw new Error('runAt must be in the future');
		}

		// Apply field updates (does not touch pendingJobId / nextRunAt unless requested).
		scheduleRepo.update(scheduleId, {
			title: input.title,
			description: input.description,
			priority: input.priority,
			preferredWorkflowId: input.preferredWorkflowId,
			labels: input.labels,
			cronExpression: input.cronExpression,
			runAt: input.runAt,
			timezone: input.timezone,
		});

		const updated = scheduleRepo.getById(scheduleId) as TaskSchedule;

		// If timing changed and the schedule is active, reschedule.
		const timingChanged =
			input.cronExpression !== undefined ||
			input.runAt !== undefined ||
			input.timezone !== undefined;

		if (updated.status === 'active' && timingChanged) {
			if (updated.pendingJobId) jobQueue.deleteJob(updated.pendingJobId);

			const tz = updated.timezone;
			let nextRunAt: number | null;
			if (updated.triggerType === 'cron' && updated.cronExpression) {
				nextRunAt = getNextRunAt(updated.cronExpression, tz);
			} else if (updated.triggerType === 'at' && updated.runAt) {
				nextRunAt = updated.runAt;
			} else {
				nextRunAt = null;
			}

			let pendingJobId: string | null = null;
			if (nextRunAt !== null) {
				const job = jobQueue.enqueue({
					queue: TASK_SCHEDULE_FIRE,
					payload: { scheduleId } satisfies TaskScheduleFirePayload,
					runAt: nextRunAt,
				});
				pendingJobId = job.id;
			}

			scheduleRepo.update(scheduleId, { nextRunAt: nextRunAt ?? undefined });
			scheduleRepo.updatePendingJobId(scheduleId, pendingJobId);
		}

		return scheduleRepo.getById(scheduleId) as TaskSchedule;
	}

	/**
	 * Pause an active schedule — cancels the pending job, sets status=paused,
	 * clears pendingJobId.
	 */
	pauseSchedule(scheduleId: string): TaskSchedule {
		const { scheduleRepo, jobQueue } = this.deps;
		const schedule = scheduleRepo.getById(scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
		if (schedule.status !== 'active') {
			throw new Error(`Schedule is not active (current: ${schedule.status})`);
		}

		if (schedule.pendingJobId) jobQueue.deleteJob(schedule.pendingJobId);
		scheduleRepo.updatePendingJobId(scheduleId, null);
		scheduleRepo.updateStatus(scheduleId, 'paused');
		return scheduleRepo.getById(scheduleId) as TaskSchedule;
	}

	/**
	 * Resume a paused schedule — recomputes nextRunAt, enqueues a fresh fire job.
	 * For an `at` trigger whose `runAt` already passed, the schedule transitions
	 * to `completed` instead.
	 */
	resumeSchedule(scheduleId: string): TaskSchedule {
		const { scheduleRepo, jobQueue } = this.deps;
		const schedule = scheduleRepo.getById(scheduleId);
		if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
		if (schedule.status !== 'paused') {
			throw new Error(`Schedule is not paused (current: ${schedule.status})`);
		}

		const tz = schedule.timezone;
		let nextRunAt: number | null;
		if (schedule.triggerType === 'cron' && schedule.cronExpression) {
			nextRunAt = getNextRunAt(schedule.cronExpression, tz);
		} else if (schedule.triggerType === 'at' && schedule.runAt) {
			nextRunAt = schedule.runAt < Date.now() ? null : schedule.runAt;
		} else {
			nextRunAt = null;
		}

		// One-shot whose target time already passed → mark completed.
		if (nextRunAt === null && schedule.triggerType === 'at') {
			scheduleRepo.updateStatus(scheduleId, 'completed');
			return scheduleRepo.getById(scheduleId) as TaskSchedule;
		}

		let pendingJobId: string | null = null;
		if (nextRunAt !== null) {
			const job = jobQueue.enqueue({
				queue: TASK_SCHEDULE_FIRE,
				payload: { scheduleId } satisfies TaskScheduleFirePayload,
				runAt: nextRunAt,
			});
			pendingJobId = job.id;
		}

		scheduleRepo.update(scheduleId, { nextRunAt: nextRunAt ?? undefined });
		scheduleRepo.updatePendingJobId(scheduleId, pendingJobId);
		scheduleRepo.updateStatus(scheduleId, nextRunAt !== null ? 'active' : 'completed');
		return scheduleRepo.getById(scheduleId) as TaskSchedule;
	}

	/**
	 * Delete a schedule permanently — also cancels its pending fire job if any.
	 */
	deleteSchedule(scheduleId: string): boolean {
		const { scheduleRepo, jobQueue } = this.deps;
		const schedule = scheduleRepo.getById(scheduleId);
		if (!schedule) return false;
		if (schedule.pendingJobId) jobQueue.deleteJob(schedule.pendingJobId);
		return scheduleRepo.delete(scheduleId);
	}

	getSchedule(scheduleId: string): TaskSchedule | null {
		return this.deps.scheduleRepo.getById(scheduleId);
	}

	listSchedules(spaceId: string, status?: TaskScheduleStatus): TaskSchedule[] {
		return this.deps.scheduleRepo.listBySpace(spaceId, status);
	}
}
