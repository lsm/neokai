/**
 * Migration 34 Tests
 *
 * Tests for Migration 34: Add 'archived' to status CHECK constraints on tasks and space_tasks.
 *
 * Covers:
 * - Fresh DB: tasks and space_tasks CHECK constraints include 'archived'
 * - Legacy DB: table-rebuild adds 'archived' to existing CHECK constraints
 * - Backfill: rows with archived_at IS NOT NULL are set to status = 'archived'
 * - Idempotency: running migration twice does not error or duplicate data
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTableSql(db: BunDatabase, table: string): string | null {
	const row = db
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
		.get(table) as { sql: string } | null;
	return row?.sql ?? null;
}

function tableExists(db: BunDatabase, table: string): boolean {
	return getTableSql(db, table) !== null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 34: Add archived to status CHECK constraints', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-34', `test-${Date.now()}`);
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

	// -------------------------------------------------------------------------
	// Fresh DB — full migration chain
	// -------------------------------------------------------------------------

	test('fresh DB: tasks CHECK constraint includes archived', () => {
		createTables(db);
		runMigrations(db, () => {});
		const sql = getTableSql(db, 'tasks');
		expect(sql).not.toBeNull();
		expect(sql!).toContain("'archived'");
	});

	test('fresh DB: space_tasks CHECK constraint includes archived', () => {
		createTables(db);
		runMigrations(db, () => {});
		expect(tableExists(db, 'space_tasks')).toBe(true);
		const sql = getTableSql(db, 'space_tasks')!;
		expect(sql).toContain("'archived'");
	});

	test('fresh DB: can insert a task with status = archived', () => {
		createTables(db);
		runMigrations(db, () => {});

		const now = Date.now();
		// Create a room first (FK requirement)
		db.prepare(
			`INSERT INTO rooms (id, name, allowed_paths, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('room-1', 'Test Room', '[]', 'active', now, now);

		// Insert a task with archived status
		expect(() => {
			db.prepare(
				`INSERT INTO tasks (id, room_id, title, description, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).run('task-1', 'room-1', 'Test Task', 'desc', 'archived', now, now);
		}).not.toThrow();

		const row = db.prepare(`SELECT status FROM tasks WHERE id = 'task-1'`).get() as {
			status: string;
		};
		expect(row.status).toBe('archived');
	});

	test('fresh DB: can insert a space_task with status = archived', () => {
		createTables(db);
		runMigrations(db, () => {});

		const now = Date.now();
		// Create a space first (FK requirement)
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace', 'Test Space', now, now);

		expect(() => {
			db.prepare(
				`INSERT INTO space_tasks (id, space_id, title, description, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).run('st-1', 'space-1', 'Test Task', 'desc', 'archived', now, now);
		}).not.toThrow();

		const row = db.prepare(`SELECT status FROM space_tasks WHERE id = 'st-1'`).get() as {
			status: string;
		};
		expect(row.status).toBe('archived');
	});

	// -------------------------------------------------------------------------
	// Legacy DB — backfill
	// -------------------------------------------------------------------------

	test('legacy DB: tasks with archived_at are backfilled to status = archived', () => {
		// Create a minimal pre-migration-34 tasks table (without 'archived' in CHECK)
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				allowed_paths TEXT DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		db.exec(`
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				task_type TEXT DEFAULT 'coding',
				assigned_agent TEXT DEFAULT 'coder',
				created_by_task_id TEXT,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				input_draft TEXT,
				updated_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);
		db.exec('CREATE INDEX idx_tasks_room ON tasks(room_id)');
		db.exec('CREATE INDEX idx_tasks_status ON tasks(status)');

		const now = Date.now();
		db.prepare(
			`INSERT INTO rooms (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('room-1', 'R', 'active', now, now);

		// Insert a completed task with archived_at set
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, archived_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('task-1', 'room-1', 'Old task', 'desc', 'completed', now - 1000, now);

		// Insert a normal task without archived_at
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('task-2', 'room-1', 'Active task', 'desc', 'in_progress', now);

		// Verify the CHECK constraint doesn't include 'archived' yet
		const sqlBefore = getTableSql(db, 'tasks')!;
		expect(sqlBefore).not.toContain("'archived'");

		// Run migrations
		runMigrations(db, () => {});

		// Check that the constraint now includes 'archived'
		const sqlAfter = getTableSql(db, 'tasks')!;
		expect(sqlAfter).toContain("'archived'");

		// Check backfill: task-1 should be archived, task-2 should remain in_progress
		const task1 = db.prepare(`SELECT status FROM tasks WHERE id = 'task-1'`).get() as {
			status: string;
		};
		expect(task1.status).toBe('archived');

		const task2 = db.prepare(`SELECT status FROM tasks WHERE id = 'task-2'`).get() as {
			status: string;
		};
		expect(task2.status).toBe('in_progress');
	});

	test('legacy DB: space_tasks with archived_at are backfilled to status = archived', () => {
		// Create minimal pre-migration-34 space tables
		db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
				priority TEXT NOT NULL DEFAULT 'normal',
				task_type TEXT,
				assigned_agent TEXT,
				custom_agent_id TEXT,
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT,
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace', 'S', now, now);

		// Space task with archived_at set
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, title, status, archived_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('st-1', 'space-1', 'Old task', 'completed', now - 1000, now, now);

		// Space task without archived_at
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('st-2', 'space-1', 'Active task', 'in_progress', now, now);

		runMigrations(db, () => {});

		const st1 = db.prepare(`SELECT status FROM space_tasks WHERE id = 'st-1'`).get() as {
			status: string;
		};
		expect(st1.status).toBe('archived');

		const st2 = db.prepare(`SELECT status FROM space_tasks WHERE id = 'st-2'`).get() as {
			status: string;
		};
		expect(st2.status).toBe('in_progress');
	});

	// -------------------------------------------------------------------------
	// Idempotency
	// -------------------------------------------------------------------------

	test('idempotency: running migration twice does not error', () => {
		createTables(db);
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();

		const tasksSql = getTableSql(db, 'tasks')!;
		expect(tasksSql).toContain("'archived'");
	});

	test('idempotency: data is not duplicated on second migration run', () => {
		createTables(db);
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO rooms (id, name, allowed_paths, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('room-1', 'R', '[]', 'active', now, now);
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('task-1', 'room-1', 'T', 'd', 'pending', now, now);

		runMigrations(db, () => {});

		const rows = db.prepare(`SELECT id FROM tasks`).all();
		expect(rows).toHaveLength(1);
	});

	test('idempotency: backfill does not change already-archived tasks', () => {
		createTables(db);
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO rooms (id, name, allowed_paths, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('room-1', 'R', '[]', 'active', now, now);

		// Insert a task already with status = 'archived' and archived_at
		db.prepare(
			`INSERT INTO tasks (id, room_id, title, description, status, archived_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run('task-1', 'room-1', 'T', 'd', 'archived', now - 5000, now, now);

		// Run again — should not error
		runMigrations(db, () => {});

		const row = db.prepare(`SELECT status, archived_at FROM tasks WHERE id = 'task-1'`).get() as {
			status: string;
			archived_at: number;
		};
		expect(row.status).toBe('archived');
		expect(row.archived_at).toBe(now - 5000);
	});
});
