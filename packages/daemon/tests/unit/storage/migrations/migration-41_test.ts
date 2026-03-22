/**
 * Migration 41 Tests
 *
 * Tests for Migration 41: Create session_group_messages table for LiveQuery streaming.
 *
 * The original session_group_messages table was dropped in migration 19.
 * Migration 41 recreates it for existing (migrated) databases as an append-only
 * store for the LiveQuery message streaming path (Milestone 4).
 * Fresh databases already have the table from createTables().
 *
 * Covers:
 * - Fresh DB (full migration chain + createTables): table and index exist
 * - Table has the correct columns and defaults (verified via PRAGMA)
 * - Existing DB that already has the table: migration is a no-op (idempotency)
 * - Existing DB that does NOT have the table: migration creates it with correct schema
 * - idx_sgm_group index is created
 * - Running migrations twice does not error
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations, createTables } from '../../../../src/storage/schema/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(db: BunDatabase, tableName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

function columnInfo(db: BunDatabase, table: string): Array<{ name: string; dflt_value: unknown }> {
	return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
		dflt_value: unknown;
	}>;
}

function indexExists(db: BunDatabase, indexName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
		.get(indexName);
	return !!result;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 41: session_group_messages table', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-41', `test-${Date.now()}`);
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
	// Fresh DB — full migration chain followed by createTables (production flow)
	// -------------------------------------------------------------------------

	test('fresh DB: session_group_messages table exists after migrations + createTables', () => {
		runMigrations(db, () => {});
		createTables(db);
		expect(tableExists(db, 'session_group_messages')).toBe(true);
	});

	test('fresh DB: table has all required columns', () => {
		runMigrations(db, () => {});
		createTables(db);
		const cols = columnInfo(db, 'session_group_messages').map((c) => c.name);
		expect(cols).toContain('id');
		expect(cols).toContain('group_id');
		expect(cols).toContain('session_id');
		expect(cols).toContain('role');
		expect(cols).toContain('message_type');
		expect(cols).toContain('content');
		expect(cols).toContain('created_at');
	});

	test('fresh DB: role defaults to "system" (verified via PRAGMA)', () => {
		runMigrations(db, () => {});
		createTables(db);
		const cols = columnInfo(db, 'session_group_messages');
		const roleCol = cols.find((c) => c.name === 'role');
		expect(roleCol?.dflt_value).toBe("'system'");
	});

	test('fresh DB: message_type defaults to "status" (verified via PRAGMA)', () => {
		runMigrations(db, () => {});
		createTables(db);
		const cols = columnInfo(db, 'session_group_messages');
		const mtCol = cols.find((c) => c.name === 'message_type');
		expect(mtCol?.dflt_value).toBe("'status'");
	});

	test('fresh DB: idx_sgm_group index exists', () => {
		runMigrations(db, () => {});
		createTables(db);
		expect(indexExists(db, 'idx_sgm_group')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Idempotency — table already present (fresh DB re-migration)
	// -------------------------------------------------------------------------

	test('idempotency: running migrations twice does not error', () => {
		runMigrations(db, () => {});
		createTables(db);
		expect(() => {
			runMigrations(db, () => {});
			createTables(db);
		}).not.toThrow();
		expect(tableExists(db, 'session_group_messages')).toBe(true);
		expect(indexExists(db, 'idx_sgm_group')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Existing DB missing the table (simulates pre-migration-41 state)
	// -------------------------------------------------------------------------

	test('creates table when it does not exist in an existing DB', () => {
		// Bootstrap only session_groups (the table session_group_messages FK-references).
		// We intentionally omit tasks/rooms so migration 16 skips its tasks path
		// (it guards on tableExists('tasks')). Migration 41 only needs session_groups
		// to exist at CREATE TABLE time; FK enforcement is deferred to inserts.
		db.exec(`
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
		`);

		// Verify the table is absent before migration
		expect(tableExists(db, 'session_group_messages')).toBe(false);

		// Run the full migration chain — migration 41 should create the table
		runMigrations(db, () => {});

		expect(tableExists(db, 'session_group_messages')).toBe(true);
		expect(indexExists(db, 'idx_sgm_group')).toBe(true);
	});

	test('existing DB: table schema is correct after migration 41 creates it', () => {
		// Minimal pre-migration-41 schema (only session_groups needed for the FK)
		db.exec(`
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
		`);

		runMigrations(db, () => {});

		const cols = columnInfo(db, 'session_group_messages').map((c) => c.name);
		expect(cols).toContain('id');
		expect(cols).toContain('group_id');
		expect(cols).toContain('session_id');
		expect(cols).toContain('role');
		expect(cols).toContain('message_type');
		expect(cols).toContain('content');
		expect(cols).toContain('created_at');
	});
});
