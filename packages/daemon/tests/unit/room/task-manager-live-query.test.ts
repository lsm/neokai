/**
 * TaskManager + LiveQuery Integration Tests
 *
 * Verifies that LiveQueryEngine subscriptions on the `tasks` table fire
 * after every write method in TaskManager. TaskManager writes directly to
 * the raw BunDatabase (not through the ReactiveDatabase proxy) and manually
 * calls reactiveDb.notifyChange('tasks') after each durable commit.
 *
 * Test setup:
 *   - In-memory BunDatabase with full schema via createTables()
 *   - Real ReactiveDatabase wrapping a minimal Database facade
 *   - Real LiveQueryEngine subscribing to the tasks table
 *   - Real TaskManager injected with reactiveDb
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../src/storage/live-query';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { QueryDiff } from '../../../src/storage/live-query';
import type { Database } from '../../../src/storage/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TaskRow {
	id: string;
	title: string;
	status: string;
}

const TASKS_SQL = 'SELECT id, title, status FROM tasks WHERE room_id = ? ORDER BY created_at';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('TaskManager + LiveQueryEngine integration', () => {
	let bunDb: BunDatabase;
	let engine: LiveQueryEngine;
	let taskManager: TaskManager;
	let roomId: string;

	beforeEach(() => {
		bunDb = new BunDatabase(':memory:');
		createTables(bunDb);

		// Create a minimal Database facade so createReactiveDatabase is happy.
		// TaskManager writes directly to bunDb (not through the proxy), so the
		// facade only needs to expose getDatabase().
		const dbFacade = { getDatabase: () => bunDb } as unknown as Database;

		const reactiveDb = createReactiveDatabase(dbFacade);
		engine = new LiveQueryEngine(bunDb, reactiveDb);
		taskManager = new TaskManager(bunDb, 'room-test', reactiveDb);

		// Create the room so FK constraints pass
		const roomManager = new RoomManager(bunDb, reactiveDb);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace' }],
			defaultPath: '/workspace',
		});
		roomId = room.id;

		// Recreate taskManager with the real room id
		const reactiveDb2 = createReactiveDatabase(dbFacade);
		engine.dispose();
		engine = new LiveQueryEngine(bunDb, reactiveDb2);
		taskManager = new TaskManager(bunDb, roomId, reactiveDb2);
	});

	afterEach(() => {
		engine.dispose();
		bunDb.close();
	});

	// -----------------------------------------------------------------------
	// createTask fires notification
	// -----------------------------------------------------------------------

	test('createTask fires a tasks subscription delta', async () => {
		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		await taskManager.createTask({ title: 'New Task', description: 'desc' });
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		const delta = diffs[1];
		expect(delta.type).toBe('delta');
		expect(delta.added?.length).toBe(1);
		expect(delta.added?.[0].title).toBe('New Task');
	});

	// -----------------------------------------------------------------------
	// updateTaskStatus fires notification
	// -----------------------------------------------------------------------

	test('updateTaskStatus fires a tasks subscription delta', async () => {
		const task = await taskManager.createTask({ title: 'Status Task', description: '' });
		await Promise.resolve(); // flush insert delta

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));
		// snapshot is diffs[0]

		await taskManager.updateTaskStatus(task.id, 'in_progress');
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		const delta = diffs[1];
		expect(delta.type).toBe('delta');
		expect(delta.updated?.length).toBe(1);
		expect(delta.updated?.[0].status).toBe('in_progress');
	});

	// -----------------------------------------------------------------------
	// updateTaskProgress fires notification
	// -----------------------------------------------------------------------

	test('updateTaskProgress fires a tasks subscription delta', async () => {
		const task = await taskManager.createTask({ title: 'Progress Task', description: '' });
		await taskManager.updateTaskStatus(task.id, 'in_progress');
		await Promise.resolve();

		// Use a query that includes `progress` so we detect the update
		const diffs: QueryDiff<{ id: string; progress: number | null }>[] = [];
		engine.subscribe(
			'SELECT id, progress FROM tasks WHERE room_id = ? ORDER BY created_at',
			[roomId],
			(diff) => diffs.push(diff)
		);

		await taskManager.updateTaskProgress(task.id, 50, 'halfway');
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		expect(diffs[1].type).toBe('delta');
		expect(diffs[1].updated?.[0].progress).toBe(50);
	});

	// -----------------------------------------------------------------------
	// promoteDraftTasks fires notification
	// -----------------------------------------------------------------------

	test('promoteDraftTasks fires a tasks subscription delta when tasks are promoted', async () => {
		// Create a draft task via createTask with status='draft'
		const plannerTask = await taskManager.createTask({
			title: 'Planner Task',
			description: '',
			status: 'pending',
		});
		await taskManager.createTask({
			title: 'Draft Child',
			description: '',
			status: 'draft',
			createdByTaskId: plannerTask.id,
		});
		await Promise.resolve();

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		const count = await taskManager.promoteDraftTasks(plannerTask.id);
		await Promise.resolve();

		expect(count).toBeGreaterThan(0);
		expect(diffs.length).toBe(2);
		expect(diffs[1].type).toBe('delta');
	});

	// -----------------------------------------------------------------------
	// updateDraftTask fires notification
	// -----------------------------------------------------------------------

	test('updateDraftTask fires a tasks subscription delta', async () => {
		const draft = await taskManager.createTask({
			title: 'Draft Task',
			description: '',
			status: 'draft',
		});
		await Promise.resolve();

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		await taskManager.updateDraftTask(draft.id, { title: 'Updated Draft' });
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		expect(diffs[1].type).toBe('delta');
		expect(diffs[1].updated?.[0].title).toBe('Updated Draft');
	});

	// -----------------------------------------------------------------------
	// removeDraftTask fires notification
	// -----------------------------------------------------------------------

	test('removeDraftTask fires a tasks subscription delta', async () => {
		const draft = await taskManager.createTask({
			title: 'To Remove',
			description: '',
			status: 'draft',
		});
		await Promise.resolve();

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		await taskManager.removeDraftTask(draft.id);
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		const delta = diffs[1];
		expect(delta.type).toBe('delta');
		expect(delta.removed?.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// deleteTask fires notification
	// -----------------------------------------------------------------------

	test('deleteTask fires a tasks subscription delta', async () => {
		const task = await taskManager.createTask({ title: 'Delete Me', description: '' });
		await Promise.resolve();

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		await taskManager.deleteTask(task.id);
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		const delta = diffs[1];
		expect(delta.type).toBe('delta');
		expect(delta.removed?.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// archiveTask fires notification
	// -----------------------------------------------------------------------

	test('archiveTask fires a tasks subscription delta', async () => {
		const task = await taskManager.createTask({ title: 'Archive Me', description: '' });
		// pending -> cancelled -> archived (cancelled is a valid archivable state)
		await taskManager.cancelTask(task.id);
		await Promise.resolve();

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		await taskManager.archiveTask(task.id);
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		expect(diffs[1].type).toBe('delta');
	});

	// -----------------------------------------------------------------------
	// updateTaskFields fires notification
	// -----------------------------------------------------------------------

	test('updateTaskFields fires a tasks subscription delta', async () => {
		const task = await taskManager.createTask({ title: 'Fields Task', description: '' });
		await Promise.resolve();

		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		await taskManager.updateTaskFields(task.id, { title: 'Updated Fields' });
		await Promise.resolve();

		expect(diffs.length).toBe(2);
		expect(diffs[1].type).toBe('delta');
		expect(diffs[1].updated?.[0].title).toBe('Updated Fields');
	});

	// -----------------------------------------------------------------------
	// notifyChange is only called after durable commit
	// -----------------------------------------------------------------------

	test('subscription does not fire before any write', () => {
		const diffs: QueryDiff<TaskRow>[] = [];
		engine.subscribe(TASKS_SQL, [roomId], (diff) => diffs.push(diff));

		// Only the initial snapshot — no write has been made
		expect(diffs.length).toBe(1);
		expect(diffs[0].type).toBe('snapshot');
	});
});
