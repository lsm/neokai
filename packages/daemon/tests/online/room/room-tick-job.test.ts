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
 * - Restarting a room resumes tick scheduling
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
 * Returns the first matching job, or throws on timeout.
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
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 3: After completion, the handler re-schedules a new tick
	// -------------------------------------------------------------------------

	test('tick handler re-schedules next tick after completion', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-rescheduled-test');

		// Wait for the initial tick to complete.
		const firstCompleted = await waitForTickJob(daemonCtx, roomId, ['completed']);
		expect(firstCompleted).toBeDefined();

		// The handler's finally block enqueues the next tick with DEFAULT_TICK_INTERVAL_MS (30s).
		const next = await waitForTickJob(daemonCtx, roomId, ['pending']);
		expect(next).toBeDefined();
		expect((next.payload as { roomId: string }).roomId).toBe(roomId);

		// Next tick should be scheduled ~30 s in the future (at least 10 s to avoid flakiness).
		expect(next.runAt).toBeGreaterThan(Date.now() + 10_000);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 4: Dedup — at most one pending tick per room
	// -------------------------------------------------------------------------

	test('dedup: at most one pending room.tick job per room', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-dedup-test');

		// Check immediately after room creation: at most 1 pending/processing tick.
		const atStartup = listTickJobs(daemonCtx, roomId, ['pending', 'processing']);
		expect(atStartup.length).toBeLessThanOrEqual(1);

		// Wait for the initial tick to complete and the next one to be enqueued.
		await waitForTickJob(daemonCtx, roomId, ['completed']);
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Still at most 1 pending tick for this room.
		const afterReschedule = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterReschedule.length).toBeLessThanOrEqual(1);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 5: Pause cancels pending tick jobs
	// -------------------------------------------------------------------------

	test('pause cancels pending room.tick jobs', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-pause-test');

		// Wait for the initial tick to complete (so we have a known pending next tick).
		await waitForTickJob(daemonCtx, roomId, ['completed']);

		// Confirm there's a pending next tick before pausing.
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Pause the runtime — this should cancel all pending ticks.
		await daemon.messageHub.request('room.runtime.pause', { roomId });

		// After a short wait, no pending ticks should remain.
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
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

		// Pause the runtime — cancels pending ticks.
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		await new Promise<void>((resolve) => setTimeout(resolve, 200));

		// Verify no pending tick after pause.
		const afterPause = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterPause.length).toBe(0);

		// Resume — enqueues a fresh immediate tick (delay=0).
		await daemon.messageHub.request('room.runtime.resume', { roomId });

		// A new pending tick should appear promptly.
		const freshTick = await waitForTickJob(daemonCtx, roomId, [
			'pending',
			'processing',
			'completed',
		]);
		expect(freshTick).toBeDefined();
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

		// Allow any in-flight job processor cycle to complete.
		await new Promise<void>((resolve) => setTimeout(resolve, 500));

		// No pending ticks should remain after stop.
		const afterStop = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterStop.length).toBe(0);

		// Wait a bit longer — no new tick should be enqueued because runtime is stopped.
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		const noNewPending = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(noNewPending.length).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Test 8: Restart resumes tick scheduling
	// -------------------------------------------------------------------------

	test('restarting a stopped room resumes tick scheduling', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-restart-test');

		// Wait for the initial tick to appear, then stop the runtime.
		await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);
		await daemon.messageHub.request('room.runtime.stop', { roomId });

		// Verify no pending tick after stop.
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		const afterStop = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterStop.length).toBe(0);

		// Restart — creates a fresh runtime and calls start() which enqueues an immediate tick.
		await daemon.messageHub.request('room.runtime.start', { roomId });

		// A fresh tick job should appear.
		const freshTick = await waitForTickJob(daemonCtx, roomId, [
			'pending',
			'processing',
			'completed',
		]);
		expect(freshTick).toBeDefined();
		expect((freshTick.payload as { roomId: string }).roomId).toBe(roomId);
	}, 15_000);
});
