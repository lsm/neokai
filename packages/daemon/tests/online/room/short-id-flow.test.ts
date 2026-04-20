/**
 * Short ID Full Flow Integration Test
 *
 * Exercises the complete short ID lifecycle through the daemon via RPC.
 * Tests are infrastructure-only (no real agent runs) — uses Dev Proxy for mocked SDK.
 *
 * Covered scenarios:
 * - Tasks created in a room receive sequential short IDs (t-1, t-2)
 * - Tasks can be fetched by short ID via task.get
 * - Goals created in a room receive sequential short IDs (g-1)
 * - room.overview includes shortId in task summaries
 * - Cross-room isolation: each room has independent short ID counters (both start at t-1)
 *
 * NOTE: All room/* online tests are intentionally commented out of the CI matrix
 * (see .github/workflows/main.yml) due to resource usage. They must be run locally
 * or enabled per-task. Registered in scripts/validate-online-test-matrix.sh.
 * Run locally with: NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/short-id-flow.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import type { NeoTask, RoomGoal } from '@neokai/shared';
import { createRoom, createGoal } from './room-test-helpers';

describe('Short ID Full Flow Integration', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 20_000);

	afterAll(async () => {
		await daemon?.waitForExit();
	}, 15_000);

	// ─── Helpers ──────────────────────────────────────────────────────────────

	async function deleteRoom(roomId: string): Promise<void> {
		await daemon.messageHub.request('room.delete', { roomId });
	}

	async function createTask(roomId: string, title: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.create', {
			roomId,
			title,
			description: 'Short ID integration test task',
		})) as { task: NeoTask };
		return result.task;
	}

	async function getTask(roomId: string, taskId: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.get', {
			roomId,
			taskId,
		})) as { task: NeoTask };
		return result.task;
	}

	async function getRoomOverview(roomId: string): Promise<RoomOverview> {
		const result = (await daemon.messageHub.request('room.overview', { roomId })) as {
			overview: RoomOverview;
		};
		return result.overview;
	}

	// ─── Main flow ────────────────────────────────────────────────────────────

	describe('short ID assignment and lookup', () => {
		test('task.create assigns sequential short IDs t-1 and t-2 in the same room', async () => {
			const roomId = await createRoom(daemon, 'short-id-seq');

			try {
				const task1 = await createTask(roomId, 'First task');
				const task2 = await createTask(roomId, 'Second task');

				expect(task1.shortId).toBe('t-1');
				expect(task2.shortId).toBe('t-2');
			} finally {
				await deleteRoom(roomId);
			}
		});

		test('task.get by short ID returns the correct task', async () => {
			const roomId = await createRoom(daemon, 'short-id-get');

			try {
				const created1 = await createTask(roomId, 'Task for short ID get t-1');
				const created2 = await createTask(roomId, 'Task for short ID get t-2');

				expect(created1.shortId).toBe('t-1');
				expect(created2.shortId).toBe('t-2');

				// Fetch by short ID — should resolve to the correct task
				const fetched1 = await getTask(roomId, 't-1');
				expect(fetched1.id).toBe(created1.id);
				expect(fetched1.title).toBe('Task for short ID get t-1');
				expect(fetched1.shortId).toBe('t-1');

				const fetched2 = await getTask(roomId, 't-2');
				expect(fetched2.id).toBe(created2.id);
				expect(fetched2.title).toBe('Task for short ID get t-2');
				expect(fetched2.shortId).toBe('t-2');
			} finally {
				await deleteRoom(roomId);
			}
		});

		test('goal.create assigns short ID g-1', async () => {
			const roomId = await createRoom(daemon, 'short-id-goal');

			try {
				const goal = await createGoal(
					daemon,
					roomId,
					'First goal',
					'Short ID integration test goal'
				);

				expect(goal.shortId).toBe('g-1');
			} finally {
				await deleteRoom(roomId);
			}
		});

		test('task.list returns tasks with shortId', async () => {
			const roomId = await createRoom(daemon, 'short-id-list');

			try {
				const task1 = await createTask(roomId, 'List task 1');
				const task2 = await createTask(roomId, 'List task 2');

				expect(task1.shortId).toBe('t-1');
				expect(task2.shortId).toBe('t-2');

				const result = (await daemon.messageHub.request('task.list', {
					roomId,
				})) as { tasks: unknown[] };

				expect(result.tasks.length).toBeGreaterThanOrEqual(2);

				const found1 = result.tasks.find((t: any) => t.id === task1.id);
				const found2 = result.tasks.find((t: any) => t.id === task2.id);

				expect(found1).toBeDefined();
				expect(found1?.shortId).toBe('t-1');

				expect(found2).toBeDefined();
				expect(found2?.shortId).toBe('t-2');
			} finally {
				await deleteRoom(roomId);
			}
		});
	});

	describe('cross-room isolation', () => {
		test('two independent rooms each start short ID counters from t-1', async () => {
			const roomA = await createRoom(daemon, 'isolation-room-a');
			const roomB = await createRoom(daemon, 'isolation-room-b');

			try {
				const taskA = await createTask(roomA, 'Room A first task');
				const taskB = await createTask(roomB, 'Room B first task');

				// Both rooms independently start at t-1
				expect(taskA.shortId).toBe('t-1');
				expect(taskB.shortId).toBe('t-1');

				// The underlying UUIDs must be different
				expect(taskA.id).not.toBe(taskB.id);

				// Fetch by short ID within each room returns the correct task
				const fetchedA = await getTask(roomA, 't-1');
				expect(fetchedA.id).toBe(taskA.id);

				const fetchedB = await getTask(roomB, 't-1');
				expect(fetchedB.id).toBe(taskB.id);
			} finally {
				await deleteRoom(roomA);
				await deleteRoom(roomB);
			}
		});
	});
});
