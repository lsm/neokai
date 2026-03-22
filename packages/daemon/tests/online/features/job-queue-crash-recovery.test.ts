/**
 * Online test: Job queue crash recovery
 *
 * Verifies that all four job types survive a daemon crash/restart cycle:
 *
 *  1. session.title_generation — stale processing job is reclaimed and processed
 *  2. github.poll             — stale processing job is reclaimed; self-scheduling chain resumes
 *  3. room.tick               — stale processing job is reclaimed; handler skips gracefully
 *  4. job_queue.cleanup       — stale processing job is reclaimed and completes
 *
 * ## Crash simulation pattern (used in every test)
 *
 * 1. daemon1 starts with a **file-backed** SQLite database (shared `dbPath`)
 * 2. A job is inserted directly into the DB with status='processing' and
 *    started_at set ~6 minutes ago (exceeding the 5-minute stale threshold)
 * 3. daemon1 is cleanly shut down via `cleanup()`.  Note: we use a clean
 *    shutdown (not a SIGKILL) because the correctness property being tested is
 *    SQLite persistence + `reclaimStale()`, not WAL crash recovery.  The
 *    manually-inserted stale job simulates what the DB looks like after an
 *    unclean crash; `cleanup()` merely releases the file lock so daemon2 can
 *    open the same file.
 * 4. daemon2 is started against the **same database file**
 * 5. `JobQueueProcessor.start()` eagerly calls `reclaimStale()` before the
 *    first poll tick — the stale job moves from 'processing' back to 'pending'
 *    immediately, without waiting for the 60-second periodic stale check
 * 6. Assertions verify: (a) the job was not lost, (b) it reaches a terminal
 *    state quickly (< 15 s), proving eagerness vs the 60-second fallback
 *
 * ## No real Anthropic API calls
 *
 * - session.title_generation: no real session exists → handler throws → job
 *   retries and eventually becomes 'dead'; the test accepts any terminal state
 * - github.poll: no repositories are registered → triggerPoll() is a no-op;
 *   the handler completes successfully and self-schedules
 * - room.tick: no runtime exists for the fake roomId → handler returns
 *   { skipped: true, reason: 'not running' } → job completes
 * - job_queue.cleanup: deletes old rows from the job_queue table — no external
 *   calls needed
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
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
// Configuration
// ---------------------------------------------------------------------------

const IS_DEV_PROXY = process.env.NEOKAI_USE_DEV_PROXY === '1';

/**
 * `started_at` that is 6 minutes in the past — comfortably beyond the
 * 5-minute stale threshold used by JobQueueProcessor.
 */
const staleMsAgo = () => Date.now() - 6 * 60 * 1000;

/**
 * Maximum time to wait for a job to reach a terminal state after daemon2
 * starts.  Must be well below 60 s (the periodic stale-check interval) so
 * that a passing test implicitly proves eager reclamation.
 */
const TERMINAL_WAIT_MS = 15_000;

/** Polling cadence for job status checks. */
const POLL_MS = 100;

// ---------------------------------------------------------------------------
// Shared file-backed database (persists across daemon instances within a test)
// ---------------------------------------------------------------------------

/**
 * Unique workspace dir created once for the entire suite.
 * Each test uses its own sub-directory so DB files do not interfere.
 */
