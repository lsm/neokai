/**
 * Integration tests: job queue crash recovery
 *
 * These tests verify that all job types are correctly recovered after a
 * daemon crash/restart. Each test:
 *   1. Starts daemon-1 with a file-backed SQLite database.
 *   2. Inserts a stale "processing" job (simulating a daemon that crashed
 *      while handling that job) into the shared database.
 *   3. Stops daemon-1 cleanly (to close the database connection).
 *   4. Starts daemon-2 against the **same** database file.
 *   5. Asserts that the stale job transitions out of 'processing' within a
 *      short deadline — proving that JobQueueProcessor.start() eagerly calls
 *      reclaimStale() rather than waiting for the 60-second periodic check.
 *   6. Asserts that the processor subsequently finishes the job.
 *
 * Eagerness proof: if reclaimStale() were only periodic (every 60 s), the
 * stale job would be stuck in 'processing' for up to 60 s.  The tests use
 * a 5-second deadline for the reclaim assertion — succeeding quickly proves
 * the call is eager, not deferred.
 *
 * The file-backed database persists between daemon instances. Each test
 * generates a unique DB path under /tmp and cleans it up in afterAll.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test';
import path from 'path';
import fs from 'fs';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';
import {
	SESSION_TITLE_GENERATION,
	GITHUB_POLL,
	ROOM_TICK,
	JOB_QUEUE_CLEANUP,
} from '../../../src/lib/job-queue-constants';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Environment variables enabling GitHub polling without real credentials. */
const GITHUB_TEST_ENV: Record<string, string> = {
	GITHUB_POLLING_INTERVAL: '300',
	GITHUB_TOKEN: 'ghp_fake_token_for_crash_recovery_test',
};

/**
 * Short deadline for the eager-reclaim assertion.
 *
 * If reclaimStale() is called eagerly on startup (as expected), the stale job
 * transitions out of 'processing' within milliseconds.  We allow up to 5 s to
 * accommodate any startup overhead.  If the assertion fires within this window,
 * it proves reclamation was NOT deferred to the 60-second periodic schedule.
 */
const EAGER_RECLAIM_TIMEOUT_MS = 5_000;

/** Maximum ms to wait for a job to reach a final state in daemon-2. */
const JOB_COMPLETE_TIMEOUT_MS = 12_000;

/** Poll cadence while waiting for a job status change. */
const POLL_INTERVAL_MS = 100;

/** How far in the past to back-date started_at so the job qualifies as stale. */
const CRASH_AGO_MS = 6 * 60 * 1000; // 6 min > 5 min stale threshold

// ---------------------------------------------------------------------------
// Temp DB tracking — cleaned up in afterAll
// ---------------------------------------------------------------------------

const tempDbFiles: string[] = [];

