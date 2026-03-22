/**
 * Integration tests: Job Queue crash/restart recovery
 *
 * Verifies that all job types survive a daemon crash and are correctly
 * reclaimed/processed when the daemon restarts against the same database.
 *
 * Each test follows the same pattern:
 *  1. Start "daemon-1" with a **file-backed** SQLite DB (not in-memory).
 *  2. Enqueue a job (or let daemon startup enqueue one automatically).
 *  3. Insert a stale 'processing' record directly into the DB to simulate
 *     a mid-execution crash — or let an in-flight job represent the crash.
 *  4. Stop daemon-1 (graceful shutdown, but the stale DB rows remain).
 *  5. Start "daemon-2" against the **same** DB file.
 *  6. Verify that `JobQueueProcessor.start()` calls `reclaimStale()` eagerly
 *     on startup and that the job is picked up and processed without manual
 *     intervention.
 *
 * Key behaviours verified:
 * - File-backed DB persists rows across daemon instances.
 * - Stale reclamation is eager (happens immediately at start(), not after
 *   the 60 s polling cadence).
 * - Self-scheduling chains (github.poll, room.tick, job_queue.cleanup) resume
 *   automatically after the stale job is processed.
 * - No jobs are lost after a restart.
 *
 * NOTE: These tests do NOT require real Anthropic API calls.  The
 * NEOKAI_USE_DEV_PROXY=1 flag routes all SDK traffic through devproxy.
 * Tests that never touch the LLM path work equally well without it.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createDaemonApp, type DaemonAppContext } from '../../../src/app';
import { getConfig } from '../../../src/config';
import {
	GITHUB_POLL,
	JOB_QUEUE_CLEANUP,
	ROOM_TICK,
	SESSION_TITLE_GENERATION,
} from '../../../src/lib/job-queue-constants';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Root directory where all file-backed test DBs are stored. */
const TEST_DB_DIR = path.join(process.cwd(), 'tmp', 'test-crash-recovery');

/** Milliseconds to wait for a job to reach a target status. */
const JOB_WAIT_TIMEOUT_MS = 10_000;

/** Polling cadence for job-status checks. */
const POLL_INTERVAL_MS = 50;

/** GitHub poll env vars — fake token, very long interval so chain doesn't auto-fire. */
const GITHUB_TEST_ENV: Record<string, string> = {
	GITHUB_POLLING_INTERVAL: '600', // 10 min — keeps the self-scheduled job far away
	GITHUB_TOKEN: 'ghp_fake_token_for_crash_recovery_test',
};

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/** Track contexts created during a test so afterEach can clean them up. */
let openContexts: DaemonAppContext[] = [];

/**
 * Create a daemon with a file-backed SQLite DB.
 *
 * Each call re-uses the provided `dbPath` so the second daemon instance
 * inherits all rows written by the first one.
 */
async function startDaemon(
	dbPath: string,
	extraEnv: Record<string, string> = {}
): Promise<DaemonAppContext> {
	// Derive a temporary workspace from the DB path (each run gets its own dir
	// so concurrent tests do not collide on the workspace root).
	const workspace = path.dirname(dbPath);

	// Apply env vars — reset after the test in afterEach.
	process.env.NEOKAI_WORKSPACE_PATH = workspace;
	process.env.NODE_ENV = 'test';
	if (!process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS) {
		process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = '30000';
	}
	for (const [k, v] of Object.entries(extraEnv)) {
		process.env[k] = v;
	}

	// Build config with an explicit DB path so both daemon instances share data.
	const config = getConfig();
	config.port = 0; // OS-assigned port — avoids collisions
	config.dbPath = dbPath;

	const ctx = await createDaemonApp({ config, verbose: false, standalone: false });
	openContexts.push(ctx);
	return ctx;
}

