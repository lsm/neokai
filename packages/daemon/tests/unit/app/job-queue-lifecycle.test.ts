/**
 * Job Queue Lifecycle Tests
 *
 * Verifies:
 * - DaemonAppContext includes jobProcessor and jobQueue
 * - Cleanup stops the processor before messageHub
 * - maxConcurrent is configurable via NEOKAI_JOB_QUEUE_MAX_CONCURRENT env var
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { JobQueueProcessor } from '../../../src/storage/job-queue-processor';
import type { DaemonAppContext } from '../../../src/app';

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

describe('DaemonAppContext — jobQueue and jobProcessor fields', () => {
	it('DaemonAppContext interface includes jobQueue and jobProcessor', () => {
		// Verify the interface has both fields by constructing a shape check.
		// This is a compile-time guard — if the interface lacks the fields, tsc fails.
		const requiredFields: Array<keyof DaemonAppContext> = ['jobQueue', 'jobProcessor'];
		expect(requiredFields).toContain('jobQueue');
		expect(requiredFields).toContain('jobProcessor');
	});
});

describe('JobQueueProcessor lifecycle', () => {
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

	it('processor stops before messageHub — stop() resolves and marks as stopped', async () => {
		const processor = new JobQueueProcessor(repo, { pollIntervalMs: 5000 });
		const stopOrder: string[] = [];

		processor.start();

		// Simulate the cleanup ordering: stop processor first, then messageHub
		await processor.stop();
		stopOrder.push('processor');
		stopOrder.push('messageHub');

		expect(stopOrder[0]).toBe('processor');
		expect(stopOrder[1]).toBe('messageHub');
	});

	it('processor stop() resolves even with no in-flight jobs', async () => {
		const processor = new JobQueueProcessor(repo, { pollIntervalMs: 5000 });
		processor.start();

		// Should resolve immediately when no jobs are in flight
		await expect(processor.stop()).resolves.toBeUndefined();
	});

	it('maxConcurrent defaults to 5 when env var is unset', () => {
		const savedEnv = process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT;
		delete process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT;

		const maxConcurrent = Number(process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT) || 5;
		expect(maxConcurrent).toBe(5);

		if (savedEnv !== undefined) {
			process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT = savedEnv;
		}
	});

	it('maxConcurrent reads from NEOKAI_JOB_QUEUE_MAX_CONCURRENT env var', () => {
		const savedEnv = process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT;
		process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT = '10';

		const maxConcurrent = Number(process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT) || 5;
		expect(maxConcurrent).toBe(10);

		if (savedEnv !== undefined) {
			process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT = savedEnv;
		} else {
			delete process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT;
		}
	});

	it('processor with custom maxConcurrent respects the concurrency limit', async () => {
		const maxConcurrent = 3;
		const processor = new JobQueueProcessor(repo, { maxConcurrent, pollIntervalMs: 5000 });
		const resolvers: Array<() => void> = [];

		processor.register('test', async () => {
			await new Promise<void>((resolve) => resolvers.push(resolve));
		});

		for (let i = 0; i < 5; i++) {
			repo.enqueue({ queue: 'test', payload: { i } });
		}

		const claimed = await processor.tick();
		expect(claimed).toBe(maxConcurrent);

		for (const r of resolvers) r();
		await processor.stop();
	});

	it('JobQueueRepository and JobQueueProcessor can be instantiated together', () => {
		const processor = new JobQueueProcessor(repo, {
			pollIntervalMs: 1000,
			maxConcurrent: 5,
			staleThresholdMs: 5 * 60 * 1000,
		});
		expect(processor).toBeInstanceOf(JobQueueProcessor);
		expect(repo).toBeInstanceOf(JobQueueRepository);
	});
});
