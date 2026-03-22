/**
 * Online test: room tick via job queue
 *
 * Verifies end-to-end room tick job queue mechanics without triggering real
 * AI agent work:
 * - room.tick job is enqueued when the room runtime starts
 * - Job transitions through pending → processing → completed
 * - Self-scheduling: next tick job is enqueued after the initial one completes
 * - Dedup: at most one pending room.tick job exists per room at any time
 * - Pause cancels pending ticks for that room
 * - Resume enqueues a fresh tick for that room
 * - Stop cancels pending ticks and prevents further scheduling
 * - Restart (startRuntime) re-enqueues a fresh tick
 * - Recovery: a stale processing job is reclaimed by reclaimStale() and completes
 *
 * A fresh room with no goals or tasks runs tick() as a fast no-op:
 * - No zombie groups exist
 * - No recurring missions exist
 * - No pending tasks exist
 * The tick completes without any Anthropic API call, so dev proxy intercepts
 * are not needed for correctness, but the test is still gated on
 * NEOKAI_USE_DEV_PROXY=1 to stay consistent with the features/ test suite.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/room-tick-job.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';
import { ROOM_TICK } from '../../../src/lib/job-queue-constants';
import { DEFAULT_TICK_INTERVAL_MS } from '../../../src/lib/job-handlers/room-tick.handler';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

// This test suite requires in-process daemon access to inspect the job queue
// directly. Spawned-process mode does not expose daemonContext.

/** Maximum time (ms) to wait for a job to reach a desired status. */
const JOB_WAIT_TIMEOUT_MS = 10_000;

/** Polling cadence for job-status checks. */
const POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

/** Extract the DaemonAppContext from an in-process daemon. */
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
 * Create a room via RPC and return its ID.
 */
async function createRoom(daemon: DaemonServerContext, name: string): Promise<string> {
	const result = (await daemon.messageHub.request('room.create', {
		name: `${name}-${Date.now()}`,
	})) as { room: { id: string } };
	return result.room.id;
}

/**
 * Return all room.tick jobs for a specific room matching any of the given statuses.
 *
 * listJobs returns rows ordered by priority DESC, run_at ASC. The first element
 * is the job with highest priority and earliest scheduled time — suitable for
 * checking existence and status but not for ordering assertions.
 */
function getRoomTickJobs(
	daemonCtx: DaemonAppContext,
	roomId: string,
	statuses: JobStatus[]
): Job[] {
	const all = daemonCtx.jobQueue.listJobs({ queue: ROOM_TICK, status: statuses, limit: 1000 });
	return all.filter((j) => (j.payload as { roomId?: string }).roomId === roomId);
}

/**
 * Poll the job queue until at least one room.tick job for the given room exists
 * with one of the given statuses, or until the timeout expires.
 */
