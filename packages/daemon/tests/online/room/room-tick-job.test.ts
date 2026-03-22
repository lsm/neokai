/**
 * Online test: room tick via job queue
 *
 * Verifies end-to-end room tick job queue mechanics without making real API
 * calls or spawning real agent sessions:
 * - room.tick job is enqueued when a room runtime starts
 * - Job transitions through pending -> processing -> completed
 * - Re-scheduling: next tick job is enqueued after completion (30 s in future)
 * - Dedup: at most one pending room.tick job per room at any time
 * - Pause lifecycle: pausing the runtime cancels all pending tick jobs
 * - Resume lifecycle: resuming enqueues a fresh immediate tick
 * - Stop lifecycle: stopping removes pending tick jobs and halts scheduling
 * - Restart lifecycle: starting a stopped room enqueues a fresh tick
 *
 * The room created in each test has no goals or tasks, so runtime.tick() is a
 * fast no-op (zombie check + empty recurring missions pass + no available
 * tasks). No Anthropic API calls are made; dev proxy is optional but harmless.
 *
 * NOTE: All room/* CI shards are intentionally disabled in
 * .github/workflows/main.yml due to resource usage. Run this test locally:
 *
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

/** Maximum time (ms) to wait for a job state transition. */
const JOB_WAIT_TIMEOUT_MS = 8000;

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

/** Create a room via RPC and return its ID. */
async function createRoom(daemon: DaemonServerContext): Promise<string> {
	const result = (await daemon.messageHub.request('room.create', {
		name: `tick-test-${Date.now()}`,
	})) as { room: { id: string } };
	return result.room.id;
}

/**
 * Return all room.tick jobs for a specific roomId with any of the given
 * statuses, or an empty array if none exist.
 */
function getRoomTickJobs(
	daemonCtx: DaemonAppContext,
	roomId: string,
	statuses: JobStatus[]
): Job[] {
	const jobs = daemonCtx.jobQueue.listJobs({ queue: ROOM_TICK, status: statuses, limit: 1000 });
	return jobs.filter((j) => (j.payload as { roomId?: string }).roomId === roomId);
}

