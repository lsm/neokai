/**
 * Integration tests for the db-query MCP server using the full NeoKai schema.
 *
 * Unlike the unit tests in tools.test.ts which use a minimal hand-crafted schema,
 * these tests create a complete in-memory database using the real `createTables()`
 * and `runMigrations()` functions, ensuring scope enforcement works correctly
 * against the actual production schema (all column constraints, FK dependencies,
 * and migration-applied changes).
 *
 * Tests cover:
 *   - Room scope: query room tables, indirect scope, cross-scope join rejection
 *   - Space scope: query space tables, indirect scope via workflow runs, gate_data
 *   - Global scope: query global tables, sensitive table rejection
 *   - Cross-scope join prevention (tasks JOIN space_tasks rejected for room scope)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../src/storage/schema/index.ts';
import { createDbQueryToolHandlers } from '../../../src/lib/db-query/tools.ts';

// ── Full-Schema DB Factory ─────────────────────────────────────────────────────

/**
 * Create a fresh in-memory database with the complete NeoKai production schema.
 * Runs migrations first (which create many tables), then createTables (which adds
 * any remaining tables via IF NOT EXISTS).
 */
function createFullSchemaDb(): Database {
	const db = new Database(':memory:');
	runMigrations(db, () => {});
	createTables(db);
	return db;
}

// ── Seed helpers ───────────────────────────────────────────────────────────────
// All INSERT statements use INSERT OR IGNORE so seed helpers can be called
// multiple times without primary-key collision errors.

function seedRooms(db: Database): void {
	db.exec(
		"INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('room-int-1', 'Integration Room 1', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('room-int-2', 'Integration Room 2', 2000, 2000)"
	);
}

function seedTasks(db: Database): void {
	seedRooms(db);
	db.exec(
		"INSERT OR IGNORE INTO tasks (id, room_id, title, description, created_at) VALUES ('task-int-1', 'room-int-1', 'Integration Task 1', '', 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, created_at) VALUES ('task-int-2', 'room-int-1', 'Integration Task 2', '', 'in_progress', 2000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO tasks (id, room_id, title, description, created_at) VALUES ('task-int-3', 'room-int-2', 'Integration Task 3', '', 3000)"
	);
}

function seedGoals(db: Database): void {
	seedRooms(db);
	db.exec(
		"INSERT OR IGNORE INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal-int-1', 'room-int-1', 'Goal Int 1', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal-int-2', 'room-int-1', 'Goal Int 2', 2000, 2000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal-int-3', 'room-int-2', 'Goal Int 3', 3000, 3000)"
	);
}

function seedMissionExecutions(db: Database): void {
	seedGoals(db);
	// goal-int-1 and goal-int-2 belong to room-int-1; goal-int-3 to room-int-2.
	// The partial unique index `idx_mission_executions_one_running` prevents
	// more than one 'running' execution per goal, so we vary statuses here.
	db.exec(
		"INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-1', 'goal-int-1', 1, 'running')"
	);
	db.exec(
		"INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-2', 'goal-int-1', 2, 'completed')"
	);
	db.exec(
		"INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-3', 'goal-int-2', 1, 'completed')"
	);
	db.exec(
		"INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-4', 'goal-int-3', 1, 'running')"
	);
}

function seedSpaces(db: Database): void {
	// spaces.slug is NOT NULL (added in migration 63)
	db.exec(
		"INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('space-int-1', 'space-int-1', '/tmp/space-int-1', 'Space Int 1', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('space-int-2', 'space-int-2', '/tmp/space-int-2', 'Space Int 2', 2000, 2000)"
	);
}

function seedSpaceTasks(db: Database): void {
	seedSpaces(db);
	// space-int-1 has 2 tasks; space-int-2 has 1 task.
	// space_tasks.task_number is NOT NULL (added in migration 62).
	db.exec(
		"INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, created_at, updated_at) VALUES ('stask-int-1', 'space-int-1', 1, 'Space Task 1', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, status, created_at, updated_at) VALUES ('stask-int-2', 'space-int-1', 2, 'Space Task 2', 'in_progress', 2000, 2000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, created_at, updated_at) VALUES ('stask-int-3', 'space-int-2', 1, 'Space Task 3', 3000, 3000)"
	);
}

function seedSpaceWorkflows(db: Database): void {
	seedSpaces(db);
	db.exec(
		"INSERT OR IGNORE INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('swf-int-1', 'space-int-1', 'Workflow Int 1', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('swf-int-2', 'space-int-2', 'Workflow Int 2', 2000, 2000)"
	);
}

