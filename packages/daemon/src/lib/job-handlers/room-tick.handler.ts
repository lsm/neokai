import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { RoomRuntime } from '../room/runtime/room-runtime';
import { ROOM_TICK } from '../job-queue-constants';

export const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * Lookup function that returns the RoomRuntime for a given room ID.
 * Returns null (or undefined) when no runtime exists for the room.
 * Matches the return type of RoomRuntimeService.getRuntime().
 */
export type GetRuntimeForRoom = (roomId: string) => RoomRuntime | null | undefined;

/**
 * Enqueues a room.tick job for a room, maintaining at most one pending tick per room.
 *
 * When a pending tick already exists for the room:
 * - If it will run at or before the requested time, keep it (no-op).
 * - If the new request is sooner (e.g. an immediate tick triggered by goal creation),
 *   delete the stale pending tick and enqueue a new one with the earlier runAt.
 *
 * This ensures event-driven ticks (scheduleTick with delay=0) are never silently
 * dropped by a slower periodic tick that happens to be pending.
 */
export function enqueueRoomTick(
	roomId: string,
	jobQueue: JobQueueRepository,
	delayMs: number = DEFAULT_TICK_INTERVAL_MS
): void {
	const existing = jobQueue.listJobs({ queue: ROOM_TICK, status: ['pending'], limit: 10_000 });
	const pendingJob = existing.find((j) => (j.payload as { roomId?: string }).roomId === roomId);

	const desiredRunAt = Date.now() + delayMs;

	if (pendingJob) {
		// Existing tick will fire sooner or at the same time — keep it
		if (pendingJob.runAt <= desiredRunAt) return;
	}

	jobQueue.enqueue({
		queue: ROOM_TICK,
		payload: { roomId },
		maxRetries: 0,
		runAt: desiredRunAt,
	});

	// New request is sooner — best-effort cleanup of the stale pending tick.
	// Enqueue first so a transient enqueue failure cannot drop the only pending
	// tick and stall room progress.
	if (pendingJob) {
		jobQueue.deleteJob(pendingJob.id);
	}
}

/**
 * Cancels all pending room.tick jobs for a given room.
 *
 * Note: in-flight (processing) tick jobs are intentionally NOT cancelled here.
 * If a tick job is mid-flight when pause/stop is called, its finally block will
 * check runtime.getState() === 'running' before re-scheduling. Since the runtime
 * is no longer running, it will skip re-enqueuing — the loop self-terminates.
 */
export function cancelPendingTickJobs(roomId: string, jobQueue: JobQueueRepository): void {
	const pending = jobQueue.listJobs({ queue: ROOM_TICK, status: ['pending'], limit: 10_000 });
	for (const job of pending) {
		if ((job.payload as { roomId?: string }).roomId === roomId) {
			jobQueue.deleteJob(job.id);
		}
	}
}

/**
 * Creates a room.tick job handler bound to a runtime lookup function.
 */
export function createRoomTickHandler(
	getRuntimeForRoom: GetRuntimeForRoom,
	jobQueue: JobQueueRepository,
	tickIntervalMs: number = DEFAULT_TICK_INTERVAL_MS
) {
	return async function roomTickHandler(job: Job): Promise<Record<string, unknown>> {
		const { roomId } = job.payload as { roomId: string };

		const runtime = getRuntimeForRoom(roomId);
		if (!runtime || runtime.getState() !== 'running') {
			return { skipped: true, reason: 'not running' };
		}

		try {
			await runtime.tick();
		} finally {
			if (runtime.getState() === 'running') {
				enqueueRoomTick(roomId, jobQueue, tickIntervalMs);
			}
		}

		return { roomId };
	};
}
