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
		} else {
			// RPC payloads are cast from `unknown` and the agent MCP tool also
			// dispatches into this service. TypeScript's narrowing isn't enforced
			// at runtime, so explicitly reject any other value rather than
			// silently falling through and creating an inconsistent schedule.
			throw new Error(
				`Unsupported triggerType: ${String(input.triggerType)} (expected 'cron' or 'at')`
			);
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
	 * particular, setting `cronExpression: null` on a `cron` schedule, or
	 * applying timing fields whose combined result yields no next run (e.g. an
	 * invalid timezone). If the timing fields change and the schedule is
	 * `active`, the existing pending job is cancelled and a fresh one is
	 * enqueued **inside a single SQLite transaction**, so an enqueue failure
	 * cannot orphan the schedule with no pending job.
	 */
	updateSchedule(scheduleId: string, input: UpdateScheduleInput): TaskSchedule {
		const { db, scheduleRepo, jobQueue } = this.deps;

		const existing = scheduleRepo.getById(scheduleId);
		if (!existing) throw new Error(`Schedule not found: ${scheduleId}`);

		// Match create-time data quality: a schedule fires tasks whose title is
		// inherited from the schedule template, so a blank title would spawn
		// nameless tasks. Reject explicit empty/whitespace updates here rather
		// than silently persisting them.
		if (input.title !== undefined && !input.title.trim()) {
			throw new Error('title must be a non-empty string');
		}

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

		const timingChanged =
			input.cronExpression !== undefined ||
			input.runAt !== undefined ||
			input.timezone !== undefined;

		// Pre-compute the post-update view so we can validate next-run *before*
		// committing anything. If timing changed, derive the merged trigger
		// fields and confirm we can compute a next run; if not, fail fast and
		// leave the schedule untouched so the caller can correct the input.
		const merged = {
			triggerType: existing.triggerType,
			cronExpression:
				input.cronExpression !== undefined ? input.cronExpression : existing.cronExpression,
			runAt: input.runAt !== undefined ? input.runAt : existing.runAt,
			timezone: input.timezone ?? existing.timezone,
		};

		let plannedNextRunAt: number | null = null;
		if (timingChanged && existing.status === 'active') {
			if (merged.triggerType === 'cron' && merged.cronExpression) {
				plannedNextRunAt = getNextRunAt(merged.cronExpression, merged.timezone);
				if (plannedNextRunAt === null) {
					throw new Error(
						`Could not compute next run from cronExpression "${merged.cronExpression}" with timezone "${merged.timezone}"`
					);
				}
			} else if (merged.triggerType === 'at' && merged.runAt) {
				plannedNextRunAt = merged.runAt;
			} else {
				throw new Error(
					'Cannot apply update: resulting trigger configuration has no next run time.'
				);
			}
		}

		// Wrap field-update + cancel-old + enqueue-new + link-new in a single
		// transaction. If `jobQueue.enqueue` throws (e.g. a transient DB error),
		// the rollback restores the prior pending job linkage so the schedule
		// continues to fire on its original cadence.
		db.transaction(() => {
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

			if (existing.status === 'active' && timingChanged) {
				if (existing.pendingJobId) jobQueue.deleteJob(existing.pendingJobId);

				let pendingJobId: string | null = null;
				if (plannedNextRunAt !== null) {
					const job = jobQueue.enqueue({
						queue: TASK_SCHEDULE_FIRE,
						payload: { scheduleId } satisfies TaskScheduleFirePayload,
						runAt: plannedNextRunAt,
					});
					pendingJobId = job.id;
				}

				scheduleRepo.update(scheduleId, { nextRunAt: plannedNextRunAt ?? undefined });
				scheduleRepo.updatePendingJobId(scheduleId, pendingJobId);
			}
		})();

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
	 *
	 * Behavior depends on triggerType:
	 *   - `at` whose runAt already passed → transition to `completed` (one-shot
	 *     schedules are intentionally terminal once their target time is in the
	 *     past).
	 *   - `cron` that cannot produce a next run (e.g. invalid timezone or
	 *     malformed expression persisted via a path that didn't validate) →
	 *     throw, leaving the schedule paused so the operator can fix the
	 *     config. We do NOT silently complete a recurring schedule, because that
	 *     would terminally end its lifecycle on a recoverable error.
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
			if (nextRunAt === null) {
				throw new Error(
					`Cannot resume cron schedule: no next run computable from "${schedule.cronExpression}" with timezone "${tz}". Fix the trigger config and try again.`
				);
			}
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

		// At this point, nextRunAt is non-null for both cron and at paths.
		const job = jobQueue.enqueue({
			queue: TASK_SCHEDULE_FIRE,
			payload: { scheduleId } satisfies TaskScheduleFirePayload,
			runAt: nextRunAt as number,
		});

		scheduleRepo.update(scheduleId, { nextRunAt: nextRunAt ?? undefined });
		scheduleRepo.updatePendingJobId(scheduleId, job.id);
		scheduleRepo.updateStatus(scheduleId, 'active');
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

	/**
	 * Recover active schedules for a space whose fire jobs were skipped while
	 * the space was paused or stopped. Called by SpaceManager when a space is
	 * resumed or restarted so cron schedules pick up forward progress without
	 * waiting for a daemon restart.
	 *
	 * For each active schedule with `pending_job_id IS NULL`:
	 *   - cron: advance `next_run_at` to the next tick from now, enqueue a fresh
	 *     fire job at that time. We do not fire missed ticks retroactively — the
	 *     space was intentionally inactive during that window.
	 *   - at:   if the target time has passed, mark the schedule `completed`
	 *     (the deadline expired during the outage). Otherwise re-enqueue at
	 *     the original runAt.
	 *
	 * Schedules that already have a pending job are left alone — startup
	 * recovery (Pass 1) handles dangling job IDs.
	 *
	 * Returns the number of schedules re-seeded.
	 */
	recoverSchedulesForSpace(spaceId: string): number {
		const { db, scheduleRepo, jobQueue } = this.deps;

		const schedules = scheduleRepo.listActiveBySpace(spaceId);
		let recovered = 0;

		for (const schedule of schedules) {
			if (schedule.pendingJobId) continue; // already linked

			db.transaction(() => {
				if (schedule.triggerType === 'cron' && schedule.cronExpression) {
					const next = getNextRunAt(schedule.cronExpression, schedule.timezone);
					if (next === null) {
						// Unrecoverable cron config — leave for operator to fix; do not
						// terminally complete a recurring schedule on transient errors.
						return;
					}
					const job = jobQueue.enqueue({
						queue: TASK_SCHEDULE_FIRE,
						payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
						runAt: next,
					});
					scheduleRepo.update(schedule.id, { nextRunAt: next });
					scheduleRepo.updatePendingJobId(schedule.id, job.id);
					recovered++;
					return;
				}

				if (schedule.triggerType === 'at' && schedule.runAt) {
					if (schedule.runAt < Date.now()) {
						// Deadline expired while the space was inactive — terminal.
						scheduleRepo.updateStatus(schedule.id, 'completed');
						return;
					}
					const job = jobQueue.enqueue({
						queue: TASK_SCHEDULE_FIRE,
						payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
						runAt: schedule.runAt,
					});
					scheduleRepo.updatePendingJobId(schedule.id, job.id);
					recovered++;
				}
			})();
		}

		return recovered;
	}
}
