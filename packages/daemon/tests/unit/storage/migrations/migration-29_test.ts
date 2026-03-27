/**
 * Migration 29 Tests
 *
 * Tests for Migration 29: Space system tables (consolidated from former migrations 29–32).
 *
 * Covers:
 * - All Space tables created correctly on a fresh DB (including space_workflow_transitions)
 * - space_agents has role/provider columns from the start (no CHECK constraint on role)
 * - space_workflows has start_node_id column from the start (renamed by M45)
 * - space_workflow_runs has current_node_id column from the start (renamed by M45)
 * - Migration is idempotent (runs twice without error)
 * - No existing tables are affected
 * - space_tasks has custom_agent_id, workflow_run_id, workflow_node_id columns from the start (renamed by M45)
 * - FK CASCADE deletes work: delete space → all child rows deleted
 * - space_tasks.workflow_run_id SET NULL on workflow run delete
 * - CHECK constraints are enforced (status, priority, etc.)
 * - Indexes are created
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(db: BunDatabase, name: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnExists(db: BunDatabase, table: string, column: string): boolean {
	const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return info.some((c) => c.name === column);
}

function indexExists(db: BunDatabase, name: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('Migration 29: Space system tables', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-29', `test-${Date.now()}`);
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
	// Table creation
	// -------------------------------------------------------------------------

	test('all Space tables are created after migration', () => {
		runMigrations(db, () => {});

		const expectedTables = [
			'spaces',
			'space_agents',
			'space_workflows',
			'space_workflow_nodes',
			'space_workflow_runs',
			'space_tasks',
		];
		// Note: space_session_groups and space_session_group_members were dropped by migration 60.

		for (const table of expectedTables) {
			expect(tableExists(db, table)).toBe(true);
		}
	});

	test('migration is idempotent — running twice does not throw', () => {
		runMigrations(db, () => {});
		expect(() => runMigrations(db, () => {})).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// space_tasks columns
	// -------------------------------------------------------------------------

	test('space_tasks has custom_agent_id column from the start', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_tasks', 'custom_agent_id')).toBe(true);
	});

	test('space_tasks has workflow_run_id column from the start', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_tasks', 'workflow_run_id')).toBe(true);
	});

	test('space_tasks has workflow_node_id column from the start', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_tasks', 'workflow_node_id')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// space_workflow_runs state tracking
	// -------------------------------------------------------------------------

	test('space_workflow_runs has all required workflow tracking columns', () => {
		runMigrations(db, () => {});

		const requiredCols = [
			'id',
			'space_id',
			'workflow_id',
			'title',
			'description',
			// Note: current_step_index and current_node_id were both dropped by migration 60.
			'status',
			'config',
			'created_at',
			'updated_at',
			'completed_at',
		];

		for (const col of requiredCols) {
			expect(columnExists(db, 'space_workflow_runs', col)).toBe(true);
		}

		// Confirm current_node_id and current_step_index were dropped by migration 60.
		expect(columnExists(db, 'space_workflow_runs', 'current_node_id')).toBe(false);
		expect(columnExists(db, 'space_workflow_runs', 'current_step_index')).toBe(false);
	});

	test('space_agents has role and provider columns with no CHECK constraint on role', () => {
		runMigrations(db, () => {});

		expect(columnExists(db, 'space_agents', 'role')).toBe(true);
		expect(columnExists(db, 'space_agents', 'provider')).toBe(true);

		// role accepts any string — no fixed enum
		const now = Date.now();
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-role', '/workspace/role', 'Role Space', ${now}, ${now})`
		);
		for (const role of ['custom-role', 'admin', 'leader', 'any-string']) {
			expect(() => {
				db.exec(
					`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at)
					 VALUES ('agent-${role}', 'sp-role', 'Agent', '${role}', ${now}, ${now})`
				);
			}).not.toThrow();
		}
	});

	test('space_workflows has start_node_id column', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_workflows', 'start_node_id')).toBe(true);
	});

	test('space_workflow_runs status CHECK constraint is enforced', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		// Insert a space first
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('s-1', '/workspace/a', 'Space A', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 's-1', 'Workflow 1', ${now}, ${now})`
		);

		// Valid status
		expect(() => {
			db.exec(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-ok', 's-1', 'wf-1', 'Run 1', 'in_progress', ${now}, ${now})`
			);
		}).not.toThrow();

		// Invalid status
		expect(() => {
			db.exec(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
				 VALUES ('wr-bad', 's-1', 'wf-1', 'Run 2', 'invalid_status', ${now}, ${now})`
			);
		}).toThrow();
	});

	// -------------------------------------------------------------------------
	// Indexes
	// -------------------------------------------------------------------------

	test('expected indexes are created', () => {
		runMigrations(db, () => {});

		const expectedIndexes = [
			'idx_spaces_status',
			// Note: idx_spaces_workspace_path is NOT created — workspace_path UNIQUE constraint
			// already creates an implicit index, so an explicit one would be redundant.
			'idx_space_agents_space_id',
			'idx_space_workflows_space_id',
			'idx_space_workflow_nodes_workflow_id',
			'idx_space_workflow_nodes_order',
			// Note: M60 rebuilt space_workflow_runs with updated index names.
			'idx_space_workflow_runs_space',
			'idx_space_workflow_runs_workflow',
			'idx_space_workflow_runs_status',
			'idx_space_tasks_space_id',
			'idx_space_tasks_status',
			'idx_space_tasks_workflow_run_id',
			'idx_space_tasks_workflow_node_id',
			'idx_space_tasks_custom_agent_id',
			// Note: idx_space_session_groups_* and idx_space_session_group_members_* indexes
			// were dropped along with those tables by migration 59.
		];

		for (const idx of expectedIndexes) {
			expect(indexExists(db, idx)).toBe(true);
		}
	});

	// -------------------------------------------------------------------------
	// CASCADE deletes: delete space → all child rows deleted
	// -------------------------------------------------------------------------

	test('deleting a space cascades to all child tables', () => {
		runMigrations(db, () => {});

		const now = Date.now();

		// Insert a space
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-1', '/workspace/cascade', 'Cascade Space', ${now}, ${now})`
		);

		// Insert a space agent
		db.exec(
			`INSERT INTO space_agents (id, space_id, name, role, created_at, updated_at)
			 VALUES ('agent-1', 'sp-1', 'Agent 1', 'coder', ${now}, ${now})`
		);

		// Insert a workflow
		db.exec(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 'sp-1', 'Workflow 1', ${now}, ${now})`
		);

		// Insert a workflow step
		db.exec(
			`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at)
			 VALUES ('step-1', 'wf-1', 'Step 1', 0, ${now}, ${now})`
		);

		// Insert a workflow run
		db.exec(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
			 VALUES ('wr-1', 'sp-1', 'wf-1', 'Run 1', ${now}, ${now})`
		);

		// Insert a task
		db.exec(
			`INSERT INTO space_tasks (id, space_id, title, created_at, updated_at)
			 VALUES ('task-1', 'sp-1', 'Task 1', ${now}, ${now})`
		);

		// Note: space_session_groups and space_session_group_members were dropped by migration 60.

		// Delete the space
		db.exec(`DELETE FROM spaces WHERE id = 'sp-1'`);

		// All child rows should be gone
		expect(db.prepare(`SELECT * FROM space_agents WHERE space_id = 'sp-1'`).all()).toHaveLength(0);
		expect(db.prepare(`SELECT * FROM space_workflows WHERE space_id = 'sp-1'`).all()).toHaveLength(
			0
		);
		expect(
			db.prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = 'wf-1'`).all()
		).toHaveLength(0);
		expect(
			db.prepare(`SELECT * FROM space_workflow_runs WHERE space_id = 'sp-1'`).all()
		).toHaveLength(0);
		expect(db.prepare(`SELECT * FROM space_tasks WHERE space_id = 'sp-1'`).all()).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// SET NULL on space_workflow_runs delete
	// -------------------------------------------------------------------------

	test('deleting a workflow run sets space_tasks.workflow_run_id to NULL', () => {
		runMigrations(db, () => {});

		const now = Date.now();

		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-2', '/workspace/setnull', 'SetNull Space', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-2', 'sp-2', 'Workflow 2', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at)
			 VALUES ('wr-2', 'sp-2', 'wf-2', 'Run 2', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_tasks (id, space_id, title, workflow_run_id, created_at, updated_at)
			 VALUES ('task-2', 'sp-2', 'Task 2', 'wr-2', ${now}, ${now})`
		);

		// Delete the workflow run
		db.exec(`DELETE FROM space_workflow_runs WHERE id = 'wr-2'`);

		// Task should still exist, but workflow_run_id should be NULL
		const task = db.prepare(`SELECT * FROM space_tasks WHERE id = 'task-2'`).get() as Record<
			string,
			unknown
		>;
		expect(task).toBeTruthy();
		expect(task['workflow_run_id']).toBeNull();
	});

	// -------------------------------------------------------------------------
	// CHECK constraints on space_tasks
	// -------------------------------------------------------------------------

	test('space_tasks status CHECK constraint is enforced', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-3', '/workspace/checks', 'Check Space', ${now}, ${now})`
		);

		// Valid status values
		for (const status of [
			'draft',
			'pending',
			'in_progress',
			'review',
			'completed',
			'needs_attention',
			'cancelled',
		]) {
			expect(() => {
				db.exec(
					`INSERT INTO space_tasks (id, space_id, title, status, created_at, updated_at)
					 VALUES ('t-${status}', 'sp-3', 'Task', '${status}', ${now}, ${now})`
				);
			}).not.toThrow();
		}

		// Invalid status
		expect(() => {
			db.exec(
				`INSERT INTO space_tasks (id, space_id, title, status, created_at, updated_at)
				 VALUES ('t-bad', 'sp-3', 'Task', 'invalid', ${now}, ${now})`
			);
		}).toThrow();
	});

	test('space_tasks priority CHECK constraint is enforced', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-4', '/workspace/priority', 'Priority Space', ${now}, ${now})`
		);

		expect(() => {
			db.exec(
				`INSERT INTO space_tasks (id, space_id, title, priority, created_at, updated_at)
				 VALUES ('t-urgent', 'sp-4', 'Task', 'urgent', ${now}, ${now})`
			);
		}).not.toThrow();

		expect(() => {
			db.exec(
				`INSERT INTO space_tasks (id, space_id, title, priority, created_at, updated_at)
				 VALUES ('t-bad-pri', 'sp-4', 'Task', 'extreme', ${now}, ${now})`
			);
		}).toThrow();
	});

	// Note: Tests for space_session_group_members role/status were removed because
	// space_session_groups and space_session_group_members tables were dropped by migration 60.

	// -------------------------------------------------------------------------
	// spaces workspace_path uniqueness
	// -------------------------------------------------------------------------

	test('spaces.workspace_path is unique', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-u1', '/workspace/unique', 'Space U1', ${now}, ${now})`
		);

		expect(() => {
			db.exec(
				`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
				 VALUES ('sp-u2', '/workspace/unique', 'Space U2', ${now}, ${now})`
			);
		}).toThrow();
	});

	// -------------------------------------------------------------------------
	// SET NULL on space_workflow_nodes delete
	// -------------------------------------------------------------------------

	test('deleting a workflow node sets space_tasks.workflow_node_id to NULL', () => {
		runMigrations(db, () => {});

		const now = Date.now();

		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-step', '/workspace/stepnull', 'StepNull Space', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-step', 'sp-step', 'Workflow Step', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_workflow_nodes (id, workflow_id, name, order_index, created_at, updated_at)
			 VALUES ('step-s1', 'wf-step', 'Step 1', 0, ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_tasks (id, space_id, title, workflow_node_id, created_at, updated_at)
			 VALUES ('task-step', 'sp-step', 'Task Step', 'step-s1', ${now}, ${now})`
		);

		// Delete the workflow node
		db.exec(`DELETE FROM space_workflow_nodes WHERE id = 'step-s1'`);

		// Task should still exist, but workflow_node_id should be NULL
		const task = db.prepare(`SELECT * FROM space_tasks WHERE id = 'task-step'`).get() as Record<
			string,
			unknown
		>;
		expect(task).toBeTruthy();
		expect(task['workflow_node_id']).toBeNull();
	});

	// Note: space_session_group_members uniqueness test removed because
	// space_session_group_members table was dropped by migration 60.

	// -------------------------------------------------------------------------
	// No existing tables affected
	// -------------------------------------------------------------------------

	test('no existing core tables are dropped or modified by migration 29', () => {
		runMigrations(db, () => {});

		// These tables are created by runMigrations / createTables and must still exist
		// after migration 29 runs. We just verify the migration itself doesn't drop them.
		// mission_metric_history and mission_executions were created in migration 28.
		const tablesFromEarlierMigrations = ['mission_metric_history', 'mission_executions'];

		for (const table of tablesFromEarlierMigrations) {
			expect(tableExists(db, table)).toBe(true);
		}
	});
});
