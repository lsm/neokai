/**
 * Tests for taskSchedule.fire job handler
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { handleTaskScheduleFire } from '../../../../src/lib/job-handlers/task-schedule-fire.handler';
import { TASK_SCHEDULE_FIRE } from '../../../../src/lib/job-queue-constants';
import type { TaskSchedule } from '@neokai/shared';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

function makeJob(overrides: Partial<Job> = {}): Job {
	return {
		id: 'job-1',
		queue: TASK_SCHEDULE_FIRE,
		status: 'pending',
		payload: {},
		result: null,
		error: null,
		priority: 0,
		maxRetries: 3,
		retryCount: 0,
		runAt: Date.now() + 60000,
		createdAt: Date.now(),
		startedAt: null,
		completedAt: null,
		...overrides,
	};
}

function makeSchedule(overrides: Partial<TaskSchedule> = {}): TaskSchedule {
	const now = Date.now();
	return {
		id: 'schedule-1',
		spaceId: 'space-1',
		title: 'Daily Standup',
		description: 'Create daily standup task',
		priority: 'normal',
		preferredWorkflowId: null,
		labels: [],
		triggerType: 'cron',
		cronExpression: '0 9 * * 1-5', // Mon-Fri at 9am
		runAt: null,
		timezone: 'UTC',
		nextRunAt: now + 3600000,
		lastRunAt: null,
		lastCreatedTaskId: null,
		pendingJobId: null,
		status: 'active',
		createdByAgent: null,
		createdBySession: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe('handleTaskScheduleFire', () => {
	let getByIdMock: ReturnType<typeof mock>;
	let createTaskMock: ReturnType<typeof mock>;
	let enqueueMock: ReturnType<typeof mock>;
	let updateAfterFireMock: ReturnType<typeof mock>;
	let updatePendingJobIdMock: ReturnType<typeof mock>;
	let updateStatusMock: ReturnType<typeof mock>;

	beforeEach(() => {
		getByIdMock = mock(() => makeSchedule());
		createTaskMock = mock(async () => ({ id: 'task-1', title: 'Daily Standup' }));
		enqueueMock = mock(() => makeJob({ id: 'job-2' }));
		updateAfterFireMock = mock(() => {});
		updatePendingJobIdMock = mock(() => {});
		updateStatusMock = mock(() => {});
	});

	function makeDeps() {
		return {
			scheduleRepo: {
				getById: getByIdMock,
				updateAfterFire: updateAfterFireMock,
				updatePendingJobId: updatePendingJobIdMock,
				updateStatus: updateStatusMock,
			} as never,
			jobQueue: {
				enqueue: enqueueMock,
			} as never,
			taskManagerFactory: () =>
				({
					createTask: createTaskMock,
				}) as never,
		};
	}

	it('creates a SpaceTask from the schedule template', async () => {
		const result = await handleTaskScheduleFire({ scheduleId: 'schedule-1' }, makeDeps());

		expect(createTaskMock).toHaveBeenCalledTimes(1);
		const createArgs = (createTaskMock.mock.calls[0] as [Record<string, unknown>])[0];
		expect(createArgs.title).toBe('Daily Standup');
		expect(createArgs.createdByTaskScheduleId).toBe('schedule-1');
		expect(result.taskId).toBe('task-1');
		expect(result.skipped).toBe(false);
	});

	it('re-enqueues itself for cron schedules', async () => {
		const result = await handleTaskScheduleFire({ scheduleId: 'schedule-1' }, makeDeps());

		expect(enqueueMock).toHaveBeenCalledTimes(1);
		const enqueueArg = (enqueueMock.mock.calls[0] as [Record<string, unknown>])[0];
		expect(enqueueArg.queue).toBe(TASK_SCHEDULE_FIRE);
		expect((enqueueArg.payload as { scheduleId: string }).scheduleId).toBe('schedule-1');
		expect(typeof enqueueArg.runAt).toBe('number');
		expect(result.nextRunAt).not.toBeNull();
	});

	it('calls updateAfterFire with the created task ID', async () => {
		await handleTaskScheduleFire({ scheduleId: 'schedule-1' }, makeDeps());

		expect(updateAfterFireMock).toHaveBeenCalledTimes(1);
		const [id, opts] = updateAfterFireMock.mock.calls[0] as [string, Record<string, unknown>];
		expect(id).toBe('schedule-1');
		expect(opts.lastCreatedTaskId).toBe('task-1');
		expect(opts.status).toBe('active');
		expect(typeof opts.lastRunAt).toBe('number');
	});

	it('marks one-shot schedule as completed and does not re-enqueue', async () => {
		getByIdMock = mock(() =>
			makeSchedule({
				triggerType: 'at',
				cronExpression: null,
				runAt: Date.now() - 1000,
			})
		);

		const deps = makeDeps();
		deps.scheduleRepo.getById = getByIdMock as never;

		const result = await handleTaskScheduleFire({ scheduleId: 'schedule-1' }, deps);

		expect(enqueueMock).not.toHaveBeenCalled();
		expect(result.nextRunAt).toBeNull();

		const [, opts] = updateAfterFireMock.mock.calls[0] as [string, Record<string, unknown>];
		expect(opts.status).toBe('completed');
		expect(opts.pendingJobId).toBeNull();
	});

	it('skips when schedule is not found', async () => {
		getByIdMock = mock(() => null);
		const deps = makeDeps();
		deps.scheduleRepo.getById = getByIdMock as never;

		const result = await handleTaskScheduleFire({ scheduleId: 'schedule-1' }, deps);

		expect(result.skipped).toBe(true);
		expect(result.taskId).toBeNull();
		expect(createTaskMock).not.toHaveBeenCalled();
		expect(enqueueMock).not.toHaveBeenCalled();
	});

	it('skips when schedule is paused', async () => {
		getByIdMock = mock(() => makeSchedule({ status: 'paused' }));
		const deps = makeDeps();
		deps.scheduleRepo.getById = getByIdMock as never;

		const result = await handleTaskScheduleFire({ scheduleId: 'schedule-1' }, deps);

		expect(result.skipped).toBe(true);
		expect(createTaskMock).not.toHaveBeenCalled();
	});

	it('re-throws createTask errors so the job queue can retry', async () => {
		createTaskMock = mock(async () => {
			throw new Error('Task creation failed');
		});
		const deps = makeDeps();
		deps.taskManagerFactory = () => ({ createTask: createTaskMock }) as never;

		await expect(handleTaskScheduleFire({ scheduleId: 'schedule-1' }, deps)).rejects.toThrow(
			'Task creation failed'
		);
	});
});
