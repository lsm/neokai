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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

/**
 * Per-daemon env snapshot captured by startDaemon.  Restored by stopDaemon
 * so env vars do not leak between tests (and between daemon-1 / daemon-2
 * within the same test).
 */
interface DaemonHandle {
	ctx: DaemonAppContext;
	/** DB file path — deleted per-test in afterEach. */
	dbPath: string;
	/** Keys whose original values were saved before mutation. */
	savedEnv: Record<string, string | undefined>;
}

/** All handles created during the current test. */
let openHandles: DaemonHandle[] = [];

/**
 * Create a daemon with a file-backed SQLite DB.
 *
 * Captures and saves all env vars before mutating them.  Call stopDaemon()
 * (or rely on afterEach) to restore them.
 */
async function startDaemon(
	dbPath: string,
	extraEnv: Record<string, string> = {}
): Promise<DaemonHandle> {
	const workspace = path.dirname(dbPath);

	// Keys that startDaemon will mutate — capture originals before any change.
	const envKeys = [
		'NEOKAI_WORKSPACE_PATH',
		'NODE_ENV',
		'NEOKAI_SDK_STARTUP_TIMEOUT_MS',
		...Object.keys(extraEnv),
	];
	const savedEnv: Record<string, string | undefined> = {};
	for (const k of envKeys) {
		savedEnv[k] = process.env[k];
	}

	// Apply env vars.  Restored in stopDaemon / afterEach via restoreEnv().
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
	const handle: DaemonHandle = { ctx, dbPath, savedEnv };
	openHandles.push(handle);
	return handle;
}

/** Restore env vars that were saved when the daemon was started. */
function restoreEnv(handle: DaemonHandle): void {
	for (const [k, original] of Object.entries(handle.savedEnv)) {
		if (original === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = original;
		}
	}
}

