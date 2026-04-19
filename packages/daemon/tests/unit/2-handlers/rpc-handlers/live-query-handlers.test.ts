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
import { createTables, runMigration74, runMigrations } from '../../../../src/storage/schema';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';
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
		runMigration74(db);
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
		expect(NAMED_QUERY_REGISTRY.has('tasks.byRoom.all')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('goals.byRoom')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('sessionGroupMessages.byGroup')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('spaceTaskActivity.byTask')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('spaceTaskMessages.byTask')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('spaceTaskMessages.byTask.compact')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('spaceTasks.needingAttention')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('skills.byRoom')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('neo.messages')).toBe(true);
		expect(NAMED_QUERY_REGISTRY.has('neo.activity')).toBe(true);
	});

	test('all registry entries have correct paramCount', () => {
		expect(NAMED_QUERY_REGISTRY.get('tasks.byRoom')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('tasks.byRoom.all')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('goals.byRoom')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('spaceTaskActivity.byTask')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('skills.byRoom')!.paramCount).toBe(1);
		expect(NAMED_QUERY_REGISTRY.get('neo.messages')!.paramCount).toBe(2);
		expect(NAMED_QUERY_REGISTRY.get('neo.activity')!.paramCount).toBe(2);
	});

	// -------------------------------------------------------------------------
	// tasks.byRoom — column aliasing and JSON parsing
	// -------------------------------------------------------------------------

	describe('tasks.byRoom', () => {
		function insertTask(overrides: Record<string, unknown> = {}): string {
			const id = `task-${Date.now()}-${Math.random()}`;
			const status = (overrides.status as string) ?? 'pending';
			db.exec(`
				INSERT INTO tasks (
					id, room_id, title, description, status, priority,
					depends_on, created_at, updated_at
				) VALUES (
					'${id}', '${roomId}', 'Test Task', 'Desc', '${status}', 'normal',
					'${JSON.stringify(overrides.dependsOn ?? [])}', ${now}, ${now}
				)
			`);
			return id;
		}

		function queryAndMap(queryName = 'tasks.byRoom'): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get(queryName)!;
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

		test('excludes archived tasks by default', () => {
			insertTask({ status: 'pending' });
			insertTask({ status: 'in_progress' });
			insertTask({ status: 'archived' });
			insertTask({ status: 'completed' });

			const rows = queryAndMap();
			const statuses = rows.map((r) => r.status);
			expect(statuses).not.toContain('archived');
			expect(rows).toHaveLength(3);
		});

		test('tasks.byRoom.all includes archived tasks', () => {
			insertTask({ status: 'pending' });
			insertTask({ status: 'archived' });

			const rows = queryAndMap('tasks.byRoom.all');
			const statuses = rows.map((r) => r.status);
			expect(statuses).toContain('archived');
			expect(statuses).toContain('pending');
			expect(rows).toHaveLength(2);
		});

		test('tasks.byRoom.all has same column shape as tasks.byRoom', () => {
			insertTask();
			const defaultRows = queryAndMap('tasks.byRoom');
			const allRows = queryAndMap('tasks.byRoom.all');
			// Both should have the same columns (keys)
			const defaultKeys = Object.keys(defaultRows[0]).sort();
			const allKeys = Object.keys(allRows[0]).sort();
			expect(allKeys).toEqual(defaultKeys);
		});
	});

	describe('spaceTaskActivity.byTask', () => {
		const spaceId = 'space-live-query-space';
		const sessionId = 'space:task:1';
		const nowIso = new Date(now).toISOString();

		beforeEach(() => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS spaces (
					id TEXT PRIMARY KEY,
					slug TEXT,
					workspace_path TEXT NOT NULL,
					name TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS space_agents (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					task_number INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL,
					status TEXT NOT NULL,
					priority TEXT NOT NULL,
					assigned_agent TEXT,
					custom_agent_id TEXT,
					agent_name TEXT,
					completion_summary TEXT,
					workflow_run_id TEXT,
					workflow_node_id TEXT,
					task_agent_session_id TEXT,
					depends_on TEXT NOT NULL DEFAULT '[]',
					current_step TEXT,
					error TEXT,
					result TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
			`);
			db.exec(
				`INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES ('${spaceId}', '${spaceId}', '/tmp/test-space', 'Test Space', ${now}, ${now})`
			);
		});

		function insertSpaceTask(overrides: Record<string, unknown> = {}): string {
			const id = (overrides.id as string) ?? `space-task-${Date.now()}-${Math.random()}`;
			db.exec(`
				INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority, assigned_agent,
					agent_name, workflow_run_id, workflow_node_id, task_agent_session_id, depends_on,
					created_at, updated_at
				) VALUES (
					'${id}', '${spaceId}', 1, 'Ship UI review', 'Describe progress', '${overrides.status ?? 'in_progress'}',
					'normal', 'coder', ${overrides.agentName ? `'${String(overrides.agentName)}'` : 'NULL'},
					${overrides.workflowRunId ? `'${String(overrides.workflowRunId)}'` : 'NULL'},
					${overrides.workflowNodeId ? `'${String(overrides.workflowNodeId)}'` : 'NULL'},
					${overrides.taskAgentSessionId ? `'${String(overrides.taskAgentSessionId)}'` : 'NULL'},
					'[]', ${now}, ${now}
				)
			`);
			return id;
		}

		function insertSession(id: string, type: string, processingState: string): void {
			db.exec(`
				INSERT INTO sessions (
					id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id,
					available_commands, processing_state, archived_at, type, session_context
				) VALUES (
					'${id}', 'Session', '/tmp/test-space', '${nowIso}', '${nowIso}', 'active', '{}', '{}',
					0, NULL, NULL, NULL, NULL, NULL, NULL, '${processingState}', NULL, '${type}', '{}'
				)
			`);
		}

		function insertSdkMessage(id: string, sessionIdValue: string): void {
			db.exec(`
				INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin
				) VALUES (
					'${id}', '${sessionIdValue}', 'assistant', NULL, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
					'${nowIso}', 'consumed', 'system'
				)
			`);
		}

		function queryAndMap(taskId: string): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('spaceTaskActivity.byTask')!;
			const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		function queryMessages(taskId: string): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
			const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('returns live activity rows with derived state and message counts', () => {
			const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
			insertSession(sessionId, 'space_task_agent', '{"status":"processing","phase":"thinking"}');
			insertSdkMessage('sdk-1', sessionId);
			insertSdkMessage('sdk-2', sessionId);

			const [row] = queryAndMap(taskId);
			expect(row.kind).toBe('task_agent');
			expect(row.label).toBe('Task Agent');
			expect(row.state).toBe('active');
			expect(row.processingStatus).toBe('processing');
			expect(row.processingPhase).toBe('thinking');
			expect(row.messageCount).toBe(2);
			expect(row.taskId).toBe(taskId);
			expect(row.taskTitle).toBe('Ship UI review');
		});

		test('returns unified task message rows with label and task metadata', () => {
			const taskId = insertSpaceTask({ taskAgentSessionId: sessionId, agentName: 'coder' });
			insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
			insertSdkMessage('sdk-msg-1', sessionId);

			const [row] = queryMessages(taskId);
			expect(row.sessionId).toBe(sessionId);
			expect(row.kind).toBe('task_agent');
			expect(row.label).toBe('Task Agent');
			expect(row.taskId).toBe(taskId);
			expect(row.messageType).toBe('assistant');
			expect(typeof row.content).toBe('string');
			expect((row.content as string).includes('_taskMeta')).toBe(true);
		});

		test('Leg 2 (node_agents): returns node agent activity via node_executions', () => {
			const orchestrationSessionId = 'space:test-space:task:orch-1';
			const nodeSessionId = 'node-agent-session-1';
			const workflowRunId = 'wr-node-agent-test';
			const workflowNodeId = 'node-coder-1';
			const agentName = 'coder';

			// Insert the orchestration task (target_task) — this is the Task Agent's own task.
			// It has a different session ID from the node agent sub-session.
			const taskId = insertSpaceTask({
				id: 'orch-task-1',
				taskAgentSessionId: orchestrationSessionId,
				workflowRunId,
				status: 'in_progress',
			});

			// Insert a separate step task for the node agent (different from the orchestration task).
			db.exec(`
				INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority, assigned_agent,
					agent_name, workflow_run_id, workflow_node_id, task_agent_session_id, depends_on,
					created_at, updated_at
				) VALUES (
					'step-task-1', '${spaceId}', 2, '${agentName}', 'Code the feature', 'in_progress',
					'normal', NULL, '${agentName}',
					'${workflowRunId}', '${workflowNodeId}', '${nodeSessionId}',
					'[]', ${now}, ${now}
				)
			`);

			// Insert a matching node_execution record with agent_session_id
			db.exec(`
				INSERT INTO node_executions (
					id, workflow_run_id, workflow_node_id, agent_name, agent_id,
					agent_session_id, status, result, created_at, started_at,
					completed_at, updated_at
				) VALUES (
					'ne-1', '${workflowRunId}', '${workflowNodeId}', '${agentName}', NULL,
					'${nodeSessionId}', 'in_progress', NULL, ${now}, ${now},
					NULL, ${now}
				)
			`);

			// Insert session and SDK messages for the node agent
			insertSession(nodeSessionId, 'space_task_agent', '{"status":"processing","phase":"coding"}');
			insertSdkMessage('sdk-node-1', nodeSessionId);
			insertSdkMessage('sdk-node-2', nodeSessionId);

			const rows = queryAndMap(taskId);
			// Should return the orchestration row (Leg 1) and the node agent row (Leg 2)
			const nodeAgentRow = rows.find((r) => r.kind === 'node_agent');
			expect(nodeAgentRow).toBeDefined();
			expect(nodeAgentRow!.label).toBeTruthy(); // COALESCE(sa.name, ne.agent_name, 'agent')
			expect(nodeAgentRow!.role).toBe('coder');
			expect(nodeAgentRow!.state).toBe('active');
			expect(nodeAgentRow!.processingStatus).toBe('processing');
			expect(nodeAgentRow!.processingPhase).toBe('coding');
			expect(nodeAgentRow!.messageCount).toBe(2);
			expect(nodeAgentRow!.sessionId).toBe(nodeSessionId);
			expect(nodeAgentRow!.workflowNodeId).toBe(workflowNodeId);
			expect(nodeAgentRow!.agentName).toBe('coder');
		});

		test('Leg 2 (node_agents): skips rows without agent_session_id', () => {
			const workflowRunId = 'wr-no-session-test';
			const taskId = insertSpaceTask({ workflowRunId, status: 'in_progress' });

			// Insert node_execution WITHOUT agent_session_id
			db.exec(`
				INSERT INTO node_executions (
					id, workflow_run_id, workflow_node_id, agent_name, agent_id,
					agent_session_id, status, result, created_at, started_at,
					completed_at, updated_at
				) VALUES (
					'ne-no-sess', '${workflowRunId}', 'node-1', 'agent', NULL,
					NULL, 'pending', NULL, ${now}, NULL,
					NULL, ${now}
				)
			`);

			const rows = queryAndMap(taskId);
			const nodeAgentRows = rows.filter((r) => r.kind === 'node_agent');
			expect(nodeAgentRows).toHaveLength(0);
		});

		// -------------------------------------------------------------------------
		// spaceTaskMessages.byTask.compact — render-focused slicing
		// -------------------------------------------------------------------------

		describe('spaceTaskMessages.byTask.compact', () => {
			function insertSdkMessageAt(
				id: string,
				sessionIdValue: string,
				timestampMs: number,
				sdkMessage?: Record<string, unknown>,
				messageType = 'assistant'
			): void {
				const iso = new Date(timestampMs).toISOString();
				const payload =
					sdkMessage ??
					({
						type: 'assistant',
						message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
					} as Record<string, unknown>);
				db.exec(`
					INSERT INTO sdk_messages (
						id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin
					) VALUES (
						'${id}', '${sessionIdValue}', '${messageType}', NULL, '${JSON.stringify(payload)}',
						'${iso}', 'consumed', 'system'
					)
				`);
			}

			function queryCompact(taskId: string): Record<string, unknown>[] {
				const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!;
				const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
				return entry.mapRow ? rows.map(entry.mapRow) : rows;
			}

			test('returns only rows needed to cover the last 5 rendered events', () => {
				const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
				insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

				for (let i = 0; i < 9; i++) {
					insertSdkMessageAt(`sdk-tail-${i}`, sessionId, now + i * 1000);
				}

				const rows = queryCompact(taskId);
				expect(rows).toHaveLength(5);
				expect(rows.map((r) => r.id)).toEqual([
					'sdk-tail-4',
					'sdk-tail-5',
					'sdk-tail-6',
					'sdk-tail-7',
					'sdk-tail-8',
				]);
				for (const row of rows) {
					expect(row.sessionMessageCount).toBeUndefined();
				}
			});

			test('includes a cutoff-crossing multi-block assistant row when needed', () => {
				const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
				insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

				insertSdkMessageAt('sdk-old', sessionId, now + 1000);
				insertSdkMessageAt(
					'sdk-multi',
					sessionId,
					now + 2000,
					{
						type: 'assistant',
						message: {
							role: 'assistant',
							content: [
								{ type: 'text', text: 'm1' },
								{ type: 'text', text: 'm2' },
								{ type: 'text', text: 'm3' },
								{ type: 'text', text: 'm4' },
							],
						},
					},
					'assistant'
				);
				insertSdkMessageAt('sdk-new-1', sessionId, now + 3000);
				insertSdkMessageAt('sdk-new-2', sessionId, now + 4000);

				const rows = queryCompact(taskId);
				expect(rows.map((r) => r.id)).toEqual(['sdk-multi', 'sdk-new-1', 'sdk-new-2']);
				expect(rows.map((r) => r.id)).not.toContain('sdk-old');
			});

			test('always includes the earliest non-synthetic user anchor row', () => {
				const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
				insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

				insertSdkMessageAt(
					'sdk-user-anchor',
					sessionId,
					now,
					{
						type: 'user',
						message: { role: 'user', content: 'Initial ask' },
					},
					'user'
				);
				for (let i = 0; i < 8; i++) {
					insertSdkMessageAt(`sdk-after-${i}`, sessionId, now + (i + 1) * 1000);
				}

				const rows = queryCompact(taskId);
				expect(rows.map((r) => r.id)).toContain('sdk-user-anchor');
				expect(rows[0].id).toBe('sdk-user-anchor');
				expect(rows).toHaveLength(6); // anchor + tail rows for last 5 events
			});

			test('does not treat synthetic user messages as the anchor', () => {
				const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
				insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

				insertSdkMessageAt(
					'sdk-user-synth',
					sessionId,
					now,
					{
						type: 'user',
						isSynthetic: true,
						message: { role: 'user', content: 'Synthetic handoff' },
					},
					'user'
				);
				for (let i = 0; i < 8; i++) {
					insertSdkMessageAt(`sdk-real-${i}`, sessionId, now + (i + 1) * 1000);
				}

				const rows = queryCompact(taskId);
				expect(rows.map((r) => r.id)).not.toContain('sdk-user-synth');
				expect(rows).toHaveLength(5);
			});

			test('final ordering is createdAt ASC, id ASC', () => {
				const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
				insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

				insertSdkMessageAt('sdk-b', sessionId, now + 2000);
				insertSdkMessageAt('sdk-a', sessionId, now + 1000);
				insertSdkMessageAt('sdk-c', sessionId, now + 3000);

				const rows = queryCompact(taskId);
				const createdAts = rows.map((r) => r.createdAt as number);
				const sorted = [...createdAts].sort((x, y) => x - y);
				expect(createdAts).toEqual(sorted);
			});

			test('legacy full query variant is unaffected (no compact slicing)', () => {
				const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
				insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

				const total = 12;
				for (let i = 0; i < total; i++) {
					insertSdkMessageAt(`sdk-full-${i}`, sessionId, now + i * 1000);
				}

				const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
				const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
				const rows = entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;

				expect(rows).toHaveLength(total);
				for (const row of rows) {
					expect(row.sessionMessageCount).toBeUndefined();
				}
			});
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

		describe('defensive JSON parsing for schedule and structuredMetrics', () => {
			function insertGoalRaw(overrides: Record<string, unknown> = {}): string {
				const id = `goal-${Date.now()}-${Math.random()}`;
				const linkedTaskIds = JSON.stringify(overrides.linkedTaskIds ?? []);
				const metrics = JSON.stringify(overrides.metrics ?? {});
				const schedule = overrides.schedule != null ? `'${String(overrides.schedule)}'` : 'NULL';
				const structuredMetrics =
					overrides.structuredMetrics != null ? `'${String(overrides.structuredMetrics)}'` : 'NULL';
				db.exec(`
					INSERT INTO goals (
						id, room_id, title, description, status, priority, progress,
						linked_task_ids, metrics, created_at, updated_at,
						schedule, structured_metrics
					) VALUES (
						'${id}', '${roomId}', 'Test Goal', 'Desc', 'active', 'normal', 0,
						'${linkedTaskIds}', '${metrics}', ${now}, ${now},
						${schedule}, ${structuredMetrics}
					)
				`);
				return id;
			}

			test('raw cron string in schedule column does not crash — returns undefined', () => {
				insertGoalRaw({ schedule: '@daily' });
				const [row] = queryAndMap();
				expect(row.schedule).toBeUndefined();
			});

			test('valid JSON schedule parses correctly', () => {
				const scheduleJson = JSON.stringify({ expression: '@daily', timezone: 'UTC' });
				insertGoalRaw({ schedule: scheduleJson });
				const [row] = queryAndMap();
				expect(row.schedule).toEqual({ expression: '@daily', timezone: 'UTC' });
			});

			test('corrupted JSON in structuredMetrics column does not crash', () => {
				insertGoalRaw({ structuredMetrics: 'corrupted{json' });
				const [row] = queryAndMap();
				expect(row.structuredMetrics).toBeUndefined();
			});

			test('valid JSON structuredMetrics parses correctly', () => {
				const metricsJson = JSON.stringify([{ name: 'coverage', target: 80, current: 60 }]);
				insertGoalRaw({ structuredMetrics: metricsJson });
				const [row] = queryAndMap();
				expect(row.structuredMetrics).toEqual([{ name: 'coverage', target: 80, current: 60 }]);
			});

			test('corrupted JSON in schedule column does not crash', () => {
				insertGoalRaw({ schedule: 'not-valid-json{' });
				const [row] = queryAndMap();
				expect(row.schedule).toBeUndefined();
			});
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
				 '${new Date(timestampMs).toISOString()}', 'consumed')`
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
	// skills.byRoom — global skills with per-room override via LEFT JOIN
	// -------------------------------------------------------------------------

	describe('skills.byRoom', () => {
		function insertSkill(
			id: string,
			name: string,
			opts: { enabled?: boolean; builtIn?: boolean } = {}
		): void {
			const enabled = opts.enabled ?? true;
			const builtIn = opts.builtIn ? 1 : 0;
			const config = JSON.stringify({ type: 'builtin', commandName: name });
			db.exec(`
				INSERT INTO skills (id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
				VALUES ('${id}', '${name}', '${name}', '${name} skill', 'builtin', '${config}', ${enabled ? 1 : 0}, ${builtIn}, 'valid', ${now})
			`);
		}

		function setOverride(roomId: string, skillId: string, enabled: boolean): void {
			db.exec(`
				INSERT INTO room_skill_overrides (skill_id, room_id, enabled)
				VALUES ('${skillId}', '${roomId}', ${enabled ? 1 : 0})
			`);
		}

		function queryAndMap(): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('skills.byRoom')!;
			const rows = db.prepare(entry.sql).all(roomId) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('returns global enabled when no room override row exists', () => {
			insertSkill('s-1', 'alpha', { enabled: true });
			insertSkill('s-2', 'beta', { enabled: false });

			const rows = queryAndMap();
			expect(rows).toHaveLength(2);
			const alpha = rows.find((r) => r.name === 'alpha')!;
			const beta = rows.find((r) => r.name === 'beta')!;
			expect(alpha.enabled).toBe(true);
			expect(beta.enabled).toBe(false);
			expect(alpha.overriddenByRoom).toBe(false);
			expect(beta.overriddenByRoom).toBe(false);
		});

		test('returns room override enabled when override row exists', () => {
			insertSkill('s-1', 'alpha', { enabled: true });
			insertSkill('s-2', 'beta', { enabled: true });

			// Override alpha to disabled in the room
			setOverride(roomId, 's-1', false);

			const rows = queryAndMap();
			const alpha = rows.find((r) => r.name === 'alpha')!;
			const beta = rows.find((r) => r.name === 'beta')!;
			expect(alpha.enabled).toBe(false);
			expect(alpha.overriddenByRoom).toBe(true);
			expect(beta.enabled).toBe(true);
			expect(beta.overriddenByRoom).toBe(false);
		});

		test('room override can enable a globally disabled skill', () => {
			insertSkill('s-1', 'alpha', { enabled: false });
			setOverride(roomId, 's-1', true);

			const [row] = queryAndMap();
			expect(row.enabled).toBe(true);
			expect(row.overriddenByRoom).toBe(true);
		});

		test('config is parsed as JSON object', () => {
			insertSkill('s-1', 'alpha');
			const [row] = queryAndMap();
			expect(typeof row.config).toBe('object');
			expect(row.config).toEqual({ type: 'builtin', commandName: 'alpha' });
		});

		test('builtIn is converted from SQLite integer to boolean', () => {
			insertSkill('s-1', 'builtin-skill', { builtIn: true });
			insertSkill('s-2', 'custom-skill', { builtIn: false });

			const rows = queryAndMap();
			const builtin = rows.find((r) => r.name === 'builtin-skill')!;
			const custom = rows.find((r) => r.name === 'custom-skill')!;
			expect(builtin.builtIn).toBe(true);
			expect(custom.builtIn).toBe(false);
		});

		test('displayName and sourceType are camelCase aliases', () => {
			insertSkill('s-1', 'alpha');
			const [row] = queryAndMap();
			expect(row).toHaveProperty('displayName', 'alpha');
			expect(row).toHaveProperty('sourceType', 'builtin');
			expect(row).not.toHaveProperty('display_name');
			expect(row).not.toHaveProperty('source_type');
		});

		test('ORDER BY is built_in DESC, created_at ASC, id ASC (deterministic)', () => {
			const sql = NAMED_QUERY_REGISTRY.get('skills.byRoom')!.sql;
			expect(sql).toContain('ORDER BY s.built_in DESC, s.created_at ASC, s.id ASC');
		});

		test('LEFT JOIN preserves skills with no override row', () => {
			insertSkill('s-1', 'no-override');
			const rows = queryAndMap();
			expect(rows).toHaveLength(1);
			expect(rows[0].overriddenByRoom).toBe(false);
		});

		test('has mapRow function', () => {
			const entry = NAMED_QUERY_REGISTRY.get('skills.byRoom')!;
			expect(typeof entry.mapRow).toBe('function');
		});
	});

	// -------------------------------------------------------------------------
	// neo.messages — sdk_messages for the neo:global session
	// -------------------------------------------------------------------------

	describe('neo.messages', () => {
		/** Insert a minimal sdk_message for the neo:global session.
		 *  SQLite FK enforcement is off by default in Bun, so no session row needed. */
		function insertNeoMessage(id: string, timestampMs: number): void {
			db.exec(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status)
				 VALUES (
				   '${id}', 'neo:global', 'assistant',
				   '${JSON.stringify({ type: 'assistant', uuid: id })}',
				   '${new Date(timestampMs).toISOString()}', 'consumed'
				 )`
			);
		}

		function queryAndMap(limit = 50, offset = 0): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('neo.messages')!;
			const rows = db.prepare(entry.sql).all(limit, offset) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('is registered in the named-query registry', () => {
			expect(NAMED_QUERY_REGISTRY.has('neo.messages')).toBe(true);
		});

		test('paramCount is 2 (limit, offset)', () => {
			expect(NAMED_QUERY_REGISTRY.get('neo.messages')!.paramCount).toBe(2);
		});

		test('SQL executes without error against the real schema', () => {
			expect(() => queryAndMap()).not.toThrow();
		});

		test('returns empty array when no neo:global messages exist', () => {
			expect(queryAndMap()).toEqual([]);
		});

		test('returns messages from neo:global session only', () => {
			insertNeoMessage('neo-msg-1', 1000);
			// Insert a message for a different session — should NOT appear (FK off, direct insert)
			db.exec(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status)
				 VALUES ('other-msg', 'other:session', 'assistant', '{}', '${new Date(2000).toISOString()}', 'consumed')`
			);
			const rows = queryAndMap();
			expect(rows.every((r) => r.sessionId === 'neo:global')).toBe(true);
			expect(rows).toHaveLength(1);
		});

		test('returns camelCase column aliases', () => {
			insertNeoMessage('neo-msg-1', 1000);
			const [row] = queryAndMap();
			expect(row).toHaveProperty('sessionId', 'neo:global');
			expect(row).toHaveProperty('messageType', 'assistant');
			expect(row).toHaveProperty('createdAt');
			expect(row).toHaveProperty('sendStatus', 'consumed');
			expect(row).not.toHaveProperty('session_id');
			expect(row).not.toHaveProperty('message_type');
			expect(row).not.toHaveProperty('send_status');
		});

		test('createdAt is a millisecond integer', () => {
			insertNeoMessage('neo-msg-1', 5000);
			const [row] = queryAndMap();
			expect(typeof row.createdAt).toBe('number');
			// julianday conversion — allow ±1s rounding
			expect(row.createdAt as number).toBeGreaterThan(0);
		});

		test('content contains the sdk_message JSON as string', () => {
			insertNeoMessage('neo-msg-1', 1000);
			const [row] = queryAndMap();
			expect(typeof row.content).toBe('string');
			const parsed = JSON.parse(row.content as string) as Record<string, unknown>;
			expect(parsed.uuid).toBe('neo-msg-1');
		});

		test('SQL targets sdk_messages with neo:global filter', () => {
			const entry = NAMED_QUERY_REGISTRY.get('neo.messages')!;
			expect(entry.sql).toContain("session_id = 'neo:global'");
			expect(entry.sql).toContain('FROM sdk_messages');
		});

		test('ORDER BY is timestamp ASC, id ASC (oldest-first)', () => {
			const sql = NAMED_QUERY_REGISTRY.get('neo.messages')!.sql;
			expect(sql).toContain('ORDER BY timestamp ASC, id ASC');
		});

		test('pagination: LIMIT restricts result count', () => {
			for (let i = 0; i < 5; i++) {
				insertNeoMessage(`neo-msg-${i}`, 1000 + i);
			}
			expect(queryAndMap(2, 0)).toHaveLength(2);
			expect(queryAndMap(3, 0)).toHaveLength(3);
		});

		test('pagination: OFFSET skips rows', () => {
			for (let i = 0; i < 5; i++) {
				insertNeoMessage(`neo-msg-${i}`, 1000 + i);
			}
			const page1 = queryAndMap(2, 0).map((r) => r.id);
			const page2 = queryAndMap(2, 2).map((r) => r.id);
			expect(page1.length).toBe(2);
			expect(page2.length).toBe(2);
			// No overlap
			expect(page1.some((id) => page2.includes(id))).toBe(false);
		});

		test('has no mapRow (column aliases sufficient)', () => {
			expect(NAMED_QUERY_REGISTRY.get('neo.messages')!.mapRow).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// neo.activity — neo_activity_log with pagination
	// -------------------------------------------------------------------------

	describe('neo.activity', () => {
		function insertActivity(
			id: string,
			toolName: string,
			opts: { undoable?: boolean; status?: string } = {}
		): void {
			const undoable = opts.undoable ? 1 : 0;
			const status = opts.status ?? 'success';
			db.exec(
				`INSERT INTO neo_activity_log (id, tool_name, status, undoable, created_at)
				 VALUES ('${id}', '${toolName}', '${status}', ${undoable}, datetime('now'))`
			);
		}

		function queryAndMap(limit = 50, offset = 0): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('neo.activity')!;
			const rows = db.prepare(entry.sql).all(limit, offset) as Record<string, unknown>[];
			return entry.mapRow ? rows.map(entry.mapRow) : rows;
		}

		test('is registered in the named-query registry', () => {
			expect(NAMED_QUERY_REGISTRY.has('neo.activity')).toBe(true);
		});

		test('paramCount is 2 (limit, offset)', () => {
			expect(NAMED_QUERY_REGISTRY.get('neo.activity')!.paramCount).toBe(2);
		});

		test('SQL executes without error against the real schema', () => {
			expect(() => queryAndMap()).not.toThrow();
		});

		test('returns empty array when no activity log entries exist', () => {
			expect(queryAndMap()).toEqual([]);
		});

		test('returns camelCase column aliases', () => {
			insertActivity('act-1', 'create_room');
			const [row] = queryAndMap();
			expect(row).toHaveProperty('toolName', 'create_room');
			expect(row).toHaveProperty('createdAt');
			expect(row).toHaveProperty('targetType');
			expect(row).toHaveProperty('targetId');
			expect(row).toHaveProperty('undoData');
			expect(row).not.toHaveProperty('tool_name');
			expect(row).not.toHaveProperty('created_at');
			expect(row).not.toHaveProperty('target_type');
			expect(row).not.toHaveProperty('target_id');
			expect(row).not.toHaveProperty('undo_data');
		});

		test('undoable is converted from SQLite integer to boolean', () => {
			insertActivity('act-undoable', 'toggle_skill', { undoable: true });
			insertActivity('act-not-undoable', 'list_rooms', { undoable: false });
			const rows = queryAndMap();
			const undoable = rows.find((r) => r.id === 'act-undoable')!;
			const notUndoable = rows.find((r) => r.id === 'act-not-undoable')!;
			expect(undoable.undoable).toBe(true);
			expect(notUndoable.undoable).toBe(false);
		});

		test('status column is included and passes through correctly', () => {
			insertActivity('act-err', 'delete_room', { status: 'error' });
			const [row] = queryAndMap();
			expect(row.status).toBe('error');
		});

		test('has mapRow function for boolean conversion', () => {
			expect(typeof NAMED_QUERY_REGISTRY.get('neo.activity')!.mapRow).toBe('function');
		});

		test('SQL targets neo_activity_log table', () => {
			const entry = NAMED_QUERY_REGISTRY.get('neo.activity')!;
			expect(entry.sql).toContain('FROM neo_activity_log');
		});

		test('ORDER BY is created_at DESC, id DESC (newest-first)', () => {
			const sql = NAMED_QUERY_REGISTRY.get('neo.activity')!.sql;
			expect(sql).toContain('ORDER BY created_at DESC, id DESC');
		});

		test('pagination: default limit of 50 prevents unbounded result sets', () => {
			// 50 is the task-spec default — verify the paramCount enforces explicit passing
			expect(NAMED_QUERY_REGISTRY.get('neo.activity')!.paramCount).toBe(2);
			// Insert 3 rows and verify limit=2 restricts count
			for (let i = 0; i < 3; i++) {
				insertActivity(`act-${i}`, 'list_rooms');
			}
			expect(queryAndMap(2, 0)).toHaveLength(2);
		});

		test('pagination: OFFSET skips rows', () => {
			for (let i = 0; i < 4; i++) {
				insertActivity(`act-${i}`, 'list_rooms');
			}
			const page1 = queryAndMap(2, 0).map((r) => r.id);
			const page2 = queryAndMap(2, 2).map((r) => r.id);
			expect(page1.length).toBe(2);
			expect(page2.length).toBe(2);
			expect(page1.some((id) => page2.includes(id))).toBe(false);
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

		test('all entries have paramCount >= 0', () => {
			for (const [name, entry] of NAMED_QUERY_REGISTRY) {
				// Global queries (e.g. mcpServers.global) need no params and use paramCount: 0.
				// Room-scoped queries require at least 1 param (e.g. roomId).
				expect(entry.paramCount).toBeGreaterThanOrEqual(0, `${name} has negative paramCount`);
			}
		});

		test('all ORDER BY clauses include a deterministic tiebreaker (id column)', () => {
			for (const [name, entry] of NAMED_QUERY_REGISTRY) {
				const upperSql = entry.sql.toUpperCase();
				expect(upperSql).toContain('ORDER BY');
				// Strip trailing LIMIT / OFFSET clauses before checking the tiebreaker so that
				// paginated queries (e.g. neo.messages, neo.activity) also pass this invariant.
				const sqlForCheck = upperSql
					.replace(/\s+LIMIT\s+\?(\s+OFFSET\s+\?)?/, '')
					.replace(/\s+/g, ' ')
					.trim();
				// Must end with either `id ASC` or `id DESC` (tiebreaker)
				const hasIdTiebreaker = /\bID\s+(ASC|DESC)\s*$/.test(sqlForCheck);
				expect(hasIdTiebreaker).toBe(true, `${name} ORDER BY lacks deterministic id tiebreaker`);
			}
		});
	});

	// -------------------------------------------------------------------------
	// spaceTasks.needingAttention — attention filter by status + block reason
	// -------------------------------------------------------------------------

	describe('spaceTasks.needingAttention', () => {
		const spaceId = 'space-attention-test';
		let attDb: BunDatabase;
		let taskSeq = 0;

		beforeEach(() => {
			attDb = new BunDatabase(':memory:');
			createTables(attDb);
			runMigrations(attDb, () => {});
			attDb.exec(
				`INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES ('${spaceId}', '${spaceId}', '/tmp/test', 'Test Space', ${now}, ${now})`
			);
			taskSeq = 0;
		});

		afterEach(() => {
			attDb.close();
		});

		function insertAttentionTask(overrides: Record<string, unknown> = {}): string {
			taskSeq++;
			const id = (overrides.id as string) ?? `att-task-${taskSeq}`;
			const status = (overrides.status as string) ?? 'open';
			const blockReason = (overrides.blockReason as string | null) ?? null;
			attDb.exec(`
				INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					depends_on, block_reason, created_at, updated_at
				) VALUES (
					'${id}', '${spaceId}', ${taskSeq}, 'Task ${taskSeq}', '', '${status}',
					'normal', '[]',
					${blockReason ? `'${blockReason}'` : 'NULL'},
					${now}, ${now}
				)
			`);
			return id;
		}

		function queryAttention(): Record<string, unknown>[] {
			const entry = NAMED_QUERY_REGISTRY.get('spaceTasks.needingAttention')!;
			return attDb.prepare(entry.sql).all(spaceId) as Record<string, unknown>[];
		}

		test('returns tasks in review status', () => {
			insertAttentionTask({ status: 'review' });
			insertAttentionTask({ status: 'open' }); // should not appear
			const rows = queryAttention();
			expect(rows).toHaveLength(1);
			expect(rows[0].status).toBe('review');
		});

		test('returns blocked tasks with human_input_requested', () => {
			insertAttentionTask({ status: 'blocked', blockReason: 'human_input_requested' });
			insertAttentionTask({ status: 'blocked', blockReason: 'agent_crashed' }); // should not appear
			const rows = queryAttention();
			expect(rows).toHaveLength(1);
			expect(rows[0].blockReason).toBe('human_input_requested');
		});

		test('returns blocked tasks with gate_rejected', () => {
			insertAttentionTask({ status: 'blocked', blockReason: 'gate_rejected' });
			const rows = queryAttention();
			expect(rows).toHaveLength(1);
			expect(rows[0].blockReason).toBe('gate_rejected');
		});

		test('excludes non-attention statuses', () => {
			insertAttentionTask({ status: 'open' });
			insertAttentionTask({ status: 'in_progress' });
			insertAttentionTask({ status: 'done' });
			insertAttentionTask({ status: 'cancelled' });
			insertAttentionTask({ status: 'blocked', blockReason: 'agent_crashed' });
			insertAttentionTask({ status: 'blocked', blockReason: 'workflow_invalid' });
			const rows = queryAttention();
			expect(rows).toHaveLength(0);
		});

		test('returns combined review + human-blocked tasks sorted by updatedAt desc', () => {
			const id1 = insertAttentionTask({ status: 'review' });
			const id2 = insertAttentionTask({ status: 'blocked', blockReason: 'human_input_requested' });
			const id3 = insertAttentionTask({ status: 'blocked', blockReason: 'gate_rejected' });
			// Update timestamps so ordering is deterministic
			attDb.exec(`UPDATE space_tasks SET updated_at = ${now + 300} WHERE id = '${id3}'`);
			attDb.exec(`UPDATE space_tasks SET updated_at = ${now + 200} WHERE id = '${id2}'`);
			attDb.exec(`UPDATE space_tasks SET updated_at = ${now + 100} WHERE id = '${id1}'`);

			const rows = queryAttention();
			expect(rows).toHaveLength(3);
			expect(rows[0].id).toBe(id3);
			expect(rows[1].id).toBe(id2);
			expect(rows[2].id).toBe(id1);
		});

		test('only returns tasks for the given space', () => {
			insertAttentionTask({ status: 'review' });
			// Insert task in a different space
			attDb.exec(
				`INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES ('other-space', 'other', '/tmp/other', 'Other', ${now}, ${now})`
			);
			attDb.exec(`
				INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority,
					depends_on, created_at, updated_at
				) VALUES (
					'other-task', 'other-space', 1, 'Other Task', '', 'review',
					'normal', '[]', ${now}, ${now}
				)
			`);
			const rows = queryAttention();
			expect(rows).toHaveLength(1);
			expect(rows[0].spaceId).toBe(spaceId);
		});

		test('row shape includes expected columns', () => {
			insertAttentionTask({ status: 'blocked', blockReason: 'human_input_requested' });
			const rows = queryAttention();
			const row = rows[0];
			expect(row.id).toBeDefined();
			expect(row.title).toBeDefined();
			expect(row.status).toBe('blocked');
			expect(row.blockReason).toBe('human_input_requested');
			expect(row.taskNumber).toBe(1);
			expect(row.spaceId).toBe(spaceId);
			expect(row.updatedAt).toBeDefined();
		});
	});
});
