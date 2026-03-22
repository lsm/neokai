/**
 * Tests for github.poll job handler
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { handleGitHubPoll } from '../../../src/lib/job-handlers/github-poll.handler';
import { GITHUB_POLL } from '../../../src/lib/job-queue-constants';
import type { Job } from '../../../src/storage/repositories/job-queue-repository';

function makeJob(overrides: Partial<Job> = {}): Job {
	return {
		id: 'job-1',
		queue: GITHUB_POLL,
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

describe('handleGitHubPoll', () => {
	let triggerPollMock: ReturnType<typeof mock>;
	let enqueueMock: ReturnType<typeof mock>;
	let listJobsMock: ReturnType<typeof mock>;

	beforeEach(() => {
		triggerPollMock = mock(async () => {});
		enqueueMock = mock(() => makeJob());
		listJobsMock = mock(() => []);
	});

	function makeDeps(overrides: { intervalMs?: number } = {}) {
		return {
			pollingService: {
				triggerPoll: triggerPollMock,
			} as never,
			jobQueue: {
				enqueue: enqueueMock,
				listJobs: listJobsMock,
			} as never,
			intervalMs: overrides.intervalMs ?? 60000,
		};
	}

	it('calls triggerPoll on the polling service', async () => {
		await handleGitHubPoll(makeDeps());
		expect(triggerPollMock).toHaveBeenCalledTimes(1);
	});

	it('returns polled: true and a future nextRunAt', async () => {
		const before = Date.now();
		const result = await handleGitHubPoll(makeDeps({ intervalMs: 60000 }));
		expect(result.polled).toBe(true);
		expect(result.nextRunAt).toBeGreaterThanOrEqual(before + 60000);
	});

	it('enqueues next job when no pending job exists', async () => {
		listJobsMock = mock(() => []);
		const deps = makeDeps();
		deps.jobQueue.listJobs = listJobsMock as never;

		await handleGitHubPoll(deps);

		expect(enqueueMock).toHaveBeenCalledTimes(1);
		const enqueueArg = (enqueueMock.mock.calls[0] as [{ queue: string; runAt: number }])[0];
		expect(enqueueArg.queue).toBe(GITHUB_POLL);
		expect(enqueueArg.runAt).toBeGreaterThan(Date.now());
	});

	it('skips enqueueing when a pending job already exists (dedup)', async () => {
		listJobsMock = mock(() => [makeJob()]);
		const deps = makeDeps();
		deps.jobQueue.listJobs = listJobsMock as never;
		deps.jobQueue.enqueue = enqueueMock as never;

		await handleGitHubPoll(deps);

		expect(enqueueMock).not.toHaveBeenCalled();
	});

	it('still schedules next poll even when triggerPoll throws (finally block)', async () => {
		triggerPollMock = mock(async () => {
			throw new Error('poll failed');
		});
		listJobsMock = mock(() => []);

		const deps = makeDeps();
		deps.pollingService.triggerPoll = triggerPollMock as never;
		deps.jobQueue.listJobs = listJobsMock as never;
		deps.jobQueue.enqueue = enqueueMock as never;

		await expect(handleGitHubPoll(deps)).rejects.toThrow('poll failed');
		expect(enqueueMock).toHaveBeenCalledTimes(1);
	});

	it('queries listJobs with pending status and GITHUB_POLL queue', async () => {
		await handleGitHubPoll(makeDeps());

		expect(listJobsMock).toHaveBeenCalledTimes(1);
		const listArg = (
			listJobsMock.mock.calls[0] as [{ queue: string; status: string[]; limit: number }]
		)[0];
		expect(listArg.queue).toBe(GITHUB_POLL);
		expect(listArg.status).toEqual(['pending']);
		expect(listArg.limit).toBe(10);
	});
});
