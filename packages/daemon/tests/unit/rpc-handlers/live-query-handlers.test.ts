/**
 * Contract tests for the named-query registry defined in live-query-handlers.ts
 *
 * These tests verify that:
 *  1. The registry is exported and contains the expected named queries.
 *  2. Row shapes returned by executing the SQL (with the mapRow transform applied)
 *     match the TypeScript types used by the frontend (NeoTask, RoomGoal).
 *  3. JSON blob columns (`dependsOn`, `metrics`, `linkedTaskIds`, etc.) are parsed
 *     to JS values before delivery.
 *  4. snake_case exceptions for RoomGoal (`planning_attempts`, `goal_review_attempts`)
 *     are preserved as-is.
 *  5. All queries have deterministic ORDER BY with tiebreakers.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { NAMED_QUERY_REGISTRY } from '../../../src/lib/rpc-handlers/live-query-handlers';
import type { NeoTask, RoomGoal } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('NAMED_QUERY_REGISTRY', () => {
	let db: BunDatabase;
	const roomId = 'room-contract-test';
	const now = Date.now();

	beforeEach(() => {
		db = new BunDatabase(':memory:');
		createTables(db);
		// Insert minimal room row to satisfy FK constraints
		db.exec(
			`INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${now}, ${now})`
		);
	});

	afterEach(() => {
		db.close();
	});

	// -------------------------------------------------------------------------
	// Registry shape
	// -------------------------------------------------------------------------

	test('registry contains all expected query names', () => {
		expect(NAMED_QUERY_REGISTRY.has('tasks.byRoom')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('goals.byRoom')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('sessionGroupMessages.byGroup')).toBe(true);
	});

	test('all registry entries have correct paramCount', () => {
		expect(NAMED_QUERY_REGISTRY.get('tasks.byRoom')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('goals.byRoom')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!.paramCount).toBe(1);
	});

	// -------------------------------------------------------------------------
	// tasks.byRoom — column aliasing and JSON parsing
	// -------------------------------------------------------------------------

	describe('tasks.byRoom', () => {
		function insertTask(overrides: Record<string, unknown> = {}): string {
			const id = `task-${Date.now()}-${Math.random()}`;
			db.exec(`
				INSERT INTO tasks (
					id, room_id, title, description, status, priority,
					depends_on, created_at, updated_at
				) VALUES (
					'${id}', '${roomId}', 'Test Task', 'Desc', 'pending', 'normal',
					'${JSON.stringify(overrides.dependsOn ?? [])}', ${now}, ${now}
				)
			`);
			return id;
		}

		function queryAndMap(): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('tasks.byRoom')!;
			const rows = db.prepare(entry.sql).all(roomId) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('returns camelCase roomId column', () => {
			insertTask();
			const [row] = queryAndMap();
			expect(row).toHaveProperty('roomId', roomId);
			expect(row).not.toHaveProperty('room_id');
		});

		test('returns camelCase createdAt, updatedAt columns', () => {
			insertTask();
			const [row] = queryAndMap();
			expect(row).toHaveProperty('createdAt');
			expect(typeof row.createdAt).toBe('number');
			expect(row).toHaveProperty('updatedAt');
			expect(row).not.toHaveProperty('created_at');
			expect(row).not.toHaveProperty('updated_at');
		});

		test('dependsOn is parsed as string[] (empty array by default)', () => {
			insertTask();
			const [row] = queryAndMap();
			expect(Array.isArray(row.dependsOn)).toBe(true);
			expect(row.dependsOn).toEqual([]);
		});

		test('dependsOn is parsed as string[] with values', () => {
			insertTask({ dependsOn: ['task-a', 'task-b'] });
			const [row] = queryAndMap();
			expect(row.dependsOn).toEqual(['task-a', 'task-b']);
		});

		test('row shape matches NeoTask interface end-to-end', () => {
			insertTask();
			const [row] = queryAndMap();

			// Type assertion — if the shape is wrong, TS will catch it in CI
			const _typed = row as unknown as NeoTask;

			// Verify key structural properties at runtime
			expect(typeof _typed.id).toBe('string');
			expect(typeof _typed.roomId).toBe('string');
			expect(typeof _typed.title).toBe('string');
			expect(typeof _typed.status).toBe('string');
			expect(Array.isArray(_typed.dependsOn)).toBe(true);
		});

		test('ORDER BY is created_at DESC, id DESC (deterministic tiebreaker)', () => {
			const sql = NAMED_QUERY_REGISTRY.get('tasks.byRoom')!.sql;
			expect(sql).toContain('ORDER BY created_at DESC, id DESC');
		});
	});

	// -------------------------------------------------------------------------
	// goals.byRoom — column aliasing, JSON parsing, snake_case exceptions
	// -------------------------------------------------------------------------

	describe('goals.byRoom', () => {
		function insertGoal(overrides: Record<string, unknown> = {}): string {
			const id = `goal-${Date.now()}-${Math.random()}`;
			const linkedTaskIds = JSON.stringify(overrides.linkedTaskIds ?? []);
			const metrics = JSON.stringify(overrides.metrics ?? {});
			db.exec(`
				INSERT INTO goals (
					id, room_id, title, description, status, priority, progress,
					linked_task_ids, metrics, created_at, updated_at
				) VALUES (
					'${id}', '${roomId}', 'Test Goal', 'Desc', 'active', 'normal', 0,
					'${linkedTaskIds}', '${metrics}', ${now}, ${now}
				)
			`);
			return id;
		}

		function queryAndMap(): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('goals.byRoom')!;
			const rows = db.prepare(entry.sql).all(roomId) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('returns camelCase roomId column', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(row).toHaveProperty('roomId', roomId);
			expect(row).not.toHaveProperty('room_id');
		});

		test('metrics is parsed as an object (empty object by default)', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(typeof row.metrics).toBe('object');
			expect(row.metrics).toEqual({});
		});

		test('metrics is parsed as an object with values', () => {
			insertGoal({ metrics: { velocity: 42, bugs: 3 } });
			const [row] = queryAndMap();
			expect(row.metrics).toEqual({ velocity: 42, bugs: 3 });
		});

		test('linkedTaskIds is parsed as string[] (empty array by default)', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(Array.isArray(row.linkedTaskIds)).toBe(true);
			expect(row.linkedTaskIds).toEqual([]);
		});

		test('linkedTaskIds is parsed as string[] with values', () => {
			insertGoal({ linkedTaskIds: ['task-x', 'task-y'] });
			const [row] = queryAndMap();
			expect(row.linkedTaskIds).toEqual(['task-x', 'task-y']);
		});

		test('planning_attempts remains snake_case (not aliased to camelCase)', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(row).toHaveProperty('planning_attempts');
			expect(row).not.toHaveProperty('planningAttempts');
		});

		test('goal_review_attempts remains snake_case (not aliased to camelCase)', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(row).toHaveProperty('goal_review_attempts');
			expect(row).not.toHaveProperty('goalReviewAttempts');
		});

		test('schedulePaused is converted from SQLite integer to boolean', () => {
			insertGoal();
			const [row] = queryAndMap();
			// schedule_paused defaults to 0 → false
			expect(row.schedulePaused).toBe(false);
		});

		test('structuredMetrics is undefined when null in DB', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(row.structuredMetrics).toBeUndefined();
		});

		test('schedule is undefined when null in DB', () => {
			insertGoal();
			const [row] = queryAndMap();
			expect(row.schedule).toBeUndefined();
		});

		test('row shape matches RoomGoal interface end-to-end', () => {
			insertGoal({ metrics: { coverage: 80 }, linkedTaskIds: ['t1'] });
			const [row] = queryAndMap();

			// Type assertion — if the shape is wrong, TS will catch it in CI
			const _typed = row as unknown as RoomGoal;

			expect(typeof _typed.id).toBe('string');
			expect(typeof _typed.roomId).toBe('string');
			expect(Array.isArray(_typed.linkedTaskIds)).toBe(true);
			expect(typeof _typed.metrics).toBe('object');
		});

		test('ORDER BY is priority DESC, created_at ASC, id ASC (deterministic tiebreaker)', () => {
			const sql = NAMED_QUERY_REGISTRY.get('goals.byRoom')!.sql;
			expect(sql).toContain('ORDER BY priority DESC, created_at ASC, id ASC');
		});
	});

	// -------------------------------------------------------------------------
	// sessionGroupMessages.byGroup — canonical timeline from sdk_messages + events
	// -------------------------------------------------------------------------

	describe('sessionGroupMessages.byGroup', () => {
		const groupId = 'group-contract-test';
		const taskId = 'task-contract-test';
		const workerSessionId = 'worker-session-contract';
		const leaderSessionId = 'leader-session-contract';

		function insertTask(): void {
			db.exec(
				`INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at, updated_at)
				 VALUES ('${taskId}', '${roomId}', 'Task', 'Desc', 'in_progress', 'normal', '[]', ${Date.now()}, ${Date.now()})`
			);
		}

		function insertGroup(): void {
			db.exec(
				`INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
				 VALUES ('${groupId}', 'task', '${taskId}', 0,
				 '${JSON.stringify({ workerRole: 'coder', feedbackIteration: 2, submittedForReview: false })}',
				 ${Date.now()})`
			);
			db.exec(
				`INSERT OR IGNORE INTO session_group_members (group_id, session_id, role, joined_at)
				 VALUES ('${groupId}', '${workerSessionId}', 'worker', ${Date.now()}),
						('${groupId}', '${leaderSessionId}', 'leader', ${Date.now()})`
			);
		}

		function insertSdkMessage(sessionId: string, id: string, timestampMs: number): void {
			db.exec(
				`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
				 VALUES ('${id}', '${sessionId}', 'assistant', NULL,
				 '${JSON.stringify({ type: 'assistant', uuid: id, message: { content: [] } })}',
				 '${new Date(timestampMs).toISOString()}', 'sent')`
			);
		}

		function insertEvent(kind: string, payload: Record<string, unknown>, createdAt: number): void {
			db.exec(
				`INSERT INTO task_group_events (group_id, kind, payload_json, created_at)
				 VALUES ('${groupId}', '${kind}', '${JSON.stringify(payload)}', ${createdAt})`
			);
		}

		function executeSQLAndMap(): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
			const rows = db.prepare(entry.sql).all(groupId) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('SQL executes without error against the real schema', () => {
			insertTask();
			insertGroup();
			expect(() => executeSQLAndMap()).not.toThrow();
		});

		test('returns empty array when no sdk/event rows exist for the group', () => {
			insertTask();
			insertGroup();
			const rows = executeSQLAndMap();
			expect(rows).toEqual([]);
		});

		test('returns camelCase row shape and injects _taskMeta for sdk messages', () => {
			insertTask();
			insertGroup();
			insertSdkMessage(workerSessionId, 'worker-msg-1', 1000);
			insertSdkMessage(leaderSessionId, 'leader-msg-1', 2000);

			const rows = executeSQLAndMap();
			expect(rows.length).toBe(2);

			const workerRow = rows[0];
			expect(workerRow).toHaveProperty('groupId', groupId);
			expect(workerRow).toHaveProperty('sessionId', workerSessionId);
			expect(workerRow).toHaveProperty('messageType', 'assistant');
			expect(workerRow).toHaveProperty('createdAt');

			const parsed = JSON.parse(workerRow.content as string) as Record<string, unknown>;
			const meta = parsed._taskMeta as Record<string, unknown>;
			expect(meta.authorRole).toBe('coder');
			expect(meta.authorSessionId).toBe(workerSessionId);
			expect(meta.iteration).toBe(0);
			expect(typeof meta.turnId).toBe('string');
			expect(parsed.uuid).toBe('worker-msg-1');
		});

		test('event rows keep null sessionId and status text extraction', () => {
			insertTask();
			insertGroup();
			insertEvent('status', { text: 'Mid status marker' }, 1500);

			const [row] = executeSQLAndMap();
			expect(row.sessionId).toBeNull();
			expect(row.messageType).toBe('status');
			expect(row.content).toBe('Mid status marker');
		});

		test('has mapRow to enrich sdk content payloads', () => {
			const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
			expect(typeof entry.mapRow).toBe('function');
		});

		test('SQL targets canonical sdk_messages + task_group_events sources', () => {
			const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
			expect(entry.sql).toContain('FROM session_groups');
			expect(entry.sql).toContain('JOIN session_group_members');
			expect(entry.sql).toContain('JOIN sdk_messages');
			expect(entry.sql).toContain('JOIN task_group_events');
		});

		test('SQL filters by group id via target_group CTE', () => {
			const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
			expect(entry.sql).toContain('WHERE id = ?');
		});

		test('ORDER BY is createdAt ASC, id ASC (deterministic tiebreaker)', () => {
			const sql = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!.sql;
			expect(sql).toContain('ORDER BY createdAt ASC, id ASC');
		});
	});

	// -------------------------------------------------------------------------
	// General registry invariants
	// -------------------------------------------------------------------------

	describe('invariants', () => {
		test('all entries have non-empty SQL', () => {
			for (const [name, entry] of NAMED_QUERY_REGISTRY) {
				expect(entry.sql.trim().length).toBeGreaterThan(0, `${name} has empty SQL`);
			}
		});

		test('all entries have paramCount >= 1', () => {
			for (const [name, entry] of NAMED_QUERY_REGISTRY) {
				expect(entry.paramCount).toBeGreaterThanOrEqual(1, `${name} has paramCount < 1`);
			}
		});

		test('all ORDER BY clauses include a deterministic tiebreaker (id column)', () => {
			for (const [name, entry] of NAMED_QUERY_REGISTRY) {
				const upperSql = entry.sql.toUpperCase();
				expect(upperSql).toContain('ORDER BY');
				// Must end with either `id ASC` or `id DESC` (tiebreaker)
				const hasIdTiebreaker = /\bID\s+(ASC|DESC)\s*$/.test(upperSql.replace(/\s+/g, ' ').trim());
				expect(hasIdTiebreaker).toBe(true, `${name} ORDER BY lacks deterministic id tiebreaker`);
			}
		});
	});
});
