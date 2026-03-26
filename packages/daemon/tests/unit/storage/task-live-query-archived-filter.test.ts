/**
 * Task LiveQuery Archived Filter Tests
 *
 * Verifies that the TASKS_BY_ROOM_SQL query used by the LiveQuery engine
 * excludes archived tasks server-side. Archived tasks are treated as deleted
 * and must not be sent to clients via the live-query stream.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';

// Mirrors TASKS_BY_ROOM_SQL from live-query-handlers.ts — keep in sync.
// The AND status != 'archived' clause is the critical server-side filter.
const TASKS_BY_ROOM_SQL = `
SELECT
  id,
  room_id             AS roomId,
  title,
  status,
  priority,
  created_at          AS createdAt
FROM tasks
WHERE room_id = ?
  AND status != 'archived'
ORDER BY created_at DESC, id DESC
`.trim();

describe('TASKS_BY_ROOM_SQL archived filter', () => {
	let db: BunDatabase;
	const roomId = 'room-lq-filter-test';

	beforeEach(() => {
		db = new BunDatabase(':memory:');
		createTables(db);
		db.exec(
			`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${Date.now()}, ${Date.now()})`
		);
	});

	afterEach(() => {
		db.close();
	});

	function insertTask(id: string, status: string, title = 'Task', createdAt = Date.now()): void {
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(id, roomId, title, '', status, 'normal', '[]', createdAt);
	}

	function queryTasks(): Array<{ id: string; status: string }> {
		return db.prepare(TASKS_BY_ROOM_SQL).all(roomId) as Array<{ id: string; status: string }>;
	}

	test('excludes archived tasks from query results', () => {
		insertTask('task-in-progress', 'in_progress');
		insertTask('task-pending', 'pending');
		insertTask('task-archived', 'archived');

		const rows = queryTasks();
		const ids = rows.map((r) => r.id);

		expect(ids).not.toContain('task-archived');
		expect(ids).toContain('task-in-progress');
		expect(ids).toContain('task-pending');
	});

	test('returns tasks in all non-archived statuses', () => {
		const statuses = [
			'draft',
			'pending',
			'in_progress',
			'review',
			'needs_attention',
			'completed',
			'cancelled',
		];
		for (const status of statuses) {
			insertTask(`task-${status}`, status);
		}
		insertTask('task-archived', 'archived');

		const rows = queryTasks();
		const ids = rows.map((r) => r.id);

		expect(ids).toHaveLength(statuses.length);
		for (const status of statuses) {
			expect(ids).toContain(`task-${status}`);
		}
		expect(ids).not.toContain('task-archived');
	});

	test('returns empty array when only archived tasks exist', () => {
		insertTask('task-1', 'archived');
		insertTask('task-2', 'archived');

		const rows = queryTasks();
		expect(rows).toHaveLength(0);
	});

	test('excludes archived tasks for a specific room only', () => {
		const otherRoomId = 'other-room';
		db.exec(
			`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${otherRoomId}', 'Other Room', ${Date.now()}, ${Date.now()})`
		);
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			'other-task-pending',
			otherRoomId,
			'Other Pending',
			'',
			'pending',
			'normal',
			'[]',
			Date.now()
		);

		insertTask('task-archived', 'archived');
		insertTask('task-pending', 'pending');

		const rows = queryTasks();
		const ids = rows.map((r) => r.id);

		expect(ids).toEqual(['task-pending']);
	});
});
