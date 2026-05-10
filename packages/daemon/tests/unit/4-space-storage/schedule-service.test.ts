/**
 * ScheduleService unit tests
 *
 * Exercises the centralized schedule lifecycle behavior shared by both the
 * RPC handlers and the agent-facing MCP tools: validation, atomic
 * create+enqueue, edit-time consistency, pause/resume, and delete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { TaskScheduleRepository } from '../../../src/storage/repositories/task-schedule-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { createSpaceTables } from '../helpers/space-test-db';

describe('ScheduleService', () => {
	let db: Database;
	let scheduleRepo: TaskScheduleRepository;
	let jobQueue: JobQueueRepository;
	let spaceRepo: SpaceRepository;
	let service: ScheduleService;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		db.exec(`
			CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		`);

		spaceRepo = new SpaceRepository(db as never);
		scheduleRepo = new TaskScheduleRepository(db as never);
		jobQueue = new JobQueueRepository(db as never);
		service = new ScheduleService({ db: db as never, scheduleRepo, jobQueue });

		const space = spaceRepo.createSpace({
			slug: 'test',
			workspacePath: '/workspace/test',
			name: 'Test',
			description: 'Test space',
		});
		spaceId = space.id;
	});

	afterEach(() => {
		db.close();
	});

	describe('createSchedule', () => {
		it('atomically creates the schedule, enqueues the first fire job, and links pendingJobId', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Daily Standup',
				triggerType: 'cron',
				cronExpression: '0 9 * * 1-5',
				timezone: 'UTC',
			});

			expect(schedule.status).toBe('active');
			expect(schedule.nextRunAt).not.toBeNull();
			expect(schedule.pendingJobId).not.toBeNull();

			// The job actually exists and points back at the schedule.
			const job = jobQueue.getJob(schedule.pendingJobId as string);
			expect(job).not.toBeNull();
			expect(job?.queue).toBe('taskSchedule.fire');
			expect((job?.payload as { scheduleId: string }).scheduleId).toBe(schedule.id);
		});

		it('rejects an invalid cron expression', () => {
			expect(() =>
				service.createSchedule({
					spaceId,
					title: 'Bad cron',
					triggerType: 'cron',
					cronExpression: 'not-a-cron',
				})
			).toThrow(/Invalid cron expression/);
		});

		it('rejects an `at` schedule without a runAt', () => {
			expect(() =>
				service.createSchedule({ spaceId, title: 'No runAt', triggerType: 'at' })
			).toThrow(/runAt is required/);
		});

		it('rejects an `at` schedule whose runAt is in the past', () => {
			expect(() =>
				service.createSchedule({
					spaceId,
					title: 'Past',
					triggerType: 'at',
					runAt: Date.now() - 60_000,
				})
			).toThrow(/runAt must be in the future/);
		});

		it('rejects an unsupported triggerType', () => {
			expect(() =>
				service.createSchedule({
					spaceId,
					title: 'Bad trigger',
					// biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing TS to simulate
					// a malformed RPC payload.
					triggerType: 'webhook' as any,
				})
			).toThrow(/Unsupported triggerType/);
		});
	});

	describe('updateSchedule', () => {
		it('rejects clearing the title to empty/whitespace', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});

			expect(() => service.updateSchedule(schedule.id, { title: '' })).toThrow(
				/title must be a non-empty string/
			);
			expect(() => service.updateSchedule(schedule.id, { title: '   ' })).toThrow(
				/title must be a non-empty string/
			);

			// Schedule's title is unchanged after the rejected updates.
			const after = scheduleRepo.getById(schedule.id);
			expect(after?.title).toBe('Cron');
		});

		it('rejects setting cronExpression to null on a cron schedule', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});

			expect(() => service.updateSchedule(schedule.id, { cronExpression: null })).toThrow(
				/Cannot clear cronExpression/
			);
		});

		it('cancels the previous pending job and enqueues a new one when timing changes', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			const oldJobId = schedule.pendingJobId as string;

			const updated = service.updateSchedule(schedule.id, { cronExpression: '0 10 * * *' });

			expect(updated.pendingJobId).not.toBeNull();
			expect(updated.pendingJobId).not.toBe(oldJobId);
			expect(jobQueue.getJob(oldJobId)).toBeNull();
		});

		it('does not touch the pending job when only descriptive fields change', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			const oldJobId = schedule.pendingJobId;

			const updated = service.updateSchedule(schedule.id, { title: 'Renamed' });

			expect(updated.title).toBe('Renamed');
			expect(updated.pendingJobId).toBe(oldJobId);
		});

		it('rejects timing edits whose merged trigger config produces no nextRunAt', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
				timezone: 'UTC',
			});
			const oldJobId = schedule.pendingJobId as string;

			// Bogus IANA timezone. croner should refuse and getNextRunAt returns null.
			expect(() => service.updateSchedule(schedule.id, { timezone: 'Not/A_Real_Zone' })).toThrow(
				/Could not compute next run/
			);

			// Schedule and original job must be untouched on failure.
			const after = scheduleRepo.getById(schedule.id);
			expect(after?.pendingJobId).toBe(oldJobId);
			expect(after?.timezone).toBe('UTC');
			expect(jobQueue.getJob(oldJobId)).not.toBeNull();
		});

		it('rolls back the old pending job linkage if enqueue throws mid-update', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			const oldJobId = schedule.pendingJobId as string;

			// Wrap jobQueue.enqueue to throw on the first reschedule call.
			const breakingService = new ScheduleService({
				db: db as never,
				scheduleRepo,
				jobQueue: {
					...jobQueue,
					enqueue: () => {
						throw new Error('synthetic enqueue failure');
					},
					deleteJob: jobQueue.deleteJob.bind(jobQueue),
					getJob: jobQueue.getJob.bind(jobQueue),
				} as unknown as typeof jobQueue,
			});

			expect(() =>
				breakingService.updateSchedule(schedule.id, { cronExpression: '0 10 * * *' })
			).toThrow('synthetic enqueue failure');

			// Schedule must still be active with the original pending job intact.
			const after = scheduleRepo.getById(schedule.id);
			expect(after?.status).toBe('active');
			expect(after?.pendingJobId).toBe(oldJobId);
			expect(jobQueue.getJob(oldJobId)).not.toBeNull();
			// And the cronExpression update was also rolled back.
			expect(after?.cronExpression).toBe('0 9 * * *');
		});
	});

	describe('pause/resume/delete', () => {
		it('pause cancels the pending job and clears pendingJobId', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			const jobId = schedule.pendingJobId as string;

			const paused = service.pauseSchedule(schedule.id);

			expect(paused.status).toBe('paused');
			expect(paused.pendingJobId).toBeNull();
			expect(jobQueue.getJob(jobId)).toBeNull();
		});

		it('resume re-enqueues a fresh fire job', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			service.pauseSchedule(schedule.id);

			const resumed = service.resumeSchedule(schedule.id);

			expect(resumed.status).toBe('active');
			expect(resumed.pendingJobId).not.toBeNull();
			expect(jobQueue.getJob(resumed.pendingJobId as string)).not.toBeNull();
		});

		it('resume of an already-passed `at` schedule transitions to completed (no job)', () => {
			// Create with a future runAt to satisfy validation.
			const future = Date.now() + 60_000;
			const schedule = service.createSchedule({
				spaceId,
				title: 'One Shot',
				triggerType: 'at',
				runAt: future,
			});
			service.pauseSchedule(schedule.id);

			// Move runAt into the past directly via the repo (bypassing validation).
			scheduleRepo.update(schedule.id, { runAt: Date.now() - 60_000 });

			const resumed = service.resumeSchedule(schedule.id);
			expect(resumed.status).toBe('completed');
			expect(resumed.pendingJobId).toBeNull();
		});

		it('resume of a cron schedule with an unrecoverable timezone throws (preserves paused)', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			service.pauseSchedule(schedule.id);

			// Corrupt the timezone directly via the repo so getNextRunAt can't compute.
			scheduleRepo.update(schedule.id, { timezone: 'Not/A_Real_Zone' });

			expect(() => service.resumeSchedule(schedule.id)).toThrow(/Cannot resume cron schedule/);
			// Schedule remains paused — operator can fix and retry.
			const after = scheduleRepo.getById(schedule.id);
			expect(after?.status).toBe('paused');
			expect(after?.pendingJobId).toBeNull();
		});

		it('delete cancels the pending job and removes the schedule row', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			const jobId = schedule.pendingJobId as string;

			const ok = service.deleteSchedule(schedule.id);

			expect(ok).toBe(true);
			expect(scheduleRepo.getById(schedule.id)).toBeNull();
			expect(jobQueue.getJob(jobId)).toBeNull();
		});
	});

	describe('recoverSchedulesForSpace', () => {
		it('re-enqueues active cron schedules whose pendingJobId was cleared', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
				timezone: 'UTC',
			});

			// Simulate the fire-handler's space-paused branch clearing pending linkage.
			scheduleRepo.updatePendingJobId(schedule.id, null);

			const recovered = service.recoverSchedulesForSpace(spaceId);
			expect(recovered).toBe(1);

			const after = scheduleRepo.getById(schedule.id);
			expect(after?.pendingJobId).not.toBeNull();
			expect(after?.status).toBe('active');
			expect(jobQueue.getJob(after?.pendingJobId as string)).not.toBeNull();
		});

		it('re-enqueues `at` schedules whose runAt is still in the future', () => {
			const future = Date.now() + 60_000;
			const schedule = service.createSchedule({
				spaceId,
				title: 'One Shot',
				triggerType: 'at',
				runAt: future,
			});
			scheduleRepo.updatePendingJobId(schedule.id, null);

			const recovered = service.recoverSchedulesForSpace(spaceId);
			expect(recovered).toBe(1);

			const after = scheduleRepo.getById(schedule.id);
			expect(after?.pendingJobId).not.toBeNull();
			expect(after?.status).toBe('active');
		});

		it('marks `at` schedules whose deadline expired during the outage as completed', () => {
			const future = Date.now() + 60_000;
			const schedule = service.createSchedule({
				spaceId,
				title: 'One Shot',
				triggerType: 'at',
				runAt: future,
			});
			scheduleRepo.updatePendingJobId(schedule.id, null);
			// Move runAt into the past directly via the repo (bypass validation).
			scheduleRepo.update(schedule.id, { runAt: Date.now() - 60_000 });

			const recovered = service.recoverSchedulesForSpace(spaceId);
			expect(recovered).toBe(0); // expired schedule wasn't re-enqueued

			const after = scheduleRepo.getById(schedule.id);
			expect(after?.status).toBe('completed');
			expect(after?.pendingJobId).toBeNull();
		});

		it('skips schedules that already have a pending job linked', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
			});
			const originalJobId = schedule.pendingJobId;

			const recovered = service.recoverSchedulesForSpace(spaceId);
			expect(recovered).toBe(0);

			// Existing linkage untouched.
			const after = scheduleRepo.getById(schedule.id);
			expect(after?.pendingJobId).toBe(originalJobId);
		});

		it('leaves an unrecoverable cron config alone for the operator to fix', () => {
			const schedule = service.createSchedule({
				spaceId,
				title: 'Cron',
				triggerType: 'cron',
				cronExpression: '0 9 * * *',
				timezone: 'UTC',
			});
			scheduleRepo.updatePendingJobId(schedule.id, null);
			// Corrupt timezone so getNextRunAt returns null.
			scheduleRepo.update(schedule.id, { timezone: 'Not/A_Real_Zone' });

			const recovered = service.recoverSchedulesForSpace(spaceId);
			expect(recovered).toBe(0);

			const after = scheduleRepo.getById(schedule.id);
			expect(after?.status).toBe('active'); // not terminally completed
			expect(after?.pendingJobId).toBeNull();
		});
	});
});