function seedSpaceWorkflowRuns(db: Database): void {
	seedSpaceWorkflows(db);
	// swfr-int-1 and swfr-int-2 belong to space-int-1; swfr-int-3 to space-int-2.
	db.exec(
		"INSERT OR IGNORE INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES ('swfr-int-1', 'space-int-1', 'swf-int-1', 'Run Int 1', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES ('swfr-int-2', 'space-int-1', 'swf-int-1', 'Run Int 2', 2000, 2000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES ('swfr-int-3', 'space-int-2', 'swf-int-2', 'Run Int 3', 3000, 3000)"
	);
}

function seedGateData(db: Database): void {
	seedSpaceWorkflowRuns(db);
	// Gate data references space_workflow_runs; scope is determined via the run's space_id.
	// swfr-int-1 → space-int-1, swfr-int-2 → space-int-1, swfr-int-3 → space-int-2.
	db.exec(
		"INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('swfr-int-1', 'gate-a', '{\"approved\":true}', 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('swfr-int-2', 'gate-a', '{\"approved\":false}', 2000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('swfr-int-3', 'gate-b', '{\"approved\":true}', 3000)"
	);
}

function seedRoomGithubMappings(db: Database): void {
	seedRooms(db);
	db.exec(
		"INSERT OR IGNORE INTO room_github_mappings (id, room_id, repositories, created_at, updated_at) VALUES ('rgm-int-1', 'room-int-1', '[\"owner/repo1\"]', 1000, 1000)"
	);
	db.exec(
		"INSERT OR IGNORE INTO room_github_mappings (id, room_id, repositories, created_at, updated_at) VALUES ('rgm-int-2', 'room-int-2', '[\"owner/repo2\"]', 2000, 2000)"
	);
}

// ── Parse helper ──────────────────────────────────────────────────────────────

