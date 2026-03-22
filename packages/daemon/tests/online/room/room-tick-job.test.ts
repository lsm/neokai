/**
 * Online test: room tick via job queue
 *
 * Verifies end-to-end room tick job queue mechanics without making real
 * LLM API calls:
 * - room.tick job is enqueued when room runtime starts
 * - No duplicate tick jobs for the same room (at most one pending)
 * - Pause cancels pending tick jobs
 * - Resume enqueues a fresh tick job
 * - Stopping a room cancels pending ticks and prevents further scheduling
 * - Restarting a room enqueues a new tick job
 * - Job processes and re-schedules (self-scheduling chain)
 *
 * These tests exercise the persistent job queue mechanics (enqueueRoomTick,
 * cancelPendingTickJobs, createRoomTickHandler) introduced in Task 4.1–4.3.
 *
 * NOTE: No Anthropic/LLM calls are made — the room.tick handler only invokes
 * RoomRuntime.tick(), which checks for active task groups. Since the test rooms
 * have no active groups, tick() returns quickly and no API calls occur.
 * Dev Proxy is still used as required by NEOKAI_USE_DEV_PROXY=1.
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
// Configuration
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for a job to reach a desired status. */
const JOB_WAIT_TIMEOUT_MS = 10_000;

/** Polling interval for job-status checks. */
const POLL_INTERVAL_MS = 50;

/** How long to wait after a control operation before asserting no tick exists. */
const SETTLE_MS = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

/** Extract the DaemonAppContext from an in-process daemon. Fails fast if spawned. */
function getDaemonCtx(daemon: DaemonServerContext): DaemonAppContext {
	const ctx = daemon as InProcessDaemon;
	if (!ctx.daemonContext) {
		throw new Error(
			'daemonContext not available — did you run in spawned mode (DAEMON_TEST_SPAWN=true)?'
		);
	}
	return ctx.daemonContext;
}

/** List all room.tick jobs for a specific room. */
function listTickJobs(daemonCtx: DaemonAppContext, roomId: string, statuses: JobStatus[]): Job[] {
	return daemonCtx.jobQueue
		.listJobs({ queue: ROOM_TICK, status: statuses, limit: 10_000 })
		.filter((j) => (j.payload as { roomId?: string }).roomId === roomId);
}

/**
 * Poll until a room.tick job for the given room exists with one of the
 * specified statuses. Returns the first matching job, or undefined on timeout.
 */