const suiteWorkspace = `/tmp/crash-recovery-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Env vars replaced in beforeAll and restored in afterAll. */
const savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Suite-level setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
	await Bun.$`mkdir -p ${suiteWorkspace}`.quiet();

	// In dev-proxy mode mirror the env setup that createInProcessDaemonServer()
	// normally performs so createDaemonApp() sees a valid API key and the
	// authentication check passes without real credentials.
	if (IS_DEV_PROXY) {
		for (const k of [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_BASE_URL',
			'ANTHROPIC_AUTH_TOKEN',
			'CLAUDE_CODE_OAUTH_TOKEN',
		]) {
			savedEnv[k] = process.env[k];
		}
		process.env.ANTHROPIC_API_KEY = 'sk-devproxy-test-key';
		process.env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:8000';
		process.env.ANTHROPIC_AUTH_TOKEN = '';
		process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
	}

	process.env.NODE_ENV = 'test';
	if (!process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS) {
		process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = '30000';
	}

	// Save and set TEST_WORKTREE_BASE_DIR so afterAll can restore it and delete
	// the directory.  Only override if not already set by the test runner.
	savedEnv['TEST_WORKTREE_BASE_DIR'] = process.env.TEST_WORKTREE_BASE_DIR;
	if (!process.env.TEST_WORKTREE_BASE_DIR) {
		process.env.TEST_WORKTREE_BASE_DIR = `/tmp/crash-recovery-worktrees-${Date.now()}`;
	}
});

afterAll(async () => {
	await Bun.$`rm -rf ${suiteWorkspace}`.quiet();

	// Clean up the worktree base dir if we created it (i.e. it was not set before).
	if (savedEnv['TEST_WORKTREE_BASE_DIR'] === undefined && process.env.TEST_WORKTREE_BASE_DIR) {
		await Bun.$`rm -rf ${process.env.TEST_WORKTREE_BASE_DIR}`.quiet();
	}

	for (const [key, original] of Object.entries(savedEnv)) {
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a DaemonAppContext using an explicit file-backed database path.
 *
 * Sets NEOKAI_WORKSPACE_PATH and any extra env vars only for the duration of
 * createDaemonApp() so that concurrent tests do not bleed into each other.
 * The caller is responsible for calling `ctx.cleanup()` when done.
 */
async function createCrashTestDaemon(
	workspace: string,
	dbPath: string,
	extraEnv: Record<string, string> = {}
): Promise<DaemonAppContext> {
	const toSet: Record<string, string> = { NEOKAI_WORKSPACE_PATH: workspace, ...extraEnv };
	const saved: Record<string, string | undefined> = {};

	for (const [k, v] of Object.entries(toSet)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}

	let ctx: DaemonAppContext;
	try {
		const config = getConfig();
		config.port = 0; // OS-assigned to avoid port conflicts
		config.dbPath = dbPath;
		ctx = await createDaemonApp({ config, verbose: false, standalone: false });
	} finally {
		for (const [k, orig] of Object.entries(saved)) {
			if (orig === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = orig;
			}
		}
	}

	return ctx;
}

/**
 * Inserts a job directly into the raw SQLite database with status='processing'
 * and a started_at that is 6 minutes in the past (well beyond the 5-minute
 * stale threshold).  Returns the newly generated job ID.
 */
function insertStaleJob(
	ctx: DaemonAppContext,
	queue: string,
	payload: Record<string, unknown> = {}
): string {
	const jobId = crypto.randomUUID();
	const staleTs = staleMsAgo();
	ctx.db
		.getDatabase()
		.prepare(
			`INSERT INTO job_queue
			(id, queue, status, payload, result, error, priority, max_retries, retry_count,
			 run_at, created_at, started_at, completed_at)
			VALUES (?, ?, 'processing', ?, NULL, NULL, 0, 3, 0, ?, ?, ?, NULL)`
		)
		.run(jobId, queue, JSON.stringify(payload), staleTs, staleTs, staleTs);
	return jobId;
}

/**
 * Polls the job queue until the specific job reaches one of `targetStatuses`,
 * or the timeout expires.  Throws with diagnostic info on timeout.
 */
async function waitForJobById(
	ctx: DaemonAppContext,
	jobId: string,
	targetStatuses: JobStatus[],
	timeoutMs: number = TERMINAL_WAIT_MS
): Promise<Job> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = ctx.jobQueue.listJobs({ limit: 1000 });
		const match = jobs.find((j) => j.id === jobId);
		if (match && targetStatuses.includes(match.status)) {
			return match;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
	}
	const all = ctx.jobQueue.listJobs({ limit: 1000 });
	const match = all.find((j) => j.id === jobId);
	throw new Error(
		`Timeout (${timeoutMs}ms) waiting for job ${jobId} to reach [${targetStatuses.join(',')}]. ` +
			`Current status: ${match?.status ?? 'not found in DB'}`
	);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Job queue crash recovery (online)', () => {
	/** All daemon contexts opened by the current test — cleaned up in afterEach. */
	const openDaemons: DaemonAppContext[] = [];

	afterEach(async () => {
		while (openDaemons.length > 0) {
			const ctx = openDaemons.pop()!;
			try {
				await ctx.cleanup();
			} catch {
				// best-effort; don't mask test failures
			}
		}
	}, 30_000);

	// -----------------------------------------------------------------------

	test('session.title_generation: stale processing job is reclaimed and processed after restart', async () => {
		// Each test gets its own workspace + DB file for full isolation.
		const workspace = `${suiteWorkspace}/title-gen`;
		const dbPath = `${workspace}/daemon.db`;
		await Bun.$`mkdir -p ${workspace}`.quiet();

		// --- daemon1: record a stale job, then shut down ---
		const daemon1 = await createCrashTestDaemon(workspace, dbPath);
		const staleJobId = insertStaleJob(daemon1, SESSION_TITLE_GENERATION, {
			sessionId: crypto.randomUUID(),
			userMessageText: 'crash recovery test',
		});

		// Verify the job is stuck in 'processing' before daemon1 stops.
		const before = daemon1.jobQueue.listJobs({ queue: SESSION_TITLE_GENERATION, limit: 100 });
		expect(before.some((j) => j.id === staleJobId && j.status === 'processing')).toBe(true);

		// Simulate crash: stop daemon1 without letting the job complete.
		await daemon1.cleanup();

		// --- daemon2: restart against the same database file ---
		const daemon2StartTs = Date.now();
		const daemon2 = await createCrashTestDaemon(workspace, dbPath);
		openDaemons.push(daemon2);

		// The job must still be present — it was not deleted by the restart.
		const afterRestart = daemon2.jobQueue.listJobs({ queue: SESSION_TITLE_GENERATION, limit: 100 });
		expect(afterRestart.some((j) => j.id === staleJobId)).toBe(true);

		// Wait for the job to reach a terminal state.
		// Accepting 'failed' and 'dead' because no real session exists in the DB,
		// so generateTitleAndRenameBranch() will throw and the job will exhaust retries.
		// The crucial property is that processing starts quickly (≪ 60 s).
		const terminal = await waitForJobById(daemon2, staleJobId, ['completed', 'failed', 'dead']);
		expect(['completed', 'failed', 'dead']).toContain(terminal.status);

		// Eagerness check: the job was processed well before the 60-second
		// periodic stale-check would have fired.
		const elapsed = Date.now() - daemon2StartTs;
		expect(elapsed).toBeLessThan(TERMINAL_WAIT_MS);
		// maxRetries=3 means 4 attempts with back-off delays of 1 s + 2 s + 4 s = 7 s.
		// 25 s is generous but still well below the 60-second periodic stale check.
	}, 25_000);

	// -----------------------------------------------------------------------

	test('github.poll: stale processing job is reclaimed; self-scheduling chain resumes after restart', async () => {
		const workspace = `${suiteWorkspace}/github-poll`;
		const dbPath = `${workspace}/daemon.db`;
		await Bun.$`mkdir -p ${workspace}`.quiet();

		// GITHUB_POLLING_INTERVAL=300 keeps the self-scheduled next job far in
		// the future so we can assert exactly one pending job after completion.
		// GITHUB_TOKEN satisfies the token-presence guard inside GitHubService.
		// No repositories are registered, so triggerPoll() is a no-op.
		const GITHUB_ENV = {
			GITHUB_POLLING_INTERVAL: '300',
			GITHUB_TOKEN: 'ghp_fake_token_crash_recovery_test',
		};

		// --- daemon1: record a stale github.poll job, then shut down ---
		const daemon1 = await createCrashTestDaemon(workspace, dbPath, GITHUB_ENV);
		const staleJobId = insertStaleJob(daemon1, GITHUB_POLL);

		const before = daemon1.jobQueue.listJobs({ queue: GITHUB_POLL, limit: 100 });
		expect(before.some((j) => j.id === staleJobId && j.status === 'processing')).toBe(true);

		await daemon1.cleanup();

		// --- daemon2: restart with GitHub env against the same DB ---
		const daemon2StartTs = Date.now();
		const daemon2 = await createCrashTestDaemon(workspace, dbPath, GITHUB_ENV);
		openDaemons.push(daemon2);

		// Job must survive the restart (not lost).
		const afterRestart = daemon2.jobQueue.listJobs({ queue: GITHUB_POLL, limit: 100 });
		expect(afterRestart.some((j) => j.id === staleJobId)).toBe(true);

		// Wait for the reclaimed job to complete.
		const completed = await waitForJobById(daemon2, staleJobId, ['completed']);
		expect(completed.status).toBe('completed');

		// Eagerness: processed well before the 60-second periodic check.
		expect(Date.now() - daemon2StartTs).toBeLessThan(TERMINAL_WAIT_MS);

		// Self-scheduling: the handler must have enqueued the next poll job.
		// Allow a short settle window for the self-schedule to be written.
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		const nextPending = daemon2.jobQueue.listJobs({
			queue: GITHUB_POLL,
			status: 'pending',
			limit: 10,
		});
		expect(nextPending.length).toBeGreaterThanOrEqual(1);

		// At least one pending job must be scheduled ~300 s from now
		// (GITHUB_POLLING_INTERVAL).  Use some() rather than [0] to be robust
		// against ordering — daemon2 startup may have enqueued an extra immediate
		// job depending on timing.
		const minFutureRunAt = Date.now() + 200_000;
		expect(nextPending.some((j) => j.runAt > minFutureRunAt)).toBe(true);
	}, 20_000);

	// -----------------------------------------------------------------------

	test('room.tick: stale processing job is reclaimed; handler skips gracefully when runtime is absent', async () => {
		const workspace = `${suiteWorkspace}/room-tick`;
		const dbPath = `${workspace}/daemon.db`;
		await Bun.$`mkdir -p ${workspace}`.quiet();

		// Use a random roomId — no room with this ID will be found in the
		// RoomRuntimeService, so the handler returns { skipped: true }.
		const fakeRoomId = crypto.randomUUID();

		// --- daemon1 ---
		const daemon1 = await createCrashTestDaemon(workspace, dbPath);
		const staleJobId = insertStaleJob(daemon1, ROOM_TICK, { roomId: fakeRoomId });

		const before = daemon1.jobQueue.listJobs({ queue: ROOM_TICK, limit: 100 });
		expect(before.some((j) => j.id === staleJobId && j.status === 'processing')).toBe(true);

		await daemon1.cleanup();

		// --- daemon2 ---
		const daemon2StartTs = Date.now();
		const daemon2 = await createCrashTestDaemon(workspace, dbPath);
		openDaemons.push(daemon2);

		// Job must survive the restart.
		const afterRestart = daemon2.jobQueue.listJobs({ queue: ROOM_TICK, limit: 100 });
		expect(afterRestart.some((j) => j.id === staleJobId)).toBe(true);

		// The room.tick handler returns { skipped: true, reason: 'not running' }
		// when no runtime exists — it does not throw, so the job completes.
		const completed = await waitForJobById(daemon2, staleJobId, ['completed']);
		expect(completed.status).toBe('completed');
		expect(completed.result).toMatchObject({ skipped: true, reason: 'not running' });

		// Eagerness: processed well before the 60-second periodic check.
		expect(Date.now() - daemon2StartTs).toBeLessThan(TERMINAL_WAIT_MS);

		// Because the runtime is not running, the handler must NOT schedule
		// a follow-up tick for this room (the tick loop self-terminates).
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		const followUpTicks = daemon2.jobQueue
			.listJobs({ queue: ROOM_TICK, status: 'pending', limit: 100 })
			.filter((j) => (j.payload as { roomId?: string }).roomId === fakeRoomId);
		expect(followUpTicks.length).toBe(0);
	}, 20_000);

	// -----------------------------------------------------------------------

	test('job_queue.cleanup: stale processing job is reclaimed, cleanup runs, and next cleanup is self-scheduled', async () => {
		const workspace = `${suiteWorkspace}/cleanup`;
		const dbPath = `${workspace}/daemon.db`;
		await Bun.$`mkdir -p ${workspace}`.quiet();

		// --- daemon1 ---
		const daemon1 = await createCrashTestDaemon(workspace, dbPath);

		// Remove any pending cleanup jobs so the startup guard in daemon2
		// does not create an extra one that races against our stale job.
		const existingPending = daemon1.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: 'pending',
			limit: 100,
		});
		for (const j of existingPending) {
			daemon1.jobQueue.deleteJob(j.id);
		}

		const staleJobId = insertStaleJob(daemon1, JOB_QUEUE_CLEANUP);

		const before = daemon1.jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, limit: 100 });
		expect(before.some((j) => j.id === staleJobId && j.status === 'processing')).toBe(true);

		await daemon1.cleanup();

		// --- daemon2 ---
		// On startup, createDaemonApp checks for pending cleanup jobs.
		// Our stale job is 'processing' (not 'pending'), so daemon2 will
		// enqueue a new immediate cleanup job AND reclaimStale() will move
		// our stale job to 'pending'.  Both will run; we track ours by ID.
		const daemon2StartTs = Date.now();
		const daemon2 = await createCrashTestDaemon(workspace, dbPath);
		openDaemons.push(daemon2);

		// Our stale job must survive the restart.
		const afterRestart = daemon2.jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, limit: 100 });
		expect(afterRestart.some((j) => j.id === staleJobId)).toBe(true);

		// Wait for our specific stale job to complete.
		const completed = await waitForJobById(daemon2, staleJobId, ['completed']);
		expect(completed.status).toBe('completed');
		expect(typeof completed.result?.deletedJobs).toBe('number');

		// Eagerness: processed well before the 60-second periodic check.
		expect(Date.now() - daemon2StartTs).toBeLessThan(TERMINAL_WAIT_MS);

		// Self-scheduling: cleanup handler must enqueue the next run ~24 h away.
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
		const nextCleanup = daemon2.jobQueue.listJobs({
			queue: JOB_QUEUE_CLEANUP,
			status: 'pending',
			limit: 10,
		});
		expect(nextCleanup.length).toBeGreaterThanOrEqual(1);
		// At least one pending cleanup should be scheduled far in the future
		// (≥ 23 h from now), confirming proper 24-hour self-scheduling.
		const longFuture = Date.now() + 23 * 60 * 60 * 1000;
		const hasFutureCleanup = nextCleanup.some((j) => j.runAt > longFuture);
		expect(hasFutureCleanup).toBe(true);
	}, 20_000);
});
