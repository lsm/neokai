/**
 * Online test: Job queue crash/restart recovery
 *
 * Verifies that all job types resume correctly after a daemon crash and restart.
 * Two daemon instances share a single file-backed SQLite database:
 *
 *   daemon1 → insert stale 'processing' job (simulating crash mid-execution)
 *           → stop daemon1
 *   daemon2 → start with same DB
 *           → eager reclaimStale() in jobProcessor.start() reclaims the stale job
 *           → job is re-dequeued and executed by daemon2
 *
 * ## Eager reclamation design note
 *
 * JobQueueProcessor.start() calls reclaimStale() synchronously and then calls
 * tick() synchronously. tick() immediately dequeues pending jobs (SQLite
 * transaction), so by the time createDaemonApp() returns, the stale job has
 * already been cycled:  stale-processing → pending → (fresh-)processing.
 *
 * Because the transition through 'pending' happens in the same synchronous call
 * as startup, the test verifies eager reclamation through timing rather than
 * catching the transient 'pending' state: if the job completes within a few
 * seconds of daemon2 starting, it MUST have been reclaimed immediately on
 * startup (not after the 60-second periodic stale check).
 *
 * Test scenarios:
 *   1. session.title_generation — stale job reclaimed; handler fails once (fake
 *      session doesn't exist) and transitions to 'dead' (maxRetries=0).
 *   2. github.poll chain — pending job left by daemon1 is picked up by daemon2;
 *      stale processing job is reclaimed and also completes.
 *   3. room.tick — stale job reclaimed; handler returns { skipped: true } because
 *      no runtime exists for the fake room ID; job completes successfully.
 *   4. job_queue.cleanup — stale job reclaimed; handler runs to completion (no
 *      API calls needed), self-schedules the next cleanup run.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonAppContext } from '../../../src/app';
import { createDaemonApp } from '../../../src/app';
import { getConfig } from '../../../src/config';
import {
	GITHUB_POLL,
	JOB_QUEUE_CLEANUP,
	ROOM_TICK,
	SESSION_TITLE_GENERATION,
} from '../../../src/lib/job-queue-constants';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Age of a simulated crashed job (must exceed the 5-min stale threshold).
 */
const STALE_AGE_MS = 6 * 60 * 1000; // 6 minutes

/**
 * Maximum time for a reclaimed job to finish executing on daemon2.
 * If this passes, eager reclamation did not happen (otherwise the job would
 * have been stuck stale for ≥60 s, far exceeding this window).
 */
const JOB_WAIT_TIMEOUT_MS = 10_000;

/** Poll cadence for job-status checks. */
const POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll the job queue until at least one job in the given queue reaches one of
 * the specified statuses, or until the timeout expires.
 */
