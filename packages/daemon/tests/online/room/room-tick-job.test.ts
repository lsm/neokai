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
 * - Tick handler skips re-scheduling when runtime is stopped
 * - Each room gets its own independent tick job
 * - Daemon restart: existing rooms get tick jobs re-enqueued via
 *   initializeExistingRooms → recoverRoomRuntime → runtime.start()
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

import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WebSocketClientTransport, MessageHub } from '@neokai/shared';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { createDaemonApp } from '../../../src/app';
import { getConfig } from '../../../src/config';
import type { DaemonAppContext } from '../../../src/app';
import { ROOM_TICK } from '../../../src/lib/job-queue-constants';
import { enqueueRoomTick } from '../../../src/lib/job-handlers/room-tick.handler';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for a job to reach a desired status. */
const JOB_WAIT_TIMEOUT_MS = 10_000;

/** Polling interval for job-status checks. */
const POLL_INTERVAL_MS = 50;

/**
 * How long to wait after a control operation before asserting no tick exists.
 * 300 ms is sufficient: the job processor's poll cycle is 1 s, so any pending
 * enqueue triggered synchronously by pause/stop/resume will complete well
 * within this window without waiting for a full processor cycle.
 */
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
 * 2. Call enqueueRoomTick with delay=0 to schedule an immediate tick.
 *
 * Using enqueueRoomTick (rather than direct jobQueue.enqueue) preserves the
 * production dedup path: if RoomRuntime fires scheduleTick() in the window
 * between delete and re-enqueue, enqueueRoomTick's guard will absorb the
 * duplicate instead of creating two pending jobs.
 */
