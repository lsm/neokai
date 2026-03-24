/**
 * Migration 38 Tests
 *
 * Tests for Migration 38: Add is_cyclic column to space_workflow_transitions.
 *
 * Covers:
 * - Fresh DB (full migration chain): column exists
 * - Fresh DB: is_cyclic defaults to NULL (nullable INTEGER, no default)
 * - Fresh DB: is_cyclic can be set to 1
 * - Legacy DB path: column is added to an existing table that lacks it
 * - Idempotency: running migration twice does not error
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 38: Add is_cyclic to space_workflow_transitions', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-38', `test-${Date.now()}`);
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

	test('fresh DB: is_cyclic column exists after full migration', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_workflow_transitions', 'is_cyclic')).toBe(true);
	});

	test('fresh DB: is_cyclic defaults to NULL', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', now, now);
		db.prepare(
			`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-1', 'wf-1', 'Step A', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-2', 'wf-1', 'Step B', 1, now, now);
		db.prepare(
			`INSERT INTO space_workflow_transitions (id, workflow_id, from_node_id, to_node_id, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('trans-1', 'wf-1', 'step-1', 'step-2', 0, now, now);

		const row = db
			.prepare(`SELECT is_cyclic FROM space_workflow_transitions WHERE id = 'trans-1'`)
			.get() as { is_cyclic: number | null };
		expect(row.is_cyclic).toBeNull();
	});

	test('fresh DB: is_cyclic can be set to 1', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/project', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', now, now);
		db.prepare(
			`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-1', 'wf-1', 'Step A', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-2', 'wf-1', 'Step B', 1, now, now);
		db.prepare(
			`INSERT INTO space_workflow_transitions (id, workflow_id, from_node_id, to_node_id, is_cyclic, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run('trans-1', 'wf-1', 'step-1', 'step-2', 1, 0, now, now);

		const row = db
			.prepare(`SELECT is_cyclic FROM space_workflow_transitions WHERE id = 'trans-1'`)
			.get() as { is_cyclic: number | null };
		expect(row.is_cyclic).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Legacy DB path — simulate pre-migration-38 state without the column
	// -------------------------------------------------------------------------

	test('legacy DB: column is added to existing table that lacks it', () => {
		// Create prerequisite tables as they existed before migration 38
		// Note: M45 renames step→node columns/tables, so we include all tables M45 expects
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
		db.exec('CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)');
		db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			CREATE TABLE space_workflow_steps (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				agent_id TEXT,
				order_index INTEGER NOT NULL DEFAULT 0,
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			CREATE TABLE space_workflow_transitions (
				id TEXT PRIMARY KEY,
				workflow_id TEXT NOT NULL,
				from_step_id TEXT NOT NULL,
				to_step_id TEXT NOT NULL,
				condition TEXT,
				order_index INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			CREATE TABLE space_workflow_runs (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				workflow_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				current_step_index INTEGER NOT NULL DEFAULT 0,
				current_step_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT,
				assigned_agent TEXT,
				custom_agent_id TEXT,
				workflow_run_id TEXT,
				workflow_step_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
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
		db.exec(`
			CREATE TABLE space_session_groups (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				workflow_run_id TEXT,
				current_step_id TEXT,
				task_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
		db.exec(`
			CREATE TABLE space_session_group_members (
				id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				order_index INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE
			)
		`);

		// Confirm column is absent before migration
		expect(columnExists(db, 'space_workflow_transitions', 'is_cyclic')).toBe(false);

		// Run migrations
		runMigrations(db, () => {});

		// Column should now exist
		expect(columnExists(db, 'space_workflow_transitions', 'is_cyclic')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Idempotency — column already exists
	// -------------------------------------------------------------------------

	test('idempotency: running migration twice does not error', () => {
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();
		expect(columnExists(db, 'space_workflow_transitions', 'is_cyclic')).toBe(true);
	});
});
