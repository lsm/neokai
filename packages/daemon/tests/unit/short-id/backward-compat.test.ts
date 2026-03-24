/**
 * Backward compatibility tests for short IDs
 *
 * Verifies that tasks (and goals) created before the short_id feature was deployed
 * continue to work correctly via lazy backfill on first access.
 *
 * Legacy records are simulated by inserting rows directly via SQL (bypassing
 * the repository's createTask/createGoal methods, which now always assign short IDs).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskRepository } from '../../../src/storage/repositories/task-repository';
import { GoalRepository } from '../../../src/storage/repositories/goal-repository';
import { ShortIdAllocator } from '../../../src/lib/short-id-allocator';
import { setupTaskHandlers } from '../../../src/lib/rpc-handlers/task-handlers';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import { MessageHub } from '@neokai/shared';
import { noOpReactiveDb } from '../../helpers/reactive-database';

// ─── DB schema shared across tests ───────────────────────────────────────────

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

		CREATE TABLE goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			priority TEXT NOT NULL DEFAULT 'normal',
			progress INTEGER NOT NULL DEFAULT 0,
			linked_task_ids TEXT NOT NULL DEFAULT '[]',
			metrics TEXT NOT NULL DEFAULT '{}',
			planning_attempts INTEGER DEFAULT 0,
			goal_review_attempts INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			mission_type TEXT NOT NULL DEFAULT 'one_shot',
			autonomy_level TEXT NOT NULL DEFAULT 'supervised',
			schedule TEXT,
			schedule_paused INTEGER NOT NULL DEFAULT 0,
			next_run_at INTEGER,
			structured_metrics TEXT,
			max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
			max_planning_attempts INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			replan_count INTEGER DEFAULT 0,
			short_id TEXT
		);

		CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		);

		CREATE INDEX idx_tasks_room ON tasks(room_id);
		CREATE INDEX idx_goals_room ON goals(room_id);
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

// Insert a goal row without short_id (simulates a legacy record)
function insertLegacyGoal(db: BunDatabase, id: string, roomId: string, title: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at)
		 VALUES (?, ?, ?, '', 'active', 'normal', 0, '[]', '{}', ?, ?)`
	).run(id, roomId, title, now, now);
}

// ─── Repository-level backward compatibility tests ────────────────────────────

describe('TaskRepository — legacy rows (no short_id)', () => {
	const ROOM_ID = 'room-legacy-0001';
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

	it('getTask returns a valid NeoTask for a legacy row (no short_id in DB)', () => {
		insertLegacyTask(db, LEGACY_UUID, ROOM_ID, 'Legacy Task');

		const task = taskRepo.getTask(LEGACY_UUID);

		expect(task).not.toBeNull();
		expect(task!.id).toBe(LEGACY_UUID);
		expect(task!.roomId).toBe(ROOM_ID);
		expect(task!.title).toBe('Legacy Task');
	});

	it('getTask performs lazy backfill — assigns shortId to legacy row on first access', () => {
		insertLegacyTask(db, LEGACY_UUID, ROOM_ID, 'Legacy Task');

		// Confirm DB has no short_id before the call
		const before = db.prepare('SELECT short_id FROM tasks WHERE id = ?').get(LEGACY_UUID) as {
			short_id: string | null;
		};
		expect(before.short_id).toBeNull();

		const task = taskRepo.getTask(LEGACY_UUID);

		expect(task!.shortId).toBeDefined();
		expect(task!.shortId).toMatch(/^t-\d+$/);

		// DB row should now have the short_id persisted
		const after = db.prepare('SELECT short_id FROM tasks WHERE id = ?').get(LEGACY_UUID) as {
			short_id: string | null;
		};
		expect(after.short_id).toBe(task!.shortId);
	});

	it('getTask called twice on same legacy row returns consistent shortId without double-allocating', () => {
		insertLegacyTask(db, LEGACY_UUID, ROOM_ID, 'Legacy Task');

		const first = taskRepo.getTask(LEGACY_UUID);
		const second = taskRepo.getTask(LEGACY_UUID);

		// Both calls should return the same short ID
		expect(first!.shortId).toBe(second!.shortId);

		// Counter should only have incremented once (backfill on second call is a no-op)
		expect(allocator.getCounter('task', ROOM_ID)).toBe(1);
	});

	it('getTaskByShortId resolves the backfilled short ID correctly', () => {
		insertLegacyTask(db, LEGACY_UUID, ROOM_ID, 'Legacy Task');

		// Backfill happens on getTask
		const backfilled = taskRepo.getTask(LEGACY_UUID);
		const assignedShortId = backfilled!.shortId!;

		// Now look up by the newly assigned short ID
		const found = taskRepo.getTaskByShortId(ROOM_ID, assignedShortId);

		expect(found).not.toBeNull();
		expect(found!.id).toBe(LEGACY_UUID);
		expect(found!.shortId).toBe(assignedShortId);
	});

	it('listTasks backfills legacy rows and returns all with shortId', () => {
		const LEGACY_UUID_2 = 'bbbbbbbb-0000-4000-8000-000000000002';

		insertLegacyTask(db, LEGACY_UUID, ROOM_ID, 'Legacy Task 1');
		insertLegacyTask(db, LEGACY_UUID_2, ROOM_ID, 'Legacy Task 2');

		const tasks = taskRepo.listTasks(ROOM_ID);

		expect(tasks.length).toBe(2);
		expect(tasks.every((t) => t.shortId !== undefined)).toBe(true);
		expect(tasks.every((t) => /^t-\d+$/.test(t.shortId!))).toBe(true);

		// Both short IDs must be distinct
		const shortIds = tasks.map((t) => t.shortId);
		expect(new Set(shortIds).size).toBe(2);
	});

	it('listTasks handles a mix of legacy (no short_id) and new (with short_id) tasks', () => {
		// New task created via repository (gets short_id at creation)
		const newTask = taskRepo.createTask({ roomId: ROOM_ID, title: 'New Task', description: '' });
		expect(newTask.shortId).toBe('t-1');

		// Legacy task inserted without short_id
		const LEGACY_UUID_2 = 'cccccccc-0000-4000-8000-000000000003';
		insertLegacyTask(db, LEGACY_UUID_2, ROOM_ID, 'Legacy Task');

		const tasks = taskRepo.listTasks(ROOM_ID);

		expect(tasks.length).toBe(2);

		// All tasks must have shortId populated
		expect(tasks.every((t) => t.shortId !== undefined)).toBe(true);
		expect(tasks.every((t) => /^t-\d+$/.test(t.shortId!))).toBe(true);

		// Short IDs must be distinct
		const shortIds = new Set(tasks.map((t) => t.shortId));
		expect(shortIds.size).toBe(2);

		// The new task retains t-1
		const found = tasks.find((t) => t.id === newTask.id);
		expect(found!.shortId).toBe('t-1');
	});
});

// ─── GoalRepository — legacy rows backward compatibility ──────────────────────

describe('GoalRepository — legacy rows (no short_id)', () => {
	const ROOM_ID = 'room-goal-legacy-0001';
	const LEGACY_GOAL_UUID = 'dddddddd-0000-4000-8000-000000000004';

	let db: BunDatabase;
	let allocator: ShortIdAllocator;
	let goalRepo: GoalRepository;

	beforeEach(() => {
		db = makeDb();
		allocator = new ShortIdAllocator(db);
		goalRepo = new GoalRepository(db, noOpReactiveDb, allocator);
	});

	afterEach(() => {
		db.close();
	});

	it('getGoal assigns shortId to legacy row on first access', () => {
		insertLegacyGoal(db, LEGACY_GOAL_UUID, ROOM_ID, 'Legacy Goal');

		const goal = goalRepo.getGoal(LEGACY_GOAL_UUID);

		expect(goal).not.toBeNull();
		expect(goal!.id).toBe(LEGACY_GOAL_UUID);
		expect(goal!.shortId).toBeDefined();
		expect(goal!.shortId).toMatch(/^g-\d+$/);

		// Persisted to DB
		const row = db.prepare('SELECT short_id FROM goals WHERE id = ?').get(LEGACY_GOAL_UUID) as {
			short_id: string | null;
		};
		expect(row.short_id).toBe(goal!.shortId);
	});

	it('listGoals backfills all legacy goal rows', () => {
		const LEGACY_GOAL_UUID_2 = 'eeeeeeee-0000-4000-8000-000000000005';
		insertLegacyGoal(db, LEGACY_GOAL_UUID, ROOM_ID, 'Legacy Goal 1');
		insertLegacyGoal(db, LEGACY_GOAL_UUID_2, ROOM_ID, 'Legacy Goal 2');

		const goals = goalRepo.listGoals(ROOM_ID);

		expect(goals.length).toBe(2);
		expect(goals.every((g) => g.shortId !== undefined)).toBe(true);
		expect(goals.every((g) => /^g-\d+$/.test(g.shortId!))).toBe(true);
		expect(new Set(goals.map((g) => g.shortId)).size).toBe(2);
	});
});

// ─── RPC handler integration tests ───────────────────────────────────────────

// Type alias for captured request handlers
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

describe('task.get RPC handler — legacy records', () => {
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

		expect(result.task).toBeDefined();
		expect(result.task.id).toBe(LEGACY_UUID);
		expect(result.task.shortId).toBeDefined();
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

		// All tasks must have shortId populated
		expect(result.tasks.every((t) => t.shortId !== undefined)).toBe(true);
		expect(result.tasks.every((t) => /^t-\d+$/.test(t.shortId!))).toBe(true);

		// Short IDs are distinct
		const shortIds = new Set(result.tasks.map((t) => t.shortId));
		expect(shortIds.size).toBe(2);
	});
});