function acceleratePendingTick(daemonCtx: DaemonAppContext, roomId: string): void {
	const pending = listTickJobs(daemonCtx, roomId, ['pending']);
	for (const job of pending) {
		// Direct DB delete bypasses any higher-level state machine, but
		// JobQueueRepository.deleteJob() is a raw DELETE with no side effects —
		// there is no state machine to bypass. The tradeoff is acceptable here
		// because this is test-only code whose sole purpose is to accelerate the
		// runAt timestamp, and deleteJob() is part of the public repository API.
		daemonCtx.jobQueue.deleteJob(job.id);
	}
	// enqueueRoomTick with delay=0 schedules an immediate tick via the same
	// production code path used by RoomRuntime.start() / resume(). If
	// RoomRuntime.scheduleTick() fires between the delete and re-enqueue,
	// enqueueRoomTick's dedup guard absorbs the duplicate.
	enqueueRoomTick(roomId, daemonCtx.jobQueue, 0);
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
		// Capture the time before the job is triggered so the runAt assertion is
		// anchored to when the tick was enqueued rather than when the assertion runs.
		// This avoids a false failure if the assertion executes many seconds later.
		const triggerTime = Date.now();
		acceleratePendingTick(daemonCtx, roomId);

		// Wait for the job to reach 'completed' status.
		const completed = await waitForTickJob(daemonCtx, roomId, ['completed']);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe('completed');

		// The handler's finally block must have enqueued a new pending tick.
		const next = await waitForTickJob(daemonCtx, roomId, ['pending']);
		expect(next).toBeDefined();
		expect(next!.queue).toBe(ROOM_TICK);

		// The next tick should be scheduled ~30 s after the handler ran.
		// Anchor to triggerTime (captured before the job was submitted) rather than
		// Date.now() (evaluated after waitForTickJob returns) to avoid spurious
		// failures in slow CI environments where the assertion can run 10+ s late.
		const minExpectedRunAt = triggerTime + 20_000;
		expect(next!.runAt).toBeGreaterThan(minExpectedRunAt);
	}, 15_000);

	// -------------------------------------------------------------------------
	// Stopped runtime prevents re-scheduling after in-flight tick completes
	// -------------------------------------------------------------------------

	test('tick handler skips re-scheduling when runtime is stopped', async () => {
		// Wait for the runtime to be ready before stopping — room.created fires
		// via queueMicrotask so the runtime may not be in the map yet when
		// room.create resolves.
		await waitForTickJob(daemonCtx, roomId, ['pending', 'processing', 'completed']);

		// Stop the runtime — removes it from the runtimes map and cancels pending ticks.
		await daemon.messageHub.request('room.runtime.stop', { roomId });
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
		expect(listTickJobs(daemonCtx, roomId, ['pending']).length).toBe(0);

		// Now directly enqueue an immediate tick for the stopped room.
		// This simulates a tick job that was already in-flight (or queued) when the
		// runtime was stopped — the handler must find no runtime and skip re-scheduling.
		daemonCtx.jobQueue.enqueue({
			queue: ROOM_TICK,
			payload: { roomId },
			maxRetries: 0,
			runAt: Date.now(),
		});

		// Wait for the tick job to be processed (status = completed).
		// The handler calls getRuntimeForRoom(roomId) → returns null (runtime was removed)
		// → returns { skipped: true, reason: 'not running' } without re-enqueuing.
		const processed = await waitForTickJob(daemonCtx, roomId, ['completed']);
		expect(processed).toBeDefined();
		expect(processed!.status).toBe('completed');
		// Verify the handler returned the skipped sentinel rather than the normal result.
		expect(processed!.result).toMatchObject({ skipped: true, reason: 'not running' });

		// The critical invariant: no new pending tick was enqueued after the skip.
		const pendingAfterProcess = listTickJobs(daemonCtx, roomId, ['pending']);
		expect(pendingAfterProcess.length).toBe(0);
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

	// -------------------------------------------------------------------------
	// Daemon restart: existing rooms get tick jobs re-enqueued
	// -------------------------------------------------------------------------

	test('daemon restart: existing rooms get tick jobs re-enqueued via initializeExistingRooms', async () => {
		// Confirm the initial tick appears so we know the room is fully set up.
		const firstTick = await waitForTickJob(daemonCtx, roomId, [
			'pending',
			'processing',
			'completed',
		]);
		expect(firstTick).toBeDefined();

		// Preserve the DB path before shutdown.
		const dbPath = daemonCtx.db.getDatabasePath();
		const workspacePath = path.dirname(dbPath);

		// Shut down daemon1 cleanly but WITHOUT deleting the workspace so the DB
		// is preserved for daemon2. We call daemonCtx.cleanup() directly instead
		// of daemon.waitForExit() (which would rm -rf the workspace).
		daemon.kill('SIGTERM'); // no-op for in-process
		await daemonCtx.cleanup();
		// Prevent afterEach from double-calling cleanup.
		daemon = null as unknown as DaemonServerContext;

		// Start daemon2 using createDaemonApp() directly with the preserved DB.
		// This exercises initializeExistingRooms() which reads rooms from the DB
		// and re-enqueues tick jobs for each one.
		let daemonCtx2: DaemonAppContext | null = null;
		let hub2: MessageHub | null = null;
		let transport2: WebSocketClientTransport | null = null;
		// originalWorkspacePath is captured inside the try block so the finally
		// restoration is always paired with the mutation, even on sync failures.
		let originalWorkspacePath: string | undefined;
		try {
			originalWorkspacePath = process.env.NEOKAI_WORKSPACE_PATH;
			process.env.NEOKAI_WORKSPACE_PATH = workspacePath;
			const config = getConfig();
			config.port = 0;
			config.dbPath = dbPath;

			daemonCtx2 = await createDaemonApp({ config, verbose: false, standalone: false });

			// Connect a client so the daemon is ready.
			const actualPort = daemonCtx2.server.port;
			transport2 = new WebSocketClientTransport({
				url: `ws://127.0.0.1:${actualPort}/ws`,
				autoReconnect: false,
			});
			hub2 = new MessageHub({ defaultSessionId: 'global' });
			hub2.registerTransport(transport2);
			await transport2.initialize();

			// initializeExistingRooms calls runtime.start() for every room in the DB,
			// which calls scheduleTick() → enqueueRoomTick(roomId, jobQueue, 0).
			const tickJob = await waitForTickJob(daemonCtx2, roomId, [
				'pending',
				'processing',
				'completed',
			]);
			expect(tickJob).toBeDefined();
			expect(tickJob!.queue).toBe(ROOM_TICK);
			expect((tickJob!.payload as { roomId: string }).roomId).toBe(roomId);

			// Verify the runtime is actively running in daemon2.
			const stateResult = (await hub2.request('room.runtime.state', {
				roomId,
			})) as { state: string };
			expect(stateResult.state).toBe('running');
		} finally {
			// Restore environment.
			if (originalWorkspacePath === undefined) {
				delete process.env.NEOKAI_WORKSPACE_PATH;
			} else {
				process.env.NEOKAI_WORKSPACE_PATH = originalWorkspacePath;
			}

			// Tear down daemon2: cleanup hub first (rejects pending calls), then transport.
			if (hub2) {
				try {
					hub2.cleanup();
				} catch {
					// Already cleaned up
				}
			}
			if (transport2) {
				try {
					await transport2.close();
				} catch {
					// Already closed
				}
			}
			if (daemonCtx2) {
				await daemonCtx2.cleanup();
			}

			// Remove the shared workspace now that both daemons are done.
			await Bun.$`rm -rf ${workspacePath}`.quiet();
		}
	}, 30_000);
});