/** Gracefully stop a daemon and restore its env snapshot. */
async function stopDaemon(handle: DaemonHandle): Promise<void> {
	openHandles = openHandles.filter((h) => h !== handle);
	try {
		await Promise.race([
			handle.ctx.cleanup(),
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error('daemon cleanup timeout')), 8_000)
			),
		]);
	} catch {
		// Best-effort — the point is to let the DB flush and close.
	} finally {
		restoreEnv(handle);
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
	handle: DaemonHandle,
	queue: string,
	payload: Record<string, unknown> = {},
	startedAtMs = Date.now() - 6 * 60 * 1000
): string {
	const jobId = crypto.randomUUID();
	handle.ctx.db
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
	// Stop any daemon handles that were not explicitly stopped inside the test
	// and restore their env snapshots.
	const remaining = [...openHandles];
	openHandles = [];
	await Promise.allSettled(
		remaining.map((handle) =>
			Promise.race([
				handle.ctx.cleanup(),
				new Promise<void>((_, reject) =>
					setTimeout(() => reject(new Error('cleanup timeout')), 8_000)
				),
			])
				.catch(() => {})
				.finally(() => restoreEnv(handle))
		)
	);

	// Clean up DB files created during this test.  Each test uses its own
	// timestamped DB path, so deleting all *.db files under TEST_DB_DIR is safe.
	// Per-test cleanup bounds disk usage even if the process crashes mid-run.
	try {
		for (const file of fs.readdirSync(TEST_DB_DIR)) {
			if (file.endsWith('.db') || file.endsWith('.db-wal') || file.endsWith('.db-shm')) {
				fs.rmSync(path.join(TEST_DB_DIR, file), { force: true });
			}
		}
	} catch {
		// Directory may not exist yet or already deleted — not a failure.
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
		const h1 = await startDaemon(dbPath);

		// Insert a stale processing job (simulates crash while generating title).
		const staleJobId = insertStaleProcessingJob(h1, SESSION_TITLE_GENERATION, {
			sessionId: 'test-session-crash-recovery',
			userMessageText: 'Hello, trigger title generation',
		});

		// Verify the stale job is visible as 'processing' before stopping.
		const before = h1.ctx.jobQueue.listJobs({
			queue: SESSION_TITLE_GENERATION,
			status: ['processing'],
		});
		expect(before.some((j) => j.id === staleJobId)).toBe(true);

		// Gracefully stop daemon-1 (rows persist in the file-backed DB).
		await stopDaemon(h1);

		// --- Daemon-2: restart against the same DB ---
		const h2 = await startDaemon(dbPath);

		// JobQueueProcessor.start() calls reclaimStale() synchronously before
		// start() returns, so the stale job is no longer stuck.  tick() is also
		// fired (async) so by the time this check runs the job may already be
		// in fresh 'processing' (dequeued with a new startedAt) or terminal.
		// Assert "not stuck as stale" rather than checking for a specific status.
		const reclaimedJob = getJobById(h2.ctx, staleJobId);
		expect(reclaimedJob).toBeDefined();
		const isStillStale =
			reclaimedJob!.status === 'processing' &&
			reclaimedJob!.startedAt !== null &&
			reclaimedJob!.startedAt < Date.now() - 5 * 60 * 1000;
		expect(isStillStale).toBe(false);

		// The processor picks up the pending job and attempts to execute it.
		// The title handler will fail (no real session) but the important
		// assertion is that the job was reclaimed and transitioned out of
		// the stale 'processing' state — i.e., no job is permanently lost.
		const processed = await waitForJobById(
			h2.ctx,
			SESSION_TITLE_GENERATION,
			staleJobId,
			['completed', 'failed', 'dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(processed).toBeDefined();
		expect(['completed', 'failed', 'dead']).toContain(processed!.status);

		await stopDaemon(h2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 2. GitHub poll chain recovery
	// -------------------------------------------------------------------------

	test('github.poll: self-scheduling chain resumes after daemon restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `github-poll-${Date.now()}.db`);

		// --- Daemon-1: start with GitHub polling enabled ---
		const h1 = await startDaemon(dbPath, GITHUB_TEST_ENV);

		// Stub triggerPoll so no real GitHub calls are made.  The stub is
		// applied after createDaemonApp() resolves, which means the first
		// processor tick may already have dequeued the initial github.poll job
		// before the stub is installed.  This is safe for two reasons:
		//   a) No repositories are registered, so pollAllRepositories() is a no-op.
		//   b) Any error from triggerPoll() is caught inside handleGitHubPoll().
		// The same comment applies to daemon-2 below.
		const stubTriggerPoll = (ctx: DaemonAppContext) => {
			const svc = ctx.gitHubService?.getPollingService();
			if (svc) svc.triggerPoll = async () => {};
		};
		stubTriggerPoll(h1.ctx);

		// gitHubService.start() seeds the initial github.poll job synchronously.
		expect(h1.ctx.gitHubService).not.toBeNull();
		const initialJobs = h1.ctx.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending', 'processing'],
		});
		expect(initialJobs.length).toBeGreaterThanOrEqual(1);

		// Wait for the first job to complete so the self-scheduled follow-up
		// job (scheduled ~600 s out) is enqueued.
		const firstCompleted = await waitForJob(h1.ctx, GITHUB_POLL, ['completed']);
		expect(firstCompleted).toBeDefined();

		// The follow-up job should be pending (scheduled ~600 s out).
		const followUpBefore = h1.ctx.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending'],
		});
		expect(followUpBefore.length).toBeGreaterThanOrEqual(1);
		const followUpId = followUpBefore[0].id;

		// Simulate a crash: insert a brand-new stale processing job as if
		// the daemon was in the middle of executing an unscheduled poll when
		// it died (e.g., triggered by a webhook or manual event).
		const crashedJobId = insertStaleProcessingJob(h1, GITHUB_POLL);

		// Verify it shows up as 'processing' before stopping daemon-1.
		const beforeStop = h1.ctx.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['processing'],
		});
		expect(beforeStop.some((j) => j.id === crashedJobId)).toBe(true);

		await stopDaemon(h1);

		// --- Daemon-2: restart ---
		const h2 = await startDaemon(dbPath, GITHUB_TEST_ENV);
		// Same stub + same safety note as daemon-1.
		stubTriggerPoll(h2.ctx);

		// Eager reclamation: the stale 'processing' job is reclaimed to 'pending'
		// by jobProcessor.start() and then immediately picked up by the processor.
		// By the time we check, it may already be 'completed' — wait for any
		// terminal state.
		const result = await waitForJobById(
			h2.ctx,
			GITHUB_POLL,
			crashedJobId,
			['completed', 'failed', 'dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(result).toBeDefined();
		expect(result!.status).toBe('completed'); // github.poll handler should succeed

		// The previously scheduled follow-up job must still exist in the DB
		// (not lost across the restart).
		const followUpAfter = getJobById(h2.ctx, followUpId);
		expect(followUpAfter).toBeDefined();

		// Chain continuity: at least one pending poll job exists (either the
		// preserved follow-up or a newly self-scheduled one).
		const pendingAfter = h2.ctx.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending'],
		});
		expect(pendingAfter.length).toBeGreaterThanOrEqual(1);

		await stopDaemon(h2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 3. Room tick recovery
	// -------------------------------------------------------------------------

	test('room.tick: stale tick job is reclaimed and processed on restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `room-tick-${Date.now()}.db`);

		// --- Daemon-1: start and insert a stale tick job for a fake room ---
		const h1 = await startDaemon(dbPath);

		const fakeRoomId = `test-room-${crypto.randomUUID()}`;

		// Insert a stale room.tick job to simulate a crash mid-tick.
		const staleTick = insertStaleProcessingJob(h1, ROOM_TICK, { roomId: fakeRoomId });

		// Verify the stale tick is visible as 'processing' before stopping.
		const processingBefore = h1.ctx.jobQueue.listJobs({
			queue: ROOM_TICK,
			status: ['processing'],
		});
		expect(processingBefore.some((j) => j.id === staleTick)).toBe(true);

		await stopDaemon(h1);

		// --- Daemon-2: restart ---
		const h2 = await startDaemon(dbPath);

		// Eager reclamation moves the job from 'processing' to 'pending', and
		// the processor immediately picks it up.  The handler will not find a
		// live runtime for fakeRoomId so it exits cleanly (no self-reschedule).
		// Key assertion: job must NOT stay stuck in stale 'processing'.
		const result = await waitForJobById(
			h2.ctx,
			ROOM_TICK,
			staleTick,
			['completed', 'failed', 'dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(result).toBeDefined();
		expect(['completed', 'failed', 'dead']).toContain(result!.status);

		await stopDaemon(h2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 4. Cleanup job recovery
	// -------------------------------------------------------------------------

	test('job_queue.cleanup: stale cleanup job is reclaimed and runs on restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `cleanup-job-${Date.now()}.db`);

		// --- Daemon-1: start, let it enqueue the initial cleanup job, then crash ---
		const h1 = await startDaemon(dbPath);

		// app.ts enqueues the initial cleanup job at startup if none exists.
		const initialCleanup = h1.ctx.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: ['pending', 'processing', 'completed'],
		});
		expect(initialCleanup.length).toBeGreaterThanOrEqual(1);

		// Simulate a crash: insert a stale processing cleanup job.
		const staleCleanupId = insertStaleProcessingJob(h1, JOB_QUEUE_CLEANUP);

		// Verify it shows up as 'processing' before stopping.
		const before = h1.ctx.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: ['processing'],
		});
		expect(before.some((j) => j.id === staleCleanupId)).toBe(true);

		await stopDaemon(h1);

		// --- Daemon-2: restart ---
		const h2 = await startDaemon(dbPath);

		// Eager reclamation: the stale cleanup job is reclaimed and processed.
		// The cleanup handler completes successfully (no old jobs to delete yet).
		const completed = await waitForJobById(
			h2.ctx,
			JOB_QUEUE_CLEANUP,
			staleCleanupId,
			['completed'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// After completion, the cleanup handler self-schedules the next run.
		// Accept 'pending' or 'processing' — the processor may have picked it up
		// already by the time waitForJob polls.
		const nextCleanup = await waitForJob(
			h2.ctx,
			JOB_QUEUE_CLEANUP,
			['pending', 'processing'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(nextCleanup).toBeDefined();

		// The next cleanup job must be a *different* job (not the stale one that
		// just ran) and must be scheduled ~24 h in the future.
		expect(nextCleanup!.id).not.toBe(staleCleanupId);
		const minExpected = Date.now() + 23 * 60 * 60 * 1000; // 23 h from now
		expect(nextCleanup!.runAt).toBeGreaterThan(minExpected);

		await stopDaemon(h2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 5. Eager reclamation: jobs are reclaimed immediately, not after 60 s
	// -------------------------------------------------------------------------

	test('stale reclamation is eager: stale jobs are NOT stuck as processing after restart', async () => {
		const dbPath = path.join(TEST_DB_DIR, `eager-reclaim-${Date.now()}.db`);

		// --- Daemon-1: create stale jobs then stop ---
		const h1 = await startDaemon(dbPath);

		const staleIds = [
			insertStaleProcessingJob(h1, SESSION_TITLE_GENERATION, {
				sessionId: 'eager-test-1',
				userMessageText: 'msg1',
			}),
			insertStaleProcessingJob(h1, JOB_QUEUE_CLEANUP),
		];

		// Verify all stale jobs are 'processing' in daemon-1.
		const processing1 = h1.ctx.jobQueue.listJobs({ status: ['processing'] });
		for (const id of staleIds) {
			expect(processing1.some((j) => j.id === id)).toBe(true);
		}

		await stopDaemon(h1);

		// --- Daemon-2: restart ---
		// jobProcessor.start() calls reclaimStale() synchronously BEFORE the
		// first poll tick fires.  So reclamation must already have happened by
		// the time createDaemonApp() resolves.
		const h2 = await startDaemon(dbPath);

		// None of the stale IDs should still be stuck as 'processing' with
		// the old stale startedAt timestamp (> 5 min ago).  They must have been
		// either reclaimed to 'pending', dequeued to fresh 'processing', or
		// already moved to a terminal state.
		const stillStuckProcessing = h2.ctx.jobQueue
			.listJobs({ status: ['processing'] })
			.filter(
				(j) =>
					staleIds.includes(j.id) &&
					j.startedAt !== null &&
					j.startedAt < Date.now() - 5 * 60 * 1000
			);
		expect(stillStuckProcessing.length).toBe(0);

		// Each stale job should eventually reach a non-stuck terminal state.
		for (const id of staleIds) {
			const final = await (async () => {
				const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
				while (Date.now() < deadline) {
					const job = getJobById(h2.ctx, id);
					if (job && ['completed', 'failed', 'dead'].includes(job.status)) {
						return job;
					}
					await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
				}
				return getJobById(h2.ctx, id);
			})();
			expect(final).toBeDefined();
			expect(['completed', 'failed', 'dead']).toContain(final!.status);
		}

		await stopDaemon(h2);
	}, 30_000);

	// -------------------------------------------------------------------------
	// 6. File-backed DB persists jobs across instances
	// -------------------------------------------------------------------------

	test('file-backed DB: jobs written by daemon-1 are visible to daemon-2', async () => {
		const dbPath = path.join(TEST_DB_DIR, `file-backed-${Date.now()}.db`);

		// --- Daemon-1: enqueue a future pending job then stop ---
		const h1 = await startDaemon(dbPath);

		const futureRunAt = Date.now() + 60 * 60 * 1000; // 1 h from now
		const enqueuedJob = h1.ctx.jobQueue.enqueue({
			queue: SESSION_TITLE_GENERATION,
			payload: { sessionId: 'persist-test', userMessageText: 'hello' },
			runAt: futureRunAt,
		});

		expect(enqueuedJob.id).toBeTruthy();
		expect(enqueuedJob.status).toBe('pending');

		await stopDaemon(h1);

		// --- Daemon-2: restart ---
		const h2 = await startDaemon(dbPath);

		// The job enqueued by daemon-1 must survive in the file-backed DB.
		const jobs = h2.ctx.jobQueue.listJobs({
			queue: SESSION_TITLE_GENERATION,
			status: ['pending'],
		});
		expect(jobs.some((j) => j.id === enqueuedJob.id)).toBe(true);

		const found = jobs.find((j) => j.id === enqueuedJob.id)!;
		// runAt must not be corrupted across restart.
		expect(Math.abs(found.runAt - futureRunAt)).toBeLessThan(1000);

		await stopDaemon(h2);
	}, 30_000);
});
