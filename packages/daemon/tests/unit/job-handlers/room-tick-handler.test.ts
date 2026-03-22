import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Job } from '../../../src/storage/repositories/job-queue-repository';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import {
	createRoomTickHandler,
	enqueueRoomTick,
	cancelPendingTickJobs,
	DEFAULT_TICK_INTERVAL_MS,
} from '../../../src/lib/job-handlers/room-tick.handler';
import { ROOM_TICK } from '../../../src/lib/job-queue-constants';

const CREATE_TABLE_SQL = `
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
	CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
`;

function makeRuntime(state: 'running' | 'paused' | 'stopped', tickFn?: () => Promise<void>) {
	return {
		getState: () => state,
		tick: tickFn ?? (async () => {}),
	};
}

/** Build a minimal Job object without touching the DB — simulates a dequeued (processing) job */
function makeJob(roomId: string): Job {
	return {
		id: `test-job-${roomId}`,
		queue: ROOM_TICK,
		status: 'processing',
		payload: { roomId },
		result: null,
		error: null,
		priority: 0,
		maxRetries: 0,
		retryCount: 0,
		runAt: Date.now(),
		createdAt: Date.now(),
		startedAt: Date.now(),
		completedAt: null,
	};
}

describe('createRoomTickHandler', () => {
	let db: Database;
	let repo: JobQueueRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(CREATE_TABLE_SQL);
		repo = new JobQueueRepository(db as any);
	});

	it('calls tick and re-schedules when runtime is running', async () => {
		let tickCalled = false;
		const runtime = makeRuntime('running', async () => {
			tickCalled = true;
		});
		const handler = createRoomTickHandler(() => runtime, repo, 1000);

		const job = makeJob('room-1');
		await handler(job);

		expect(tickCalled).toBe(true);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending.some((j) => (j.payload as any).roomId === 'room-1')).toBe(true);
	});

	it('skips and does NOT re-schedule when runtime not found', async () => {
		const handler = createRoomTickHandler(() => undefined, repo, 1000);
		const job = makeJob('room-2');

		const result = await handler(job);

		expect(result).toEqual({ skipped: true, reason: 'not running' });
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});

	it('skips and does NOT re-schedule when runtime is paused', async () => {
		const runtime = makeRuntime('paused');
		const handler = createRoomTickHandler(() => runtime, repo, 1000);
		const job = makeJob('room-3');

		const result = await handler(job);

		expect(result).toEqual({ skipped: true, reason: 'not running' });
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});

	it('skips and does NOT re-schedule when runtime is stopped', async () => {
		const runtime = makeRuntime('stopped');
		const handler = createRoomTickHandler(() => runtime, repo, 1000);
		const job = makeJob('room-stopped');

		const result = await handler(job);

		expect(result).toEqual({ skipped: true, reason: 'not running' });
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});

	it('re-schedules after error in tick() if runtime still running', async () => {
		let callCount = 0;
		const runtimeState = { state: 'running' as 'running' | 'paused' | 'stopped' };
		const runtime = {
			getState: () => runtimeState.state,
			tick: async () => {
				callCount++;
				throw new Error('tick failed');
			},
		};

		const handler = createRoomTickHandler(() => runtime, repo, 1000);
		const job = makeJob('room-4');

		await expect(handler(job)).rejects.toThrow('tick failed');
		expect(callCount).toBe(1);

		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending.some((j) => (j.payload as any).roomId === 'room-4')).toBe(true);
	});

	it('does NOT re-schedule after error in tick() when runtime becomes paused', async () => {
		const runtimeState = { state: 'running' as 'running' | 'paused' | 'stopped' };
		const runtime = {
			getState: () => runtimeState.state,
			tick: async () => {
				runtimeState.state = 'paused';
				throw new Error('tick failed, now paused');
			},
		};

		const handler = createRoomTickHandler(() => runtime, repo, 1000);
		const job = makeJob('room-5');

		await expect(handler(job)).rejects.toThrow();
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});
});

describe('enqueueRoomTick', () => {
	let db: Database;
	let repo: JobQueueRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(CREATE_TABLE_SQL);
		repo = new JobQueueRepository(db as any);
	});

	it('enqueues a pending tick job', () => {
		enqueueRoomTick('room-a', repo, 1000);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(1);
		expect((pending[0].payload as any).roomId).toBe('room-a');
	});

	it('deduplicates: second enqueue with existing pending job is a no-op', () => {
		enqueueRoomTick('room-a', repo, 1000);
		enqueueRoomTick('room-a', repo, 1000);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(1);
	});

	it('allows enqueueing for different rooms independently', () => {
		enqueueRoomTick('room-a', repo, 1000);
		enqueueRoomTick('room-b', repo, 1000);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(2);
	});

	it('uses default delay when not specified', () => {
		const before = Date.now();
		enqueueRoomTick('room-x', repo);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(1);
		expect(pending[0].runAt).toBeGreaterThanOrEqual(before + DEFAULT_TICK_INTERVAL_MS - 100);
	});
});

describe('cancelPendingTickJobs', () => {
	let db: Database;
	let repo: JobQueueRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(CREATE_TABLE_SQL);
		repo = new JobQueueRepository(db as any);
	});

	it('removes all pending tick jobs for a room', () => {
		repo.enqueue({ queue: ROOM_TICK, payload: { roomId: 'room-z' } });
		repo.enqueue({ queue: ROOM_TICK, payload: { roomId: 'room-z' } });
		cancelPendingTickJobs('room-z', repo);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});

	it('only removes jobs for the specified room, not others', () => {
		repo.enqueue({ queue: ROOM_TICK, payload: { roomId: 'room-z' } });
		repo.enqueue({ queue: ROOM_TICK, payload: { roomId: 'room-other' } });
		cancelPendingTickJobs('room-z', repo);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(1);
		expect((pending[0].payload as any).roomId).toBe('room-other');
	});

	it('is a no-op when no pending jobs exist', () => {
		cancelPendingTickJobs('room-none', repo);
		const pending = repo.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});

	it('does not cancel in-flight (processing) tick jobs — they self-terminate via finally block', () => {
		// Simulate an in-flight tick: status is processing, not pending
		const job = repo.enqueue({ queue: ROOM_TICK, payload: { roomId: 'room-inflight' } });
		// Move to processing state
		repo.dequeue(ROOM_TICK, 1);

		cancelPendingTickJobs('room-inflight', repo);

		// The processing job is still there (not cancelled)
		const processing = repo.listJobs({ queue: ROOM_TICK, status: ['processing'] });
		expect(processing.some((j) => j.id === job.id)).toBe(true);
	});
});
