/**
 * Migration 122 Tests — replace task-thread projection with schema fix.
 *
 * Migration 122 makes two schema-level moves:
 *   1. Adds derived columns (`is_renderable`, `is_terminal`, `parent_tool_use_id`)
 *      to `sdk_messages` and backfills them from existing rows. New rows are
 *      stamped at write time by the SDK message repository.
 *   2. Creates `task_session_map` — an explicit lookup that resolves a
 *      `space_task` to the set of sessions whose `sdk_messages` contribute to
 *      its task-thread timeline. Backfilled from `space_tasks.task_agent_session_id`
 *      (task_agent leg) and `node_executions.agent_session_id` joined with
 *      `space_tasks` via `workflow_run_id` (node_agent leg).
 *
 * Covers:
 *   - Fresh, fully-migrated DB — both new structures exist with the expected
 *     shape.
 *   - Pre-120 schema with rows — derived columns are computed correctly,
 *     parent_tool_use_id is extracted, task_session_map is fully populated.
 *   - Re-running the migration is a no-op (idempotent).
 *   - Empty / partial-table DB cases are guarded.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import {
	createTables,
	runMigration122,
	runMigrations,
} from '../../../../../src/storage/schema/index.ts';

function columnNames(db: BunDatabase, table: string): string[] {
	const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
	return rows.map((r) => r.name);
}

function tableExists(db: BunDatabase, table: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(table) as { name?: string } | undefined;
	return !!row?.name;
}

function indexExists(db: BunDatabase, name: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
		.get(name) as { name?: string } | undefined;
	return !!row?.name;
}

/**
 * Build the post-M117 / pre-M120 shape needed to exercise backfill: a minimal
 * `sessions`, `sdk_messages`, `space_tasks`, `node_executions`, and `space_agents`
 * surface that lets us seed rows and then assert the migration's effects.
 */
