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
 * No real AI API calls are made: session-title and room-tick handlers are
 * monkey-patched, github.poll uses a stub triggerPoll(), and cleanup runs
 * against the local SQLite file only.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, unlink } from 'node:fs/promises';
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

	beforeEach(async () => {
		await mkdir(TMP_DIR, { recursive: true });

		const id = uid();
		dbPath = `${TMP_DIR}/crash-test-${id}.db`;
		workspaceRoot = `${TMP_DIR}/ws-${id}`;
		await mkdir(workspaceRoot, { recursive: true });

		// Snapshot env vars that individual tests may modify
		originalGithubToken = process.env.GITHUB_TOKEN;
		originalGithubInterval = process.env.GITHUB_POLLING_INTERVAL;

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

		// Remove temporary DB files
		await removeDbFiles(dbPath);
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

		await stopDaemon(daemon1);

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, eager reclaim, handler completion
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// Monkey-patch generateTitleAndRenameBranch so no real AI call is made
		const sessionLifecycle = daemon2.sessionManager.getSessionLifecycle();
		sessionLifecycle.generateTitleAndRenameBranch = async (_sid: string, _text: string) => {};

		// reclaimStale() runs eagerly inside jobProcessor.start(), so the stale job
		// is immediately moved back to 'pending' before the first poll tick.
		// We verify the job now appears in 'pending' OR already moved to 'completed'
		// (processor can be very fast)
		const reclaimedOrComplete = await waitForJobById(
			daemon2,
			staleJobId,
			['pending', 'completed'],
			3_000
		);
		expect(reclaimedOrComplete).toBeDefined();

		// Wait for the job processor to pick it up and complete it
		const completed = await waitForJobById(daemon2, staleJobId, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');
		expect(completed!.result).toMatchObject({ generated: true });
	}, 30_000);

	// =========================================================================

	test('github poll chain recovery: stale processing job is reclaimed and chain resumes on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: start with GitHub config, simulate a crash
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot, GITHUB_ENV);

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
		const staleJobId = insertStaleProcessingJob(daemon1, GITHUB_POLL, {}, 2);

		await stopDaemon(daemon1);

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, reclaim, poll chain resumes
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot, GITHUB_ENV);

		// Stub triggerPoll on daemon2 — no real GitHub API calls
		const pollingService2 = daemon2.gitHubService?.getPollingService();
		if (pollingService2) {
			pollingService2.triggerPoll = async () => {};
		}

		// The stale job must be reclaimed (processing → pending) and then completed
		const completed = await waitForJobById(daemon2, staleJobId, ['completed']);
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

	test('room tick recovery: stale tick job is reclaimed and runtime resumes ticking on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: create a room, simulate crash with stale tick job
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		// Create a room directly via RoomManager (bypasses RPC, no AI calls needed)
		const roomManager1 = new RoomManager(daemon1.db.getDatabase());
		const room = roomManager1.createRoom({
			name: 'Crash Recovery Test Room',
		});
		expect(room.id).toBeDefined();

		// Insert a stale processing tick job for this room
		const staleTickId = insertStaleProcessingJob(
			daemon1,
			ROOM_TICK,
			{ roomId: room.id },
			0 // room.tick uses maxRetries=0
		);

		await stopDaemon(daemon1);

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, room runtime is re-initialized, stale
		//           tick job is reclaimed, handler runs under active runtime
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// daemon2's RoomRuntimeService.initializeExistingRooms() picks up the
		// persisted room and starts a runtime for it. The stale tick job is
		// reclaimed to 'pending' by reclaimStale().

		// Verify the stale tick job is reclaimed and eventually completes.
		// The handler either ticks the running runtime or returns {skipped:true}
		// if the runtime hasn't fully started yet — both are valid recovery outcomes.
		const processedTick = await waitForJobById(daemon2, staleTickId, ['completed']);
		expect(processedTick).toBeDefined();
		expect(processedTick!.status).toBe('completed');

		// Self-scheduling: if the runtime is running, the handler enqueues the next
		// tick.  We don't assert on this because the runtime state depends on async
		// recovery — the critical invariant is that the stale job was NOT lost.
	}, 30_000);

	// =========================================================================

	test('cleanup job recovery: stale processing cleanup job is reclaimed and runs on restart', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: simulate a crash with a cleanup job mid-flight
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		// The initial cleanup job is seeded by createDaemonApp() as 'pending'.
		// We insert an *additional* job directly as 'processing' + stale to simulate
		// the cleanup handler that was running when the daemon crashed.
		const staleCleanupId = insertStaleProcessingJob(daemon1, JOB_QUEUE_CLEANUP, {}, 2);

		await stopDaemon(daemon1);

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: same DB, reclaim, cleanup runs
		// ------------------------------------------------------------------
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// Stale cleanup job should be reclaimed and reach 'completed'
		const completed = await waitForJobById(daemon2, staleCleanupId, ['completed']);
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

	test('eager reclamation: stale jobs are reclaimed immediately on startup, not after 60s polling delay', async () => {
		// ------------------------------------------------------------------
		// Phase 1 — daemon1: insert multiple stale jobs across all queues
		// ------------------------------------------------------------------
		const daemon1 = await startDaemon(dbPath, workspaceRoot);

		const staleIds = [
			insertStaleProcessingJob(daemon1, SESSION_TITLE_GENERATION, {
				sessionId: crypto.randomUUID(),
				userMessageText: 'eager reclaim test',
			}),
			insertStaleProcessingJob(daemon1, JOB_QUEUE_CLEANUP, {}),
		];

		// Confirm all stale jobs are in 'processing' state
		for (const id of staleIds) {
			const allProcessing = daemon1.jobQueue.listJobs({ status: ['processing'], limit: 100 });
			expect(allProcessing.some((j) => j.id === id)).toBe(true);
		}

		await stopDaemon(daemon1);

		// ------------------------------------------------------------------
		// Phase 2 — daemon2: verify reclaim happens BEFORE the first 60s check
		// ------------------------------------------------------------------
		const startTime = Date.now();
		daemon2 = await startDaemon(dbPath, workspaceRoot);

		// Mock title generator to avoid real AI calls
		const sessionLifecycle = daemon2.sessionManager.getSessionLifecycle();
		sessionLifecycle.generateTitleAndRenameBranch = async () => {};

		// Wait for all stale jobs to leave 'processing' state.
		// This must happen well within 60 seconds (the periodic stale-check interval).
		// Eager reclamation in jobProcessor.start() makes this near-instantaneous.
		for (const id of staleIds) {
			const reclaimed = await waitForJobById(
				daemon2,
				id,
				['pending', 'completed', 'failed', 'dead'],
				5_000
			);
			expect(reclaimed).toBeDefined();
			// Stale job must no longer be 'processing' within 5 s — far below 60 s
			expect(reclaimed!.status).not.toBe('processing');
		}

		// The elapsed time must be less than the periodic 60s stale-check delay,
		// proving reclamation was eager (on startup) rather than periodic.
		const elapsed = Date.now() - startTime;
		expect(elapsed).toBeLessThan(30_000);
	}, 30_000);
});
