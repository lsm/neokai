/**
 * Migration 29 Tests
 *
 * Tests for Migration 29: Space system tables.
 *
 * Covers:
 * - All Space tables created correctly on a fresh DB
 * - Migration is idempotent (runs twice without error)
 * - No existing tables are affected
 * - space_tasks has custom_agent_id, workflow_run_id, workflow_step_id columns from the start
 * - space_workflow_runs tracks workflow execution state
 * - FK CASCADE deletes work: delete space → all child rows deleted
 * - space_tasks.workflow_run_id SET NULL on workflow run delete
 * - CHECK constraints are enforced (status, priority, role, etc.)
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
			'space_workflow_steps',
			'space_workflow_runs',
			'space_tasks',
			'space_session_groups',
			'space_session_group_members',
		];

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

	test('space_tasks has workflow_step_id column from the start', () => {
		runMigrations(db, () => {});
		expect(columnExists(db, 'space_tasks', 'workflow_step_id')).toBe(true);
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
			'current_step_index',
			'status',
			'config',
			'created_at',
			'updated_at',
			'completed_at',
		];

		for (const col of requiredCols) {
			expect(columnExists(db, 'space_workflow_runs', col)).toBe(true);
		}
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
			'idx_spaces_workspace_path',
			'idx_space_agents_space_id',
			'idx_space_workflows_space_id',
			'idx_space_workflow_steps_workflow_id',
			'idx_space_workflow_steps_order',
			'idx_space_workflow_runs_space_id',
			'idx_space_workflow_runs_workflow_id',
			'idx_space_workflow_runs_status',
			'idx_space_tasks_space_id',
			'idx_space_tasks_status',
			'idx_space_tasks_workflow_run_id',
			'idx_space_tasks_custom_agent_id',
			'idx_space_session_groups_space_id',
			'idx_space_session_group_members_group_id',
			'idx_space_session_group_members_session_id',
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
			`INSERT INTO space_agents (id, space_id, name, created_at, updated_at)
			 VALUES ('agent-1', 'sp-1', 'Agent 1', ${now}, ${now})`
		);

		// Insert a workflow
		db.exec(
			`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 'sp-1', 'Workflow 1', ${now}, ${now})`
		);

		// Insert a workflow step
		db.exec(
			`INSERT INTO space_workflow_steps (id, workflow_id, name, order_index, created_at, updated_at)
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

		// Insert a session group
		db.exec(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at)
			 VALUES ('sg-1', 'sp-1', 'Group 1', ${now}, ${now})`
		);

		// Insert a session group member
		db.exec(
			`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at)
			 VALUES ('sgm-1', 'sg-1', 'sess-1', 'worker', 0, ${now})`
		);

		// Delete the space
		db.exec(`DELETE FROM spaces WHERE id = 'sp-1'`);

		// All child rows should be gone
		expect(db.prepare(`SELECT * FROM space_agents WHERE space_id = 'sp-1'`).all()).toHaveLength(0);
		expect(db.prepare(`SELECT * FROM space_workflows WHERE space_id = 'sp-1'`).all()).toHaveLength(
			0
		);
		expect(
			db.prepare(`SELECT * FROM space_workflow_steps WHERE workflow_id = 'wf-1'`).all()
		).toHaveLength(0);
		expect(
			db.prepare(`SELECT * FROM space_workflow_runs WHERE space_id = 'sp-1'`).all()
		).toHaveLength(0);
		expect(db.prepare(`SELECT * FROM space_tasks WHERE space_id = 'sp-1'`).all()).toHaveLength(0);
		expect(
			db.prepare(`SELECT * FROM space_session_groups WHERE space_id = 'sp-1'`).all()
		).toHaveLength(0);
		expect(
			db.prepare(`SELECT * FROM space_session_group_members WHERE group_id = 'sg-1'`).all()
		).toHaveLength(0);
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

	// -------------------------------------------------------------------------
	// space_session_group_members role CHECK
	// -------------------------------------------------------------------------

	test('space_session_group_members role CHECK constraint is enforced', () => {
		runMigrations(db, () => {});

		const now = Date.now();
		db.exec(
			`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-5', '/workspace/roles', 'Role Space', ${now}, ${now})`
		);
		db.exec(
			`INSERT INTO space_session_groups (id, space_id, name, created_at, updated_at)
			 VALUES ('sg-5', 'sp-5', 'Group 5', ${now}, ${now})`
		);

		// Valid roles
		for (const role of ['worker', 'leader']) {
			expect(() => {
				db.exec(
					`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at)
					 VALUES ('sgm-${role}', 'sg-5', 'sess-${role}', '${role}', 0, ${now})`
				);
			}).not.toThrow();
		}

		// Invalid role
		expect(() => {
			db.exec(
				`INSERT INTO space_session_group_members (id, group_id, session_id, role, order_index, created_at)
				 VALUES ('sgm-bad', 'sg-5', 'sess-bad', 'observer', 0, ${now})`
			);
		}).toThrow();
	});

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
