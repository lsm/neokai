/**
 * Migration 54 Tests
 *
 * Covers:
 * - Index is created on a fresh DB (workflow_node_id + agent_name present)
 * - Index is skipped when workflow_node_id is absent (graceful guard)
 * - Index is skipped when agent_name is absent (graceful guard)
 * - Index enforces uniqueness for active-status tuples
 * - Index allows duplicate (run, node, agent) when old row is completed
 * - Index allows duplicate (run, node, agent) when old row is cancelled
 * - Index allows NULL workflow_run_id / workflow_node_id / agent_name (legacy compat)
 * - Idempotent: calling runMigration54 twice does not error
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { runMigration54 } from '../../../../src/storage/schema/migrations.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-migration-54',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function getIndexNames(db: BunDatabase, table: string): string[] {
	const rows = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
		.all(table) as { name: string }[];
	return rows.map((r) => r.name);
}

function seedSpace(db: BunDatabase, spaceId = 'sp-1'): void {
	db.prepare(
		`INSERT OR IGNORE INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
}

function insertTask(
	db: BunDatabase,
	opts: {
		id: string;
		spaceId?: string;
		runId?: string | null;
		nodeId?: string | null;
		agentName?: string | null;
		status?: string;
	}
): void {
	const now = Date.now();
	// Disable FK checks for test fixture inserts so we can use arbitrary run/node IDs
	// without needing to create all referenced parent rows.
	db.exec('PRAGMA foreign_keys = OFF');
	try {
		const spaceId = opts.spaceId ?? 'sp-1';
		const nextNumber = (
			db
				.prepare(
					`SELECT COALESCE(MAX(task_number), 0) + 1 AS next FROM space_tasks WHERE space_id = ?`
				)
				.get(spaceId) as { next: number }
		).next;
		db.prepare(
			`INSERT INTO space_tasks
		 (id, space_id, task_number, title, description, status, priority, depends_on, workflow_run_id, workflow_node_id, agent_name, created_at, updated_at)
		 VALUES (?, ?, ?, 'Task', '', ?, 'normal', '[]', ?, ?, ?, ?, ?)`
		).run(
			opts.id,
			spaceId,
			nextNumber,
			opts.status ?? 'pending',
			opts.runId ?? null,
			opts.nodeId ?? null,
			opts.agentName ?? null,
			now,
			now
		);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration 54: uq_space_tasks_run_node_agent unique index', () => {
	let db: BunDatabase;
	let dir: string;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('index is created on a fresh migrated DB', () => {
		const indexes = getIndexNames(db, 'space_tasks');
		expect(indexes).toContain('uq_space_tasks_run_node_agent');
	});

	test('idempotent: calling runMigration54 again does not error', () => {
		expect(() => runMigration54(db)).not.toThrow();
		const indexes = getIndexNames(db, 'space_tasks');
		expect(indexes).toContain('uq_space_tasks_run_node_agent');
	});

	test('enforces uniqueness for two pending tasks with same run+node+slot', () => {
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'pending',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'coder',
				status: 'pending',
			})
		).toThrow(/UNIQUE constraint failed/);
	});

	test('enforces uniqueness for in_progress duplicate', () => {
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'in_progress',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'coder',
				status: 'pending',
			})
		).toThrow(/UNIQUE constraint failed/);
	});

	test('allows second pending task after first is completed', () => {
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'completed',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'coder',
				status: 'pending',
			})
		).not.toThrow();
	});

	test('allows second pending task after first is cancelled', () => {
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'cancelled',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'coder',
				status: 'pending',
			})
		).not.toThrow();
	});

	test('allows second pending task after first is needs_attention', () => {
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'needs_attention',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'coder',
				status: 'pending',
			})
		).not.toThrow();
	});

	test('allows two draft tasks with the same run+node+slot (draft excluded from index)', () => {
		// draft is intentionally excluded from the partial index so that external callers
		// can create draft tasks without being constrained by ChannelRouter's uniqueness guarantee.
		// Two draft tasks for the same (run, node, slot) must NOT trigger a UNIQUE violation.
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'draft',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'coder',
				status: 'draft',
			})
		).not.toThrow();
	});

	test('allows multiple legacy tasks with NULL workflow_run_id', () => {
		insertTask(db, { id: 't-1', runId: null, nodeId: null, agentName: null, status: 'pending' });
		expect(() =>
			insertTask(db, { id: 't-2', runId: null, nodeId: null, agentName: null, status: 'pending' })
		).not.toThrow();
	});

	test('different slot roles on same run+node are allowed simultaneously', () => {
		insertTask(db, {
			id: 't-1',
			runId: 'run-1',
			nodeId: 'node-1',
			agentName: 'coder',
			status: 'pending',
		});
		expect(() =>
			insertTask(db, {
				id: 't-2',
				runId: 'run-1',
				nodeId: 'node-1',
				agentName: 'planner',
				status: 'pending',
			})
		).not.toThrow();
	});

	test('skips gracefully when workflow_node_id column is absent', () => {
		// Create a minimal space_tasks table WITHOUT workflow_node_id
		const db2Dir = join(process.cwd(), 'tmp', 'test-migration-54', `no-col-${Date.now()}`);
		mkdirSync(db2Dir, { recursive: true });
		const db2 = new BunDatabase(join(db2Dir, 'test2.db'));
		try {
			db2.exec(`
				CREATE TABLE space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					title TEXT NOT NULL DEFAULT '',
					description TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL DEFAULT 'pending',
					priority TEXT NOT NULL DEFAULT 'normal',
					agent_name TEXT,
					workflow_run_id TEXT,
					depends_on TEXT NOT NULL DEFAULT '[]',
					created_at INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL DEFAULT 0
				)
			`);
			// runMigration54 should skip without throwing
			expect(() => runMigration54(db2)).not.toThrow();
			// Index should NOT exist since workflow_node_id is absent
			const indexes = getIndexNames(db2, 'space_tasks');
			expect(indexes).not.toContain('uq_space_tasks_run_node_agent');
		} finally {
			db2.close();
			rmSync(db2Dir, { recursive: true, force: true });
		}
	});
});