/** Gracefully stop a daemon and remove it from the tracked list. */
async function stopDaemon(ctx: DaemonAppContext): Promise<void> {
	openContexts = openContexts.filter((c) => c !== ctx);
	try {
		await Promise.race([
			ctx.cleanup(),
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error('daemon cleanup timeout')), 8_000)
			),
		]);
	} catch {
		// Best-effort — the point is to let the DB flush and close.
	}
}

// ---------------------------------------------------------------------------
// Job-polling helpers
// ---------------------------------------------------------------------------

/**
 * Poll the job queue until at least one job in the given `queue` reaches one
 * of the target `statuses`, or until `timeoutMs` elapses.
 */
async function waitForJob(
	ctx: DaemonAppContext,
	queue: string,
	statuses: JobStatus[],
	timeoutMs = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = ctx.jobQueue.listJobs({ queue, status: statuses });
		if (jobs.length > 0) return jobs[0];
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Poll for a specific job by id until it reaches one of the target statuses.
 */
async function waitForJobById(
	ctx: DaemonAppContext,
	queue: string,
	jobId: string,
	statuses: JobStatus[],
	timeoutMs = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = ctx.jobQueue.listJobs({ queue, status: statuses });
		const match = jobs.find((j) => j.id === jobId);
		if (match) return match;
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Return the current job row for a specific id, regardless of status.
 */
function getJobById(ctx: DaemonAppContext, jobId: string): Job | undefined {
	// listJobs doesn't filter by id directly — search across all terminal + active statuses.
	const all = ctx.jobQueue.listJobs({
		status: ['pending', 'processing', 'completed', 'failed', 'dead'],
		limit: 1000,
	});
	return all.find((j) => j.id === jobId);
}

/**
 * Insert a 'processing' job row directly into the database to simulate a
 * daemon that crashed while executing the job.  `startedAtMs` defaults to
 * 6 minutes ago so it exceeds the processor's 5-minute stale threshold.
 */
function insertStaleProcessingJob(
	ctx: DaemonAppContext,
	queue: string,
	payload: Record<string, unknown> = {},
	startedAtMs = Date.now() - 6 * 60 * 1000
): string {
	const jobId = crypto.randomUUID();
	ctx.db
		.getDatabase()
		.prepare(
			`INSERT INTO job_queue
			(id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, completed_at)
			VALUES (?, ?, 'processing', ?, NULL, NULL, 0, 3, 0, ?, ?, ?, NULL)`
		)
		.run(jobId, queue, JSON.stringify(payload), startedAtMs, startedAtMs, startedAtMs);
	return jobId;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
	await Bun.$`mkdir -p ${TEST_DB_DIR}`.quiet();
});

afterEach(async () => {
	// Stop any daemon contexts that were not explicitly stopped inside the test.
	const remaining = [...openContexts];
	openContexts = [];
	await Promise.allSettled(
		remaining.map((ctx) =>
			Promise.race([
				ctx.cleanup(),
				new Promise<void>((_, reject) =>
					setTimeout(() => reject(new Error('cleanup timeout')), 8_000)
				),
			]).catch(() => {})
		)
	);
});

afterAll(async () => {
	// Remove all file-backed DB files created during this test run.
	try {
		fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup — a leftover directory is not a test failure.
	}
});

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('Job queue crash/restart recovery (integration)', () => {
	// -------------------------------------------------------------------------
	// 1. Session title generation recovery
	// -------------------------------------------------------------------------

	test('session.title_generation: stale processing job is reclaimed and processed on restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `session-title-${Date.now()}.db`);

		// --- Daemon-1: simulate a crash mid-title-generation ---
		const daemon1 = await startDaemon(dbPath);

		// Insert a stale processing job (simulates crash while generating title).
		const staleJobId = insertStaleProcessingJob(daemon1, SESSION_TITLE_GENERATION, {
			sessionId: 'test-session-crash-recovery',
			userMessageText: 'Hello, trigger title generation',
		});

		// Verify the stale job is visible.
		const before = daemon1.jobQueue.listJobs({
			queue: SESSION_TITLE_GENERATION,
			status: ['processing'],
		});
		expect(before.some((j) => j.id === staleJobId)).toBe(true);

		// Gracefully stop daemon-1 (rows persist in the file-backed DB).
		await stopDaemon(daemon1);

		// --- Daemon-2: restart against the same DB ---
		const daemon2 = await startDaemon(dbPath);

		// JobQueueProcessor.start() calls reclaimStale() eagerly — the
		// stale job should immediately be back to 'pending'.
		const reclaimed = daemon2.jobQueue.listJobs({
			queue: SESSION_TITLE_GENERATION,
			status: ['pending'],
		});
		expect(reclaimed.some((j) => j.id === staleJobId)).toBe(true);

		// The processor picks up the pending job and attempts to execute it.
		// The title handler will fail (no real session) but the important
		// assertion is that the job was reclaimed and transitioned out of
		// 'processing' — i.e., no job is lost.
		const processed = await waitForJobById(
			daemon2,
			SESSION_TITLE_GENERATION,
			staleJobId,
			['completed', 'failed', 'dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(processed).toBeDefined();
		expect(['completed', 'failed', 'dead']).toContain(processed!.status);

		await stopDaemon(daemon2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 2. GitHub poll chain recovery
	// -------------------------------------------------------------------------

	test('github.poll: self-scheduling chain resumes after daemon restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `github-poll-${Date.now()}.db`);

		// --- Daemon-1: start with GitHub polling enabled ---
		const daemon1 = await startDaemon(dbPath, GITHUB_TEST_ENV);

		// Stub triggerPoll so no real GitHub calls are made.
		const stubTriggerPoll = (ctx: DaemonAppContext) => {
			const svc = ctx.gitHubService?.getPollingService();
			if (svc) svc.triggerPoll = async () => {};
		};
		stubTriggerPoll(daemon1);

		// gitHubService.start() seeds the initial github.poll job synchronously.
		expect(daemon1.gitHubService).not.toBeNull();
		const initialJobs = daemon1.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending', 'processing'],
		});
		expect(initialJobs.length).toBeGreaterThanOrEqual(1);

		// Wait for the first job to complete so the self-scheduled follow-up
		// job is enqueued.
		const firstCompleted = await waitForJob(daemon1, GITHUB_POLL, ['completed']);
		expect(firstCompleted).toBeDefined();

		// The follow-up job should now be pending (scheduled ~600 s out).
		const followUpBefore = daemon1.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending'],
		});
		expect(followUpBefore.length).toBeGreaterThanOrEqual(1);
		const followUpId = followUpBefore[0].id;

		// Simulate a crash: insert a stale processing job (the follow-up
		// arrived earlier than expected and was being processed when daemon died).
		const crashedJobId = insertStaleProcessingJob(daemon1, GITHUB_POLL);

		// Verify it shows up as 'processing' before stopping daemon-1.
		const beforeStop = daemon1.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['processing'],
		});
		expect(beforeStop.some((j) => j.id === crashedJobId)).toBe(true);

		await stopDaemon(daemon1);

		// --- Daemon-2: restart ---
		const daemon2 = await startDaemon(dbPath, GITHUB_TEST_ENV);
		stubTriggerPoll(daemon2);

		// Eager reclamation: the stale 'processing' job is reclaimed to 'pending'
		// by jobProcessor.start() and then immediately picked up by the processor.
		// By the time we check, it may already be 'completed'.  Assert it is no
		// longer stuck in a stale 'processing' state (i.e. it was processed).
		const result = await waitForJobById(
			daemon2,
			GITHUB_POLL,
			crashedJobId,
			['completed', 'failed', 'dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(result).toBeDefined();
		expect(result!.status).toBe('completed'); // github.poll handler should succeed

		// The previously scheduled follow-up job must still exist in the DB
		// (not lost across the restart).
		const followUpAfter = getJobById(daemon2, followUpId);
		expect(followUpAfter).toBeDefined();

		// Chain continuity: at least one pending poll job exists (either the
		// preserved follow-up or a newly self-scheduled one).
		const pendingAfter = daemon2.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending'],
		});
		expect(pendingAfter.length).toBeGreaterThanOrEqual(1);

		await stopDaemon(daemon2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 3. Room tick recovery
	// -------------------------------------------------------------------------

	test('room.tick: stale tick job is reclaimed and processed on restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `room-tick-${Date.now()}.db`);

		// --- Daemon-1: start and insert a stale tick job for a fake room ---
		const daemon1 = await startDaemon(dbPath);

		const fakeRoomId = `test-room-${crypto.randomUUID()}`;

		// Insert a stale room.tick job to simulate a crash mid-tick.
		const staleTick = insertStaleProcessingJob(daemon1, ROOM_TICK, {
			roomId: fakeRoomId,
		});

		// Verify the stale tick is visible as 'processing' before stopping.
		const processingBefore = daemon1.jobQueue.listJobs({
			queue: ROOM_TICK,
			status: ['processing'],
		});
		expect(processingBefore.some((j) => j.id === staleTick)).toBe(true);

		await stopDaemon(daemon1);

		// --- Daemon-2: restart ---
		const daemon2 = await startDaemon(dbPath);

		// Eager reclamation moves the job from 'processing' to 'pending', and
		// the processor immediately picks it up.  The handler will not find a
		// live runtime for fakeRoomId so it exits cleanly.
		// Key assertion: job must NOT stay stuck in 'processing'.
		const result = await waitForJobById(
			daemon2,
			ROOM_TICK,
			staleTick,
			['completed', 'failed', 'dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(result).toBeDefined();
		expect(['completed', 'failed', 'dead']).toContain(result!.status);

		await stopDaemon(daemon2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 4. Cleanup job recovery
	// -------------------------------------------------------------------------

	test('job_queue.cleanup: stale cleanup job is reclaimed and runs on restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `cleanup-job-${Date.now()}.db`);

		// --- Daemon-1: start, let it enqueue the initial cleanup job, then crash ---
		const daemon1 = await startDaemon(dbPath);

		// app.ts enqueues the initial cleanup job at startup if none exists.
		const initialCleanup = daemon1.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: ['pending', 'processing', 'completed'],
		});
		expect(initialCleanup.length).toBeGreaterThanOrEqual(1);

		// Simulate a crash: insert a stale processing cleanup job.
		const staleCleanupId = insertStaleProcessingJob(daemon1, JOB_QUEUE_CLEANUP);

		// Verify it shows up as 'processing' before stopping.
		const before = daemon1.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: ['processing'],
		});
		expect(before.some((j) => j.id === staleCleanupId)).toBe(true);

		await stopDaemon(daemon1);

		// --- Daemon-2: restart ---
		const daemon2 = await startDaemon(dbPath);

		// Eager reclamation: the stale cleanup job is reclaimed and processed.
		// The cleanup handler completes successfully (no old jobs to delete yet).
		const completed = await waitForJobById(
			daemon2,
			JOB_QUEUE_CLEANUP,
			staleCleanupId,
			['completed'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// After completion, the cleanup handler self-schedules the next run.
		const nextCleanup = await waitForJob(daemon2, JOB_QUEUE_CLEANUP, ['pending']);
		expect(nextCleanup).toBeDefined();

		// The next cleanup job should be scheduled ~24 h in the future.
		const minExpected = Date.now() + 23 * 60 * 60 * 1000; // 23 h from now
		expect(nextCleanup!.runAt).toBeGreaterThan(minExpected);

		await stopDaemon(daemon2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 5. Eager reclamation: jobs are reclaimed immediately, not after 60 s
	// -------------------------------------------------------------------------

	test('stale reclamation is eager: stale jobs are NOT stuck as processing after restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `eager-reclaim-${Date.now()}.db`);

		// --- Daemon-1: create stale jobs then stop ---
		const daemon1 = await startDaemon(dbPath);

		const staleIds = [
			insertStaleProcessingJob(daemon1, SESSION_TITLE_GENERATION, {
				sessionId: 'eager-test-1',
				userMessageText: 'msg1',
			}),
			insertStaleProcessingJob(daemon1, JOB_QUEUE_CLEANUP),
		];

		// Verify all stale jobs are 'processing' in daemon-1.
		const processing1 = daemon1.jobQueue.listJobs({ status: ['processing'] });
		for (const id of staleIds) {
			expect(processing1.some((j) => j.id === id)).toBe(true);
		}

		await stopDaemon(daemon1);

		// --- Daemon-2: restart ---
		// jobProcessor.start() calls reclaimStale() synchronously BEFORE the
		// first poll tick fires.  So reclamation must already have happened
		// by the time createDaemonApp() resolves.
		const daemon2 = await startDaemon(dbPath);

		// None of the stale IDs should still be stuck as 'processing' (with
		// old stale startedAt values).  They must have been either reclaimed
		// to 'pending' or (if the processor ran very fast) already moved to
		// a terminal state.
		const stillStuckProcessing = daemon2.jobQueue
			.listJobs({ status: ['processing'] })
			.filter(
				(j) =>
					staleIds.includes(j.id) &&
					j.startedAt !== null &&
					j.startedAt < Date.now() - 5 * 60 * 1000
			);
		expect(stillStuckProcessing.length).toBe(0);

		// Each stale job should eventually reach a non-stuck state.
		for (const id of staleIds) {
			const final = await (async () => {
				const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
				while (Date.now() < deadline) {
					const job = getJobById(daemon2, id);
					if (job && ['pending', 'completed', 'failed', 'dead'].includes(job.status)) {
						return job;
					}
					// Still in 'processing' with a fresh startedAt (not stale) — that's fine.
					if (
						job &&
						job.status === 'processing' &&
						job.startedAt !== null &&
						job.startedAt > Date.now() - 5 * 60 * 1000
					) {
						// Being processed right now — wait for it to finish.
					}
					await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
				}
				return getJobById(daemon2, id);
			})();
			expect(final).toBeDefined();
			expect(['pending', 'completed', 'failed', 'dead']).toContain(final!.status);
		}

		await stopDaemon(daemon2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 6. File-backed DB persists jobs across instances
	// -------------------------------------------------------------------------

	test('file-backed DB: jobs written by daemon-1 are visible to daemon-2', async () => {
		const dbPath = path.join(TEST_DB_DIR, `file-backed-${Date.now()}.db`);

		// --- Daemon-1: enqueue a future pending job then stop ---
		const daemon1 = await startDaemon(dbPath);

		const futureRunAt = Date.now() + 60 * 60 * 1000; // 1 h from now
		const enqueuedJob = daemon1.jobQueue.enqueue({
			queue: SESSION_TITLE_GENERATION,
			payload: { sessionId: 'persist-test', userMessageText: 'hello' },
			runAt: futureRunAt,
		});

		expect(enqueuedJob.id).toBeTruthy();
		expect(enqueuedJob.status).toBe('pending');

		await stopDaemon(daemon1);

		// --- Daemon-2: restart ---
		const daemon2 = await startDaemon(dbPath);

		// The job enqueued by daemon-1 must survive in the file-backed DB.
		const jobs = daemon2.jobQueue.listJobs({
			queue: SESSION_TITLE_GENERATION,
			status: ['pending'],
		});
		expect(jobs.some((j) => j.id === enqueuedJob.id)).toBe(true);

		const found = jobs.find((j) => j.id === enqueuedJob.id)!;
		// runAt must not be corrupted across restart.
		expect(Math.abs(found.runAt - futureRunAt)).toBeLessThan(1000);

		await stopDaemon(daemon2);
	}, 30_000);
});
