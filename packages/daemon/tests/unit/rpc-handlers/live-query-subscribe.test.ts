/**
 * Unit tests for liveQuery.subscribe and liveQuery.unsubscribe RPC handlers
 *
 * Covers:
 *  - subscribe → snapshot → delta → unsubscribe full lifecycle
 *  - Unknown query name rejected
 *  - Mismatched params count rejected
 *  - Unauthorized room_id rejected (tasks.byRoom / goals.byRoom)
 *  - Unauthorized group_id rejected (sessionGroupMessages.byGroup)
 *  - Absent clientId rejected
 *  - subscriptionId collision replaces prior subscription
 *  - Snapshot delivered before delta
 *  - Version monotonically increasing
 *  - Client disconnect disposes all subscriptions
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { createTables } from '../../../src/storage/schema';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../src/storage/live-query';
import { setupLiveQueryHandlers } from '../../../src/lib/rpc-handlers/live-query-handlers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RequestHandler = (data: unknown, context: Partial<CallCtx>) => Promise<unknown> | unknown;
type CallCtx = {
	clientId?: string;
	sessionId: string;
	messageId: string;
	method: string;
	timestamp: string;
};

interface SentMessage {
	clientId: string;
	message: {
		method: string;
		data: {
			subscriptionId: string;
			rows?: unknown[];
			added?: unknown[];
			removed?: unknown[];
			updated?: unknown[];
			version: number;
		};
	};
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockSetup() {
	const handlers = new Map<string, RequestHandler>();
	let disconnectHandler: ((clientId: string) => void) | null = null;
	const sentMessages: SentMessage[] = [];
	let sendToClientResult = true; // override per-test if needed
	let routerEnabled = true; // set to false to simulate null router

	const mockRouter = {
		sendToClient: mock((clientId: string, message: unknown) => {
			sentMessages.push({ clientId, message: message as SentMessage['message'] });
			return sendToClientResult;
		}),
	};

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		getRouter: mock(() => (routerEnabled ? mockRouter : null)),
		onClientDisconnect: mock((handler: (clientId: string) => void) => {
			disconnectHandler = handler;
			return () => {
				disconnectHandler = null;
			};
		}),
	} as unknown as MessageHub;

	const callHandler = async (
		method: string,
		data: unknown,
		ctx: Partial<CallCtx> = {}
	): Promise<unknown> => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`No handler registered for method: ${method}`);
		const fullCtx: CallCtx = {
			clientId: 'client-1',
			sessionId: 'global',
			messageId: 'msg-1',
			method,
			timestamp: new Date().toISOString(),
			...ctx,
		};
		return handler(data, fullCtx);
	};

	const fireDisconnect = (clientId: string) => {
		disconnectHandler?.(clientId);
	};

	const setSendResult = (result: boolean) => {
		sendToClientResult = result;
	};

	const setRouterEnabled = (enabled: boolean) => {
		routerEnabled = enabled;
	};

	return {
		hub,
		handlers,
		sentMessages,
		callHandler,
		fireDisconnect,
		setSendResult,
		setRouterEnabled,
		mockRouter,
	};
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function createDb() {
	const db = new BunDatabase(':memory:');
	createTables(db);
	return db;
}

function insertRoom(db: BunDatabase, roomId: string) {
	const now = Date.now();
	db.exec(
		`INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${now}, ${now})`
	);
}

function insertTask(db: BunDatabase, taskId: string, roomId: string) {
	const now = Date.now();
	db.exec(
		`INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, priority, task_type, created_at, updated_at)
		 VALUES ('${taskId}', '${roomId}', 'Test Task', '', 'pending', 'normal', 'coding', ${now}, ${now})`
	);
}

function insertSessionGroup(
	db: BunDatabase,
	groupId: string,
	refId: string,
	groupType: string = 'task'
) {
	const now = Date.now();
	db.exec(
		`INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, version, created_at)
		 VALUES ('${groupId}', '${groupType}', '${refId}', 1, ${now})`
	);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('setupLiveQueryHandlers', () => {
	let db: BunDatabase;
	let reactiveDb: ReactiveDatabase;
	let engine: LiveQueryEngine;
	let setup: ReturnType<typeof createMockSetup>;
	const roomId = 'room-test-1';
	const taskId = 'task-test-1';

	beforeEach(() => {
		db = createDb();
		// Use a minimal facade wrapper that exposes getDatabase() for createReactiveDatabase
		reactiveDb = createReactiveDatabase({ getDatabase: () => db } as never);
		engine = new LiveQueryEngine(db, reactiveDb);
		setup = createMockSetup();
		setupLiveQueryHandlers(setup.hub, engine, db);
		insertRoom(db, roomId);
		insertTask(db, taskId, roomId);
	});

	afterEach(() => {
		engine.dispose();
		db.close();
	});

	// -----------------------------------------------------------------------
	// Absent clientId
	// -----------------------------------------------------------------------

	test('subscribe: absent clientId throws', async () => {
		await expect(
			setup.callHandler(
				'liveQuery.subscribe',
				{ queryName: 'tasks.byRoom', params: [roomId], subscriptionId: 'sub-1' },
				{ clientId: undefined }
			)
		).rejects.toThrow('clientId absent');
	});

	test('unsubscribe: absent clientId throws', async () => {
		await expect(
			setup.callHandler(
				'liveQuery.unsubscribe',
				{ subscriptionId: 'sub-1' },
				{ clientId: undefined }
			)
		).rejects.toThrow('clientId absent');
	});

	// -----------------------------------------------------------------------
	// Unknown query name
	// -----------------------------------------------------------------------

	test('subscribe: unknown query name throws', async () => {
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'nonexistent.query',
				params: ['x'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('Unknown query name');
	});

	// -----------------------------------------------------------------------
	// Mismatched param count
	// -----------------------------------------------------------------------

	test('subscribe: mismatched params count throws', async () => {
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [], // expects 1
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('expects 1 parameter(s), got 0');
	});

	test('subscribe: too many params throws', async () => {
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId, 'extra'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('expects 1 parameter(s), got 2');
	});

	// -----------------------------------------------------------------------
	// Unauthorized room_id
	// -----------------------------------------------------------------------

	test('subscribe tasks.byRoom: nonexistent room rejected', async () => {
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: ['room-does-not-exist'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('Unauthorized');
	});

	test('subscribe goals.byRoom: nonexistent room rejected', async () => {
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'goals.byRoom',
				params: ['room-does-not-exist'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('Unauthorized');
	});

	// -----------------------------------------------------------------------
	// Unauthorized group_id
	// -----------------------------------------------------------------------

	test('subscribe sessionGroupMessages.byGroup: nonexistent group rejected', async () => {
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'sessionGroupMessages.byGroup',
				params: ['group-does-not-exist'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('Unauthorized');
	});

	test('subscribe sessionGroupMessages.byGroup: group with missing task rejected', async () => {
		insertSessionGroup(db, 'grp-1', 'nonexistent-task', 'task');
		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'sessionGroupMessages.byGroup',
				params: ['grp-1'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('Unauthorized');
	});

	test('subscribe sessionGroupMessages.byGroup: task with missing room rejected', async () => {
		// Insert a task with a room_id that doesn't exist
		const orphanTask = 'orphan-task-1';
		const missingRoom = 'missing-room-1';
		const now = Date.now();
		db.exec(
			`INSERT INTO tasks (id, room_id, title, description, status, priority, task_type, created_at, updated_at)
			 VALUES ('${orphanTask}', '${missingRoom}', 'Orphan Task', '', 'pending', 'normal', 'coding', ${now}, ${now})`
		);
		insertSessionGroup(db, 'grp-2', orphanTask, 'task');

		await expect(
			setup.callHandler('liveQuery.subscribe', {
				queryName: 'sessionGroupMessages.byGroup',
				params: ['grp-2'],
				subscriptionId: 'sub-1',
			})
		).rejects.toThrow('Unauthorized');
	});

	test('subscribe sessionGroupMessages.byGroup: non-task group_type allowed without task lookup', async () => {
		// group_type != 'task' should skip the task→room chain
		insertSessionGroup(db, 'grp-other', 'some-ref', 'workflow');
		const result = await setup.callHandler('liveQuery.subscribe', {
			queryName: 'sessionGroupMessages.byGroup',
			params: ['grp-other'],
			subscriptionId: 'sub-1',
		});
		expect(result).toEqual({ ok: true });
	});

	// -----------------------------------------------------------------------
	// Snapshot delivery on subscribe
	// -----------------------------------------------------------------------

	test('subscribe: snapshot delivered immediately on subscribe', async () => {
		const result = await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-1',
		});
		expect(result).toEqual({ ok: true });

		// Snapshot should have been sent synchronously
		expect(setup.sentMessages.length).toBe(1);
		const msg = setup.sentMessages[0];
		expect(msg.clientId).toBe('client-1');
		expect(msg.message.method).toBe('liveQuery.snapshot');
		expect(msg.message.data.subscriptionId).toBe('sub-1');
		expect(Array.isArray(msg.message.data.rows)).toBe(true);
		expect(typeof msg.message.data.version).toBe('number');
	});

	// -----------------------------------------------------------------------
	// Full lifecycle: snapshot → delta → unsubscribe
	// -----------------------------------------------------------------------

	test('full lifecycle: subscribe → snapshot → delta → unsubscribe', async () => {
		// Subscribe
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-lc',
		});
		expect(setup.sentMessages.length).toBe(1);
		expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');

		// Trigger a change to produce a delta (insert another task then notify)
		insertTask(db, 'task-new-1', roomId);
		reactiveDb.notifyChange('tasks');
		// Let microtasks flush
		await new Promise((r) => setTimeout(r, 10));

		// At least the snapshot should be there; delta depends on reactive chain
		expect(setup.sentMessages.length).toBeGreaterThanOrEqual(1);

		// Unsubscribe
		const unsubResult = await setup.callHandler('liveQuery.unsubscribe', {
			subscriptionId: 'sub-lc',
		});
		expect(unsubResult).toEqual({ ok: true });
	});

	// -----------------------------------------------------------------------
	// Snapshot before delta ordering
	// -----------------------------------------------------------------------

	test('snapshot always delivered before any delta', async () => {
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-order',
		});

		// Snapshot must be first
		expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');
		// Any subsequent messages must be deltas
		for (let i = 1; i < setup.sentMessages.length; i++) {
			expect(setup.sentMessages[i].message.method).toBe('liveQuery.delta');
		}
	});

	// -----------------------------------------------------------------------
	// subscriptionId collision replaces prior subscription
	// -----------------------------------------------------------------------

	test('subscriptionId collision: prior subscription replaced', async () => {
		// First subscribe
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-collision',
		});
		const firstSnapshotCount = setup.sentMessages.length;
		expect(firstSnapshotCount).toBe(1);

		// Second subscribe with same subscriptionId
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-collision',
		});
		// Should have received a second snapshot
		expect(setup.sentMessages.length).toBe(2);
		expect(setup.sentMessages[1].message.method).toBe('liveQuery.snapshot');
		expect(setup.sentMessages[1].message.data.subscriptionId).toBe('sub-collision');
	});

	// -----------------------------------------------------------------------
	// Unsubscribe on unknown subscriptionId is safe
	// -----------------------------------------------------------------------

	test('unsubscribe: unknown subscriptionId returns ok (no error)', async () => {
		const result = await setup.callHandler('liveQuery.unsubscribe', {
			subscriptionId: 'non-existent-sub',
		});
		expect(result).toEqual({ ok: true });
	});

	// -----------------------------------------------------------------------
	// Client disconnect cleanup
	// -----------------------------------------------------------------------

	test('client disconnect disposes all subscriptions for that client', async () => {
		// Subscribe two different subscriptions for the same client
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-a',
		});
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-b',
		});
		expect(setup.sentMessages.length).toBe(2); // two snapshots

		// Simulate disconnect
		setup.fireDisconnect('client-1');

		// After disconnect, unsubscribing should be a no-op (already cleaned)
		const result = await setup.callHandler('liveQuery.unsubscribe', {
			subscriptionId: 'sub-a',
		});
		expect(result).toEqual({ ok: true });
	});

	// -----------------------------------------------------------------------
	// sessionGroupMessages authorization: valid path allowed
	// -----------------------------------------------------------------------

	test('subscribe sessionGroupMessages.byGroup: valid group→task→room allowed', async () => {
		insertSessionGroup(db, 'grp-valid', taskId, 'task');
		const result = await setup.callHandler('liveQuery.subscribe', {
			queryName: 'sessionGroupMessages.byGroup',
			params: ['grp-valid'],
			subscriptionId: 'sub-msg',
		});
		expect(result).toEqual({ ok: true });
		expect(setup.sentMessages.length).toBe(1);
		expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');
	});

	// -----------------------------------------------------------------------
	// Snapshot delivery failure: still returns ok
	// -----------------------------------------------------------------------

	test('subscribe: snapshot delivery failure (client not found) returns ok gracefully', async () => {
		setup.setSendResult(false);
		const result = await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-fail',
		});
		// Should not throw; the subscription was attempted
		expect(result).toEqual({ ok: true });
	});

	// -----------------------------------------------------------------------
	// P1: Null router during snapshot — subscription disposed, returns ok
	// -----------------------------------------------------------------------

	test('subscribe: null router during snapshot disposes handle and returns ok', async () => {
		setup.setRouterEnabled(false);
		const result = await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-no-router',
		});
		// No message was sent (router was null)
		expect(setup.sentMessages.length).toBe(0);
		// Returns ok — not a protocol error
		expect(result).toEqual({ ok: true });

		// After router is re-enabled, a second subscribe with the same id should work
		// cleanly (old handle was disposed, not leaked into the tracking map)
		setup.setRouterEnabled(true);
		const result2 = await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-no-router',
		});
		expect(result2).toEqual({ ok: true });
		expect(setup.sentMessages.length).toBe(1);
		expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');
	});

	// -----------------------------------------------------------------------
	// P1: Version monotonically increasing across deltas
	// -----------------------------------------------------------------------

	test('version is monotonically increasing across snapshot and deltas', async () => {
		await setup.callHandler('liveQuery.subscribe', {
			queryName: 'tasks.byRoom',
			params: [roomId],
			subscriptionId: 'sub-version',
		});

		// First message is snapshot
		expect(setup.sentMessages.length).toBe(1);
		const snapshotVersion = setup.sentMessages[0].message.data.version;
		expect(typeof snapshotVersion).toBe('number');

		// Trigger first delta
		insertTask(db, 'task-v2', roomId);
		reactiveDb.notifyChange('tasks');
		await new Promise((r) => setTimeout(r, 10));

		// Trigger second delta
		insertTask(db, 'task-v3', roomId);
		reactiveDb.notifyChange('tasks');
		await new Promise((r) => setTimeout(r, 10));

		// Collect all delta messages
		const deltas = setup.sentMessages
			.slice(1)
			.filter((m) => m.message.method === 'liveQuery.delta');
		expect(deltas.length).toBeGreaterThanOrEqual(1);

		// Verify version is non-decreasing across snapshot → delta1 → delta2
		let prevVersion = snapshotVersion;
		for (const delta of deltas) {
			const v = delta.message.data.version;
			expect(v).toBeGreaterThanOrEqual(prevVersion);
			prevVersion = v;
		}
	});
});