function seedPreM120Schema(db: BunDatabase): void {
	db.exec('PRAGMA foreign_keys = OFF');
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL DEFAULT 'worker',
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			config TEXT NOT NULL DEFAULT '{}',
			metadata TEXT NOT NULL DEFAULT '{}',
			title TEXT NOT NULL DEFAULT ''
		)
	`);
	db.exec(`
		CREATE TABLE sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT DEFAULT 'consumed',
			origin TEXT
		)
	`);
	db.exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_number INTEGER NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open',
			priority TEXT NOT NULL DEFAULT 'normal',
			labels TEXT NOT NULL DEFAULT '[]',
			workflow_run_id TEXT,
			task_agent_session_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE node_executions (
			id TEXT PRIMARY KEY,
			workflow_run_id TEXT NOT NULL,
			workflow_node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			agent_id TEXT,
			agent_session_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			data TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec('PRAGMA foreign_keys = ON');
}

describe('Migration 122: derived columns + task_session_map', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(
			process.cwd(),
			'tmp',
			'test-migration-122',
			`test-${Date.now()}-${Math.random()}`
		);
		mkdirSync(testDir, { recursive: true });
		db = new BunDatabase(join(testDir, 'test.db'));
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

	describe('fresh DB (all migrations applied)', () => {
		beforeEach(() => {
			runMigrations(db, () => {});
			createTables(db);
		});

		test('sdk_messages has the new derived columns', () => {
			const columns = columnNames(db, 'sdk_messages');
			expect(columns).toContain('is_renderable');
			expect(columns).toContain('is_terminal');
			expect(columns).toContain('parent_tool_use_id');
		});

		test('task_session_map table exists with expected columns', () => {
			expect(tableExists(db, 'task_session_map')).toBe(true);
			const cols = columnNames(db, 'task_session_map');
			expect(cols).toEqual(
				expect.arrayContaining([
					'task_id',
					'session_id',
					'kind',
					'role',
					'label',
					'node_execution_id',
					'created_at',
				])
			);
		});

		test('task_session_map(session_id) index exists', () => {
			expect(indexExists(db, 'idx_task_session_map_session')).toBe(true);
		});

		test('sdk_messages new indexes exist', () => {
			expect(indexExists(db, 'idx_sdk_messages_parent_tool_use_id')).toBe(true);
			expect(indexExists(db, 'idx_sdk_messages_renderable_terminal')).toBe(true);
		});

		test('task_session_map is empty on a fresh DB with no tasks', () => {
			const row = db.prepare(`SELECT COUNT(*) AS n FROM task_session_map`).get() as { n: number };
			expect(row.n).toBe(0);
		});
	});

	describe('backfill from pre-120 schema', () => {
		beforeEach(() => {
			seedPreM120Schema(db);
			const now = Date.now();
			const ts = new Date(now).toISOString();

			// Sessions: one Task Agent, two node-agent sessions.
			db.prepare(
				`INSERT INTO sessions (id, type, created_at, last_active_at) VALUES (?, ?, ?, ?)`
			).run('sess-task-agent', 'space_task_agent', ts, ts);
			db.prepare(
				`INSERT INTO sessions (id, type, created_at, last_active_at) VALUES (?, ?, ?, ?)`
			).run('sess-coder', 'coder', ts, ts);
			db.prepare(
				`INSERT INTO sessions (id, type, created_at, last_active_at) VALUES (?, ?, ?, ?)`
			).run('sess-reviewer', 'general', ts, ts);

			// Space agent for label resolution.
			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			).run('agent-coder', 'sp-1', 'Coder Agent', now, now);

			// Task with both legs: a Task Agent session and node executions on a workflow run.
			db.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, title, workflow_run_id, task_agent_session_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).run('task-1', 'sp-1', 1, 'Task 1', 'run-1', 'sess-task-agent', now, now);

			// Task without workflow run — should still get its task_agent leg.
			db.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, title, task_agent_session_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).run('task-2', 'sp-1', 2, 'Task 2', 'sess-task-agent', now, now);

			// Node executions — one with agent_id (label from space_agents), one without (fallback to agent_name).
			db.prepare(
				`INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, agent_session_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).run('ne-1', 'run-1', 'node-coder', 'coder', 'agent-coder', 'sess-coder', now, now);
			db.prepare(
				`INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, agent_session_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).run('ne-2', 'run-1', 'node-reviewer', 'reviewer', null, 'sess-reviewer', now, now);

			// Node execution without a session — must NOT appear in the map.
			db.prepare(
				`INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, agent_session_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).run('ne-3', 'run-1', 'node-pending', 'pending', null, null, now, now);

			// SDK messages spanning all renderability classes.
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
			).run(
				'msg-result',
				'sess-coder',
				'result',
				JSON.stringify({ type: 'result', subtype: 'success' }),
				ts
			);
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
			).run(
				'msg-user-tool-result',
				'sess-coder',
				'user',
				JSON.stringify({
					type: 'user',
					message: { content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'ok' }] },
				}),
				ts
			);
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
			).run(
				'msg-user-text',
				'sess-coder',
				'user',
				JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
				ts
			);
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
			).run(
				'msg-assistant-text',
				'sess-coder',
				'assistant',
				JSON.stringify({
					type: 'assistant',
					message: { content: [{ type: 'text', text: 'response' }] },
				}),
				ts
			);
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
			).run(
				'msg-assistant-empty',
				'sess-coder',
				'assistant',
				JSON.stringify({
					type: 'assistant',
					message: { content: [{ type: 'text', text: '   ' }] },
				}),
				ts
			);
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
			).run(
				'msg-subagent',
				'sess-coder',
				'assistant',
				JSON.stringify({
					type: 'assistant',
					parent_tool_use_id: 'parent-tu-1',
					message: { content: [{ type: 'text', text: 'sub' }] },
				}),
				ts
			);
		});

		test('is_terminal is set to 1 for result messages and 0 elsewhere', () => {
			runMigration122(db);
			const rows = db
				.prepare(`SELECT id, is_terminal FROM sdk_messages ORDER BY id`)
				.all() as Array<{ id: string; is_terminal: number }>;
			const map = new Map(rows.map((r) => [r.id, r.is_terminal]));
			expect(map.get('msg-result')).toBe(1);
			expect(map.get('msg-user-text')).toBe(0);
			expect(map.get('msg-assistant-text')).toBe(0);
		});

		test('parent_tool_use_id is extracted from JSON', () => {
			runMigration122(db);
			const subagent = db
				.prepare(`SELECT parent_tool_use_id FROM sdk_messages WHERE id = ?`)
				.get('msg-subagent') as { parent_tool_use_id: string | null };
			expect(subagent.parent_tool_use_id).toBe('parent-tu-1');
			const plain = db
				.prepare(`SELECT parent_tool_use_id FROM sdk_messages WHERE id = ?`)
				.get('msg-user-text') as { parent_tool_use_id: string | null };
			expect(plain.parent_tool_use_id).toBeNull();
		});

		test('is_renderable=0 for user rows with tool_result content', () => {
			runMigration122(db);
			const row = db
				.prepare(`SELECT is_renderable FROM sdk_messages WHERE id = ?`)
				.get('msg-user-tool-result') as { is_renderable: number };
			expect(row.is_renderable).toBe(0);
		});

		test('is_renderable=0 for assistant rows with no renderable content', () => {
			runMigration122(db);
			const row = db
				.prepare(`SELECT is_renderable FROM sdk_messages WHERE id = ?`)
				.get('msg-assistant-empty') as { is_renderable: number };
			expect(row.is_renderable).toBe(0);
		});

		test('is_renderable=1 for normal user/assistant rows and result rows', () => {
			runMigration122(db);
			const ids = ['msg-user-text', 'msg-assistant-text', 'msg-result'];
			const placeholders = ids.map(() => '?').join(',');
			const rows = db
				.prepare(`SELECT id, is_renderable FROM sdk_messages WHERE id IN (${placeholders})`)
				.all(...ids) as Array<{ id: string; is_renderable: number }>;
			for (const row of rows) {
				expect(row.is_renderable).toBe(1);
			}
		});

		test('task_session_map seeds the task_agent leg for tasks with a Task Agent session', () => {
			runMigration122(db);
			const row = db
				.prepare(
					`SELECT task_id, session_id, kind, role, label, node_execution_id
					 FROM task_session_map
					 WHERE task_id = ? AND kind = 'task_agent'`
				)
				.get('task-1') as {
				task_id: string;
				session_id: string;
				kind: string;
				role: string;
				label: string;
				node_execution_id: string | null;
			};
			expect(row.session_id).toBe('sess-task-agent');
			expect(row.role).toBe('task-agent');
			expect(row.label).toBe('Task Agent');
			expect(row.node_execution_id).toBeNull();
		});

		test('task_session_map seeds the node_agent leg for every (task, session) pair on the run', () => {
			runMigration122(db);
			const rows = db
				.prepare(
					`SELECT task_id, session_id, kind, role, label, node_execution_id
					 FROM task_session_map
					 WHERE task_id = ? AND kind = 'node_agent'
					 ORDER BY session_id ASC`
				)
				.all('task-1') as Array<{
				task_id: string;
				session_id: string;
				kind: string;
				role: string;
				label: string;
				node_execution_id: string | null;
			}>;
			expect(rows).toEqual([
				{
					task_id: 'task-1',
					session_id: 'sess-coder',
					kind: 'node_agent',
					role: 'coder',
					label: 'Coder Agent',
					node_execution_id: 'ne-1',
				},
				{
					task_id: 'task-1',
					session_id: 'sess-reviewer',
					kind: 'node_agent',
					role: 'reviewer',
					label: 'reviewer',
					node_execution_id: 'ne-2',
				},
			]);
		});

		test('task_session_map skips node executions without an agent_session_id', () => {
			runMigration122(db);
			const orphan = db
				.prepare(`SELECT COUNT(*) AS n FROM task_session_map WHERE node_execution_id = ?`)
				.get('ne-3') as { n: number };
			expect(orphan.n).toBe(0);
		});

		test('task_session_map skips workflow-less tasks for node_agent leg but keeps task_agent leg', () => {
			runMigration122(db);
			const nodeRows = db
				.prepare(`SELECT COUNT(*) AS n FROM task_session_map WHERE task_id = ? AND kind = ?`)
				.get('task-2', 'node_agent') as { n: number };
			expect(nodeRows.n).toBe(0);
			const orchestrationRows = db
				.prepare(`SELECT COUNT(*) AS n FROM task_session_map WHERE task_id = ? AND kind = ?`)
				.get('task-2', 'task_agent') as { n: number };
			expect(orchestrationRows.n).toBe(1);
		});

		test('is idempotent — running a second time produces the same state', () => {
			runMigration122(db);
			const sdkBefore = db
				.prepare(
					`SELECT COUNT(*) AS n FROM sdk_messages WHERE is_renderable IS NOT NULL AND is_terminal IS NOT NULL`
				)
				.get() as { n: number };
			const mapBefore = (
				db.prepare(`SELECT COUNT(*) AS n FROM task_session_map`).get() as { n: number }
			).n;

			expect(() => runMigration122(db)).not.toThrow();

			const sdkAfter = db
				.prepare(
					`SELECT COUNT(*) AS n FROM sdk_messages WHERE is_renderable IS NOT NULL AND is_terminal IS NOT NULL`
				)
				.get() as { n: number };
			const mapAfter = (
				db.prepare(`SELECT COUNT(*) AS n FROM task_session_map`).get() as { n: number }
			).n;

			expect(sdkAfter.n).toBe(sdkBefore.n);
			expect(mapAfter).toBe(mapBefore);
		});
	});

	describe('missing tables — no-op guards', () => {
		test('runMigration122 on an empty DB does not throw and creates only task_session_map', () => {
			expect(() => runMigration122(db)).not.toThrow();
			expect(tableExists(db, 'task_session_map')).toBe(true);
			expect(tableExists(db, 'sdk_messages')).toBe(false);
		});

		test('runMigration122 with only sdk_messages adds derived columns and creates empty task_session_map', () => {
			db.exec(`
				CREATE TABLE sdk_messages (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					message_type TEXT NOT NULL,
					message_subtype TEXT,
					sdk_message TEXT NOT NULL,
					timestamp TEXT NOT NULL
				)
			`);
			expect(() => runMigration122(db)).not.toThrow();
			const cols = columnNames(db, 'sdk_messages');
			expect(cols).toContain('is_renderable');
			expect(cols).toContain('is_terminal');
			expect(cols).toContain('parent_tool_use_id');
			expect(tableExists(db, 'task_session_map')).toBe(true);
			expect(
				(db.prepare(`SELECT COUNT(*) AS n FROM task_session_map`).get() as { n: number }).n
			).toBe(0);
		});
	});
});
