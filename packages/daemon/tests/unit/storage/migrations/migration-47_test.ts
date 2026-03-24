/**
 * Migration 47 Tests
 *
 * Migration 47 adds short_id support:
 * - tasks.short_id TEXT (nullable, unique where not null)
 * - goals.short_id TEXT (nullable, unique where not null)
 * - short_id_counters table (entity_type, scope_id) PRIMARY KEY
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations, createTables } from '../../../../src/storage/schema/index.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
	const result = db
		.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`)
		.get(column);
	return !!result;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

function indexExists(db: BunDatabase, indexName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
		.get(indexName);
	return !!result;
}

describe('Migration 47: add short_id columns and short_id_counters table', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-47', `test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		const dbPath = join(testDir, 'test.db');
		db = new BunDatabase(dbPath);
		db.exec('PRAGMA foreign_keys = ON');
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('fresh DB has short_id column on tasks', () => {
		runMigrations(db, () => {});
		createTables(db);

		expect(columnExists(db, 'tasks', 'short_id')).toBe(true);
	});

	test('fresh DB has short_id column on goals', () => {
		runMigrations(db, () => {});
		createTables(db);

		expect(columnExists(db, 'goals', 'short_id')).toBe(true);
	});

	test('fresh DB has short_id_counters table with correct schema', () => {
		runMigrations(db, () => {});
		createTables(db);

		expect(tableExists(db, 'short_id_counters')).toBe(true);

		// Verify columns
		expect(columnExists(db, 'short_id_counters', 'entity_type')).toBe(true);
		expect(columnExists(db, 'short_id_counters', 'scope_id')).toBe(true);
		expect(columnExists(db, 'short_id_counters', 'counter')).toBe(true);
	});

	test('short_id_counters table enforces composite PRIMARY KEY', () => {
		runMigrations(db, () => {});
		createTables(db);

		// Insert a row
		db.exec(
			`INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('task', 'room-1', 1)`
		);

		// Inserting duplicate (entity_type, scope_id) should fail
		expect(() => {
			db.exec(
				`INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('task', 'room-1', 2)`
			);
		}).toThrow();

		// Different scope_id should succeed
		expect(() => {
			db.exec(
				`INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('task', 'room-2', 1)`
			);
		}).not.toThrow();

		// Different entity_type should succeed
		expect(() => {
			db.exec(
				`INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('goal', 'room-1', 1)`
			);
		}).not.toThrow();
	});

	test('partial unique indexes exist for tasks and goals short_id', () => {
		runMigrations(db, () => {});
		createTables(db);

		expect(indexExists(db, 'idx_tasks_short_id')).toBe(true);
		expect(indexExists(db, 'idx_goals_short_id')).toBe(true);
	});

	test('tasks short_id unique index allows multiple NULLs', () => {
		runMigrations(db, () => {});
		createTables(db);

		db.exec(
			`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-uuid-1', 'Test Room', 1000, 1000)`
		);

		// Insert two tasks without short_id — both NULL should be allowed
		db.exec(`
			INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at)
			VALUES
				('task-uuid-1', 'room-uuid-1', 'Task 1', '', 'pending', 'normal', 1000, 1000),
				('task-uuid-2', 'room-uuid-1', 'Task 2', '', 'pending', 'normal', 1001, 1001)
		`);

		// Both have NULL short_id — should be fine (partial index only covers non-null)
		const rows = db
			.prepare(`SELECT short_id FROM tasks WHERE id IN ('task-uuid-1', 'task-uuid-2')`)
			.all() as Array<{ short_id: string | null }>;
		expect(rows.every((r) => r.short_id === null)).toBe(true);
	});

	test('tasks short_id unique index rejects duplicate non-null values', () => {
		runMigrations(db, () => {});
		createTables(db);

		db.exec(
			`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-uuid-1', 'Test Room', 1000, 1000)`
		);

		db.exec(`
			INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at, short_id)
			VALUES ('task-uuid-1', 'room-uuid-1', 'Task 1', '', 'pending', 'normal', 1000, 1000, 't:roomabc:1')
		`);

		expect(() => {
			db.exec(`
				INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at, short_id)
				VALUES ('task-uuid-2', 'room-uuid-1', 'Task 2', '', 'pending', 'normal', 1001, 1001, 't:roomabc:1')
			`);
		}).toThrow();
	});

	test('migration is idempotent — running runMigrations twice does not throw', () => {
		runMigrations(db, () => {});
		createTables(db);

		// Running migrations a second time should be safe
		expect(() => {
			runMigrations(db, () => {});
		}).not.toThrow();
	});
});
