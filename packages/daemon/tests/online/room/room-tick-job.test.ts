/**
 * Online test: room.tick job queue end-to-end
 *
 * Verifies that room ticks work end-to-end through the persistent job queue,
 * including dedup, pause/resume job cancellation, and stop/restart recovery.
 *
 * Test coverage:
 * - room.tick job is enqueued when a room runtime starts
 * - Job transitions through pending -> processing -> completed
 * - No duplicate tick jobs for the same room (at most one pending at a time)
 * - Pause cancels pending tick jobs
 * - Resume enqueues a fresh immediate tick
 * - Stopping a room cancels pending ticks and prevents further scheduling
 * - Restarting a room resumes tick scheduling (new job post-restart is identified)
 * - Dead tick job (maxRetries=0) does not produce a ghost pending tick
 *
 * The room.tick handler calls runtime.tick() which is a no-op for an empty
 * room (no active task groups, no goals). No real AI calls are made.
 *
 * NOTE: dev proxy intercepts Anthropic API calls only. This test does not
 * send any Claude messages, so no Anthropic calls are made either.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/room-tick-job.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';
import { ROOM_TICK } from '../../../src/lib/job-queue-constants';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for a job to reach a desired status. */
const JOB_WAIT_TIMEOUT_MS = 8_000;

/** Polling cadence for job-status checks. */
const POLL_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the DaemonAppContext from an in-process daemon. Throws for spawned mode. */
function getDaemonCtx(daemon: DaemonServerContext): DaemonAppContext {
	const ctx = daemon as InProcessDaemon;
	if (!ctx.daemonContext) {
		throw new Error(
			'daemonContext not available — did you run in spawned mode (DAEMON_TEST_SPAWN=true)?'
		);
	}
	return ctx.daemonContext;
}

/**
 * List all room.tick jobs for a specific room with the given status(es).
 */
function listTickJobs(daemonCtx: DaemonAppContext, roomId: string, statuses: JobStatus[]): Job[] {
	const all = daemonCtx.jobQueue.listJobs({ queue: ROOM_TICK, status: statuses, limit: 10_000 });
	return all.filter((j) => (j.payload as { roomId?: string }).roomId === roomId);
}

/**
 * Poll the job queue until at least one room.tick job for the given room
 * exists with one of the specified statuses, or until the timeout expires.
 *
 * Throws on timeout with a full diagnostic snapshot.
 */
