import type { Job } from '../../storage/repositories/job-queue-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { RoomRuntime } from '../room/runtime/room-runtime';
import { ROOM_TICK } from '../job-queue-constants';

export const DEFAULT_TICK_INTERVAL_MS = 30_000;

export type GetRuntimeForRoom = (roomId: string) => RoomRuntime | undefined;

/**
 * Enqueues a room.tick job for a room if no pending tick job already exists for it.
 * Deduplication is by roomId — only one pending tick per room is allowed.
 */
export async function enqueueRoomTick(
	roomId: string,
	jobQueue: JobQueueRepository,
	delayMs: number = DEFAULT_TICK_INTERVAL_MS
): Promise<void> {
	const existing = jobQueue.listJobs({ queue: ROOM_TICK, status: ['pending'], limit: 100 });
	const hasPending = existing.some((j) => (j.payload as { roomId?: string }).roomId === roomId);
	if (hasPending) return;

	jobQueue.enqueue({
		queue: ROOM_TICK,
		payload: { roomId },
		maxRetries: 0,
		runAt: Date.now() + delayMs,
	});
}

/**
 * Cancels all pending room.tick jobs for a given room.
 */
export async function cancelPendingTickJobs(
	roomId: string,
	jobQueue: JobQueueRepository
): Promise<void> {
	const pending = jobQueue.listJobs({ queue: ROOM_TICK, status: ['pending'], limit: 100 });
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
				await enqueueRoomTick(roomId, jobQueue, tickIntervalMs);
			}
		}

		return { roomId };
	};
}