async function waitForQueueJob(
	jobQueue: DaemonAppContext['jobQueue'],
	queue: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = jobQueue.listJobs({ queue, status: statuses });
		if (jobs.length > 0) return jobs[0];
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Poll until a specific job (by id) in the given queue reaches one of the
 * specified statuses, or until the timeout expires.
 */
async function waitForJobById(
	jobQueue: DaemonAppContext['jobQueue'],
	queue: string,
	jobId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = jobQueue.listJobs({ queue, status: statuses });
		const match = jobs.find((j) => j.id === jobId);
		if (match) return match;
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Insert a stale 'processing' job directly into the SQLite database to
 * simulate a daemon crash mid-execution.
 *
 * The job's started_at is STALE_AGE_MS in the past, which exceeds the
 * processor's 5-minute stale threshold and ensures reclaimStale() picks it up.
 *
 * @returns The newly-inserted job's UUID.
 */
function insertStaleCrashedJob(
	rawDb: ReturnType<DaemonAppContext['db']['getDatabase']>,
	queue: string,
	payload: Record<string, unknown>,
	maxRetries = 3
): string {
	const id = crypto.randomUUID();
	const stalePast = Date.now() - STALE_AGE_MS;

	rawDb
		.prepare(
			`INSERT INTO job_queue
			(id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, completed_at)
			VALUES (?, ?, 'processing', ?, NULL, NULL, 0, ?, 0, ?, ?, ?, NULL)`
		)
		.run(id, queue, JSON.stringify(payload), maxRetries, stalePast, stalePast, stalePast);

	return id;
}

/**
 * Verify that a job was eagerly reclaimed by daemon2.
 *
 * Since reclaimStale() and tick() both run synchronously inside start(),
 * the job transitions stale-processing → pending → (fresh-)processing
 * before createDaemonApp() returns. We verify reclamation by checking that
 * the job is either:
 *   (a) in 'processing' with a fresh startedAt (re-dequeued after reclaim), or
 *   (b) already in a final state (completed/dead/failed — processed immediately).
 *
 * In either case the stale startedAt is gone, proving reclaimStale() ran.
 */
function assertEagerlyReclaimed(
	jobQueue: DaemonAppContext['jobQueue'],
	queue: string,
	jobId: string
): void {
	// The job must NOT still be stuck in stale processing (started_at 6 min ago)
	const allJobs = jobQueue.listJobs({
		queue,
		status: ['pending', 'processing', 'completed', 'failed', 'dead'],
	});
	const job = allJobs.find((j) => j.id === jobId);
	expect(job).toBeDefined(); // job must still exist

	if (job!.status === 'processing') {
		// Re-dequeued after reclaim → startedAt must be recent, not the old stale value
		const staleCutoff = Date.now() - STALE_AGE_MS + 30_000; // ≥ 5m30s ago is still "recent enough"
		expect(job!.startedAt).toBeGreaterThan(staleCutoff);
	}
	// Any other status (pending, completed, dead, failed) also proves reclamation
}

/**
 * Create a daemon instance backed by a specific file-based SQLite database.
 *
 * Each call creates a fresh workspace directory (to avoid worktree conflicts)
 * but points the database at the shared `dbPath`. This lets two sequential
 * daemon instances share persistent job-queue state across restarts.
 */
async function createDaemonWithSharedDb(dbPath: string): Promise<DaemonAppContext> {
	const workspaceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const workspace = `/tmp/crash-recovery-ws-${workspaceId}`;
	await Bun.$`mkdir -p ${workspace}`.quiet();

	process.env.NEOKAI_WORKSPACE_PATH = workspace;
	process.env.NODE_ENV = 'test';
	if (!process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS) {
		process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = '30000';
	}
	if (!process.env.TEST_WORKTREE_BASE_DIR) {
		process.env.TEST_WORKTREE_BASE_DIR = `/tmp/daemon-worktrees-${Date.now()}`;
	}

	const config = getConfig();
	config.port = 0; // OS-assigned port to avoid collisions
	config.dbPath = dbPath; // Shared file-backed database

	return createDaemonApp({ config, verbose: false, standalone: false });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Job queue crash/restart recovery (online)', () => {
	let tmpDir: string;
	let dbPath: string;
	let daemon1: DaemonAppContext | null;
	let daemon2: DaemonAppContext | null;

	// GitHub env vars saved for restoration
	let savedGithubPollingInterval: string | undefined;
	let savedGithubToken: string | undefined;

	beforeEach(async () => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		tmpDir = `/tmp/crash-recovery-${id}`;
		await Bun.$`mkdir -p ${tmpDir}`.quiet();
		dbPath = `${tmpDir}/crash-test.db`;
		daemon1 = null;
		daemon2 = null;

		savedGithubPollingInterval = process.env.GITHUB_POLLING_INTERVAL;
		savedGithubToken = process.env.GITHUB_TOKEN;
	}, 30_000);

	afterEach(async () => {
		// Stop daemons (best-effort — do not let cleanup errors fail the suite)
		if (daemon1) {
			try {
				await daemon1.cleanup();
			} catch {
				// best-effort
			}
			daemon1 = null;
		}
		if (daemon2) {
			try {
				await daemon2.cleanup();
			} catch {
				// best-effort
			}
			daemon2 = null;
		}

		// Restore GitHub env vars
		if (savedGithubPollingInterval === undefined) {
			delete process.env.GITHUB_POLLING_INTERVAL;
		} else {
			process.env.GITHUB_POLLING_INTERVAL = savedGithubPollingInterval;
		}
		if (savedGithubToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = savedGithubToken;
		}

		// Remove per-test DB and workspace directories
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	}, 30_000);

	// -------------------------------------------------------------------------

	test('session.title_generation: stale crash job is eagerly reclaimed on restart', async () => {
		// --- daemon1: initialize schema, insert stale processing job, stop ---
		daemon1 = await createDaemonWithSharedDb(dbPath);

		const rawDb1 = daemon1.db.getDatabase();
		// maxRetries=0: job dies on the first failed attempt (no retry delays)
		const staleJobId = insertStaleCrashedJob(
			rawDb1,
			SESSION_TITLE_GENERATION,
			{
				sessionId: 'fake-session-crash-test',
				userMessageText: 'Hello',
				// maxRetries=0 so it dies on first failure without retry backoff delays
			},
			0
		);

		// Verify stale job is in 'processing' before restart
		const beforeStop = daemon1.jobQueue.listJobs({
			queue: SESSION_TITLE_GENERATION,
			status: ['processing'],
		});
		expect(beforeStop.some((j) => j.id === staleJobId)).toBe(true);

		await daemon1.cleanup();
		daemon1 = null;

		// --- daemon2: start with same DB ---
		// jobProcessor.start() eagerly calls reclaimStale(), moving the stale
		// job to 'pending', then immediately calls tick() which re-dequeues it.
		daemon2 = await createDaemonWithSharedDb(dbPath);

		// Verify eager reclamation: stale startedAt is gone
		assertEagerlyReclaimed(daemon2.jobQueue, SESSION_TITLE_GENERATION, staleJobId);

		// The job fails (fake session doesn't exist) and with maxRetries=0 immediately
		// transitions to 'dead'. Completing within JOB_WAIT_TIMEOUT_MS proves
		// eager reclamation (not waiting 60 s for the periodic stale check).
		const dead = await waitForJobById(
			daemon2.jobQueue,
			SESSION_TITLE_GENERATION,
			staleJobId,
			['dead'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(dead).toBeDefined();
		expect(dead!.status).toBe('dead');
	}, 30_000);

	// -------------------------------------------------------------------------

	test('github.poll chain: poll chain resumes and stale job is reclaimed after restart', async () => {
		// Enable GitHub polling for this test (fake token, no real repos)
		process.env.GITHUB_POLLING_INTERVAL = '300'; // 5-min interval keeps next job far in future
		process.env.GITHUB_TOKEN = 'ghp_fake_token_for_crash_recovery_test';

		// --- daemon1: start polling, get the initial poll job enqueued, then stop ---
		daemon1 = await createDaemonWithSharedDb(dbPath);

		// Stub triggerPoll to avoid any real GitHub network calls
		const pollingService1 = daemon1.gitHubService?.getPollingService();
		if (pollingService1) {
			pollingService1.triggerPoll = async () => {};
		}

		// Wait for the initial poll job to complete so the chain self-schedules
		// a next pending job (with runAt = now + 300s, safely in the future)
		const firstCompleted = await waitForQueueJob(
			daemon1.jobQueue,
			GITHUB_POLL,
			['completed'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(firstCompleted).toBeDefined();

		// Insert a stale processing job to simulate a crash mid-poll
		const rawDb1 = daemon1.db.getDatabase();
		const staleJobId = insertStaleCrashedJob(rawDb1, GITHUB_POLL, {});

		// Stop daemon1 — DB now has: 1 pending (future) + 1 stale processing poll job
		await daemon1.cleanup();
		daemon1 = null;

		// --- daemon2: start with same DB ---
		daemon2 = await createDaemonWithSharedDb(dbPath);

		// Stub triggerPoll on daemon2 as well
		const pollingService2 = daemon2.gitHubService?.getPollingService();
		if (pollingService2) {
			pollingService2.triggerPoll = async () => {};
		}

		// Stale processing job was eagerly reclaimed by daemon2's startup
		assertEagerlyReclaimed(daemon2.jobQueue, GITHUB_POLL, staleJobId);

		// The reclaimed poll job has runAt in the past → it will be processed
		// immediately. Verify it completes within the timeout window.
		const completed = await waitForJobById(
			daemon2.jobQueue,
			GITHUB_POLL,
			staleJobId,
			['completed'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// Poll chain remains alive: a new pending poll job exists for the next cycle
		const chainPending = daemon2.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: ['pending'],
		});
		expect(chainPending.length).toBeGreaterThanOrEqual(1);
	}, 30_000);

	// -------------------------------------------------------------------------

	test('room.tick: stale crash job is reclaimed and completes gracefully (no active runtime)', async () => {
		// --- daemon1: initialize schema, insert stale tick job, stop ---
		daemon1 = await createDaemonWithSharedDb(dbPath);

		const rawDb1 = daemon1.db.getDatabase();
		const fakeRoomId = `crash-test-room-${Date.now()}`;
		// maxRetries=0 matches the design of room.tick jobs (enqueueRoomTick uses 0 retries)
		const staleJobId = insertStaleCrashedJob(rawDb1, ROOM_TICK, { roomId: fakeRoomId }, 0);

		// Verify stale tick is in 'processing' before stop
		const beforeStop = daemon1.jobQueue.listJobs({
			queue: ROOM_TICK,
			status: ['processing'],
		});
		expect(beforeStop.some((j) => j.id === staleJobId)).toBe(true);

		await daemon1.cleanup();
		daemon1 = null;

		// --- daemon2: start with same DB ---
		daemon2 = await createDaemonWithSharedDb(dbPath);

		// Stale tick was eagerly reclaimed by daemon2's startup
		assertEagerlyReclaimed(daemon2.jobQueue, ROOM_TICK, staleJobId);

		// The handler finds no running runtime for the fake room ID and returns
		// { skipped: true, reason: 'not running' }, completing the job successfully.
		// Completing within JOB_WAIT_TIMEOUT_MS proves eager reclamation.
		const completed = await waitForJobById(
			daemon2.jobQueue,
			ROOM_TICK,
			staleJobId,
			['completed'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');
		expect(completed!.result).toEqual({ skipped: true, reason: 'not running' });
	}, 30_000);

	// -------------------------------------------------------------------------

	test('job_queue.cleanup: stale crash job is reclaimed and runs to completion on restart', async () => {
		// --- daemon1: initialize schema (seeds initial cleanup job), insert stale job, stop ---
		daemon1 = await createDaemonWithSharedDb(dbPath);

		const rawDb1 = daemon1.db.getDatabase();
		const staleJobId = insertStaleCrashedJob(rawDb1, JOB_QUEUE_CLEANUP, {});

		// Verify stale cleanup job is in 'processing' before stop
		const beforeStop = daemon1.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: ['processing'],
		});
		expect(beforeStop.some((j) => j.id === staleJobId)).toBe(true);

		await daemon1.cleanup();
		daemon1 = null;

		// --- daemon2: start with same DB ---
		daemon2 = await createDaemonWithSharedDb(dbPath);

		// Stale cleanup job was eagerly reclaimed by daemon2's startup
		assertEagerlyReclaimed(daemon2.jobQueue, JOB_QUEUE_CLEANUP, staleJobId);

		// Cleanup job executes successfully — no API calls needed.
		// Completing within JOB_WAIT_TIMEOUT_MS proves eager reclamation.
		const completed = await waitForJobById(
			daemon2.jobQueue,
			JOB_QUEUE_CLEANUP,
			staleJobId,
			['completed'],
			JOB_WAIT_TIMEOUT_MS
		);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		const result = completed!.result as { deletedJobs: number; nextRunAt: number } | null;
		expect(result).not.toBeNull();
		expect(typeof result!.deletedJobs).toBe('number');
		expect(result!.deletedJobs).toBeGreaterThanOrEqual(0);
		// Next cleanup is self-scheduled at least 1 hour in the future
		expect(result!.nextRunAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
	}, 30_000);
});
