/**
 * JobQueueProcessor Lifecycle Integration Tests
 *
 * Verifies the behavioral contracts that the app-level wiring depends on:
 * - start() → eager reclaimStale() → poll → dequeue → dispatch → stop()
 * - setChangeNotifier callback on status transitions
 * - error → retry → dead progression
 * - stale reclamation timing
 *
 * Scope: processor internals and contract, NOT app-level wiring (see app/job-queue-lifecycle.test.ts).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { JobQueueProcessor } from '../../../src/storage/job-queue-processor';

const DB_SCHEMA = `
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

/** Wait for async side-effects to settle */
const flush = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe('JobQueueProcessor — lifecycle contracts', () => {
	let db: Database;
	let repo: JobQueueRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(DB_SCHEMA);
		repo = new JobQueueRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	// ─── Eager stale reclamation on start() ────────────────────────────────────

	describe('eager stale reclamation on start()', () => {
		it('calls reclaimStale() synchronously during start(), before the first interval tick', async () => {
			// Use a very long poll interval so the interval tick cannot interfere.
			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 500,
				pollIntervalMs: 60_000,
			});
			processor.register('test-q', async () => {});

			let reclaimCallCount = 0;
			const original = repo.reclaimStale.bind(repo);
			repo.reclaimStale = (staleBefore: number) => {
				reclaimCallCount++;
				return original(staleBefore);
			};

			// reclaimStale must NOT be called before start()
			expect(reclaimCallCount).toBe(0);

			processor.start();
			// After start() returns (synchronously), reclaimStale should already have been invoked.
			expect(reclaimCallCount).toBeGreaterThanOrEqual(1);

			await processor.stop();
		});

		it('reclaims processing jobs that exceeded staleThresholdMs instantly on start()', async () => {
			// Simulate a job left in processing state from a prior crash.
			const job = repo.enqueue({ queue: 'crash-q', payload: { src: 'crash' } });
			// Manually mark as processing with a very old started_at.
			db.prepare(`UPDATE job_queue SET status = 'processing', started_at = ? WHERE id = ?`).run(
				Date.now() - 30_000,
				job.id
			);
			expect(repo.getJob(job.id)?.status).toBe('processing');

			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 1_000, // threshold = 1 s; job started 30 s ago → stale
				pollIntervalMs: 60_000,
			});
			processor.register('crash-q', async () => {});

			// start() eagerly reclaims → job transitions to pending → immediate tick processes it.
			processor.start();
			await flush();
			await processor.stop();

			// The stale job should have been reclaimed and processed.
			const after = repo.getJob(job.id);
			expect(after?.status).toBe('completed');
		});

		it('does not reclaim jobs whose started_at is within the stale threshold', async () => {
			const job = repo.enqueue({ queue: 'fresh-q', payload: {} });
			// Mark as processing with a very recent started_at (well within threshold).
			db.prepare(`UPDATE job_queue SET status = 'processing', started_at = ? WHERE id = ?`).run(
				Date.now(),
				job.id
			);

			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 60_000, // threshold = 60 s; job started just now → fresh
				pollIntervalMs: 60_000,
			});
			processor.register('fresh-q', async () => {});

			processor.start();
			await flush();
			await processor.stop();

			// Fresh job must stay in processing (no handler dequeued it after reclaim).
			expect(repo.getJob(job.id)?.status).toBe('processing');
		});
	});

	// ─── start() → poll → dequeue → dispatch lifecycle ────────────────────────

	describe('start() → poll → dequeue → dispatch', () => {
		it('processes a job enqueued before start() via the initial tick', async () => {
			let dispatched = false;
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('pre-q', async () => {
				dispatched = true;
			});

			repo.enqueue({ queue: 'pre-q', payload: {} });
			processor.start(); // triggers immediate tick
			await flush();
			await processor.stop();

			expect(dispatched).toBe(true);
		});

		it('processes a job enqueued after start() via the poll interval', async () => {
			let dispatched = false;
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 30 });
			processor.register('post-q', async () => {
				dispatched = true;
			});

			processor.start();
			// Enqueue after start so the initial tick misses it.
			await flush(10);
			repo.enqueue({ queue: 'post-q', payload: {} });

			// Wait for at least one poll interval to fire.
			await flush(80);
			await processor.stop();

			expect(dispatched).toBe(true);
		});

		it('delivers the correct job object with payload to the handler', async () => {
			let receivedPayload: Record<string, unknown> | null = null;
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('payload-q', async (job) => {
				receivedPayload = job.payload;
			});

			repo.enqueue({ queue: 'payload-q', payload: { key: 'hello', n: 42 } });
			processor.start();
			await flush();
			await processor.stop();

			expect(receivedPayload).toEqual({ key: 'hello', n: 42 });
		});

		it('marks a successfully handled job as completed', async () => {
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('done-q', async () => ({ ok: true }));

			const job = repo.enqueue({ queue: 'done-q', payload: {} });
			processor.start();
			await flush();
			await processor.stop();

			const updated = repo.getJob(job.id);
			expect(updated?.status).toBe('completed');
			expect(updated?.result).toEqual({ ok: true });
		});
	});

	// ─── stop() drains in-flight jobs ─────────────────────────────────────────

	describe('stop() drains in-flight jobs', () => {
		it('resolves only after all in-flight jobs have finished', async () => {
			let jobDone = false;
			let unblock!: () => void;

			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('drain-q', async () => {
				await new Promise<void>((resolve) => {
					unblock = resolve;
				});
				jobDone = true;
			});

			repo.enqueue({ queue: 'drain-q', payload: {} });
			processor.start();
			await flush(); // allow job to be dequeued and dispatched

			const stopPromise = processor.stop();

			// stop() must NOT have resolved yet — job is still in-flight.
			expect(jobDone).toBe(false);

			// Unblock the in-flight job.
			unblock();
			await stopPromise;

			// stop() resolves only after the job finishes.
			expect(jobDone).toBe(true);
		});

		it('resolves immediately when there are no in-flight jobs', async () => {
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.start();

			// No jobs enqueued — stop() should resolve right away.
			await expect(processor.stop()).resolves.toBeUndefined();
		});

		it('does not process new jobs after stop()', async () => {
			let callCount = 0;
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 20 });
			processor.register('post-stop-q', async () => {
				callCount++;
			});

			processor.start();
			await processor.stop();

			// Enqueue after stop — the interval is cleared so nothing should run.
			repo.enqueue({ queue: 'post-stop-q', payload: {} });
			await flush(80);

			expect(callCount).toBe(0);
		});
	});

	// ─── setChangeNotifier callback on status transitions ─────────────────────

	describe('setChangeNotifier', () => {
		it('invokes the notifier with "job_queue" when a job completes successfully', async () => {
			const tables: string[] = [];
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.setChangeNotifier((t) => tables.push(t));
			processor.register('notify-ok-q', async () => {});

			repo.enqueue({ queue: 'notify-ok-q', payload: {} });
			processor.start();
			await flush();
			await processor.stop();

			expect(tables.length).toBeGreaterThan(0);
			expect(tables.every((t) => t === 'job_queue')).toBe(true);
		});

		it('invokes the notifier when a job exhausts retries and becomes dead', async () => {
			const tables: string[] = [];
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.setChangeNotifier((t) => tables.push(t));
			processor.register('notify-dead-q', async () => {
				throw new Error('always fails');
			});

			repo.enqueue({ queue: 'notify-dead-q', payload: {}, maxRetries: 0 });
			processor.start();
			await flush();
			await processor.stop();

			expect(tables.length).toBeGreaterThan(0);
		});

		it('invokes the notifier when a job fails and is re-queued for retry', async () => {
			const tables: string[] = [];
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.setChangeNotifier((t) => tables.push(t));
			processor.register('notify-retry-q', async () => {
				throw new Error('transient');
			});

			// maxRetries=3 means first failure → pending (retry scheduled)
			repo.enqueue({ queue: 'notify-retry-q', payload: {}, maxRetries: 3 });
			processor.start();
			await flush();
			await processor.stop();

			expect(tables.length).toBeGreaterThan(0);
		});

		it('does not invoke the notifier when no jobs are processed', async () => {
			const tables: string[] = [];
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.setChangeNotifier((t) => tables.push(t));
			processor.register('silent-q', async () => {});

			// No jobs enqueued.
			processor.start();
			await flush();
			await processor.stop();

			expect(tables.length).toBe(0);
		});
	});

	// ─── error → retry → dead transitions ─────────────────────────────────────

	describe('error → retry → dead transitions', () => {
		it('increments retryCount and resets to pending on first handler failure', async () => {
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('retry-q', async () => {
				throw new Error('boom');
			});

			const job = repo.enqueue({ queue: 'retry-q', payload: {}, maxRetries: 2 });
			processor.start();
			await flush();
			await processor.stop();

			const updated = repo.getJob(job.id);
			expect(updated?.status).toBe('pending');
			expect(updated?.retryCount).toBe(1);
			expect(updated?.error).toBe('boom');
		});

		it('marks job as dead after all retries are exhausted (full retry sequence)', async () => {
			// maxRetries=1 means: first failure → pending (retryCount=1), second failure → dead.
			let failCount = 0;
			const processor = new JobQueueProcessor(repo, {
				pollIntervalMs: 5, // fast polling to drive the retry cycle
				maxConcurrent: 1,
			});
			processor.register('exhaust-q', async () => {
				failCount++;
				throw new Error(`failure #${failCount}`);
			});

			const job = repo.enqueue({ queue: 'exhaust-q', payload: {}, maxRetries: 1 });
			processor.start();

			// Wait enough time for both attempts: initial + retry (run_at delay from exponential backoff).
			// Exponential backoff: delay = 2^retryCount * 1000 ms = 1000 ms for first retry.
			// To avoid a 1 s sleep, override run_at directly after the first failure.
			await flush(50);

			// Advance run_at for the retried job so it can be dequeued immediately.
			db.prepare(`UPDATE job_queue SET run_at = ? WHERE id = ? AND status = 'pending'`).run(
				Date.now(),
				job.id
			);

			await flush(50);
			await processor.stop();

			const final = repo.getJob(job.id);
			expect(final?.status).toBe('dead');
			expect(failCount).toBe(2);
		});

		it('stores the error message from the handler on each failure', async () => {
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('err-msg-q', async () => {
				throw new Error('specific error message');
			});

			const job = repo.enqueue({ queue: 'err-msg-q', payload: {}, maxRetries: 0 });
			processor.start();
			await flush();
			await processor.stop();

			expect(repo.getJob(job.id)?.error).toBe('specific error message');
		});

		it('handles non-Error throws by converting to string', async () => {
			const processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000 });
			processor.register('str-throw-q', async () => {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw 'plain string error';
			});

			const job = repo.enqueue({ queue: 'str-throw-q', payload: {}, maxRetries: 0 });
			processor.start();
			await flush();
			await processor.stop();

			const updated = repo.getJob(job.id);
			expect(updated?.status).toBe('dead');
			expect(updated?.error).toBe('plain string error');
		});
	});

	// ─── Stale job reclamation timing ─────────────────────────────────────────

	describe('stale job reclamation timing', () => {
		it('resets a stale processing job to pending during the first tick', async () => {
			// Create a job and mark it as processing.
			const job = repo.enqueue({ queue: 'stale-q', payload: {} });
			repo.dequeue('stale-q', 1);
			expect(repo.getJob(job.id)?.status).toBe('processing');

			// Back-date started_at so the job is well past the stale threshold.
			db.prepare(`UPDATE job_queue SET started_at = ? WHERE id = ?`).run(
				Date.now() - 20_000,
				job.id
			);

			// Use a fresh processor so lastStaleCheck=0 → stale check runs on the very first tick.
			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 1_000,
				pollIntervalMs: 60_000,
			});
			processor.register('stale-q', async () => {});

			await processor.tick();
			// After tick, reclaimStale has run and re-queued the stale job as pending;
			// the same tick then dequeues and processes it.
			await flush();

			expect(repo.getJob(job.id)?.status).toBe('completed');
			await processor.stop();
		});

		it('resets stale job to pending (not directly to completed) before the handler picks it up', async () => {
			// Verify the reclaim itself transitions the job to pending, not the handler.
			const job = repo.enqueue({ queue: 'reclaim-seq-q', payload: {} });
			repo.dequeue('reclaim-seq-q', 1);

			db.prepare(`UPDATE job_queue SET started_at = ? WHERE id = ?`).run(
				Date.now() - 20_000,
				job.id
			);

			// Track status at the moment reclaimStale is called.
			let statusAtReclaim: string | undefined;
			const originalReclaim = repo.reclaimStale.bind(repo);
			repo.reclaimStale = (staleBefore: number) => {
				const count = originalReclaim(staleBefore);
				statusAtReclaim = repo.getJob(job.id)?.status;
				return count;
			};

			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 1_000,
				pollIntervalMs: 60_000,
			});
			processor.register('reclaim-seq-q', async () => {});

			await processor.tick();
			await flush();
			await processor.stop();

			// After reclaimStale returns, the job should be pending (not yet completed).
			expect(statusAtReclaim).toBe('pending');
			// After processing, it should be completed.
			expect(repo.getJob(job.id)?.status).toBe('completed');
		});

		it('throttles stale checks to at most once per STALE_CHECK_INTERVAL', async () => {
			let reclaimCallCount = 0;
			const original = repo.reclaimStale.bind(repo);
			repo.reclaimStale = (staleBefore: number) => {
				reclaimCallCount++;
				return original(staleBefore);
			};

			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 100,
				pollIntervalMs: 60_000,
			});
			processor.register('throttle-q', async () => {});

			// First tick: lastStaleCheck=0, so stale check runs.
			await processor.tick();
			const countAfterFirst = reclaimCallCount;
			expect(countAfterFirst).toBeGreaterThanOrEqual(1);

			// Second tick within the same 60 s window: stale check must be skipped.
			await processor.tick();
			expect(reclaimCallCount).toBe(countAfterFirst);

			await processor.stop();
		});

		it('does not reclaim jobs started within the stale threshold window', async () => {
			const job = repo.enqueue({ queue: 'fresh-proc-q', payload: {} });
			repo.dequeue('fresh-proc-q', 1);

			// started_at = now (within any reasonable threshold).
			db.prepare(`UPDATE job_queue SET started_at = ? WHERE id = ?`).run(Date.now(), job.id);

			const processor = new JobQueueProcessor(repo, {
				staleThresholdMs: 60_000,
				pollIntervalMs: 60_000,
			});
			processor.register('fresh-proc-q', async () => {});

			await processor.tick();
			await flush();
			await processor.stop();

			// Job should remain in processing — not reclaimed.
			expect(repo.getJob(job.id)?.status).toBe('processing');
		});
	});
});