/**
 * Poll until at least one room.tick job for `roomId` matches one of the given
 * statuses. Returns the first matching job, or undefined on timeout.
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
		if (jobs.length > 0) return jobs[0];
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('room tick via job queue (online)', () => {
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

	test('room.tick job is enqueued when room runtime starts', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// runtime.start() calls scheduleTick() which enqueues an immediate tick
		// (runAt = now + 0). The room was just created so this should appear
		// in pending (or already picked up) within a very short window.
		const job = await waitForRoomTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);

		expect(job).toBeDefined();
		expect(job!.queue).toBe(ROOM_TICK);
		expect((job!.payload as { roomId: string }).roomId).toBe(roomId);
	}, 15_000);

	test('tick job transitions to completed and re-schedules with 30 s interval', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// Wait for the initial tick to complete.
		const completed = await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');
		expect(completed!.completedAt).not.toBeNull();

		// The handler's finally block must have enqueued the next tick.
		const next = await waitForRoomTickJob(daemonCtx, roomId, ['pending']);
		expect(next).toBeDefined();
		expect(next!.queue).toBe(ROOM_TICK);

		// Next tick should be ~30 s from now. Allow generous skew: at least 20 s.
		const minExpectedRunAt = Date.now() + 20_000;
		expect(next!.runAt).toBeGreaterThan(minExpectedRunAt);
	}, 15_000);

	test('dedup: exactly one pending room.tick job per room at creation', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// enqueueRoomTick() is called synchronously inside room.created handler
		// (runtime.start() -> scheduleTick() -> enqueueRoomTick). The job processor
		// polls every 1 s, so the job is in 'pending' state before the first poll
		// fires — expect exactly 1 active job immediately after createRoom().
		const atCreation = getRoomTickJobs(daemonCtx, roomId, ['pending', 'processing']);
		expect(atCreation.length).toBe(1);

		// Allow the initial tick to complete and the next to be enqueued.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await waitForRoomTickJob(daemonCtx, roomId, ['pending']);

		// After re-scheduling: still at most one pending job for this room.
		// (The 30 s job could be in 'pending' only; 'processing' is excluded since
		// runAt is 30 s in the future and the processor won't pick it up yet.)
		const afterReschedule = getRoomTickJobs(daemonCtx, roomId, ['pending']);
		expect(afterReschedule.length).toBeLessThanOrEqual(1);
	}, 15_000);

	test('pause cancels pending tick jobs', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// Wait for the initial immediate tick to complete so the runtime has
		// queued the next 30 s tick — gives us a pending job to cancel.
		// The 30 s runAt ensures the processor cannot pick it up before we pause.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await waitForRoomTickJob(daemonCtx, roomId, ['pending']);

		// Pause the runtime. cancelPendingTickJobs() is called synchronously
		// inside the RPC handler before it returns, so there is no async race
		// between the pause RPC completing and our assertion below.
		await daemon.messageHub.request('room.runtime.pause', { roomId });

		// No pending room.tick jobs should remain for this room.
		const pendingAfterPause = getRoomTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterPause.length).toBe(0);

		// Verify runtime state is now paused via RPC.
		const stateResult = (await daemon.messageHub.request('room.runtime.state', {
			roomId,
		})) as { state: string };
		expect(stateResult.state).toBe('paused');
	}, 15_000);

	test('resume enqueues a fresh tick after pause', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// Pause the runtime.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await waitForRoomTickJob(daemonCtx, roomId, ['pending']);
		await daemon.messageHub.request('room.runtime.pause', { roomId });

		// Confirm no pending jobs after pause.
		expect(getRoomTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Resume: calls scheduleTick() which enqueues an immediate tick.
		await daemon.messageHub.request('room.runtime.resume', { roomId });

		// A new pending job must appear quickly.
		const fresh = await waitForRoomTickJob(daemonCtx, roomId, ['pending', 'processing']);
		expect(fresh).toBeDefined();
		expect((fresh!.payload as { roomId: string }).roomId).toBe(roomId);

		// Verify runtime state is running again.
		const stateResult = (await daemon.messageHub.request('room.runtime.state', {
			roomId,
		})) as { state: string };
		expect(stateResult.state).toBe('running');
	}, 15_000);

	test('stop cancels pending ticks and removes the runtime', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// Wait until there's a pending future tick to cancel.
		// The 30 s runAt ensures the processor cannot pick it up before we stop.
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await waitForRoomTickJob(daemonCtx, roomId, ['pending']);

		// Stop the runtime. cancelPendingTickJobs() is called synchronously inside
		// the RPC handler before it returns — no async race between the stop RPC
		// completing and the assertion below.
		await daemon.messageHub.request('room.runtime.stop', { roomId });

		// No pending tick jobs should remain for this room.
		const pendingAfterStop = getRoomTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterStop.length).toBe(0);

		// stopRuntime() deletes the runtime from the map; getRuntimeState returns null
		// which the RPC handler normalises to 'stopped'.
		const stateResult = (await daemon.messageHub.request('room.runtime.state', {
			roomId,
		})) as { state: string };
		expect(stateResult.state).toBe('stopped');
	}, 15_000);

	test('restart after stop resumes tick scheduling', async () => {
		const daemonCtx = getDaemonCtx(daemon);
		const roomId = await createRoom(daemon);

		// Let initial tick complete, then stop (no need to wait for the 30 s
		// reschedule — stopRuntime cancels any pending ticks internally).
		await waitForRoomTickJob(daemonCtx, roomId, ['completed']);
		await daemon.messageHub.request('room.runtime.stop', { roomId });

		// Confirm no pending jobs after stop.
		expect(getRoomTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Start the runtime again — creates a fresh runtime and calls start().
		await daemon.messageHub.request('room.runtime.start', { roomId });

		// A fresh tick should be enqueued by the new runtime's start().
		const fresh = await waitForRoomTickJob(daemonCtx, roomId, [
			'pending',
			'processing',
			'completed',
		]);
		expect(fresh).toBeDefined();
		expect((fresh!.payload as { roomId: string }).roomId).toBe(roomId);
	}, 15_000);
});