async function waitForTickJob(
	daemonCtx: DaemonAppContext,
	roomId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = listTickJobs(daemonCtx, roomId, statuses);
		if (jobs.length > 0) return jobs[0];
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Immediately re-enqueue a tick with runAt=now so the job processor picks it up
 * within one poll cycle (~1 s) rather than the default 30 s interval.
 *
 * Steps:
 * 1. Delete the existing pending tick (if any) for the room.
 * 2. Directly insert a new pending tick with runAt = Date.now().
 *
 * This avoids coupling the test to timer internals and keeps tests fast.
 */
function acceleratePendingTick(daemonCtx: DaemonAppContext, roomId: string): void {
	const pending = listTickJobs(daemonCtx, roomId, ['pending']);
	for (const job of pending) {
		daemonCtx.jobQueue.deleteJob(job.id);
	}
	// Enqueue a tick that is due immediately so the processor runs it ASAP.
	daemonCtx.jobQueue.enqueue({
		queue: ROOM_TICK,
		payload: { roomId },
		maxRetries: 0,
		runAt: Date.now(),
	});
}

/** Create a room and return its ID. */
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
	let daemonCtx: DaemonAppContext;
	let roomId: string;

	beforeEach(async () => {
		daemon = await createDaemonServer();
		daemonCtx = getDaemonCtx(daemon);
		roomId = await createRoom(daemon, 'tick-test-room');
	}, 30_000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 15_000);

	// -------------------------------------------------------------------------
	// Basic enqueue on start
	// -------------------------------------------------------------------------

	test('room.tick job is enqueued when room runtime starts', async () => {
		// Room creation triggers runtime.start() → scheduleTick() → enqueueRoomTick().
		// The pending tick may not be visible immediately due to timing, so we poll briefly.
		const job = await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);

		expect(job).toBeDefined();
		expect(job!.queue).toBe(ROOM_TICK);
		expect((job!.payload as { roomId: string }).roomId).toBe(roomId);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Dedup: at most one pending tick per room
	// -------------------------------------------------------------------------

	test('no duplicate pending tick jobs for the same room', async () => {
		// Ensure an initial tick exists.
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Attempt to enqueue additional ticks via the RPC resume path (which calls
		// enqueueRoomTick internally). The dedup guard must absorb these.
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		await daemon.messageHub.request('room.runtime.resume', { roomId });
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		await daemon.messageHub.request('room.runtime.resume', { roomId });

		// Short settle so any in-flight enqueue calls complete.
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

		const pendingJobs = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingJobs.length).toBeLessThanOrEqual(1);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Pause cancels pending ticks
	// -------------------------------------------------------------------------

	test('pause cancels all pending tick jobs for the room', async () => {
		// Wait for the initial tick to exist.
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Pause via RPC — this calls cancelPendingTickJobs() internally.
		await daemon.messageHub.request('room.runtime.pause', { roomId });

		// Allow any in-flight operations to settle.
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

		const pendingAfterPause = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterPause.length).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Resume enqueues fresh tick
	// -------------------------------------------------------------------------

	test('resume enqueues a fresh tick job after pause', async () => {
		// Wait for initial tick, then pause (cancels it).
		await waitForTickJob(daemonCtx, roomId, ['pending']);
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

		// Confirm no pending ticks after pause.
		expect(listTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Resume via RPC — this calls enqueueRoomTick() internally.
		await daemon.messageHub.request('room.runtime.resume', { roomId });

		// The fresh tick should appear promptly.
		const freshJob = await waitForTickJob(daemonCtx, roomId, ['pending']);
		expect(freshJob).toBeDefined();
		expect(freshJob!.queue).toBe(ROOM_TICK);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Stop cancels pending ticks
	// -------------------------------------------------------------------------

	test('stopping a room cancels all pending tick jobs', async () => {
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Stop via RPC — this calls cancelPendingTickJobs() internally.
		await daemon.messageHub.request('room.runtime.stop', { roomId });
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

		const pendingAfterStop = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterStop.length).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Restart re-enqueues tick
	// -------------------------------------------------------------------------

	test('restarting a room enqueues a new tick job', async () => {
		await waitForTickJob(daemonCtx, roomId, ['pending']);

		// Stop first (removes runtime and pending ticks).
		await daemon.messageHub.request('room.runtime.stop', { roomId });
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
		expect(listTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Restart — creates fresh runtime and calls runtime.start() → scheduleTick().
		await daemon.messageHub.request('room.runtime.start', { roomId });

		const newJob = await waitForTickJob(daemonCtx, roomId, ['pending']);
		expect(newJob).toBeDefined();
		expect(newJob!.queue).toBe(ROOM_TICK);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Job processes and re-schedules (self-scheduling chain)
	// -------------------------------------------------------------------------

	test('job processes and re-enqueues the next tick (self-scheduling)', async () => {
		// Wait for the initial pending tick, then accelerate it to run immediately.
		await waitForTickJob(daemonCtx, roomId, ['pending']);
		acceleratePendingTick(daemonCtx, roomId);

		// Wait for the job to reach 'completed' status.
		const completed = await waitForTickJob(daemonCtx, roomId, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// The handler's finally block must have enqueued a new pending tick.
		const next = await waitForTickJob(daemonCtx, roomId, ['pending']);
		expect(next).toBeDefined();
		expect(next!.queue).toBe(ROOM_TICK);

		// The next tick should be scheduled ~30 s in the future.
		// Verify it is at least 20 s away to allow for minor clock skew.
		const minExpectedRunAt = Date.now() + 20_000;
		expect(next!.runAt).toBeGreaterThan(minExpectedRunAt);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Stopped runtime prevents re-scheduling after in-flight tick completes
	// -------------------------------------------------------------------------

	test('in-flight tick does not re-schedule after runtime is stopped', async () => {
		// Accelerate the initial tick so it runs immediately.
		await waitForTickJob(daemonCtx, roomId, ['pending']);
		acceleratePendingTick(daemonCtx, roomId);

		// Stop the runtime before the processor picks up the accelerated job.
		// Race: stop may happen before or after the handler reads runtime state.
		// Either way, the invariant is: after the job completes, no new pending tick
		// should be enqueued (handler checks runtime.getState() === 'running').
		await daemon.messageHub.request('room.runtime.stop', { roomId });

		// Wait long enough for the processor to pick up and finish the accelerated job.
		await new Promise<void>((resolve) => setTimeout(resolve, 3_000));

		// No new pending tick should exist for the stopped room.
		const pendingAfterStop = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterStop.length).toBe(0);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Multiple rooms: each gets an independent tick job
	// -------------------------------------------------------------------------

	test('each room gets its own independent tick job', async () => {
		const roomId2 = await createRoom(daemon, 'tick-test-room-2');

		// Both rooms should have a pending tick.
		const job1 = await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);
		const job2 = await waitForTickJob(daemonCtx, roomId2, ['pending', 'processing', 'completed']);

		expect(job1).toBeDefined();
		expect(job2).toBeDefined();
		expect(job1!.id).not.toBe(job2!.id);

		// Pause room1 — only its tick should be cancelled.
		await daemon.messageHub.request('room.runtime.pause', { roomId });
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

		const pendingRoom1 = listTickJobs(daemonCtx, roomId, ['pending']);
		const pendingRoom2 = listTickJobs(daemonCtx, roomId2, ['pending']);

		expect(pendingRoom1.length).toBe(0);
		expect(pendingRoom2.length).toBeGreaterThanOrEqual(1);
	}, 20_000);
});
