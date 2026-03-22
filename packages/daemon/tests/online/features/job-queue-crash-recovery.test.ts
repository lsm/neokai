/**
 * Integration tests: Job queue crash/restart recovery
 *
 * Simulates daemon crash scenarios and verifies all job types resume correctly
 * when a fresh daemon instance starts against the same file-backed SQLite database.
 *
 * Strategy: each test runs TWO daemon instances sharing a single persistent DB file.
 * Daemon-1 creates the initial state (sessions, rooms, stale processing jobs).
 * Daemon-2 opens the same DB file; its eager `reclaimStale()` call in
 * `JobQueueProcessor.start()` immediately moves all stale-processing jobs back to
 * 'pending', after which the job processor picks them up and completes them.
 *
 * Monkey-patching vs. race condition
 * -----------------------------------
 * `jobProcessor.start()` calls `reclaimStale()` synchronously and then dispatches
 * a floating `tick()` → `processJob()` Promise. By the time `createDaemonApp()`
 * resolves and the test code runs, the floating `processJob` has already called the
 * registered handler up to its first internal `await`. To avoid having the real
 * handler execute before the test stub is in place, each test that patches a handler
 * calls `await daemon2.jobProcessor.stop()` immediately after `startDaemon()`. This
 * waits for any in-flight jobs from the eager first tick to complete (they fail fast
 * because the session/service is not set up), then applies the stub, and restarts
 * the processor so the stub is in place before the job's retry fires.
 *
 * No real AI API calls are made: session-title handler is re-registered with a mock,
 * github.poll uses a stub triggerPoll(), and cleanup runs against the local SQLite
 * file only.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createDaemonApp, type DaemonAppContext } from '../../../src/app';
import { getConfig } from '../../../src/config';
import {
	SESSION_TITLE_GENERATION,
	GITHUB_POLL,
	ROOM_TICK,
	JOB_QUEUE_CLEANUP,
} from '../../../src/lib/job-queue-constants';
import type { JobStatus } from '../../../src/storage/repositories/job-queue-repository';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMP_DIR = '/tmp/neokai-crash-recovery-tests';
const JOB_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/** Milliseconds that make a job "stale" — must exceed processor's 5-min threshold. */
const STALE_AGE_MS = 6 * 60 * 1000;

