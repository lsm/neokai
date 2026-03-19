/**
 * Migration 31 Tests
 *
 * Tests for Migration 31: Remove CHECK constraint on space_agents.role.
 *
 * Covers:
 * - Fresh DB (full migration chain): role column accepts any string value
 * - Legacy DB path: table with CHECK constraint is rebuilt without it
 * - Idempotency: running migration on already-rebuilt table is a no-op
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTableSchema(db: BunDatabase, name: string): string | null {
	const row = db
		.prepare<{ sql: string }, [string]>(
			`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
		)
		.get(name);
	return row?.sql ?? null;
}

function indexExists(db: BunDatabase, name: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 31: Remove role CHECK constraint from space_agents', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-31', `test-${Date.now()}`);
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

	test('fresh DB: role column accepts any string value after full migration', () => {
		runMigrations(db, () => {});

		// Insert a space first (FK constraint)
		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);

		// These would have been rejected by the old CHECK constraint
		for (const role of ['custom-role', 'admin', 'leader', 'any-string']) {
			expect(() => {
				db.prepare(
					`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
				).run(`agent-${role}`, 'space-1', `Agent ${role}`, role, now, now);
			}).not.toThrow();
		}
	});

	test('fresh DB: schema does not contain CHECK(role IN after migration', () => {
		runMigrations(db, () => {});

		const schema = getTableSchema(db, 'space_agents');
		expect(schema).not.toBeNull();
		expect(schema).not.toContain('CHECK(role IN');
	});

	test('fresh DB: idx_space_agents_space_id index exists after migration', () => {
		runMigrations(db, () => {});
		expect(indexExists(db, 'idx_space_agents_space_id')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Legacy DB path — simulate pre-migration-31 state with CHECK constraint
	// -------------------------------------------------------------------------

	test('legacy DB: table with CHECK constraint is rebuilt without it', () => {
		// Simulate the pre-migration-31 state: run only migrations 1–30 by
		// manually creating the space_agents table with the CHECK constraint.
		// We directly exec the DDL that migration 29+30 would have produced.
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
			CREATE TABLE space_agents (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				model TEXT,
				provider TEXT,
				tools TEXT NOT NULL DEFAULT '[]',
				system_prompt TEXT NOT NULL DEFAULT '',
				role TEXT NOT NULL DEFAULT 'coder'
					CHECK(role IN ('planner', 'coder', 'general', 'reviewer')),
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);

		// Verify the constraint IS enforced before migration
		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);
		expect(() => {
			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			).run('agent-1', 'space-1', 'My Agent', 'custom-role', now, now);
		}).toThrow(/CHECK constraint failed/);

		// Now run migration 31 in isolation via full runMigrations
		// (it is idempotent for all other migrations)
		runMigrations(db, () => {});

		// CHECK constraint should be gone — custom roles now accepted
		expect(() => {
			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			).run('agent-custom', 'space-1', 'Custom Agent', 'custom-role', now, now);
		}).not.toThrow();

		const schema = getTableSchema(db, 'space_agents');
		expect(schema).not.toContain('CHECK(role IN');
	});

	test('legacy DB: existing agent rows are preserved after rebuild', () => {
		db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT, allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
				config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)
		`);
		db.exec(`
			CREATE TABLE space_agents (
				id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', model TEXT, provider TEXT,
				tools TEXT NOT NULL DEFAULT '[]', system_prompt TEXT NOT NULL DEFAULT '',
				role TEXT NOT NULL DEFAULT 'coder'
					CHECK(role IN ('planner', 'coder', 'general', 'reviewer')),
				config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace', 'S', now, now);
		db.prepare(
			`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('agent-1', 'space-1', 'Coder', 'coder', now, now);
		db.prepare(
			`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('agent-2', 'space-1', 'Planner', 'planner', now, now);

		runMigrations(db, () => {});

		const rows = db.prepare(`SELECT id, name, role FROM space_agents ORDER BY id`).all() as Array<{
			id: string;
			name: string;
			role: string;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: 'agent-1', name: 'Coder', role: 'coder' });
		expect(rows[1]).toMatchObject({ id: 'agent-2', name: 'Planner', role: 'planner' });
	});

	// -------------------------------------------------------------------------
	// Idempotency — already-migrated DB
	// -------------------------------------------------------------------------

	test('idempotency: running migration twice does not error or duplicate data', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace', 'S', now, now);
		db.prepare(
			`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('agent-1', 'space-1', 'Coder', 'coder', now, now);

		// Run migrations a second time — should be a no-op for migration 31
		expect(() => runMigrations(db, () => {})).not.toThrow();

		const rows = db.prepare(`SELECT id FROM space_agents`).all();
		expect(rows).toHaveLength(1);
	});
});
