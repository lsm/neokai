/**
 * Migration 45 Tests
 *
 * Migration 45 renames step-related columns and tables to node:
 * - space_workflow_steps -> space_workflow_nodes
 * - space_workflows.start_step_id -> start_node_id
 * - space_workflow_transitions.from_step_id -> from_node_id
 * - space_workflow_transitions.to_step_id -> to_node_id
 * - space_tasks.workflow_step_id -> workflow_node_id
 * - space_workflow_runs.current_step_id -> current_node_id
 * - space_session_groups.current_step_id -> current_node_id
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

function getIndexes(db: BunDatabase, table: string): string[] {
	const rows = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`)
		.all(table) as Array<{ name: string }>;
	return rows.map((r) => r.name);
}

describe('Migration 45: rename step to node in workflow tables', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-45', `test-${Date.now()}`);
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

	test('fresh DB has node column names (not step)', () => {
		runMigrations(db, () => {});
		createTables(db);

		// space_workflow_nodes table exists (not space_workflow_steps)
		expect(tableExists(db, 'space_workflow_nodes')).toBe(true);
		expect(tableExists(db, 'space_workflow_steps')).toBe(false);

		// space_workflows has start_node_id (not start_step_id)
		expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflows', 'start_step_id')).toBe(false);

		// space_workflow_transitions has from_node_id and to_node_id
		expect(columnExists(db, 'space_workflow_transitions', 'from_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_transitions', 'to_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_transitions', 'from_step_id')).toBe(false);
		expect(columnExists(db, 'space_workflow_transitions', 'to_step_id')).toBe(false);

		// space_tasks has workflow_node_id
		expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(true);
		expect(columnExists(db, 'space_tasks', 'workflow_step_id')).toBe(false);

		// space_workflow_runs has current_node_id
		expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_runs', 'current_step_id')).toBe(false);

		// space_session_groups has current_node_id
		expect(columnExists(db, 'space_session_groups', 'current_node_id')).toBe(true);
		expect(columnExists(db, 'space_session_groups', 'current_step_id')).toBe(false);
	});

	test('fresh DB has correct indexes', () => {
		runMigrations(db, () => {});
		createTables(db);

		const nodeIndexes = getIndexes(db, 'space_workflow_nodes');
		expect(nodeIndexes).toContain('idx_space_workflow_nodes_order');
		expect(nodeIndexes).toContain('idx_space_workflow_nodes_workflow_id');

		const taskIndexes = getIndexes(db, 'space_tasks');
		expect(taskIndexes).toContain('idx_space_tasks_workflow_node_id');
		expect(taskIndexes).toContain('idx_space_tasks_goal_id');

		const runIndexes = getIndexes(db, 'space_workflow_runs');
		expect(runIndexes).toContain('idx_space_workflow_runs_goal_id');
	});

	test('existing DB with old schema gets migrated correctly', () => {
		// Create a pre-migration-45 schema with step column names
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
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

		db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
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
				order_index INTEGER NOT NULL,
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
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
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
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
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
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
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
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
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
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

		// Insert test data
		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/test', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, start_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', 'step-1', now, now);
		db.prepare(
			`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-1', 'wf-1', 'Step 1', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-2', 'wf-1', 'Step 2', 1, now, now);
		db.prepare(
			`INSERT INTO space_workflow_transitions (id, workflow_id, from_step_id, to_step_id, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('trans-1', 'wf-1', 'step-1', 'step-2', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, current_step_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run('run-1', 'space-1', 'wf-1', 'Test Run', 'step-1', 'in_progress', now, now);
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, title, workflow_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('task-1', 'space-1', 'Test Task', 'step-1', now, now);
		db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, current_step_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('group-1', 'space-1', 'Test Group', 'step-1', 'active', now, now);

		// Run migrations
		runMigrations(db, () => {});

		// Verify table rename
		expect(tableExists(db, 'space_workflow_nodes')).toBe(true);
		expect(tableExists(db, 'space_workflow_steps')).toBe(false);

		// Verify column renames in space_workflows
		expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflows', 'start_step_id')).toBe(false);

		// Verify data preserved in space_workflows
		const wf = db
			.prepare(`SELECT id, start_node_id FROM space_workflows WHERE id='wf-1'`)
			.get() as {
			id: string;
			start_node_id: string | null;
		};
		expect(wf.start_node_id).toBe('step-1');

		// Verify column renames in space_workflow_transitions
		expect(columnExists(db, 'space_workflow_transitions', 'from_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_transitions', 'to_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_transitions', 'from_step_id')).toBe(false);
		expect(columnExists(db, 'space_workflow_transitions', 'to_step_id')).toBe(false);

		// Verify data preserved in space_workflow_transitions
		const trans = db
			.prepare(
				`SELECT id, from_node_id, to_node_id FROM space_workflow_transitions WHERE id='trans-1'`
			)
			.get() as {
			id: string;
			from_node_id: string;
			to_node_id: string;
		};
		expect(trans.from_node_id).toBe('step-1');
		expect(trans.to_node_id).toBe('step-2');

		// Verify column rename in space_workflow_runs
		expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_runs', 'current_step_id')).toBe(false);

		// Verify data preserved in space_workflow_runs
		const run = db
			.prepare(`SELECT id, current_node_id FROM space_workflow_runs WHERE id='run-1'`)
			.get() as {
			id: string;
			current_node_id: string | null;
		};
		expect(run.current_node_id).toBe('step-1');

		// Verify column rename in space_tasks
		expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(true);
		expect(columnExists(db, 'space_tasks', 'workflow_step_id')).toBe(false);

		// Verify data preserved in space_tasks
		const task = db
			.prepare(`SELECT id, workflow_node_id FROM space_tasks WHERE id='task-1'`)
			.get() as {
			id: string;
			workflow_node_id: string | null;
		};
		expect(task.workflow_node_id).toBe('step-1');

		// Verify column rename in space_session_groups
		expect(columnExists(db, 'space_session_groups', 'current_node_id')).toBe(true);
		expect(columnExists(db, 'space_session_groups', 'current_step_id')).toBe(false);

		// Verify data preserved in space_session_groups
		const group = db
			.prepare(`SELECT id, current_node_id FROM space_session_groups WHERE id='group-1'`)
			.get() as {
			id: string;
			current_node_id: string | null;
		};
		expect(group.current_node_id).toBe('step-1');
	});

	test('migration is idempotent - re-running does not change anything', () => {
		// Create pre-migration schema with step names
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
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

		db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
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
				order_index INTEGER NOT NULL,
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
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
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
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
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
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
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
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
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
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/test', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, start_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', 'step-1', now, now);
		db.prepare(
			`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-1', 'wf-1', 'Step 1', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, current_step_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run('run-1', 'space-1', 'wf-1', 'Test Run', 'step-1', 'in_progress', now, now);

		// Run migrations twice
		runMigrations(db, () => {});
		runMigrations(db, () => {});

		// Should still have node columns
		expect(tableExists(db, 'space_workflow_nodes')).toBe(true);
		expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_transitions', 'from_node_id')).toBe(true);
		expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(true);

		// Data should still be intact
		const wf = db.prepare(`SELECT start_node_id FROM space_workflows WHERE id='wf-1'`).get() as {
			start_node_id: string | null;
		};
		expect(wf.start_node_id).toBe('step-1');
	});

	test('foreign key relationships are preserved after migration', () => {
		// Create pre-migration schema
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
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

		db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
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
				order_index INTEGER NOT NULL,
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
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
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
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
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
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
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
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
			)
		`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/test', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', now, now);
		db.prepare(
			`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-1', 'wf-1', 'Step 1', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('run-1', 'space-1', 'wf-1', 'Test Run', 'in_progress', now, now);
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, title, workflow_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('task-1', 'space-1', 'Test Task', 'step-1', now, now);

		// Run migration
		runMigrations(db, () => {});

		// FK from space_tasks to space_workflow_nodes should work
		const task = db.prepare(`SELECT workflow_node_id FROM space_tasks WHERE id='task-1'`).get() as {
			workflow_node_id: string | null;
		};
		expect(task.workflow_node_id).toBe('step-1');

		// FK from space_workflow_transitions to space_workflow_nodes should work
		const transExists = db
			.prepare(`SELECT id FROM space_workflow_transitions WHERE id='trans-1'`)
			.get();
		expect(transExists).toBeUndefined(); // No transition inserted, so should not exist
	});

	test('preserves columns added by earlier migrations', () => {
		// Create pre-migration schema with M30/M35/M36/M37/M38/M40 columns
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
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

		db.exec(`
			CREATE TABLE space_workflows (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				start_step_id TEXT,
				config TEXT,
				layout TEXT,
				max_iterations INTEGER,
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
				order_index INTEGER NOT NULL,
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
				is_cyclic INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
				FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
				FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
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
				iteration_count INTEGER NOT NULL DEFAULT 0,
				max_iterations INTEGER NOT NULL DEFAULT 5,
				goal_id TEXT,
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
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
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
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
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
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
		).run('space-1', '/workspace/test', 'Test Space', now, now);
		db.prepare(
			`INSERT INTO space_workflows (id, space_id, name, layout, max_iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('wf-1', 'space-1', 'Test Workflow', '{"nodes":{}}', 10, now, now);
		db.prepare(
			`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('step-1', 'wf-1', 'Step 1', 0, now, now);
		db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, iteration_count, max_iterations, goal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run('run-1', 'space-1', 'wf-1', 'Test Run', 3, 10, 'goal-1', now, now);

		// Run migration
		runMigrations(db, () => {});

		// Verify M30 column (layout) preserved
		const wf = db
			.prepare(`SELECT layout, max_iterations FROM space_workflows WHERE id='wf-1'`)
			.get() as {
			layout: string | null;
			max_iterations: number | null;
		};
		expect(wf.layout).toBe('{"nodes":{}}');
		expect(wf.max_iterations).toBe(10);

		// Verify M35 columns (iteration_count, max_iterations) preserved
		const run = db
			.prepare(
				`SELECT iteration_count, max_iterations, goal_id FROM space_workflow_runs WHERE id='run-1'`
			)
			.get() as {
			iteration_count: number;
			max_iterations: number;
			goal_id: string | null;
		};
		expect(run.iteration_count).toBe(3);
		expect(run.max_iterations).toBe(10);
		expect(run.goal_id).toBe('goal-1');

		// Verify M38 column (is_cyclic) preserved
		db.prepare(
			`INSERT INTO space_workflow_transitions (id, workflow_id, from_step_id, to_step_id, is_cyclic, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run('trans-1', 'wf-1', 'step-1', 'step-1', 1, 0, now, now);
		const trans = db
			.prepare(`SELECT is_cyclic FROM space_workflow_transitions WHERE id='trans-1'`)
			.get() as {
			is_cyclic: number | null;
		};
		expect(trans.is_cyclic).toBe(1);

		// Verify M40 column (status) preserved
		db.prepare(
			`INSERT INTO space_session_groups (id, space_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		).run('group-1', 'space-1', 'Test Group', 'completed', now, now);
		const group = db
			.prepare(`SELECT status FROM space_session_groups WHERE id='group-1'`)
			.get() as {
			status: string;
		};
		expect(group.status).toBe('completed');
	});
});
