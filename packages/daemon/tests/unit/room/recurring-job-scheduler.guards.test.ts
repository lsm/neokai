import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RecurringJobScheduler } from '../../../src/lib/room/recurring-job-scheduler';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RecurringJob } from '@neokai/shared';

const MAX_SET_TIMEOUT_MS = 2_147_483_647;

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

describe('RecurringJobScheduler guards', () => {
	const dbs: Database[] = [];

	afterEach(() => {
		for (const db of dbs.splice(0, dbs.length)) {
			db.close();
		}
	});

	it('rejects cron schedule on createJob', async () => {
		const db = new Database(':memory:');
		dbs.push(db);
		const scheduler = new RecurringJobScheduler(db, createMockDaemonHub());

		await expect(
			scheduler.createJob({
				roomId: 'room-1',
				name: 'Cron job',
				description: '',
				schedule: { type: 'cron', expression: '* * * * *' },
				taskTemplate: {
					title: 'Task',
					description: 'desc',
					priority: 'normal',
				},
			})
		).rejects.toThrow('Cron schedules are not supported');
	});

	it('rejects cron schedule on updateJob', async () => {
		const db = new Database(':memory:');
		dbs.push(db);
		const scheduler = new RecurringJobScheduler(db, createMockDaemonHub());

		await expect(
			scheduler.updateJob('job-1', {
				schedule: { type: 'cron', expression: '0 0 * * *' },
			})
		).rejects.toThrow('Cron schedules are not supported');
	});

	it('throws on calculateNextRun for cron schedule', () => {
		const db = new Database(':memory:');
		dbs.push(db);
		const scheduler = new RecurringJobScheduler(db, createMockDaemonHub());

		expect(() =>
			scheduler.calculateNextRun({
				type: 'cron',
				expression: '0 0 * * *',
			})
		).toThrow("Unsupported schedule type 'cron'");
	});

	it('chunks long delays to avoid setTimeout overflow', () => {
		const db = new Database(':memory:');
		dbs.push(db);
		const scheduler = new RecurringJobScheduler(db, createMockDaemonHub());

		const farFutureJob: RecurringJob = {
			id: 'job-1',
			roomId: 'room-1',
			name: 'Future Job',
			description: '',
			schedule: { type: 'daily', hour: 9, minute: 0 },
			taskTemplate: { title: 'Task', description: '', priority: 'normal' },
			enabled: true,
			nextRunAt: Date.now() + MAX_SET_TIMEOUT_MS + 60_000,
			runCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		(scheduler as unknown as { jobRepo: Record<string, unknown> }).jobRepo = {
			hasReachedMaxRuns: () => false,
			updateJob: () => null,
			getJob: () => farFutureJob,
		};

		const timeoutSpy = spyOn(globalThis, 'setTimeout');

		(scheduler as unknown as { scheduleJob: (job: RecurringJob) => void }).scheduleJob(
			farFutureJob
		);

		expect(timeoutSpy).toHaveBeenCalled();
		const overflowCall = timeoutSpy.mock.calls.find(
			(call) => typeof call[1] === 'number' && call[1] === MAX_SET_TIMEOUT_MS
		);
		expect(overflowCall).toBeDefined();

		timeoutSpy.mockRestore();
		scheduler.stop();
	});
});
