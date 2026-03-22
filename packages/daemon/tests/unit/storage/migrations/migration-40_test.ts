/**
 * Migration 40 Tests
 *
 * Tests for Migration 40: Flexible session groups.
 *
 * space_session_groups:
 *   - task_id TEXT (nullable) column added
 *   - status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed')) added
 *   - index on task_id added
 *
 * space_session_group_members:
 *   - role CHECK constraint dropped (freeform string)
 *   - agent_id TEXT (nullable) column added
 *   - status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed')) added
 *
 * Covers:
 * - Fresh DB (full migration chain): all columns exist
 * - New columns have correct defaults
 * - space_session_groups.status CHECK enforced ('active'/'completed'/'failed' only)
 * - space_session_group_members.status CHECK enforced
 * - space_session_group_members.role accepts any freeform string
 * - Existing data preserved after members table recreation
 * - Idempotency: running migrations twice does not error
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

function indexExists(db: BunDatabase, indexName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
		.get(indexName);
	return !!result;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 40: Flexible session groups', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-40', `test-${Date.now()}`);
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

	test('fresh DB: space_session_groups has task_id and status columns', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_session_groups', 'task_id')).toBe(true);
		expect(columnExists(db, 'space_session_groups', 'status')).toBe(true);
	});

	test('fresh DB: space_session_group_members has agent_id and status columns', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_session_group_members', 'agent_id')).toBe(true);
		expect(columnExists(db, 'space_session_group_members', 'status')).toBe(true);
	});

	test('fresh DB: idx_space_session_groups_task_id index exists', () => {
		runMigrations(db, () => {});
		expect(indexExists(db, 'idx_space_session_groups_task_id')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Defaults
	// -------------------------------------------------------------------------

	test('space_session_groups.status defaults to "active"', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/m40', 'M40 Space', now, now);
		db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('grp-1', 'space-1', 'Group 1', now, now);

		const row = db
			.prepare(`SELECT status, task_id FROM space_session_groups WHERE id = 'grp-1'`)
			.get() as { status: string; task_id: string | null };
		expect(row.status).toBe('active');
		expect(row.task_id).toBeNull();
	});

	test('space_session_group_members.status defaults to "active" and agent_id defaults to NULL', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-2', '/workspace/m40b', 'M40 Space B', now, now);
		db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('grp-2', 'space-2', 'Group 2', now, now);
		db.prepare(
			`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('mem-1', 'grp-2', 'sess-1', 'coder', 0, now);

		const row = db
			.prepare(`SELECT status, agent_id FROM space_session_group_members WHERE id = 'mem-1'`)
			.get() as { status: string; agent_id: string | null };
		expect(row.status).toBe('active');
		expect(row.agent_id).toBeNull();
	});

	// -------------------------------------------------------------------------
	// CHECK constraints
	// -------------------------------------------------------------------------

	test('space_session_groups.status CHECK rejects invalid values', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-3', '/workspace/m40c', 'M40 Space C', now, now);

		expect(() => {
			db.exec(
				`INSERT INTO space_session_groups (id, space_id, name, status, created_at, updated_at)
				 VALUES ('grp-bad', 'space-3', 'Bad Group', 'pending', ${now}, ${now})`
			);
		}).toThrow();
	});

	test('space_session_groups.status accepts valid values', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-4', '/workspace/m40d', 'M40 Space D', now, now);

		for (const [idx, status] of ['active', 'completed', 'failed'].entries()) {
			expect(() => {
				db.exec(
					`INSERT INTO space_session_groups (id, space_id, name, status, created_at, updated_at)
					 VALUES ('grp-${idx}', 'space-4', 'Group ${idx}', '${status}', ${now}, ${now})`
				);
			}).not.toThrow();
		}
	});

	test('space_session_group_members.status CHECK rejects invalid values', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-5', '/workspace/m40e', 'M40 Space E', now, now);
		db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('grp-5', 'space-5', 'Group 5', now, now);

		expect(() => {
			db.exec(
				`INSERT INTO space_session_group_members (id, group_id, session_id, role, status, order_index, created_at)
				 VALUES ('mem-bad', 'grp-5', 'sess-bad', 'coder', 'pending', 0, ${now})`
			);
		}).toThrow();
	});

	// -------------------------------------------------------------------------
	// Freeform role (CHECK constraint dropped)
	// -------------------------------------------------------------------------

	test('space_session_group_members.role accepts any freeform string', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-6', '/workspace/m40f', 'M40 Space F', now, now);
		db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('grp-6', 'space-6', 'Group 6', now, now);

		for (const [idx, role] of [
			'worker',
			'leader',
			'observer',
			'security-auditor',
			'coder',
			'reviewer',
		].entries()) {
			expect(() => {
				db.exec(
					`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at)
					 VALUES ('mem-role-${idx}', 'grp-6', 'sess-role-${idx}', '${role}', ${idx}, ${now})`
				);
			}).not.toThrow();
		}
	});

	// -------------------------------------------------------------------------
	// Data preservation — existing rows survive the members table recreation
	// -------------------------------------------------------------------------

	test('existing member rows are preserved after migration', () => {
		// Simulate a pre-migration-40 state: create tables up to migration 29 schema
		// and insert rows, then run the full migration chain.
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
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		db.exec(`
			CREATE TABLE space_session_groups (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				workflow_run_id TEXT,
				current_step_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
		);
		db.exec(`
			CREATE TABLE space_session_group_members (
				id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL
					CHECK(role IN ('worker', 'leader')),
				order_index INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
				UNIQUE(group_id, session_id)
			)
		`);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
		);
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
		);

		const now = Date.now();
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES ('sp-legacy', '/workspace/legacy', 'Legacy Space', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at) VALUES ('grp-legacy', 'sp-legacy', 'Legacy Group', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at) VALUES ('mem-legacy-1', 'grp-legacy', 'sess-legacy-1', 'worker', 0, ${now})`
		);
		db.exec(
			`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at) VALUES ('mem-legacy-2', 'grp-legacy', 'sess-legacy-2', 'leader', 1, ${now})`
		);

		// Run full migration chain
		runMigrations(db, () => {});

		// Existing rows should still be present with original values
		const members = db
			.prepare(
				`SELECT id, role, order_index, status, agent_id FROM space_session_group_members WHERE group_id = 'grp-legacy' ORDER BY order_index`
			)
			.all() as Array<{
			id: string;
			role: string;
			order_index: number;
			status: string;
			agent_id: string | null;
		}>;

		expect(members).toHaveLength(2);
		expect(members[0].id).toBe('mem-legacy-1');
		expect(members[0].role).toBe('worker');
		expect(members[0].order_index).toBe(0);
		expect(members[0].status).toBe('active'); // default
		expect(members[0].agent_id).toBeNull(); // default

		expect(members[1].id).toBe('mem-legacy-2');
		expect(members[1].role).toBe('leader');
		expect(members[1].order_index).toBe(1);
		expect(members[1].status).toBe('active');
		expect(members[1].agent_id).toBeNull();
	});

	// -------------------------------------------------------------------------
	// Idempotency
	// -------------------------------------------------------------------------

	test('idempotency: running migrations twice does not error', () => {
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();
		expect(columnExists(db, 'space_session_groups', 'task_id')).toBe(true);
		expect(columnExists(db, 'space_session_groups', 'status')).toBe(true);
		expect(columnExists(db, 'space_session_group_members', 'agent_id')).toBe(true);
		expect(columnExists(db, 'space_session_group_members', 'status')).toBe(true);
	});
});
