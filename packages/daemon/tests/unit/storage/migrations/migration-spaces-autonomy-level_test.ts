/**
 * Migration 33 Tests — autonomy_level column on spaces
 *
 * Tests for Migration 33: Add autonomy_level column to the spaces table.
 *
 * Covers:
 * - Fresh DB (full migration chain): column exists with correct default
 * - Legacy DB path: column is added to an existing table that lacks it
 * - Idempotency: running migration twice on a table that already has the column is a no-op
 * - Default value: existing rows get 'supervised' as autonomy_level after column add
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

describe('Migration 33: Add autonomy_level to spaces', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-spaces-autonomy', `test-${Date.now()}`);
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

	test('fresh DB: autonomy_level column exists after full migration', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(true);
	});

	test("fresh DB: autonomy_level has default value of 'supervised'", () => {
		runMigrations(db, () => {});
		expect(getColumnDefault(db, 'spaces', 'autonomy_level')).toBe("'supervised'");
	});

	test("fresh DB: new spaces default to autonomy_level = 'supervised'", () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);

		const row = db.prepare(`SELECT autonomy_level FROM spaces WHERE id = 'space-1'`).get() as {
			autonomy_level: string;
		};
		expect(row.autonomy_level).toBe('supervised');
	});

	test("fresh DB: autonomy_level can be set to 'semi_autonomous'", () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, autonomy_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', 'semi_autonomous', now, now);

		const row = db.prepare(`SELECT autonomy_level FROM spaces WHERE id = 'space-1'`).get() as {
			autonomy_level: string;
		};
		expect(row.autonomy_level).toBe('semi_autonomous');
	});

	// -------------------------------------------------------------------------
	// Legacy DB path — simulate pre-migration-33 state without the column
	// -------------------------------------------------------------------------

	test('legacy DB: column is added to existing spaces table that lacks it', () => {
		// Create the spaces table as it existed before migration 33
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

		// Confirm column is absent before migration
		expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(false);

		// Run migrations
		runMigrations(db, () => {});

		// Column should now exist
		expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(true);
	});

	test("legacy DB: existing space rows get 'supervised' as autonomy_level after column add", () => {
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

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/a', 'Space A', now, now);
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-2', '/workspace/b', 'Space B', now, now);

		runMigrations(db, () => {});

		const rows = db
			.prepare(`SELECT id, name, autonomy_level FROM spaces ORDER BY id`)
			.all() as Array<{ id: string; name: string; autonomy_level: string }>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: 'space-1', name: 'Space A', autonomy_level: 'supervised' });
		expect(rows[1]).toMatchObject({ id: 'space-2', name: 'Space B', autonomy_level: 'supervised' });
	});

	// -------------------------------------------------------------------------
	// Idempotency — column already exists
	// -------------------------------------------------------------------------

	test('idempotency: running migration twice does not error', () => {
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();
		expect(columnExists(db, 'spaces', 'autonomy_level')).toBe(true);
	});

	test('idempotency: data is not duplicated on second migration run', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test', now, now);

		runMigrations(db, () => {});

		const rows = db.prepare(`SELECT id FROM spaces`).all();
		expect(rows).toHaveLength(1);
	});
});