async function waitForRoomTickJob(
	daemonCtx: DaemonAppContext,
	roomId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = getRoomTickJobs(daemonCtx, roomId, statuses);
		if (jobs.length > 0) {
			return jobs[0];
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Poll until a specific job (by id) reaches one of the given statuses.
 */
async function waitForJobById(
	daemonCtx: DaemonAppContext,
	roomId: string,
	jobId: string,
	statuses: JobStatus[],
	timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = getRoomTickJobs(daemonCtx, roomId, statuses);
		const match = jobs.find((j) => j.id === jobId);
		if (match) return match;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return undefined;
}

/**
 * Pause the room runtime via RPC.
 */
async function pauseRuntime(daemon: DaemonServerContext, roomId: string): Promise<void> {
	await daemon.messageHub.request('room.runtime.pause', { roomId });
}

/**
 * Resume the room runtime via RPC.
 */
async function resumeRuntime(daemon: DaemonServerContext, roomId: string): Promise<void> {
	await daemon.messageHub.request('room.runtime.resume', { roomId });
}

/**
 * Stop the room runtime via RPC.
 */
async function stopRuntime(daemon: DaemonServerContext, roomId: string): Promise<void> {
	await daemon.messageHub.request('room.runtime.stop', { roomId });
}

/**
 * Start (or restart) the room runtime via RPC.
 */
async function startRuntime(daemon: DaemonServerContext, roomId: string): Promise<void> {
	await daemon.messageHub.request('room.runtime.start', { roomId });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const describeOrSkip = process.env.DAEMON_TEST_SPAWN === 'true' ? describe.skip : describe;

describeOrSkip('room tick via job queue (online)', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30_000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 15_000);

	// -------------------------------------------------------------------------

	test('room.tick job is enqueued when a new room runtime starts', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-enqueue-test');

		// The runtime starts synchronously inside room.create → RoomRuntimeService
		// creates the runtime and calls runtime.start() → scheduleTick() → enqueueRoomTick(delay=0).
		// The job is visible in the DB immediately.
		const jobs = getRoomTickJobs(daemonCtx, roomId, ['pending', 'processing', 'completed']);
		expect(jobs.length).toBeGreaterThanOrEqual(1);
		expect(jobs[0].queue).toBe(ROOM_TICK);
		expect((jobs[0].payload as { roomId: string }).roomId).toBe(roomId);
	});

	test('room.tick job transitions through processing and reaches completed', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-complete-test');

		const completed = await waitForRoomTickJob(daemonCtx, roomId, ['completed']);

		expect(completed).toBeDefined();
		expect(completed!.queue).toBe(ROOM_TICK);
		expect(completed!.status).toBe('completed');
		expect(completed!.completedAt).not.toBeNull();
	}, 15_000);

	test('self-scheduling: next tick job is enqueued after the initial tick completes', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-self-schedule-test');

		// Wait for the initial tick to complete.
		const firstCompleted = await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		expect(firstCompleted).toBeDefined();

		// The handler must have enqueued a new pending job for the next cycle.
		const next = await waitForRoomTickJob(daemonCtx, roomId, ['pending']);
		expect(next).toBeDefined();
		expect(next!.queue).toBe(ROOM_TICK);

		// Next job must be scheduled at least DEFAULT_TICK_INTERVAL_MS from now.
		// Allow 2 s of slack for CI timing — a correct 30 s interval easily clears this.
		const slack = 2_000;
		expect(next!.runAt).toBeGreaterThan(Date.now() + DEFAULT_TICK_INTERVAL_MS - slack);
	}, 15_000);

	test('dedup: at most one pending room.tick job exists per room at any time', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-dedup-test');

		// Immediately after room creation: exactly 1 tick job (pending or processing).
		const atStart = getRoomTickJobs(daemonCtx, roomId, ['pending', 'processing']);
		expect(atStart.length).toBe(1);

		// Let the initial job run and the next job be enqueued.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await waitForRoomTickJob(daemonCtx, roomId, ['pending']);

		// After self-scheduling: still at most 1 pending/processing job, never more.
		const afterSchedule = getRoomTickJobs(daemonCtx, roomId, ['pending', 'processing']);
		expect(afterSchedule.length).toBeLessThanOrEqual(1);
	}, 15_000);

	test('pause cancels pending tick jobs for the room', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-pause-test');

		// Wait for the initial 0-delay tick to complete and for the self-scheduled job to appear.
		// The self-scheduled job has runAt ≈ now + DEFAULT_TICK_INTERVAL_MS (30 s), so the
		// processor will not dequeue it for at least ~30 s. Pausing within that window is safe:
		// the job is still 'pending' when cancelPendingTickJobs() runs.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		const pendingBeforePause = await waitForRoomTickJob(daemonCtx, roomId, ['pending']);
		expect(pendingBeforePause).toBeDefined();

		// Pause the runtime — cancelPendingTickJobs() deletes all pending tick jobs.
		await pauseRuntime(daemon, roomId);

		// No pending tick jobs should remain for this room after pause.
		const pendingAfterPause = getRoomTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterPause.length).toBe(0);

		// If a tick were still 'processing' when pause was called, the handler's finally
		// block would check runtime.getState() === 'running' (false when paused) and skip
		// re-enqueue. Wait one full processor poll cycle (1 s) to confirm no new pending
		// job appears, covering both the cancellation and the in-flight self-termination paths.
		await new Promise<void>((resolve) => setTimeout(resolve, 1200));
		const noPendingAfterWait = getRoomTickJobs(daemonCtx, roomId, ['pending']);
		expect(noPendingAfterWait.length).toBe(0);
	}, 15_000);

	test('resume enqueues a fresh tick after pause', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-resume-test');

		// Let the initial tick complete so we have a pending self-scheduled job.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		const pendingBeforePause = await waitForRoomTickJob(daemonCtx, roomId, ['pending']);
		expect(pendingBeforePause).toBeDefined();

		// Pause — clears pending ticks.
		await pauseRuntime(daemon, roomId);
		expect(getRoomTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Resume — scheduleTick() is called with delay=0, so runAt ≈ now.
		const beforeResume = Date.now();
		await resumeRuntime(daemon, roomId);

		const freshTick = await waitForRoomTickJob(daemonCtx, roomId, ['pending', 'processing']);
		expect(freshTick).toBeDefined();
		expect(freshTick!.queue).toBe(ROOM_TICK);
		expect((freshTick!.payload as { roomId: string }).roomId).toBe(roomId);
		// Verify it was enqueued immediately (delay=0): runAt must be ≤ 1 s after resume.
		expect(freshTick!.runAt).toBeLessThanOrEqual(beforeResume + 1000);
	}, 15_000);

	test('stop cancels pending ticks and prevents further scheduling', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-stop-test');

		// Wait for the initial tick to complete and a pending self-scheduled job to appear.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await waitForRoomTickJob(daemonCtx, roomId, ['pending']);

		// Stop the runtime — cancelPendingTickJobs() is called inside stop().
		await stopRuntime(daemon, roomId);

		// Pending jobs must be gone.
		const pendingAfterStop = getRoomTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterStop.length).toBe(0);

		// Wait more than one full processor poll cycle (1 s) to confirm no new tick job
		// is enqueued. The runtime has been deleted from the map, so the handler returns
		// {skipped:true} without re-scheduling even if a stale job somehow fires.
		await new Promise<void>((resolve) => setTimeout(resolve, 1200));
		const stillNoPending = getRoomTickJobs(daemonCtx, roomId, ['pending', 'processing']);
		expect(stillNoPending.length).toBe(0);
	}, 15_000);

	test('restart enqueues a fresh tick after stop', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-restart-test');

		// Wait for initial tick and stop the runtime.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await stopRuntime(daemon, roomId);
		expect(getRoomTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Restart — a fresh runtime is created and start() → scheduleTick() → enqueueRoomTick(0).
		const beforeRestart = Date.now();
		await startRuntime(daemon, roomId);

		const freshTick = await waitForRoomTickJob(daemonCtx, roomId, ['pending', 'processing']);
		expect(freshTick).toBeDefined();
		expect(freshTick!.queue).toBe(ROOM_TICK);
		expect((freshTick!.payload as { roomId: string }).roomId).toBe(roomId);
		// Verify it was enqueued immediately (delay=0): runAt must be ≤ 1 s after restart.
		expect(freshTick!.runAt).toBeLessThanOrEqual(beforeRestart + 1000);
	}, 15_000);

	test('recovery: stale processing job is reclaimed and completes', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon, 'tick-recovery-test');

		// Wait for the initial tick to complete so there are no live processing jobs.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);

		// Simulate a daemon crash: insert a room.tick job with status='processing' and
		// a started_at that exceeds the 5-minute stale threshold. The runtime is kept
		// running so the reclaimed job's handler finds the runtime and calls tick()
		// (returns {skipped:true} only when state !== 'running').
		const crashedStartedAt = Date.now() - 6 * 60 * 1000;
		const rawDb = daemonCtx.db.getDatabase();
		const staleJobId = crypto.randomUUID();
		rawDb
			.prepare(
				`INSERT INTO job_queue
				(id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, completed_at)
				VALUES (?, ?, 'processing', ?, NULL, NULL, 0, 0, 0, ?, ?, ?, NULL)`
			)
			.run(
				staleJobId,
				ROOM_TICK,
				JSON.stringify({ roomId }),
				crashedStartedAt,
				crashedStartedAt,
				crashedStartedAt
			);

		// Verify the stale job is visible as 'processing' before reclamation.
		const beforeReclaim = daemonCtx.jobQueue.listJobs({
			queue: ROOM_TICK,
			status: ['processing'],
		});
		expect(beforeReclaim.some((j) => j.id === staleJobId)).toBe(true);

		// Trigger stale reclamation with a 5-minute cutoff (mirrors JobQueueProcessor.start()).
		const reclaimed = daemonCtx.jobQueue.reclaimStale(Date.now() - 5 * 60 * 1000);
		expect(reclaimed).toBeGreaterThanOrEqual(1);

		// The reclaimed job is now 'pending' and ready to be picked up.
		const afterReclaim = daemonCtx.jobQueue.listJobs({
			queue: ROOM_TICK,
			status: ['pending'],
		});
		expect(afterReclaim.some((j) => j.id === staleJobId)).toBe(true);

		// The running job processor picks it up and completes it.
		const completed = await waitForJobById(daemonCtx, roomId, staleJobId, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// After completion, the handler's finally block checks runtime.getState() === 'running'
		// (the runtime was never stopped), so it enqueues a new tick. Verify the next tick
		// is scheduled, confirming the recovery path leaves the runtime in a healthy state.
		const nextTick = await waitForRoomTickJob(daemonCtx, roomId, ['pending'], 5_000);
		expect(nextTick).toBeDefined();
	}, 20_000);
});
