/**
 * Task RPC Handlers — Short ID tests
 *
 * Covers:
 *  - task.get with short ID input returns correct task (shortId field included)
 *  - task.get response includes shortId field
 *  - task.cancel with short ID input cancels the correct task
 *  - task.get with unknown short ID throws 'Task not found'
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { MessageHub } from '@neokai/shared';
import type { NeoTask } from '@neokai/shared';
import { setupTaskHandlers } from '../../../../src/lib/rpc-handlers/task-handlers';
import type { TaskManagerFactory } from '../../../../src/lib/rpc-handlers/task-handlers';
import { TaskRepository } from '../../../../src/storage/repositories/task-repository';
import { ShortIdAllocator } from '../../../../src/lib/short-id-allocator';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../../src/lib/room/managers/room-manager';
import type { Database } from '../../../../src/storage/database';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// ─── DB Setup ───

function makeRealDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec(`
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
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

/** Build a Database facade wrapping a real BunDatabase. */
function makeDbFacade(rawDb: BunDatabase): Database {
	return {
		getDatabase: mock(() => rawDb),
		getShortIdAllocator: mock(() => undefined),
	} as unknown as Database;
}

// ─── Mock helpers ───

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

const mockRoomManager = {
	getRoomOverview: mock(() => null),
} as unknown as RoomManager;

/** Build a TaskManagerFactory that returns a mock manager which resolves getTask by UUID. */
function makeTaskManagerFactory(tasksByUUID: Map<string, NeoTask>): TaskManagerFactory {
	const manager = {
		createTask: mock(async () => {
			throw new Error('not implemented');
		}),
		getTask: mock(async (id: string) => tasksByUUID.get(id) ?? null),
		listTasks: mock(async () => [...tasksByUUID.values()]),
		failTask: mock(async (id: string) => {
			const t = tasksByUUID.get(id);
			if (!t) throw new Error(`Task not found: ${id}`);
			return { ...t, status: 'needs_attention' as const };
		}),
		cancelTask: mock(async (id: string) => {
			const t = tasksByUUID.get(id);
			if (!t) throw new Error(`Task not found: ${id}`);
			return { ...t, status: 'cancelled' as const };
		}),
		setTaskStatus: mock(async (id: string, status: string) => {
			const t = tasksByUUID.get(id);
			if (!t) throw new Error(`Task not found: ${id}`);
			return { ...t, status } as NeoTask;
		}),
		archiveTask: mock(async (id: string) => {
			const t = tasksByUUID.get(id);
			if (!t) throw new Error(`Task not found: ${id}`);
			return { ...t, archivedAt: Date.now() };
		}),
		updateTaskStatus: mock(async () => {}),
	};
	return mock(() => manager);
}

// ─── Test fixtures ───

const ROOM_ID = 'room-abc';
const TASK_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TASK_SHORT_ID = 't-1';

