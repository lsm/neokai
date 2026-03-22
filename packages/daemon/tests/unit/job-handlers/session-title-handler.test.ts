import { describe, it, expect, mock } from 'bun:test';
import { handleSessionTitleGeneration } from '../../../src/lib/job-handlers/session-title.handler';
import type { Job } from '../../../src/storage/repositories/job-queue-repository';
import type { SessionLifecycle } from '../../../src/lib/session/session-lifecycle';

function makeJob(payload: Record<string, unknown>): Job {
	return {
		id: 'test-job-id',
		queue: 'session.title_generation',
		status: 'processing',
		payload,
		result: null,
		error: null,
		priority: 0,
		maxRetries: 3,
		retryCount: 0,
		runAt: Date.now(),
		createdAt: Date.now(),
		startedAt: Date.now(),
		completedAt: null,
	};
}

function makeSessionLifecycle(
	impl?: Partial<Pick<SessionLifecycle, 'generateTitleAndRenameBranch'>>
): SessionLifecycle {
	return {
		generateTitleAndRenameBranch:
			impl?.generateTitleAndRenameBranch ??
			mock(() => Promise.resolve({ title: 'Generated Title', isFallback: false })),
	} as unknown as SessionLifecycle;
}

describe('handleSessionTitleGeneration', () => {
	it('calls generateTitleAndRenameBranch with correct params and returns { generated: true }', async () => {
		const stub = mock(() => Promise.resolve({ title: 'My Title', isFallback: false }));
		const lifecycle = makeSessionLifecycle({ generateTitleAndRenameBranch: stub });

		const job = makeJob({ sessionId: 'session-123', userMessageText: 'hello world' });
		const result = await handleSessionTitleGeneration(job, lifecycle);

		expect(result).toEqual({ generated: true });
		expect(stub).toHaveBeenCalledTimes(1);
		expect(stub).toHaveBeenCalledWith('session-123', 'hello world');
	});

	it('propagates errors from generateTitleAndRenameBranch for job queue retry', async () => {
		const error = new Error('API failure');
		const stub = mock(() => Promise.reject(error));
		const lifecycle = makeSessionLifecycle({ generateTitleAndRenameBranch: stub });

		const job = makeJob({ sessionId: 'session-abc', userMessageText: 'some text' });

		await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow('API failure');
		expect(stub).toHaveBeenCalledTimes(1);
	});

	it('propagates "session not found" error when session is missing', async () => {
		const stub = mock(() => Promise.reject(new Error('Session session-missing not found')));
		const lifecycle = makeSessionLifecycle({ generateTitleAndRenameBranch: stub });

		const job = makeJob({ sessionId: 'session-missing', userMessageText: 'hi' });

		await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow(
			'Session session-missing not found'
		);
	});
});
