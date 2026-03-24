/**
 * Backward compatibility tests for short IDs
 *
 * Focuses on scenarios NOT already covered by task-repository-short-id.test.ts or
 * goal-repository-short-id.test.ts:
 *
 * 1. Cross-method consistency: after getTask backfills a legacy row, a second getTask call
 *    is idempotent (counter increments exactly once, not twice).
 *
 * 2. RPC handler integration: exercises the full handler chain
 *    (resolveTaskId → TaskManager → TaskRepository) with legacy records, which is not
 *    covered by the repository-level tests.
 *
 * Repository-level backfill correctness (inserts, listTasks, listGoals) is already
 * thoroughly tested in:
 *   - tests/unit/storage/task-repository-short-id.test.ts
 *   - tests/unit/storage/goal-repository-short-id.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskRepository } from '../../../src/storage/repositories/task-repository';
import { ShortIdAllocator } from '../../../src/lib/short-id-allocator';
import { setupTaskHandlers } from '../../../src/lib/rpc-handlers/task-handlers';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import { MessageHub } from '@neokai/shared';
import { noOpReactiveDb } from '../../helpers/reactive-database';

// ─── DB schema ───────────────────────────────────────────────────────────────

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec(`
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			priority TEXT NOT NULL DEFAULT 'normal',
			task_type TEXT NOT NULL DEFAULT 'coding',
			assigned_agent TEXT DEFAULT 'coder',
			created_by_task_id TEXT,
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			short_id TEXT,
			input_draft TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			archived_at INTEGER,
			active_session TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			updated_at INTEGER
		);

		CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		);

		CREATE INDEX idx_tasks_room ON tasks(room_id);
	`);
	return db;
}

// Insert a task row without short_id (simulates a legacy record)
function insertLegacyTask(db: BunDatabase, id: string, roomId: string, title: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO tasks (id, room_id, title, description, status, priority, task_type, assigned_agent, depends_on, created_at, updated_at)
		 VALUES (?, ?, ?, '', 'pending', 'normal', 'coding', 'coder', '[]', ?, ?)`
	).run(id, roomId, title, now, now);
}

// ─── Cross-method consistency test ───────────────────────────────────────────

describe('TaskRepository — backfill idempotency on legacy rows', () => {
	const ROOM_ID = 'room-legacy-compat';
	const LEGACY_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';

	let db: BunDatabase;
	let allocator: ShortIdAllocator;
	let taskRepo: TaskRepository;

	beforeEach(() => {
		db = makeDb();
		allocator = new ShortIdAllocator(db);
		taskRepo = new TaskRepository(db, noOpReactiveDb, allocator);
	});

	afterEach(() => {
		db.close();
	});

	it('getTask on a legacy row backfills shortId on first call and is idempotent on second call', () => {
		// task-repository-short-id.test.ts tests idempotency starting from a new task that
		// already has a short_id. This test verifies the same invariant starting from a
		// legacy row where the first getTask call itself performs the backfill write.
		insertLegacyTask(db, LEGACY_UUID, ROOM_ID, 'Legacy Task');

		const first = taskRepo.getTask(LEGACY_UUID);
		expect(first!.shortId).toMatch(/^t-\d+$/);
		expect(allocator.getCounter('task', ROOM_ID)).toBe(1);

		// Second call should NOT increment the counter — backfill is a one-shot write
		const second = taskRepo.getTask(LEGACY_UUID);
		expect(second!.shortId).toBe(first!.shortId);
		expect(allocator.getCounter('task', ROOM_ID)).toBe(1);
	});
});

// ─── RPC handler integration tests ───────────────────────────────────────────

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

function createMockRoomManager(): RoomManager {
	return {
		createRoom: mock(() => ({ id: 'room-123' })),
		listRooms: mock(() => []),
		getRoom: mock(() => null),
		getRoomOverview: mock(() => null),
		updateRoom: mock(() => null),
		archiveRoom: mock(() => null),
	} as unknown as RoomManager;
}

describe('task.get / task.list RPC handlers — legacy records', () => {
	const ROOM_ID = 'room-rpc-legacy-0001';
	const LEGACY_UUID = 'ffffffff-0000-4000-8000-000000000006';

	let bunDb: BunDatabase;
	let allocator: ShortIdAllocator;
	let fakeDb: Database;
	let handlers: Map<string, RequestHandler>;

	beforeEach(() => {
		bunDb = makeDb();
		allocator = new ShortIdAllocator(bunDb);

		// Minimal Database facade: exposes the raw SQLite instance and the allocator
		fakeDb = {
			getDatabase: () => bunDb,
			getShortIdAllocator: () => allocator,
		} as unknown as Database;

		const { hub, handlers: h } = createMockMessageHub();
		handlers = h;

		setupTaskHandlers(hub, createMockRoomManager(), createMockDaemonHub(), fakeDb, noOpReactiveDb);
	});

	afterEach(() => {
		bunDb.close();
	});

	it('task.get with UUID resolves a legacy record and returns shortId', async () => {
		insertLegacyTask(bunDb, LEGACY_UUID, ROOM_ID, 'Legacy RPC Task');

		const handler = handlers.get('task.get')!;
		const result = (await handler({ roomId: ROOM_ID, taskId: LEGACY_UUID }, {})) as {
			task: { id: string; shortId?: string };
		};

		expect(result.task.id).toBe(LEGACY_UUID);
		expect(result.task.shortId).toMatch(/^t-\d+$/);
	});

	it('task.get with short ID resolves after UUID-based backfill assigned the short ID', async () => {
		insertLegacyTask(bunDb, LEGACY_UUID, ROOM_ID, 'Legacy RPC Task');

		const getHandler = handlers.get('task.get')!;

		// First call via UUID triggers lazy backfill
		const first = (await getHandler({ roomId: ROOM_ID, taskId: LEGACY_UUID }, {})) as {
			task: { id: string; shortId?: string };
		};
		const assignedShortId = first.task.shortId!;
		expect(assignedShortId).toMatch(/^t-\d+$/);

		// Second call via the backfilled short ID must also succeed
		const second = (await getHandler({ roomId: ROOM_ID, taskId: assignedShortId }, {})) as {
			task: { id: string; shortId?: string };
		};

		expect(second.task.id).toBe(LEGACY_UUID);
		expect(second.task.shortId).toBe(assignedShortId);
	});

	it('task.list returns all tasks (legacy and new) with shortId populated', async () => {
		// New task created via repository (short_id assigned at creation)
		const taskRepo = new TaskRepository(bunDb, noOpReactiveDb, allocator);
		const newTask = taskRepo.createTask({ roomId: ROOM_ID, title: 'New Task', description: '' });
		expect(newTask.shortId).toBe('t-1');

		// Legacy task inserted without short_id
		const LEGACY_UUID_2 = 'aaaaaaaa-1111-4000-8000-000000000007';
		insertLegacyTask(bunDb, LEGACY_UUID_2, ROOM_ID, 'Legacy Task');

		const listHandler = handlers.get('task.list')!;
		const result = (await listHandler({ roomId: ROOM_ID }, {})) as {
			tasks: { id: string; shortId?: string }[];
		};

		expect(result.tasks.length).toBe(2);
		expect(result.tasks.every((t) => t.shortId !== undefined)).toBe(true);
		expect(result.tasks.every((t) => /^t-\d+$/.test(t.shortId!))).toBe(true);
		expect(new Set(result.tasks.map((t) => t.shortId)).size).toBe(2);
	});
});