function makeNeoTask(id: string, shortId?: string): NeoTask {
	return {
		id,
		roomId: ROOM_ID,
		title: 'Test Task',
		description: 'Test description',
		status: 'pending',
		priority: 'normal',
		taskType: 'coding',
		progress: 0,
		dependsOn: [],
		shortId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

// ─── Test suite ───

describe('task handlers — short ID support', () => {
	let rawDb: BunDatabase;
	let dbFacade: Database;
	let taskRepo: TaskRepository;
	let allocator: ShortIdAllocator;
	let tasksByUUID: Map<string, NeoTask>;

	beforeEach(() => {
		rawDb = makeRealDb();
		dbFacade = makeDbFacade(rawDb);
		allocator = new ShortIdAllocator(rawDb);
		taskRepo = new TaskRepository(rawDb, noOpReactiveDb, allocator);

		// Insert a task row with short_id = 't-1'
		const created = taskRepo.createTask({
			roomId: ROOM_ID,
			title: 'Test Task',
			description: 'Test description',
			priority: 'normal',
			taskType: 'coding',
		});

		// Map the real UUID to a NeoTask for the mock manager
		tasksByUUID = new Map([[created.id, { ...created, id: created.id }]]);
	});

	function getShortId(): string {
		// The allocator should have assigned t-1 as the first short ID
		const row = rawDb
			.prepare('SELECT short_id FROM tasks WHERE room_id = ?')
			.get(ROOM_ID) as Record<string, unknown>;
		return row.short_id as string;
	}

	function getUUID(): string {
		const row = rawDb.prepare('SELECT id FROM tasks WHERE room_id = ?').get(ROOM_ID) as Record<
			string,
			unknown
		>;
		return row.id as string;
	}

	function setupHandlers(): { handlers: Map<string, RequestHandler> } {
		const { hub, handlers } = createMockMessageHub();
		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			dbFacade,
			noOpReactiveDb,
			makeTaskManagerFactory(tasksByUUID)
		);
		return { handlers };
	}

	describe('task.get', () => {
		it('accepts short ID input and returns the correct task', async () => {
			const { handlers } = setupHandlers();
			const shortId = getShortId();
			const uuid = getUUID();

			const handler = handlers.get('task.get')!;
			const result = (await handler({ roomId: ROOM_ID, taskId: shortId }, {})) as { task: NeoTask };

			expect(result.task).toBeDefined();
			expect(result.task.id).toBe(uuid);
		});

		it('response includes shortId field when task has one', async () => {
			const { handlers } = setupHandlers();
			const shortId = getShortId();
			const uuid = getUUID();

			// Update the mock manager's task to include shortId
			const taskWithShortId = makeNeoTask(uuid, shortId);
			tasksByUUID.set(uuid, taskWithShortId);

			const handler = handlers.get('task.get')!;
			const result = (await handler({ roomId: ROOM_ID, taskId: shortId }, {})) as { task: NeoTask };

			expect(result.task.shortId).toBe(shortId);
		});

		it('still accepts UUID input', async () => {
			const { handlers } = setupHandlers();
			const uuid = getUUID();

			const handler = handlers.get('task.get')!;
			const result = (await handler({ roomId: ROOM_ID, taskId: uuid }, {})) as { task: NeoTask };

			expect(result.task.id).toBe(uuid);
		});

		it('throws Task not found for unknown short ID', async () => {
			const { handlers } = setupHandlers();
			const handler = handlers.get('task.get')!;

			await expect(handler({ roomId: ROOM_ID, taskId: 't-9999' }, {})).rejects.toThrow(
				'Task not found: t-9999'
			);
		});
	});

	describe('task.cancel', () => {
		beforeEach(() => {
			// Set tasks to pending so they can be cancelled
			const uuid = getUUID();
			const task = tasksByUUID.get(uuid)!;
			tasksByUUID.set(uuid, { ...task, status: 'pending' });
		});

		it('accepts short ID input and cancels the correct task', async () => {
			const { handlers } = setupHandlers();
			const shortId = getShortId();
			const uuid = getUUID();

			const handler = handlers.get('task.cancel')!;
			const result = (await handler({ roomId: ROOM_ID, taskId: shortId }, {})) as { task: NeoTask };

			expect(result.task).toBeDefined();
			expect(result.task.id).toBe(uuid);
			expect(result.task.status).toBe('cancelled');
		});

		it('still accepts UUID input', async () => {
			const { handlers } = setupHandlers();
			const uuid = getUUID();

			const handler = handlers.get('task.cancel')!;
			const result = (await handler({ roomId: ROOM_ID, taskId: uuid }, {})) as { task: NeoTask };

			expect(result.task.status).toBe('cancelled');
		});

		it('throws Task not found for unknown short ID', async () => {
			const { handlers } = setupHandlers();
			const handler = handlers.get('task.cancel')!;

			await expect(handler({ roomId: ROOM_ID, taskId: 't-9999' }, {})).rejects.toThrow(
				'Task not found: t-9999'
			);
		});
	});
});
