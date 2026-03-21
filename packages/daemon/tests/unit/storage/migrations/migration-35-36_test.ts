/**
 * Migration 35 & 36 Tests
 *
 * Migration 35: Add iteration_count and max_iterations columns to space_workflow_runs.
 * Migration 36: Add max_iterations column to space_workflows.
 *
 * Covers:
 * - Fresh DB: columns exist with correct defaults after full migration
 * - Idempotency: running migrations twice does not error
 * - Default values: iteration_count defaults to 0, max_iterations defaults to 5 for runs
 * - Nullable: space_workflows.max_iterations is nullable
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnExists(db: BunDatabase, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.some((r) => r.name === column);
}

function getColumnDefault(db: BunDatabase, table: string, column: string): string | null {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
		dflt_value: string | null;
	}>;
	return rows.find((r) => r.name === column)?.dflt_value ?? null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 35: Add iteration tracking to space_workflow_runs', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-35-36', `test-${Date.now()}`);
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

	test('fresh DB: iteration_count column exists after full migration', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_workflow_runs', 'iteration_count')).toBe(true);
	});

	test('fresh DB: max_iterations column exists on space_workflow_runs', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_workflow_runs', 'max_iterations')).toBe(true);
	});

	test('fresh DB: iteration_count has default value of 0', () => {
		runMigrations(db, () => {});
		expect(getColumnDefault(db, 'space_workflow_runs', 'iteration_count')).toBe('0');
	});

	test('fresh DB: max_iterations on runs has default value of 5', () => {
		runMigrations(db, () => {});
		expect(getColumnDefault(db, 'space_workflow_runs', 'max_iterations')).toBe('5');
	});

	test('fresh DB: new runs default to iteration_count=0 and max_iterations=5', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('run-1', 'space-1', 'wf-1', 'Run #1', now, now);

		const row = db
			.prepare(`SELECT iteration_count, max_iterations FROM space_workflow_runs WHERE id = 'run-1'`)
			.get() as { iteration_count: number; max_iterations: number };
		expect(row.iteration_count).toBe(0);
		expect(row.max_iterations).toBe(5);
	});

	test('idempotency: running migration twice does not error', () => {
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();
		expect(columnExists(db, 'space_workflow_runs', 'iteration_count')).toBe(true);
		expect(columnExists(db, 'space_workflow_runs', 'max_iterations')).toBe(true);
	});

	test('upgrade path: existing rows get default iteration_count=0 and max_iterations=5', () => {
		// Simulate a pre-migration-35 database with the space_workflow_runs table
		// but without iteration columns
		db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT, allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)
		`);
		db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', start_step_id TEXT, config TEXT, layout TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
				title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0, current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending', config TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);

		// Confirm new columns are absent
		expect(columnExists(db, 'space_workflow_runs', 'iteration_count')).toBe(false);
		expect(columnExists(db, 'space_workflow_runs', 'max_iterations')).toBe(false);

		// Insert existing rows before migration
		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace', 'S', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'WF', now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('run-1', 'space-1', 'wf-1', 'Old Run', 'in_progress', now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('run-2', 'space-1', 'wf-1', 'Completed Run', 'completed', now, now);

		// Run migrations
		runMigrations(db, () => {});

		// Verify columns now exist
		expect(columnExists(db, 'space_workflow_runs', 'iteration_count')).toBe(true);
		expect(columnExists(db, 'space_workflow_runs', 'max_iterations')).toBe(true);

		// Verify existing rows got correct defaults
		const rows = db
			.prepare(
				`SELECT id, iteration_count, max_iterations FROM space_workflow_runs ORDER BY id`
			)
			.all() as Array<{ id: string; iteration_count: number; max_iterations: number }>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: 'run-1', iteration_count: 0, max_iterations: 5 });
		expect(rows[1]).toMatchObject({ id: 'run-2', iteration_count: 0, max_iterations: 5 });
	});
});

describe('Migration 36: Add max_iterations to space_workflows', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-35-36', `test-${Date.now()}`);
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

	test('fresh DB: max_iterations column exists on space_workflows', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_workflows', 'max_iterations')).toBe(true);
	});

	test('fresh DB: max_iterations on workflows is nullable (no default)', () => {
		runMigrations(db, () => {});
		expect(getColumnDefault(db, 'space_workflows', 'max_iterations')).toBeNull();
	});

	test('fresh DB: new workflows default to max_iterations=NULL', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', now, now);

		const row = db
			.prepare(`SELECT max_iterations FROM space_workflows WHERE id = 'wf-1'`)
			.get() as { max_iterations: number | null };
		expect(row.max_iterations).toBeNull();
	});

	test('fresh DB: max_iterations can be set on workflows', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, max_iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Cyclic Workflow', 3, now, now);

		const row = db
			.prepare(`SELECT max_iterations FROM space_workflows WHERE id = 'wf-1'`)
			.get() as { max_iterations: number | null };
		expect(row.max_iterations).toBe(3);
	});

	test('idempotency: running migration twice does not error', () => {
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();
		expect(columnExists(db, 'space_workflows', 'max_iterations')).toBe(true);
	});
});
