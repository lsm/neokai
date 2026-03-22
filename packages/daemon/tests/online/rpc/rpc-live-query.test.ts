/**
 * LiveQuery end-to-end online integration tests
 *
 * Tests the full reactive pipeline against a real daemon with a real SQLite
 * database (no SDK/LLM calls required):
 *
 *  - subscribe → snapshot delivered synchronously
 *  - DB write via task.create RPC → notifyChange('tasks') → delta pushed to client
 *  - unsubscribe stops further delta delivery
 *  - two concurrent subscriptions each receive independent deltas from a single write
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/rpc/rpc-live-query.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { LiveQueryDeltaEvent, LiveQuerySnapshotEvent, NeoTask } from '@neokai/shared';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DELTA_WAIT_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until predicate returns true, or reject on timeout. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs: number = DELTA_WAIT_TIMEOUT_MS,
	label = 'condition'
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for: ${label}`);
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LiveQuery — end-to-end reactive pipeline', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 30_000);

	afterAll(async () => {
		await daemon?.waitForExit();
	}, 15_000);

	async function createRoom(label: string): Promise<string> {
		const result = (await daemon.messageHub.request('room.create', {
			name: `lq-${label}-${Date.now()}`,
		})) as { room: { id: string } };
		return result.room.id;
	}

	async function createTask(roomId: string, title: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.create', {
			roomId,
			title,
			description: 'Created by LiveQuery online test',
		})) as { task: NeoTask };
		return result.task;
	}

	// -----------------------------------------------------------------------
	// Test 1: subscribe → snapshot delivered
	// -----------------------------------------------------------------------

	test('subscribe delivers a snapshot immediately', async () => {
		const roomId = await createRoom('snapshot');

		const snapshots: LiveQuerySnapshotEvent[] = [];
		const unsub = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (ev) => {
			if (ev.subscriptionId === 'sub-snap-1') {
				snapshots.push(ev);
			}
		});

		try {
			const result = (await daemon.messageHub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: 'sub-snap-1',
			})) as { ok: boolean };

			expect(result.ok).toBe(true);

			// Snapshot must arrive
			await waitFor(() => snapshots.length > 0, DELTA_WAIT_TIMEOUT_MS, 'snapshot arrival');

			expect(snapshots[0].subscriptionId).toBe('sub-snap-1');
			expect(Array.isArray(snapshots[0].rows)).toBe(true);
			expect(typeof snapshots[0].version).toBe('number');

			// Room is empty — snapshot rows should be empty
			expect(snapshots[0].rows).toHaveLength(0);
		} finally {
			unsub();
			await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId: 'sub-snap-1' });
		}
	}, 20_000);

	// -----------------------------------------------------------------------
	// Test 2: DB write via RPC → delta pushed to subscribed client
	// -----------------------------------------------------------------------

	test('task.create RPC triggers a liveQuery.delta for tasks.byRoom subscriber', async () => {
		const roomId = await createRoom('delta');
		const subId = 'sub-delta-1';

		const snapshots: LiveQuerySnapshotEvent[] = [];
		const deltas: LiveQueryDeltaEvent[] = [];

		const unsubSnap = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
			'liveQuery.snapshot',
			(ev) => {
				if (ev.subscriptionId === subId) snapshots.push(ev);
			}
		);
		const unsubDelta = daemon.messageHub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (ev) => {
			if (ev.subscriptionId === subId) deltas.push(ev);
		});

		try {
			// Subscribe
			await daemon.messageHub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: subId,
			});

			// Wait for snapshot
			await waitFor(() => snapshots.length > 0, DELTA_WAIT_TIMEOUT_MS, 'snapshot before delta');
			const snapshotVersion = snapshots[0].version;

			// Write to the DB — this triggers notifyChange('tasks') inside task.create handler
			const task = await createTask(roomId, 'LiveQuery Delta Task');

			// Wait for delta
			await waitFor(() => deltas.length > 0, DELTA_WAIT_TIMEOUT_MS, 'delta after task.create');

			const delta = deltas[0];
			expect(delta.subscriptionId).toBe(subId);
			expect(delta.version).toBeGreaterThan(snapshotVersion);

			// The new task should appear in the added array
			const added = delta.added ?? [];
			expect(added.length).toBeGreaterThan(0);
			const addedTask = added.find((r) => (r as Record<string, unknown>).id === task.id) as
				| Record<string, unknown>
				| undefined;
			expect(addedTask).toBeDefined();
			expect(addedTask!.title).toBe('LiveQuery Delta Task');
		} finally {
			unsubSnap();
			unsubDelta();
			await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId: subId });
		}
	}, 20_000);

	// -----------------------------------------------------------------------
	// Test 3: unsubscribe stops delta delivery
	// -----------------------------------------------------------------------

	test('liveQuery.unsubscribe stops delta delivery', async () => {
		const roomId = await createRoom('unsub');
		const subId = 'sub-unsub-1';

		const snapshots: LiveQuerySnapshotEvent[] = [];
		const deltas: LiveQueryDeltaEvent[] = [];

		const unsubSnap = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
			'liveQuery.snapshot',
			(ev) => {
				if (ev.subscriptionId === subId) snapshots.push(ev);
			}
		);
		const unsubDelta = daemon.messageHub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (ev) => {
			if (ev.subscriptionId === subId) deltas.push(ev);
		});

		try {
			// Subscribe
			await daemon.messageHub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: subId,
			});
			await waitFor(() => snapshots.length > 0, DELTA_WAIT_TIMEOUT_MS, 'snapshot');

			// Unsubscribe before writing
			const unsubResult = (await daemon.messageHub.request('liveQuery.unsubscribe', {
				subscriptionId: subId,
			})) as { ok: boolean };
			expect(unsubResult.ok).toBe(true);

			// Write to the DB after unsubscribe
			await createTask(roomId, 'Post-Unsubscribe Task');

			// Wait a short time to confirm no delta arrives
			await new Promise((r) => setTimeout(r, 500));
			expect(deltas).toHaveLength(0);
		} finally {
			unsubSnap();
			unsubDelta();
		}
	}, 20_000);

	// -----------------------------------------------------------------------
	// Test 4: multiple subscriptions — each gets its own deltas
	// -----------------------------------------------------------------------

	test('two concurrent subscriptions both receive deltas from the same write', async () => {
		const roomId = await createRoom('multi-sub');
		const subId1 = 'sub-multi-1';
		const subId2 = 'sub-multi-2';

		const deltas1: LiveQueryDeltaEvent[] = [];
		const deltas2: LiveQueryDeltaEvent[] = [];
		const snapshots: string[] = [];

		const unsubSnap = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
			'liveQuery.snapshot',
			(ev) => {
				if (ev.subscriptionId === subId1 || ev.subscriptionId === subId2) {
					snapshots.push(ev.subscriptionId);
				}
			}
		);
		const unsubDelta = daemon.messageHub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (ev) => {
			if (ev.subscriptionId === subId1) deltas1.push(ev);
			if (ev.subscriptionId === subId2) deltas2.push(ev);
		});

		try {
			// Subscribe twice with different subscriptionIds
			await daemon.messageHub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: subId1,
			});
			await daemon.messageHub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: subId2,
			});

			// Both snapshots must arrive
			await waitFor(
				() => snapshots.includes(subId1) && snapshots.includes(subId2),
				DELTA_WAIT_TIMEOUT_MS,
				'both snapshots'
			);

			// Write to the DB
			await createTask(roomId, 'Multi-Sub Task');

			// Both subscriptions receive a delta
			await waitFor(() => deltas1.length > 0, DELTA_WAIT_TIMEOUT_MS, 'delta for sub 1');
			await waitFor(() => deltas2.length > 0, DELTA_WAIT_TIMEOUT_MS, 'delta for sub 2');

			expect(deltas1[0].subscriptionId).toBe(subId1);
			expect(deltas2[0].subscriptionId).toBe(subId2);
		} finally {
			unsubSnap();
			unsubDelta();
			await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId: subId1 });
			await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId: subId2 });
		}
	}, 20_000);

	// -----------------------------------------------------------------------
	// Test 5: task.fail triggers liveQuery.delta (no handler-layer emit needed)
	// -----------------------------------------------------------------------

	test('task.fail RPC triggers a liveQuery.delta for tasks.byRoom subscriber', async () => {
		const roomId = await createRoom('task-fail-delta');
		const subId = 'sub-task-fail-1';

		// First create a task to fail
		const task = await createTask(roomId, 'Task To Fail');

		const snapshots: LiveQuerySnapshotEvent[] = [];
		const deltas: LiveQueryDeltaEvent[] = [];

		const unsubSnap = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
			'liveQuery.snapshot',
			(ev) => {
				if (ev.subscriptionId === subId) snapshots.push(ev);
			}
		);
		const unsubDelta = daemon.messageHub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (ev) => {
			if (ev.subscriptionId === subId) deltas.push(ev);
		});

		try {
			// Subscribe after task is created
			await daemon.messageHub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: subId,
			});

			// Wait for snapshot
			await waitFor(() => snapshots.length > 0, DELTA_WAIT_TIMEOUT_MS, 'snapshot before fail');
			const snapshotVersion = snapshots[0].version;

			// Fail the task — triggers notifyChange('tasks') via TaskManager, no handler-layer emit
			await daemon.messageHub.request('task.fail', {
				roomId,
				taskId: task.id,
				error: 'Simulated failure',
			});

			// A delta must arrive reflecting the status change
			await waitFor(() => deltas.length > 0, DELTA_WAIT_TIMEOUT_MS, 'delta after task.fail');

			const delta = deltas[0];
			expect(delta.subscriptionId).toBe(subId);
			expect(delta.version).toBeGreaterThan(snapshotVersion);

			// The updated task must appear in the delta
			const allChanges = [...(delta.added ?? []), ...(delta.updated ?? [])];
			const updatedTask = allChanges.find((r) => (r as Record<string, unknown>).id === task.id) as
				| Record<string, unknown>
				| undefined;
			expect(updatedTask).toBeDefined();
			expect(updatedTask!.status).toBe('needs_attention');
		} finally {
			unsubSnap();
			unsubDelta();
			await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId: subId });
		}
	}, 20_000);
});