async function waitForTickJob(
	daemonCtx: DaemonAppContext,
	roomId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = listTickJobs(daemonCtx, roomId, statuses);
		if (jobs.length > 0) {
			return jobs[0];
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	// Final snapshot for diagnostics
	const all = daemonCtx.jobQueue.listJobs({ queue: ROOM_TICK, limit: 10_000 });
	throw new Error(
		`Timeout waiting for room.tick job for room "${roomId}" with status [${statuses.join(',')}] after ${timeoutMs}ms. ` +
			`All room.tick jobs: ${JSON.stringify(all.map((j) => ({ id: j.id, payload: j.payload, status: j.status, runAt: j.runAt })))}`
	);
}

/**
 * Poll until no room.tick jobs with the given statuses exist for the room,
 * or throw on timeout.
 */
async function waitForNoTickJobs(
	daemonCtx: DaemonAppContext,
	roomId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = listTickJobs(daemonCtx, roomId, statuses);
		if (jobs.length === 0) return;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	const remaining = listTickJobs(daemonCtx, roomId, statuses);
	throw new Error(
		`Timeout waiting for room.tick jobs [${statuses.join(',')}] to clear for room "${roomId}" after ${timeoutMs}ms. ` +
			`Remaining: ${JSON.stringify(remaining.map((j) => ({ id: j.id, status: j.status })))}`
	);
}

/**
 * Create a room via RPC and return its ID.
 */
async function createRoom(daemon: DaemonServerContext, name: string): Promise<string> {
	const result = (await daemon.messageHub.request('room.create', { name })) as {
		room: { id: string };
	};
	return result.room.id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('room.tick via job queue (online)', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();

		const ctx = daemon as InProcessDaemon;
		if (!ctx.daemonContext) {
			throw new Error(
				'room-tick-job tests require in-process daemon mode. ' +
					'Unset DAEMON_TEST_SPAWN to run these tests.'
			);
		}
	}, 30_000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 1: Tick job is enqueued when room runtime starts
	// -------------------------------------------------------------------------

	test('room.tick job is enqueued after room creation', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-enqueue-test');

		// The runtime starts synchronously on room.created and calls scheduleTick(delay=0),
		// so a job should appear very quickly.
		const job = await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);

		expect(job.queue).toBe(ROOM_TICK);
		expect((job.payload as { roomId: string }).roomId).toBe(roomId);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 2: Job processes and reaches completed status
	// -------------------------------------------------------------------------

	test('room.tick job transitions through processing and reaches completed', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-completed-test');

		// Wait for the first tick job to finish (empty room — tick is a no-op).
		const completed = await waitForTickJob(daemonCtx, roomId, ['completed']);

		expect(completed.status).toBe('completed');
		expect(completed.completedAt).not.toBeNull();
		expect((completed.payload as { roomId: string }).roomId).toBe(roomId);
		// maxRetries=0 by design: tick failures are terminal (no silent retry loop).
		expect(completed.maxRetries).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 3: After completion, the handler re-schedules a new tick
	// -------------------------------------------------------------------------

	test('tick handler re-schedules next tick after completion', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-rescheduled-test');

		// Wait for the initial tick to complete (discard result — waitForTickJob throws on timeout).
		await waitForTickJob(daemonCtx, roomId, ['completed']);

		// The handler's finally block enqueues the next tick with DEFAULT_TICK_INTERVAL_MS (30s).
		const next = await waitForTickJob(daemonCtx, roomId, ['pending']);
		expect((next.payload as { roomId: string }).roomId).toBe(roomId);

		// Next tick should be scheduled ~30 s in the future (at least 10 s to avoid flakiness).
		expect(next.runAt).toBeGreaterThan(Date.now() + 10_000);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 4: Dedup — exactly one pending tick per room
	// -------------------------------------------------------------------------

	test('dedup: exactly one pending room.tick job per room', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-dedup-test');

		// Wait for the tick to appear: room.created handlers fire via queueMicrotask
		// after the RPC returns, so the enqueue is not guaranteed to have happened
		// the moment createRoom() resolves. Poll until it does, then assert count=1.
		await waitForTickJob(daemonCtx, roomId, ['pending', 'processing']);
		const atStartup = listTickJobs(daemonCtx, roomId, ['pending', 'processing']);
		expect(atStartup.length).toBe(1);

		// Wait for the initial tick to complete and the next one to be enqueued.
		await waitForTickJob(daemonCtx, roomId, ['completed']);
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// After self-scheduling: still exactly 1 pending tick — dedup prevents extras.
		const afterReschedule = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterReschedule.length).toBe(1);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 5: Pause cancels pending tick jobs
	// -------------------------------------------------------------------------

	test('pause cancels pending room.tick jobs', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-pause-test');

		// Wait for the initial tick to complete (so we have a known pending next tick
		// with runAt ≈ now+30s — safely in the future, won't be picked up mid-test).
		await waitForTickJob(daemonCtx, roomId, ['completed']);
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Pause the runtime — cancelPendingTickJobs() runs synchronously inside pause(),
		// so by the time this RPC returns all pending ticks are already deleted.
		await daemon.messageHub.request('room.runtime.pause', { roomId });

		// No sleep needed — cancellation is synchronous with the RPC.
		const afterPause = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterPause.length).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 6: Resume enqueues a fresh immediate tick
	// -------------------------------------------------------------------------

	test('resume enqueues a fresh room.tick job after pause', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-resume-test');

		// Wait for the initial tick to complete so there's a predictable pending next tick.
		await waitForTickJob(daemonCtx, roomId, ['completed']);
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Pause — cancelPendingTickJobs() is synchronous; no sleep needed.
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		const afterPause = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterPause.length).toBe(0);

		// Resume — enqueues a fresh immediate tick (delay=0).
		await daemon.messageHub.request('room.runtime.resume', { roomId });

		// A new pending or processing tick should appear promptly (delay=0).
		const freshTick = await waitForTickJob(daemonCtx, roomId, ['pending', 'processing']);
		expect((freshTick.payload as { roomId: string }).roomId).toBe(roomId);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 7: Stop cancels pending ticks and prevents further scheduling
	// -------------------------------------------------------------------------

	test('stop cancels pending ticks and prevents further scheduling', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-stop-test');

		// Wait for the initial tick job to appear.
		await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);

		// Stop the runtime — cancels pending ticks and removes runtime from map.
		await daemon.messageHub.request('room.runtime.stop', { roomId });

		// If a tick was in-flight (processing) at the moment of stop, wait for it to
		// finish. Once complete, the handler's finally block checks runtime.getState()
		// (now 'stopped') and skips re-enqueuing.
		await waitForNoTickJobs(daemonCtx, roomId, ['processing']);

		// No pending ticks should remain after stop.
		const afterStop = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterStop.length).toBe(0);

		// Brief window to confirm no new tick is scheduled by any residual path.
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		const noNewPending = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(noNewPending.length).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 8: Restart resumes tick scheduling with a verifiably new job
	// -------------------------------------------------------------------------

	test('restarting a stopped room resumes tick scheduling', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-restart-test');

		// Wait for the initial tick to appear, then stop the runtime.
		await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);
		await daemon.messageHub.request('room.runtime.stop', { roomId });

		// Wait for any in-flight tick to finish before asserting pending=0.
		await waitForNoTickJobs(daemonCtx, roomId, ['processing']);
		const afterStop = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterStop.length).toBe(0);

		// Record timestamp immediately before restart so we can verify the post-restart
		// job is genuinely new (createdAt >= beforeRestartTimestamp).
		const beforeRestartTimestamp = Date.now();

		// Restart — creates a fresh runtime and calls start() which enqueues an immediate tick.
		await daemon.messageHub.request('room.runtime.start', { roomId });

		// A fresh tick job should appear.
		const freshTick = await waitForTickJob(daemonCtx, roomId, [
			'pending',
			'processing',
			'completed',
		]);
		expect((freshTick.payload as { roomId: string }).roomId).toBe(roomId);
		// Confirm this is a newly created job, not a leftover from before the restart.
		expect(freshTick.createdAt).toBeGreaterThanOrEqual(beforeRestartTimestamp);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 9: Dead tick job (maxRetries=0) does not produce a ghost pending tick
	// -------------------------------------------------------------------------

	test('dead tick job does not produce a ghost pending tick', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-dead-test');

		// Wait for the initial job to complete so the state is predictable.
		await waitForTickJob(daemonCtx, roomId, ['completed']);

		// Pause to stop new ticks from being enqueued naturally.
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		const afterPause = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterPause.length).toBe(0);

		// Insert a 'dead' job directly, simulating what happens when the tick handler
		// throws and maxRetries=0 is exhausted (no retries, status goes straight to dead).
		const rawDb = daemonCtx.db.getDatabase();
		const deadJobId = crypto.randomUUID();
		const now = Date.now();
		rawDb
			.prepare(
				`INSERT INTO job_queue
				(id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, completed_at)
				VALUES (?, ?, 'dead', ?, NULL, 'simulated handler throw', 0, 0, 0, ?, ?, ?, ?)`
			)
			.run(deadJobId, ROOM_TICK, JSON.stringify({ roomId }), now, now, now, now);

		// Dead jobs are terminal — no automatic retry, no re-enqueue.
		// Wait a moment and confirm no new pending tick appears.
		await new Promise<void>((resolve) => setTimeout(resolve, 400));
		const noPending = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(noPending.length).toBe(0);

		// The dead job itself should remain in dead status (not reclaimed or retried).
		const deadJobs = listTickJobs(daemonCtx, roomId, ['dead']);
		expect(deadJobs.some((j) => j.id === deadJobId)).toBe(true);
	}, 15_000);
});