afterAll(() => {
	for (const dbPath of tempDbFiles) {
		for (const suffix of ['', '-shm', '-wal']) {
			try {
				fs.unlinkSync(dbPath + suffix);
			} catch {
				// File may not exist; ignore
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

/** Extract DaemonAppContext from an in-process daemon. Throws in spawned mode. */
function getDaemonCtx(daemon: DaemonServerContext): DaemonAppContext {
	const ctx = daemon as InProcessDaemon;
	if (!ctx.daemonContext) {
		throw new Error(
			'daemonContext not available — is DAEMON_TEST_SPAWN=true? Crash-recovery tests require in-process mode.'
		);
	}
	return ctx.daemonContext;
}

/** Create a unique temp DB file path and register it for cleanup. */
function makeTempDbPath(): string {
	const dbPath = path.join(
		'/tmp',
		`crash-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	);
	tempDbFiles.push(dbPath);
	return dbPath;
}

/**
 * Insert a stale 'processing' job directly into the database.
 *
 * This simulates the daemon crashing while the job was in-flight: the row is
 * in 'processing' state with a started_at that is 6 minutes old, exceeding the
 * processor's 5-minute stale threshold.
 *
 * Returns the new job's ID.
 */
function insertStaleProcessingJob(
	daemonCtx: DaemonAppContext,
	queue: string,
	payload: Record<string, unknown> = {},
	maxRetries = 0
): string {
	const rawDb = daemonCtx.db.getDatabase();
	const jobId = crypto.randomUUID();
	const crashedAt = Date.now() - CRASH_AGO_MS;

	rawDb
		.prepare(
			`INSERT INTO job_queue
			(id, queue, status, payload, result, error, priority, max_retries, retry_count,
			 run_at, created_at, started_at, completed_at)
			VALUES (?, ?, 'processing', ?, NULL, NULL, 0, ?, 0, ?, ?, ?, NULL)`
		)
		.run(jobId, queue, JSON.stringify(payload), maxRetries, crashedAt, crashedAt, crashedAt);

	return jobId;
}

/**
 * Poll daemon-2's job queue until the job with `jobId` reaches one of the
 * given statuses, or until the timeout expires.
 */
async function waitForJobById(
	daemonCtx: DaemonAppContext,
	jobId: string,
	statuses: JobStatus[],
	queue: string,
	timeoutMs: number
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = daemonCtx.jobQueue.listJobs({ queue, status: statuses });
		const match = jobs.find((j) => j.id === jobId);
		if (match) return match;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Poll daemon-2's job queue until at least one job in `queue` reaches one of
 * the given statuses, or until the timeout expires.
 */
async function waitForAnyJob(
	daemonCtx: DaemonAppContext,
	queue: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_COMPLETE_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = daemonCtx.jobQueue.listJobs({ queue, status: statuses });
		if (jobs.length > 0) return jobs[0];
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Stop a daemon and wait for it to finish cleanup.
 *
 * We call kill() + waitForExit() which closes the DB connection cleanly.
 * The DB **file** is preserved because it lives outside the daemon's temp
 * workspace directory (caller supplied custom dbPath).
 */
async function stopDaemon(daemon: DaemonServerContext): Promise<void> {
	daemon.kill('SIGTERM');
	await daemon.waitForExit();
}

/**
 * Assert eager stale-job reclamation: verify that the stale job transitions
 * out of 'processing' within EAGER_RECLAIM_TIMEOUT_MS of daemon-2 startup.
 *
 * The job may already be in a terminal state by the time we call this
 * (reclaimed AND processed before the assertion runs) — that is fine.  The
 * critical check is that it did NOT stay in 'processing' for a long time,
 * which would indicate the periodic 60-second path was used instead.
 */
async function assertEagerReclaim(
	ctx2: DaemonAppContext,
	staleJobId: string,
	queue: string
): Promise<Job> {
	// Any status other than 'processing' means reclamation already happened.
	const reclaimedOrDone = await waitForJobById(
		ctx2,
		staleJobId,
		['pending', 'completed', 'failed', 'dead'],
		queue,
		EAGER_RECLAIM_TIMEOUT_MS
	);

	expect(reclaimedOrDone).toBeDefined();
	expect(reclaimedOrDone!.status).not.toBe('processing');

	return reclaimedOrDone!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Job queue crash recovery (online)', () => {
	// -----------------------------------------------------------------------
	// Test 1: Session title generation recovery
	// -----------------------------------------------------------------------

	test('session title gen: stale processing job is reclaimed immediately on restart', async () => {
		const dbPath = makeTempDbPath();

		// --- Daemon 1: insert stale processing job, then simulate crash ---
		const daemon1 = await createDaemonServer({ dbPath });
		const ctx1 = getDaemonCtx(daemon1);

		// Insert a stale session.title_generation job.
		// maxRetries=0 so it goes directly to 'dead' on failure rather than
		// cycling through retries — keeps the test fast and deterministic.
		const staleJobId = insertStaleProcessingJob(
			ctx1,
			SESSION_TITLE_GENERATION,
			{ sessionId: 'crash-test-session', userMessageText: 'hello from crash test' },
			0 // maxRetries
		);

		// Confirm the job is in stale 'processing' state before the stop.
		expect(ctx1.jobQueue.getJob(staleJobId)?.status).toBe('processing');

		// Stop daemon-1 (DB file is preserved outside the temp workspace).
		await stopDaemon(daemon1);

		// --- Daemon 2: restart against the same DB ---
		const daemon2 = await createDaemonServer({ dbPath });
		const ctx2 = getDaemonCtx(daemon2);

		// EAGER RECLAMATION: the job must leave 'processing' within 5 s.
		// processor.start() calls reclaimStale() synchronously before the first
		// poll tick — stale jobs are promoted to 'pending' immediately on startup.
		// If the job is already in a terminal state (processed before we check),
		// that also proves eager reclamation occurred.
		const reclaimedOrDone = await assertEagerReclaim(ctx2, staleJobId, SESSION_TITLE_GENERATION);

		// Wait for the job to reach a final state.  The handler will fail because
		// the session does not exist in daemon-2's memory, and with maxRetries=0
		// it goes straight to 'dead'.  The important invariant is that the job was
		// reclaimed and handled — not lost or stuck in 'processing'.
		let finalJob = reclaimedOrDone;
		if (finalJob.status === 'pending') {
			const done = await waitForJobById(
				ctx2,
				staleJobId,
				['completed', 'failed', 'dead'],
				SESSION_TITLE_GENERATION,
				JOB_COMPLETE_TIMEOUT_MS
			);
			expect(done).toBeDefined();
			finalJob = done!;
		}
		expect(['completed', 'failed', 'dead']).toContain(finalJob.status);

		await stopDaemon(daemon2);
	}, 60_000);

	// -----------------------------------------------------------------------
	// Test 2: GitHub poll chain recovery
	// -----------------------------------------------------------------------

	test('github poll chain: stale processing job is reclaimed and chain resumes after restart', async () => {
		const dbPath = makeTempDbPath();

		// --- Daemon 1: start GitHub polling, simulate crash mid-poll ---
		const daemon1 = await createDaemonServer({ env: GITHUB_TEST_ENV, dbPath });
		const ctx1 = getDaemonCtx(daemon1);

		// Insert a stale github.poll processing job (simulating crash mid-poll).
		const staleJobId = insertStaleProcessingJob(ctx1, GITHUB_POLL, {}, 3);

		// Confirm stale state before stopping daemon-1.
		expect(ctx1.jobQueue.getJob(staleJobId)?.status).toBe('processing');

		// Stop daemon-1.
		await stopDaemon(daemon1);

		// --- Daemon 2: restart with the same DB and GitHub env ---
		const daemon2 = await createDaemonServer({ env: GITHUB_TEST_ENV, dbPath });
		const ctx2 = getDaemonCtx(daemon2);

		// No triggerPoll stub is set here — and none is needed.
		//
		// Setting a stub *after* createDaemonServer() returns would be racy:
		// JobQueueProcessor.start() calls reclaimStale() and immediately fires
		// tick(), which dequeues the reclaimed job synchronously.  By the time
		// this code runs, the job handler may have already called triggerPoll().
		//
		// The stub is intentionally omitted because it is not required for test
		// correctness: no repositories are registered in this test environment,
		// so GitHubPollingService.triggerPoll() → pollAllRepositories() is a
		// no-op regardless.  Any errors from triggerPoll() are caught inside
		// handleGitHubPoll() and do not affect job completion.

		// EAGER RECLAMATION: stale job must leave 'processing' within 5 s.
		await assertEagerReclaim(ctx2, staleJobId, GITHUB_POLL);

		// COMPLETED: the reclaimed github.poll job must complete successfully.
		const completed = await waitForJobById(
			ctx2,
			staleJobId,
			['completed'],
			GITHUB_POLL,
			JOB_COMPLETE_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// CHAIN RESUMED: the handler self-schedules the next poll job.
		// At least one pending github.poll job should exist after completion.
		const nextPending = await waitForAnyJob(ctx2, GITHUB_POLL, ['pending']);
		expect(nextPending).toBeDefined();
		expect(nextPending!.queue).toBe(GITHUB_POLL);

		await stopDaemon(daemon2);
	}, 60_000);

	// -----------------------------------------------------------------------
	// Test 3: Room tick recovery
	// -----------------------------------------------------------------------

	test('room tick: stale processing tick is reclaimed and tick loop is re-seeded after daemon restart', async () => {
		const dbPath = makeTempDbPath();

		// --- Daemon 1: create a room (seeds a tick job), then simulate crash ---
		const daemon1 = await createDaemonServer({ dbPath });
		const ctx1 = getDaemonCtx(daemon1);

		// Create a room via RPC so it is persisted in the shared DB.
		const createResp = await daemon1.messageHub.request('room.create', {
			name: 'crash-test-room',
		});
		const roomId = (createResp as { room: { id: string } }).room.id;
		expect(roomId).toBeDefined();

		// Insert a stale room.tick processing job for this room.
		const staleJobId = insertStaleProcessingJob(ctx1, ROOM_TICK, { roomId }, 0);

		// Confirm stale state before stopping daemon-1.
		expect(ctx1.jobQueue.getJob(staleJobId)?.status).toBe('processing');

		// Stop daemon-1.
		await stopDaemon(daemon1);

		// --- Daemon 2: restart with the same DB ---
		const daemon2 = await createDaemonServer({ dbPath });
		const ctx2 = getDaemonCtx(daemon2);

		// EAGER RECLAMATION: stale tick must leave 'processing' within 5 s.
		await assertEagerReclaim(ctx2, staleJobId, ROOM_TICK);

		// COMPLETED: the reclaimed tick completes normally.  Since no room
		// runtime is running in daemon-2, the handler returns
		// {skipped: true, reason: 'not running'} and the job status is 'completed'.
		const completedTick = await waitForJobById(
			ctx2,
			staleJobId,
			['completed'],
			ROOM_TICK,
			JOB_COMPLETE_TIMEOUT_MS
		);
		expect(completedTick).toBeDefined();
		expect(completedTick!.status).toBe('completed');

		// TICK LOOP RE-SEEDED: daemon-2 bootstraps a *new* pending tick for every
		// existing room on startup (via roomRuntimeService.start().then(seedAllRooms)).
		// We verify a distinct pending tick — different from the stale job we already
		// tracked — exists for this room.  This assertion would fail if the bootstrap
		// seeding code were broken (the completed stale job would no longer satisfy it).
		//
		// The seeded tick has runAt = now + DEFAULT_TICK_INTERVAL_MS (30 s), so it
		// remains in 'pending' state during the test window.
		const RESEED_TIMEOUT_MS = 5_000;
		const reseedDeadline = Date.now() + RESEED_TIMEOUT_MS;
		let reseededTick: Job | undefined;
		while (Date.now() < reseedDeadline) {
			const pendingTicks = ctx2.jobQueue.listJobs({
				queue: ROOM_TICK,
				status: ['pending'],
			});
			reseededTick = pendingTicks.find(
				(j) => (j.payload as { roomId?: string }).roomId === roomId && j.id !== staleJobId
			);
			if (reseededTick) break;
			await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		expect(reseededTick).toBeDefined();

		await stopDaemon(daemon2);
	}, 60_000);

	// -----------------------------------------------------------------------
	// Test 4: Cleanup job recovery
	// -----------------------------------------------------------------------

	test('cleanup job: stale processing job is reclaimed, cleanup runs, and next run is self-scheduled', async () => {
		const dbPath = makeTempDbPath();

		// --- Daemon 1: insert stale cleanup processing job, then stop ---
		const daemon1 = await createDaemonServer({ dbPath });
		const ctx1 = getDaemonCtx(daemon1);

		// Remove any cleanup job daemon-1 seeded on first boot so we have a
		// single, unambiguous stale job to track after restart.
		const existingPending = ctx1.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: ['pending'],
		});
		for (const j of existingPending) {
			ctx1.jobQueue.deleteJob(j.id);
		}

		// Insert the stale processing cleanup job (simulating crash during cleanup).
		const staleJobId = insertStaleProcessingJob(ctx1, JOB_QUEUE_CLEANUP, {}, 0);
		expect(ctx1.jobQueue.getJob(staleJobId)?.status).toBe('processing');

		// Stop daemon-1.
		await stopDaemon(daemon1);

		// --- Daemon 2: restart with the same DB ---
		const daemon2 = await createDaemonServer({ dbPath });
		const ctx2 = getDaemonCtx(daemon2);

		// EAGER RECLAMATION: stale cleanup job must leave 'processing' within 5 s.
		await assertEagerReclaim(ctx2, staleJobId, JOB_QUEUE_CLEANUP);

		// COMPLETED: the cleanup handler must finish.
		const completed = await waitForJobById(
			ctx2,
			staleJobId,
			['completed'],
			JOB_QUEUE_CLEANUP,
			JOB_COMPLETE_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// RESULT SHAPE: cleanup handler returns {deletedJobs, nextRunAt}.
		const result = completed!.result as { deletedJobs: number; nextRunAt: number } | null;
		expect(result).not.toBeNull();
		expect(typeof result!.deletedJobs).toBe('number');
		expect(typeof result!.nextRunAt).toBe('number');

		// SELF-SCHEDULING: the cleanup handler enqueues the next run ~24 h out.
		// Daemon-2 may also have seeded its own cleanup job on startup; any
		// pending cleanup job that fires at least 23 h from now is acceptable.
		const nextCleanup = await waitForAnyJob(ctx2, JOB_QUEUE_CLEANUP, ['pending']);
		expect(nextCleanup).toBeDefined();
		expect(nextCleanup!.runAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

		await stopDaemon(daemon2);
	}, 60_000);
});