function parseResult(result: {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}) {
	const text = result.content[0].text;
	try {
		return { ...JSON.parse(text), isError: result.isError };
	} catch {
		return { raw: text, isError: result.isError };
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('db-query integration', () => {
	let db: Database;

	beforeEach(() => {
		db = createFullSchemaDb();
	});

	afterEach(() => {
		db.close();
	});

	// ── Room scope ──────────────────────────────────────────────────────────────

	describe('room scope', () => {
		it('can query tasks filtered to the specified room_id', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(2);
			for (const row of parsed.rows) {
				expect(row.room_id).toBe('room-int-1');
			}
		});

		it('task rows do not include the blacklisted restrictions column', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			for (const row of parsed.rows) {
				expect(row).not.toHaveProperty('restrictions');
			}
		});

		it('can query goals filtered to the specified room_id', async () => {
			seedGoals(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id, title FROM goals' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(2);
			const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
			expect(ids).toEqual(['goal-int-1', 'goal-int-2']);
		});

		it('goals not in the scoped room are excluded', async () => {
			seedGoals(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-2' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id FROM goals' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('goal-int-3');
		});

		it('can query mission_executions filtered via goals indirect scope', async () => {
			seedMissionExecutions(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id, goal_id FROM mission_executions' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// goal-int-1 (room-int-1): exec-int-1, exec-int-2
			// goal-int-2 (room-int-1): exec-int-3
			// goal-int-3 (room-int-2): exec-int-4 — excluded
			expect(parsed.rows).toHaveLength(3);
			const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
			expect(ids).toEqual(['exec-int-1', 'exec-int-2', 'exec-int-3']);
		});

		it('mission_executions from other rooms are excluded via indirect scope', async () => {
			seedMissionExecutions(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-2' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id FROM mission_executions' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('exec-int-4');
		});

		it('can query room_github_mappings filtered to the specified room_id', async () => {
			seedRoomGithubMappings(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT id, room_id FROM room_github_mappings',
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('rgm-int-1');
		});

		it('can JOIN tasks and goals (both room-scoped) with scope filter applied', async () => {
			seedTasks(db);
			seedGoals(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT tasks.id AS task_id, goals.id AS goal_id FROM tasks JOIN goals ON tasks.room_id = goals.room_id',
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// room-int-1 has 2 tasks × 2 goals = 4 cross-join rows
			expect(parsed.rows).toHaveLength(4);
		});

		it('cannot query space-scoped table space_tasks — rejected with scope error', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('cannot query space-scoped table space_workflows — rejected with scope error', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflows' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('cannot query sensitive table auth_config — rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM auth_config' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('cannot query sensitive table global_settings — rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM global_settings' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('cross-scope JOIN tasks with space_tasks is rejected for room scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT * FROM tasks JOIN space_tasks ON tasks.id = space_tasks.id',
			});

			expect(result.isError).toBe(true);
			// space_tasks is not in room scope
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('parameterized query with ? placeholder filters correctly in room scope', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT id FROM tasks WHERE status = ?',
				params: ['in_progress'],
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('task-int-2');
		});

		it('COUNT aggregate returns correct count for scoped room', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows[0].cnt).toBe(2);
		});

		it('GROUP BY status works in room scope with full schema', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status ORDER BY status',
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(2);
			const statuses = parsed.rows.map((r: Record<string, unknown>) => r.status).sort();
			expect(statuses).toEqual(['in_progress', 'pending']);
		});

		it('ORDER BY and LIMIT work in room scope with full schema', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1',
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			// task-int-2 has later created_at=2000 vs task-int-1=1000
			expect(parsed.rows[0].id).toBe('task-int-2');
		});

		it('db_list_tables shows room-scoped tables only (no space or global tables)', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_list_tables();
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// parsed.tables is an array of string table names
			expect(parsed.tables).toContain('tasks');
			expect(parsed.tables).toContain('goals');
			expect(parsed.tables).toContain('mission_executions');
			// Space-scoped tables must NOT appear
			expect(parsed.tables).not.toContain('space_tasks');
			expect(parsed.tables).not.toContain('space_workflows');
			// Sensitive tables must NOT appear
			expect(parsed.tables).not.toContain('auth_config');
			expect(parsed.tables).not.toContain('global_settings');
		});

		it('db_describe_table works for tasks table in room scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_describe_table({ table_name: 'tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.description).toContain('tasks');
			// restrictions column is blacklisted — should not appear
			expect(parsed.description).not.toContain('| restrictions |');
		});

		it('db_describe_table rejects out-of-scope space_tasks in room scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_describe_table({ table_name: 'space_tasks' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});
	});

	// ── Space scope ─────────────────────────────────────────────────────────────

	describe('space scope', () => {
		it('can query space_tasks filtered to the specified space_id', async () => {
			seedSpaceTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(2);
			for (const row of parsed.rows) {
				expect(row.space_id).toBe('space-int-1');
			}
		});

		it('space_tasks from other spaces are excluded', async () => {
			seedSpaceTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-2' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id FROM space_tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('stask-int-3');
		});

		it('can query space_workflows filtered to the specified space_id', async () => {
			seedSpaceWorkflows(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id, name FROM space_workflows' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('swf-int-1');
		});

		it('space_workflows blacklisted columns (config, gates, channels) are excluded', async () => {
			seedSpaceWorkflows(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflows' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			for (const row of parsed.rows) {
				expect(row).not.toHaveProperty('config');
				expect(row).not.toHaveProperty('gates');
				expect(row).not.toHaveProperty('channels');
				expect(row).toHaveProperty('id');
				expect(row).toHaveProperty('name');
			}
		});

		it('can query gate_data filtered via space_workflow_runs indirect scope', async () => {
			seedGateData(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT run_id, gate_id FROM gate_data' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// swfr-int-1 and swfr-int-2 belong to space-int-1
			// swfr-int-3 belongs to space-int-2 — excluded
			expect(parsed.rows).toHaveLength(2);
			const runIds = parsed.rows.map((r: Record<string, unknown>) => r.run_id).sort();
			expect(runIds).toEqual(['swfr-int-1', 'swfr-int-2']);
		});

		it('gate_data from other spaces is excluded via indirect scope', async () => {
			seedGateData(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-2' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT run_id FROM gate_data' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].run_id).toBe('swfr-int-3');
		});

		it('cannot query room-scoped table tasks — rejected with scope error', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in space scope');
		});

		it('cannot query room-scoped table goals — rejected with scope error', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM goals' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in space scope');
		});

		it('cannot query sensitive table auth_config from space scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM auth_config' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in space scope');
		});

		it('COUNT aggregate in space scope returns correct filtered count', async () => {
			seedSpaceTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM space_tasks' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows[0].cnt).toBe(2);
		});

		it('db_list_tables shows space-scoped tables only (no room or global tables)', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_list_tables();
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.tables).toContain('space_tasks');
			expect(parsed.tables).toContain('space_workflows');
			expect(parsed.tables).toContain('gate_data');
			// Room-scoped tables must NOT appear
			expect(parsed.tables).not.toContain('tasks');
			expect(parsed.tables).not.toContain('goals');
			// Sensitive tables must NOT appear
			expect(parsed.tables).not.toContain('auth_config');
		});

		it('db_describe_table rejects out-of-scope tasks in space scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_describe_table({ table_name: 'tasks' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in space scope');
		});

		it('cross-scope JOIN space_tasks with tasks is rejected for space scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT * FROM space_tasks JOIN tasks ON space_tasks.id = tasks.id',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in space scope');
		});
	});

	// ── Global scope ─────────────────────────────────────────────────────────────

	describe('global scope', () => {
		it('can query all rows from rooms (no scope filter)', async () => {
			seedRooms(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id FROM rooms' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// Both rooms should appear — no scope filter applied
			expect(parsed.rows).toHaveLength(2);
		});

		it('can query all rows from spaces (no scope filter)', async () => {
			seedSpaces(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT id FROM spaces' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.rows).toHaveLength(2);
		});

		it('rooms rows do not include the blacklisted config column', async () => {
			seedRooms(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM rooms' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			for (const row of parsed.rows) {
				expect(row).not.toHaveProperty('config');
				expect(row).toHaveProperty('id');
				expect(row).toHaveProperty('name');
			}
		});

		it('cannot query sensitive table auth_config from global scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM auth_config' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in global scope');
		});

		it('cannot query sensitive table global_settings from global scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM global_settings' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in global scope');
		});

		it('cannot query internal table session_groups from global scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT * FROM session_groups' });

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in global scope');
		});

		it('no scope filter is applied in global scope — all rooms are returned', async () => {
			seedRooms(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM rooms' });
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// Global scope sees all 2 seeded rooms — no filtering
			expect(parsed.rows[0].cnt).toBe(2);
		});

		it('db_list_tables shows global-scoped tables only', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_list_tables();
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			expect(parsed.tables).toContain('rooms');
			expect(parsed.tables).toContain('spaces');
			expect(parsed.tables).toContain('sessions');
			expect(parsed.tables).toContain('skills');
			// Room/space-scoped tables must NOT appear
			expect(parsed.tables).not.toContain('tasks');
			expect(parsed.tables).not.toContain('space_tasks');
			// Sensitive tables must NOT appear
			expect(parsed.tables).not.toContain('auth_config');
			expect(parsed.tables).not.toContain('global_settings');
		});
	});

	// ── Cross-scope join prevention ──────────────────────────────────────────────

	describe('cross-scope join prevention', () => {
		it('room scope: JOIN with space_tasks (a space-scoped table) is rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT tasks.id FROM tasks JOIN space_tasks ON tasks.id = space_tasks.id',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('room scope: JOIN with space_workflow_runs (space-scoped) is rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT * FROM goals JOIN space_workflow_runs ON goals.room_id = space_workflow_runs.space_id',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('space scope: JOIN with tasks (a room-scoped table) is rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT space_tasks.id FROM space_tasks JOIN tasks ON space_tasks.id = tasks.id',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in space scope');
		});

		it('room scope: JOIN with sensitive table auth_config is rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT * FROM tasks JOIN auth_config ON 1 = 1',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('global scope: JOIN with auth_config is rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
				db
			);
			const result = await handlers.db_query({
				sql: 'SELECT * FROM rooms JOIN auth_config ON 1 = 1',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in global scope');
		});
	});

	// ── CTE queries in scoped mode ───────────────────────────────────────────────

	describe('CTE queries in scoped mode with full schema', () => {
		it('CTE over room-scoped table applies scope filter correctly', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			// The CTE body references 'tasks' (room-scoped); outer SELECT queries the CTE alias.
			// The validator extracts only 'tasks' from tableRefs (CTE alias excluded).
			const result = await handlers.db_query({
				sql: "WITH active AS (SELECT id, title FROM tasks WHERE status = 'pending') SELECT * FROM active",
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// room-int-1 has task-int-1 (pending) and task-int-2 (in_progress)
			// Only task-int-1 matches status='pending'
			expect(parsed.rows).toHaveLength(1);
			expect(parsed.rows[0].id).toBe('task-int-1');
		});

		it('CTE referencing space-scoped table is rejected in room scope', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			// CTE body references space_tasks — not accessible in room scope.
			// The validator extracts 'space_tasks' from tableRefs even though
			// the outer SELECT only references the CTE alias.
			const result = await handlers.db_query({
				sql: 'WITH space AS (SELECT * FROM space_tasks) SELECT * FROM space',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('CTE referencing sensitive table is rejected', async () => {
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			const result = await handlers.db_query({
				sql: 'WITH sensitive AS (SELECT * FROM auth_config) SELECT * FROM sensitive',
			});

			expect(result.isError).toBe(true);
			expect(parseResult(result).raw).toContain('not accessible in room scope');
		});

		it('CTE over room-scoped table counts only in-scope rows', async () => {
			seedTasks(db);
			const handlers = createDbQueryToolHandlers(
				{ dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
				db
			);
			// CTE wraps tasks; the outer SELECT aggregates from the CTE alias.
			// The scope filter for room-int-1 is injected into the CTE body,
			// so only the 2 tasks belonging to room-int-1 are counted.
			const result = await handlers.db_query({
				sql: 'WITH all_tasks AS (SELECT id FROM tasks) SELECT COUNT(*) AS cnt FROM all_tasks',
			});
			const parsed = parseResult(result);

			expect(parsed.isError).toBeFalsy();
			// room-int-1 has 2 tasks; room-int-2 has 1 — the CTE must be scoped
			expect(parsed.rows[0].cnt).toBe(2);
		});
	});
});