/** GitHub env vars: enable polling without real credentials. */
const GITHUB_ENV: Record<string, string> = {
	GITHUB_POLLING_INTERVAL: '300',
	GITHUB_TOKEN: 'ghp_fake_for_crash_recovery_test',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique suffix for test isolation. */
function uid(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start a daemon app with a file-backed DB (no in-memory SQLite).
 * Returns the DaemonAppContext; caller is responsible for calling cleanup().
 */
async function startDaemon(
	dbPath: string,
	workspaceRoot: string,
	extraEnv: Record<string, string> = {}
): Promise<DaemonAppContext> {
	// Apply extra env vars to the current process (in-process daemon shares env)
	for (const [k, v] of Object.entries(extraEnv)) {
		process.env[k] = v;
	}
	process.env.NEOKAI_WORKSPACE_PATH = workspaceRoot;

	const config = getConfig({ dbPath, workspace: workspaceRoot });
	config.port = 0; // OS-assigned — avoids port conflicts between test daemons

	return createDaemonApp({ config, verbose: false, standalone: false });
}

/**
 * Stop daemon and wait for cleanup to complete.
 */
async function stopDaemon(ctx: DaemonAppContext): Promise<void> {
	await ctx.cleanup();
}

/**
 * Insert a stale processing job directly into the job_queue table.
 * `started_at` is set STALE_AGE_MS ms in the past, which exceeds the processor's
 * 5-minute stale threshold — so reclaimStale() will reclaim it on next startup.
 *
 * Returns the inserted job id.
 */
function insertStaleProcessingJob(
	ctx: DaemonAppContext,
	queue: string,
	payload: Record<string, unknown>,
	maxRetries = 2
): string {
	const jobId = crypto.randomUUID();
	const startedAt = Date.now() - STALE_AGE_MS;
	ctx.db
		.getDatabase()
		.prepare(
			`INSERT INTO job_queue
			(id, queue, status, payload, result, error, priority, max_retries, retry_count,
			 run_at, created_at, started_at, completed_at)
			VALUES (?, ?, 'processing', ?, NULL, NULL, 0, ?, 0, ?, ?, ?, NULL)`
		)
		.run(jobId, queue, JSON.stringify(payload), maxRetries, startedAt, startedAt, startedAt);
	return jobId;
}

/**
 * Poll `jobQueue.listJobs` until a job with one of the given statuses exists in
 * `queue`, or the timeout expires.  Returns the first matching job.
 */
async function waitForJobStatus(
	ctx: DaemonAppContext,
	queue: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<ReturnType<DaemonAppContext['jobQueue']['listJobs']>[number] | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = ctx.jobQueue.listJobs({ queue, status: statuses });
		if (jobs.length > 0) return jobs[0];
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Poll until a specific job (by id) appears in the given statuses, or timeout.
 */
async function waitForJobById(
	ctx: DaemonAppContext,
	jobId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<ReturnType<DaemonAppContext['jobQueue']['listJobs']>[number] | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = ctx.jobQueue.listJobs({ status: statuses, limit: 1000 });
		const match = jobs.find((j) => j.id === jobId);
		if (match) return match;
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Remove DB files (main + WAL + SHM shards) — best-effort cleanup.
 */
async function removeDbFiles(dbPath: string): Promise<void> {
	for (const suffix of ['', '-wal', '-shm']) {
		const p = dbPath + suffix;
		if (existsSync(p)) {
			await unlink(p).catch(() => {});
		}
	}
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Job queue crash/restart recovery (online)', () => {
	let dbPath: string;
	let workspaceRoot: string;
	let daemon2: DaemonAppContext | null = null;

	// Original env vars we might mutate (restored in afterEach)
	let originalGithubToken: string | undefined;
	let originalGithubInterval: string | undefined;
	let originalWorkspacePath: string | undefined;

	beforeEach(async () => {
		await mkdir(TMP_DIR, { recursive: true });

		const id = uid();
		dbPath = `${TMP_DIR}/crash-test-${id}.db`;
		workspaceRoot = `${TMP_DIR}/ws-${id}`;
		await mkdir(workspaceRoot, { recursive: true });

		// Snapshot env vars that individual tests may modify
		originalGithubToken = process.env.GITHUB_TOKEN;
		originalGithubInterval = process.env.GITHUB_POLLING_INTERVAL;
		originalWorkspacePath = process.env.NEOKAI_WORKSPACE_PATH;

		daemon2 = null;
	});

	afterEach(async () => {
		// Always stop daemon2 (daemon1 is stopped inside each test)
		if (daemon2) {
			await stopDaemon(daemon2).catch(() => {});
			daemon2 = null;
		}

		// Restore env vars
		if (originalGithubToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = originalGithubToken;
		}
		if (originalGithubInterval === undefined) {
			delete process.env.GITHUB_POLLING_INTERVAL;
		} else {
			process.env.GITHUB_POLLING_INTERVAL = originalGithubInterval;
		}
		if (originalWorkspacePath === undefined) {
			delete process.env.NEOKAI_WORKSPACE_PATH;
		} else {
			process.env.NEOKAI_WORKSPACE_PATH = originalWorkspacePath;
		}

		// Remove temporary DB files and workspace directory
		await removeDbFiles(dbPath);
		await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
	}, 20_000);

	// =========================================================================

	test('session title gen recovery: stale processing job is reclaimed and completed on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: simulate a crash mid-job
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		// The handler only validates payload fields and delegates to
		// generateTitleAndRenameBranch — which we mock on daemon2.
		// No real session row is needed in the DB.
		const sessionId = crypto.randomUUID();

		let daemon1Err: unknown;
		try {
			// Insert a stale processing job — simulates a job that was mid-flight when
			// the daemon crashed (job left stuck in 'processing' with an old started_at)
			const staleJobId = insertStaleProcessingJob(daemon1, SESSION_TITLE_GENERATION, {
				sessionId,
				userMessageText: 'Crash recovery test message',
			});

			// Verify the stale job exists in 'processing' state before shutdown
			const beforeStop = daemon1.jobQueue.listJobs({
				queue: SESSION_TITLE_GENERATION,
				status: ['processing'],
			});
			expect(beforeStop.some((j) => j.id === staleJobId)).toBe(true);

			// ------------------------------------------------------------------
			// Phase 2 — daemon2: same DB, eager reclaim, handler completion
			// ------------------------------------------------------------------
			await stopDaemon(daemon1);

			daemon2 = await startDaemon(dbPath, workspaceRoot);

			// Stop the processor so we can safely install the mock before any retry fires.
			// The eager first tick may have already dispatched processJob; stop() waits
			// until that in-flight attempt completes (it fails fast — session not in cache)
			// before returning, ensuring the mock is in place before the retry window.
			await daemon2.jobProcessor.stop();

			// Replace the SESSION_TITLE_GENERATION handler with a no-op mock so no real
			// AI call is made when the reclaimed job is retried.
			daemon2.jobProcessor.register(SESSION_TITLE_GENERATION, async (_job) => ({
				generated: true,
			}));

			// Restart the processor: reclaimStale() runs again (no-op — job is already
			// pending from the first startup's reclaim), then the processor begins polling.
			daemon2.jobProcessor.start();

			// Wait for the job processor to pick it up and complete it
			const completed = await waitForJobById(daemon2, staleJobId, ['completed']);
			expect(completed).toBeDefined();
			expect(completed!.status).toBe('completed');
			expect(completed!.result).toMatchObject({ generated: true });
		} catch (e) {
			daemon1Err = e;
		}

		if (daemon1Err) throw daemon1Err;
	}, 30_000);

	// =========================================================================

	test('github poll chain recovery: stale processing job is reclaimed and chain resumes on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: start with GitHub config, simulate a crash
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot, GITHUB_ENV);

		let staleJobId: string;
		try {
			// Stub triggerPoll on daemon1 to prevent real HTTP calls
			const pollingService1 = daemon1.gitHubService?.getPollingService();
			if (pollingService1) {
				pollingService1.triggerPoll = async () => {};
			}

			// Wait for the initial github.poll job enqueued by gitHubService.start()
			const initialJob = await waitForJobStatus(daemon1, GITHUB_POLL, [
				'pending',
				'processing',
				'completed',
			]);
			expect(initialJob).toBeDefined();

			// Insert an additional stale processing job — simulates the polling job that
			// was running when the daemon crashed (started_at is 6 min ago)
			staleJobId = insertStaleProcessingJob(daemon1, GITHUB_POLL, {}, 2);
		} finally {
			await stopDaemon(daemon1);
		}

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, reclaim, poll chain resumes
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot, GITHUB_ENV);

		// gitHubService must be active — if null, no handler is registered and the
		// reclaimed job will fail permanently instead of completing.
		expect(daemon2.gitHubService).not.toBeNull();

		// Stop the processor, install the stub, then restart — ensures the stub is
		// in place before the reclaimed job's retry executes (same pattern as test 1).
		await daemon2.jobProcessor.stop();
		const pollingService2 = daemon2.gitHubService!.getPollingService();
		if (pollingService2) {
			pollingService2.triggerPoll = async () => {};
		}
		daemon2.jobProcessor.start();

		// The stale job must be reclaimed (processing → pending) and then completed
		const completed = await waitForJobById(daemon2, staleJobId!, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// Self-scheduling: the handler should have enqueued the next pending poll job
		const nextPending = await waitForJobStatus(daemon2, GITHUB_POLL, ['pending']);
		expect(nextPending).toBeDefined();
		expect(nextPending!.queue).toBe(GITHUB_POLL);

		// Next job should be scheduled ~300 s from now (GITHUB_POLLING_INTERVAL=300)
		const minExpectedRunAt = Date.now() + 200_000;
		expect(nextPending!.runAt).toBeGreaterThan(minExpectedRunAt);
	}, 30_000);

	// =========================================================================

	test('room tick recovery: stale tick job is reclaimed and completes gracefully on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: create a room, simulate crash with stale tick job
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		let staleTickId: string;
		try {
			// Create a room directly via RoomManager (bypasses RPC, no AI calls needed).
			// The room is persisted in the shared DB so daemon2 will load it on startup.
			const roomManager1 = new RoomManager(daemon1.db.getDatabase());
			const room = roomManager1.createRoom({
				name: 'Crash Recovery Test Room',
			});
			expect(room.id).toBeDefined();

			// Insert a stale processing tick job for this room
			staleTickId = insertStaleProcessingJob(
				daemon1,
				ROOM_TICK,
				{ roomId: room.id },
				0 // room.tick uses maxRetries=0
			);
		} finally {
			await stopDaemon(daemon1);
		}

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, stale tick job is reclaimed, handler runs.
		//
		// Note on expected behavior: the room was created via RoomManager directly
		// (not through RoomRuntimeService), so daemon1 never started a runtime for
		// it. On daemon2, initializeExistingRooms() does pick up the room and starts
		// a runtime, but the handler's `runtime.getState() === 'running'` check may
		// return false if the room has no active goal (it returns {skipped:true}).
		// Either outcome — the handler ticking the runtime OR returning skipped — is
		// a valid crash-recovery result: the critical invariant is that the stale job
		// is NOT stuck in 'processing' and DOES complete after restart.
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// Verify the stale tick job is reclaimed and eventually completes
		const processedTick = await waitForJobById(daemon2, staleTickId!, ['completed']);
		expect(processedTick).toBeDefined();
		expect(processedTick!.status).toBe('completed');
	}, 30_000);

	// =========================================================================

	test('cleanup job recovery: stale processing cleanup job is reclaimed and runs on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: simulate a crash with a cleanup job mid-flight
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		let staleCleanupId: string;
		try {
			// The initial cleanup job is seeded by createDaemonApp() as 'pending'.
			// We insert an *additional* job directly as 'processing' + stale to simulate
			// the cleanup handler that was running when the daemon crashed.
			staleCleanupId = insertStaleProcessingJob(daemon1, JOB_QUEUE_CLEANUP, {}, 2);
		} finally {
			await stopDaemon(daemon1);
		}

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, reclaim, cleanup runs
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// Stale cleanup job should be reclaimed and reach 'completed'
		const completed = await waitForJobById(daemon2, staleCleanupId!, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// Cleanup handler returns { deletedJobs, nextRunAt }
		expect(typeof (completed!.result as Record<string, unknown>)?.deletedJobs).toBe('number');
		expect(typeof (completed!.result as Record<string, unknown>)?.nextRunAt).toBe('number');

		// Self-scheduling: handler must enqueue the next cleanup ~24h from now
		const nextPending = await waitForJobStatus(daemon2, JOB_QUEUE_CLEANUP, ['pending'], 5_000);
		expect(nextPending).toBeDefined();

		// Next run should be scheduled well in the future (at least 23 h from now)
		const minNextRun = Date.now() + 23 * 60 * 60 * 1000;
		expect(nextPending!.runAt).toBeGreaterThan(minNextRun);
	}, 30_000);

	// =========================================================================

	test('eager reclamation: stale jobs leave processing state within 5 s of daemon startup', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: insert multiple stale jobs across different queues
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		let staleIds: string[];
		try {
			staleIds = [
				insertStaleProcessingJob(daemon1, SESSION_TITLE_GENERATION, {
					sessionId: crypto.randomUUID(),
					userMessageText: 'eager reclaim test',
				}),
				insertStaleProcessingJob(daemon1, JOB_QUEUE_CLEANUP, {}),
			];

			// Confirm all inserted jobs are in 'processing' state before daemon1 stops
			for (const id of staleIds) {
				const all = daemon1.jobQueue.listJobs({ status: ['processing'], limit: 100 });
				expect(all.some((j) => j.id === id)).toBe(true);
			}
		} finally {
			await stopDaemon(daemon1);
		}

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: verify reclaim happens within 5 s (eager, not periodic).
		//
		// The periodic stale-check runs every 60 s. Eager reclamation fires inside
		// jobProcessor.start() BEFORE the first poll tick. The 5-second window below
		// is tight enough to verify eagerness while leaving room for daemon startup time.
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// Stop processor immediately and replace the SESSION_TITLE_GENERATION handler
		// with a no-op mock to prevent the real handler from making AI calls on retry.
		await daemon2.jobProcessor.stop();
		daemon2.jobProcessor.register(SESSION_TITLE_GENERATION, async (_job) => ({
			generated: true,
		}));
		daemon2.jobProcessor.start();

		// All stale jobs must leave 'processing' within 5 s — eager reclamation
		// (on startup) moves them to 'pending' almost immediately, far below 60 s.
		for (const id of staleIds!) {
			const reclaimed = await waitForJobById(
				daemon2,
				id,
				['pending', 'completed', 'failed', 'dead'],
				5_000
			);
			expect(reclaimed).toBeDefined();
			// 'processing' would mean reclamation has NOT yet happened — that is the failure case
			expect(reclaimed!.status).not.toBe('processing');
		}
	}, 30_000);
});
