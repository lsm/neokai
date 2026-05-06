/**
 * Migration 118 Tests — Task-thread message projection.
 *
 * Migration 118 introduces a materialised projection table
 * `task_thread_messages` keyed on `(task_id, source, source_id)` that pre-
 * computes the per-task timeline used by the
 * `spaceTaskMessages.byTask` and `spaceTaskMessages.byTask.compact` LiveQuery
 * feeds. Triggers fan out source-table writes (sdk_messages,
 * space_github_events, node_executions, space_tasks) into the projection so
 * reads become a single indexed scan.
 *
 * Covers:
 *   - Table + indexes are created.
 *   - Backfill correctly projects pre-existing sdk_messages for orchestration
 *     and node-agent legs.
 *   - Backfill projects pre-existing space_github_events (only for routed/
 *     delivered events).
 *   - Re-running the migration is a no-op (idempotent).
 *   - INSERT trigger fans new sdk_messages into the projection.
 *   - DELETE trigger clears projection rows when sdk_messages are removed
 *     (rewind/replay path).
 *   - UPDATE trigger refreshes projection content when an sdk_message row is
 *     modified.
 *   - node_executions UPDATE trigger projects messages once the node binds to
 *     a session (agent_session_id flips from NULL).
 *   - space_tasks DELETE trigger cascades projection cleanup.
 *   - User rows in `deferred` send_status are excluded from the projection
 *     (the historic compact-feed visibility predicate).
 *   - The `is_renderable` flag is computed correctly for tool_result-only
 *     user rows and empty assistant rows.
 *   - The `is_terminal` flag is set on result rows.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigration74 } from '../../../../../src/storage/schema/index.ts';
import { runMigration118 } from '../../../../../src/storage/schema/migrations.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(db: BunDatabase, name: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function indexExists(db: BunDatabase, name: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function triggerExists(db: BunDatabase, name: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`).get(name);
}

function setupSpaceTables(db: BunDatabase, now: number): void {
	// `space_github_events` is created by `createTables`. We only need to add
	// the Space-side tables (spaces, space_agents, space_tasks) the migration's
	// triggers reference.
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
		 VALUES ('s1', 's1', '/tmp/test-117', 'Test', ${now}, ${now})`
	);
}

function insertSession(db: BunDatabase, id: string, type: string, isoNow: string): void {
	db.exec(`
		INSERT INTO sessions (
			id, title, workspace_path, created_at, last_active_at, status, config, metadata,
			is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id,
			available_commands, processing_state, archived_at, type, session_context
		) VALUES (
			'${id}', 'Session', '/tmp/test-117', '${isoNow}', '${isoNow}', 'active', '{}', '{}',
			0, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '${type}', '{}'
		)
	`);
}

function insertSpaceTask(
	db: BunDatabase,
	opts: {
		id: string;
		title: string;
		taskAgentSessionId?: string | null;
		workflowRunId?: string | null;
		now: number;
	}
): void {
	db.exec(`
		INSERT INTO space_tasks (
			id, space_id, task_number, title, description, status, priority, assigned_agent,
			agent_name, workflow_run_id, workflow_node_id, task_agent_session_id, depends_on,
			created_at, updated_at
		) VALUES (
			'${opts.id}', 's1', 1, '${opts.title}', 'Desc', 'in_progress', 'normal', 'coder',
			NULL,
			${opts.workflowRunId ? `'${opts.workflowRunId}'` : 'NULL'},
			NULL,
			${opts.taskAgentSessionId ? `'${opts.taskAgentSessionId}'` : 'NULL'},
			'[]', ${opts.now}, ${opts.now}
		)
	`);
}

function insertSdkMessage(
	db: BunDatabase,
	opts: {
		id: string;
		sessionId: string;
		messageType?: string;
		payload?: Record<string, unknown>;
		isoNow: string;
		sendStatus?: string;
	}
): void {
	const messageType = opts.messageType ?? 'assistant';
	const payload =
		opts.payload ??
		({
			type: 'assistant',
			uuid: opts.id,
			message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
		} as Record<string, unknown>);
	const sendStatus = opts.sendStatus ?? 'consumed';
	db.exec(`
		INSERT INTO sdk_messages (
			id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin
		) VALUES (
			'${opts.id}', '${opts.sessionId}', '${messageType}', NULL,
			'${JSON.stringify(payload).replace(/'/g, "''")}',
			'${opts.isoNow}', '${sendStatus}', 'system'
		)
	`);
}

interface ProjRow {
	task_id: string;
	source: string;
	source_id: string;
	session_id: string | null;
	node_execution_id: string | null;
	kind: string;
	role: string;
	label: string;
	task_title: string;
	message_type: string;
	is_terminal: number;
	is_renderable: number;
	iteration: number;
}

function readProjection(db: BunDatabase, taskId: string): ProjRow[] {
	return db
		.prepare(
			`SELECT task_id, source, source_id, session_id, node_execution_id, kind, role,
			        label, task_title, message_type, is_terminal, is_renderable, iteration
			   FROM task_thread_messages
			  WHERE task_id = ?
			  ORDER BY proj_id ASC`
		)
		.all(taskId) as ProjRow[];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Migration 118 — task_thread_messages projection', () => {
	let db: BunDatabase;
	const now = Date.now();
	const isoNow = new Date(now).toISOString();

	beforeEach(() => {
		db = new BunDatabase(':memory:');
		createTables(db);
		runMigration74(db);
		setupSpaceTables(db, now);
	});

	afterEach(() => {
		db.close();
	});

	// -------------------------------------------------------------------------
	// Schema creation
	// -------------------------------------------------------------------------

	test('creates task_thread_messages table', () => {
		expect(tableExists(db, 'task_thread_messages')).toBe(false);
		runMigration118(db);
		expect(tableExists(db, 'task_thread_messages')).toBe(true);
	});

	test('creates expected indexes', () => {
		runMigration118(db);
		expect(indexExists(db, 'idx_ttm_task_created')).toBe(true);
		expect(indexExists(db, 'idx_ttm_task_session_created')).toBe(true);
		expect(indexExists(db, 'idx_ttm_session_created')).toBe(true);
		expect(indexExists(db, 'idx_ttm_source')).toBe(true);
	});

	test('creates expected triggers when full schema is present', () => {
		runMigration118(db);
		expect(triggerExists(db, 'trg_ttm_after_insert_sdk')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_update_sdk')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_delete_sdk')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_insert_github')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_update_github')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_delete_github')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_update_space_task')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_delete_space_task')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_insert_node_exec')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_update_node_exec')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_delete_node_exec')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_update_space_agent')).toBe(true);
	});

	test('skips trigger creation when space_tasks is missing (partial schema)', () => {
		db.close();
		db = new BunDatabase(':memory:');
		createTables(db);
		runMigration74(db);
		// Don't call setupSpaceTables — space_tasks is absent
		runMigration118(db);
		// Table should be created but triggers should be skipped
		expect(tableExists(db, 'task_thread_messages')).toBe(true);
		expect(triggerExists(db, 'trg_ttm_after_insert_sdk')).toBe(false);
	});

	test('idempotent — re-running the migration is a no-op', () => {
		runMigration118(db);
		expect(() => runMigration118(db)).not.toThrow();
		expect(tableExists(db, 'task_thread_messages')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Backfill — orchestration leg (task_agent_session_id)
	// -------------------------------------------------------------------------

	test('backfill projects orchestration sdk_messages for an existing task', () => {
		const sessionId = 'session-orch-1';
		const taskId = 'task-1';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Build it', taskAgentSessionId: sessionId, now });
		insertSdkMessage(db, { id: 'sdk-1', sessionId, isoNow });
		insertSdkMessage(db, { id: 'sdk-2', sessionId, isoNow });

		runMigration118(db);

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(2);
		expect(rows[0].task_id).toBe(taskId);
		expect(rows[0].kind).toBe('task_agent');
		expect(rows[0].label).toBe('Task Agent');
		expect(rows[0].task_title).toBe('Build it');
		expect(rows[0].source).toBe('sdk');
	});

	test('backfill skips deferred user messages (send_status = "deferred")', () => {
		const sessionId = 'session-deferred-1';
		const taskId = 'task-def';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Wait', taskAgentSessionId: sessionId, now });
		insertSdkMessage(db, {
			id: 'user-deferred',
			sessionId,
			isoNow,
			messageType: 'user',
			payload: {
				type: 'user',
				uuid: 'user-deferred',
				message: { role: 'user', content: 'Pending input' },
			},
			sendStatus: 'deferred',
		});

		runMigration118(db);

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(0);
	});

	test('backfill projects github events with state in (routed, delivered)', () => {
		const taskId = 'task-gh';
		insertSpaceTask(db, { id: taskId, title: 'PR review', now });
		const baseGhCols = `id, space_id, task_id, source, delivery_id, event_type, action,
			repo_owner, repo_name, pr_number, pr_url, actor, actor_type, body, summary,
			external_url, external_id, occurred_at, dedupe_key, raw_payload, state,
			created_at, updated_at`;
		const ghValues = (id: string, state: string, summary: string, occurredAt: number): string =>
			`('${id}', 's1', '${taskId}', 'webhook', '${id}', 'pull_request', 'opened',
			  'org', 'r', 1, 'https://example/${id}', 'bot', 'User',
			  '', '${summary}', 'https://example/${id}', '${id}', ${occurredAt}, '${id}',
			  '{}', '${state}', ${now}, ${now})`;
		db.exec(`
			INSERT INTO space_github_events (${baseGhCols}) VALUES
				${ghValues('gh-pending', 'received', 'Pending', now + 10)},
				${ghValues('gh-routed', 'routed', 'Routed event', now + 20)},
				${ghValues('gh-delivered', 'delivered', 'Delivered event', now + 30)}
		`);

		runMigration118(db);

		const rows = readProjection(db, taskId);
		expect(rows.map((r) => r.source_id).sort()).toEqual(['gh-delivered', 'gh-routed']);
		expect(rows.every((r) => r.kind === 'github')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// INSERT trigger
	// -------------------------------------------------------------------------

	test('AFTER INSERT trigger projects new sdk_messages into the projection', () => {
		const sessionId = 'session-insert-1';
		const taskId = 'task-ins';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Trig insert', taskAgentSessionId: sessionId, now });

		runMigration118(db);
		expect(readProjection(db, taskId)).toHaveLength(0);

		insertSdkMessage(db, { id: 'live-1', sessionId, isoNow });
		insertSdkMessage(db, { id: 'live-2', sessionId, isoNow });

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.source_id).sort()).toEqual(['live-1', 'live-2']);
	});

	test('AFTER INSERT trigger excludes deferred user rows', () => {
		const sessionId = 'session-insert-deferred';
		const taskId = 'task-ins-def';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 't', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, {
			id: 'user-pending',
			sessionId,
			isoNow,
			messageType: 'user',
			payload: { type: 'user', uuid: 'user-pending', message: { role: 'user', content: 'Hi' } },
			sendStatus: 'deferred',
		});

		expect(readProjection(db, taskId)).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// DELETE trigger
	// -------------------------------------------------------------------------

	test('AFTER DELETE trigger removes projection rows for deleted sdk_messages', () => {
		const sessionId = 'session-delete-1';
		const taskId = 'task-del';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Wipe', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, { id: 'rm-1', sessionId, isoNow });
		insertSdkMessage(db, { id: 'rm-2', sessionId, isoNow });
		expect(readProjection(db, taskId)).toHaveLength(2);

		db.exec(`DELETE FROM sdk_messages WHERE id = 'rm-1'`);
		const remaining = readProjection(db, taskId);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].source_id).toBe('rm-2');
	});

	// -------------------------------------------------------------------------
	// UPDATE trigger
	// -------------------------------------------------------------------------

	test('AFTER UPDATE trigger reflects changes in projection content', () => {
		const sessionId = 'session-update-1';
		const taskId = 'task-upd';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Mutating', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, {
			id: 'mut-1',
			sessionId,
			isoNow,
			messageType: 'user',
			payload: { type: 'user', uuid: 'mut-1', message: { role: 'user', content: 'pending' } },
			sendStatus: 'deferred',
		});
		// Deferred row is filtered out
		expect(readProjection(db, taskId)).toHaveLength(0);

		// Promote to consumed — UPDATE trigger should re-project
		db.exec(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = 'mut-1'`);
		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].source_id).toBe('mut-1');
	});

	// -------------------------------------------------------------------------
	// node_executions trigger — late session binding
	// -------------------------------------------------------------------------

	test('node_executions trigger projects messages once agent_session_id is set', () => {
		const orchSessionId = 'orch-session-node';
		const nodeSessionId = 'node-session-node';
		const workflowRunId = 'wr-node-1';
		const taskId = 'task-node-1';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, nodeSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Coder leg',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		runMigration118(db);

		// Insert a node_execution without agent_session_id first; no projection yet.
		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES (
				'ne-late', '${workflowRunId}', 'node-1', 'coder', NULL,
				NULL, 'pending', NULL, ${now}, NULL, NULL, ${now}
			)
		`);

		// Pre-existing messages on the node session are projected through the
		// orchestration leg only (none here) — node leg waits for the binding.
		insertSdkMessage(db, { id: 'node-msg-1', sessionId: nodeSessionId, isoNow });
		expect(readProjection(db, taskId)).toHaveLength(0);

		// Now bind the node execution to the session — UPDATE trigger should
		// project the node-leg messages.
		db.exec(
			`UPDATE node_executions SET agent_session_id = '${nodeSessionId}' WHERE id = 'ne-late'`
		);

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('node_agent');
		expect(rows[0].source_id).toBe('node-msg-1');
		expect(rows[0].node_execution_id).toBe('ne-late');
	});

	// -------------------------------------------------------------------------
	// node_executions DELETE — re-project when session is shared
	// -------------------------------------------------------------------------

	test('node_executions DELETE re-projects rows from a surviving execution sharing the session', () => {
		const orchSessionId = 'orch-session-share';
		const sharedSessionId = 'shared-node-session';
		const workflowRunId = 'wr-share-1';
		const taskId = 'task-share-1';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, sharedSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Reused-session task',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		runMigration118(db);

		// First execution claims the session and projects messages.
		// TaskAgentManager re-uses the same agent_session_id across executions
		// for a named agent — see task-agent-manager.ts createSubSession reuse
		// path. We model that here with two node_executions pointing at the same
		// session id.
		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES
			('ne-1', '${workflowRunId}', 'node-1', 'coder', NULL,
				'${sharedSessionId}', 'done', NULL, ${now}, ${now}, ${now}, ${now}),
			('ne-2', '${workflowRunId}', 'node-1', 'coder', NULL,
				'${sharedSessionId}', 'in_progress', NULL, ${now + 1}, ${now + 1}, NULL, ${now + 1})
		`);

		insertSdkMessage(db, { id: 'shared-msg-1', sessionId: sharedSessionId, isoNow });
		insertSdkMessage(db, { id: 'shared-msg-2', sessionId: sharedSessionId, isoNow });

		// First-insert wins on (task_id, source, source_id) — both rows are
		// attributed to whichever node_execution was created first (ne-1).
		const beforeDelete = readProjection(db, taskId);
		expect(beforeDelete).toHaveLength(2);
		expect(beforeDelete.every((r) => r.node_execution_id === 'ne-1')).toBe(true);

		// Delete ne-1 — naive trigger would orphan both messages even though
		// ne-2 still references the same session. With the re-projection step,
		// the rows survive but are now attributed to ne-2.
		db.exec(`DELETE FROM node_executions WHERE id = 'ne-1'`);

		const afterDelete = readProjection(db, taskId);
		expect(afterDelete).toHaveLength(2);
		expect(afterDelete.every((r) => r.node_execution_id === 'ne-2')).toBe(true);
		const sourceIds = afterDelete.map((r) => r.source_id).sort();
		expect(sourceIds).toEqual(['shared-msg-1', 'shared-msg-2']);
	});

	test('node_executions DELETE drops rows when no surviving execution shares the session', () => {
		const orchSessionId = 'orch-session-solo';
		const soloSessionId = 'solo-node-session';
		const workflowRunId = 'wr-solo-1';
		const taskId = 'task-solo-1';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, soloSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Single-execution task',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		runMigration118(db);

		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES
			('ne-solo', '${workflowRunId}', 'node-1', 'coder', NULL,
				'${soloSessionId}', 'done', NULL, ${now}, ${now}, ${now}, ${now})
		`);

		insertSdkMessage(db, { id: 'solo-msg-1', sessionId: soloSessionId, isoNow });
		expect(readProjection(db, taskId)).toHaveLength(1);

		db.exec(`DELETE FROM node_executions WHERE id = 'ne-solo'`);

		// No surviving execution → re-projection finds no source row, so the
		// projection ends up empty. (Hard-delete is the right behaviour when
		// nothing else owns the session.)
		expect(readProjection(db, taskId)).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// space_tasks DELETE trigger
	// -------------------------------------------------------------------------

	test('space_tasks DELETE trigger cascades projection cleanup', () => {
		const sessionId = 'session-task-del';
		const taskId = 'task-killme';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Soon dead', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, { id: 'die-1', sessionId, isoNow });
		insertSdkMessage(db, { id: 'die-2', sessionId, isoNow });
		expect(readProjection(db, taskId)).toHaveLength(2);

		db.exec(`DELETE FROM space_tasks WHERE id = '${taskId}'`);
		expect(readProjection(db, taskId)).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// is_terminal / is_renderable derivation
	// -------------------------------------------------------------------------

	test('is_terminal flag is set on result rows', () => {
		const sessionId = 'session-terminal';
		const taskId = 'task-term';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Terminal', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, { id: 'asst-1', sessionId, isoNow });
		insertSdkMessage(db, {
			id: 'res-1',
			sessionId,
			isoNow,
			messageType: 'result',
			payload: {
				type: 'result',
				uuid: 'res-1',
				subtype: 'success',
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				total_cost_usd: 0,
			},
		});

		const rows = readProjection(db, taskId);
		const asst = rows.find((r) => r.source_id === 'asst-1')!;
		const res = rows.find((r) => r.source_id === 'res-1')!;
		expect(asst.is_terminal).toBe(0);
		expect(res.is_terminal).toBe(1);
	});

	test('is_renderable = 0 for user rows that are exclusively tool_result blocks', () => {
		const sessionId = 'session-render';
		const taskId = 'task-render';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Render', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, {
			id: 'tool-result-only',
			sessionId,
			isoNow,
			messageType: 'user',
			payload: {
				type: 'user',
				uuid: 'tool-result-only',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }],
				},
			},
		});

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].is_renderable).toBe(0);
	});

	test('is_renderable = 1 for user rows with mixed tool_result + text blocks', () => {
		const sessionId = 'session-render-mix';
		const taskId = 'task-render-mix';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'RenderMix', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, {
			id: 'mixed-content',
			sessionId,
			isoNow,
			messageType: 'user',
			payload: {
				type: 'user',
				uuid: 'mixed-content',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 't1', content: 'output' },
						{ type: 'text', text: 'hello' },
					],
				},
			},
		});

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].is_renderable).toBe(1);
	});

	test('is_renderable = 1 for normal assistant/text rows', () => {
		const sessionId = 'session-render-2';
		const taskId = 'task-render-2';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Render2', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, { id: 'asst-render', sessionId, isoNow });

		const rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].is_renderable).toBe(1);
	});

	test('iteration is extracted from _taskMeta.iteration in payload', () => {
		const sessionId = 'session-iter';
		const taskId = 'task-iter';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Iter', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, {
			id: 'iter-1',
			sessionId,
			isoNow,
			payload: {
				type: 'assistant',
				uuid: 'iter-1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'go' }] },
				_taskMeta: { iteration: 7 },
			},
		});

		const rows = readProjection(db, taskId);
		expect(rows[0].iteration).toBe(7);
	});

	test('iteration defaults to 0 when _taskMeta.iteration is absent', () => {
		const sessionId = 'session-iter-default';
		const taskId = 'task-iter-default';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'IterDef', taskAgentSessionId: sessionId, now });
		runMigration118(db);

		insertSdkMessage(db, { id: 'plain', sessionId, isoNow });

		const rows = readProjection(db, taskId);
		expect(rows[0].iteration).toBe(0);
	});

	// -------------------------------------------------------------------------
	// space_tasks UPDATE — session re-linking
	// -------------------------------------------------------------------------

	test('space_tasks UPDATE re-projects when task_agent_session_id changes', () => {
		const sessionA = 'session-a';
		const sessionB = 'session-b';
		const taskId = 'task-relink';

		insertSession(db, sessionA, 'space_task_agent', isoNow);
		insertSession(db, sessionB, 'space_task_agent', isoNow);
		insertSpaceTask(db, { id: taskId, title: 'Relink', taskAgentSessionId: sessionA, now });
		runMigration118(db);

		insertSdkMessage(db, { id: 'a-msg', sessionId: sessionA, isoNow });
		insertSdkMessage(db, { id: 'b-msg', sessionId: sessionB, isoNow });

		// Initially only sessionA messages are projected
		let rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].source_id).toBe('a-msg');

		// Re-link the task to sessionB
		db.exec(`UPDATE space_tasks SET task_agent_session_id = '${sessionB}' WHERE id = '${taskId}'`);
		rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].source_id).toBe('b-msg');
	});

	test('space_tasks UPDATE of unrelated columns is a no-op on the projection', () => {
		const sessionId = 'session-noop-up';
		const taskId = 'task-noop-up';

		insertSession(db, sessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'NoopUp',
			taskAgentSessionId: sessionId,
			now,
		});
		runMigration118(db);

		insertSdkMessage(db, { id: 'noop-up-msg', sessionId, isoNow });
		const before = readProjection(db, taskId);
		expect(before).toHaveLength(1);
		expect(before[0].source_id).toBe('noop-up-msg');

		// Change status — not in the WHEN clause, so trigger should be a no-op.
		db.exec(`UPDATE space_tasks SET status = 'completed' WHERE id = '${taskId}'`);
		const after = readProjection(db, taskId);
		expect(after).toHaveLength(1);
		expect(after[0].source_id).toBe('noop-up-msg');
	});

	// -------------------------------------------------------------------------
	// space_agents UPDATE — node-agent label refresh
	// -------------------------------------------------------------------------

	test('space_agents UPDATE OF name refreshes labels on owned node-agent rows', () => {
		const orchSessionId = 'orch-session-rename';
		const nodeSessionId = 'node-session-rename';
		const workflowRunId = 'wr-rename-1';
		const taskId = 'task-rename-1';
		const agentId = 'agent-rename';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, nodeSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Rename leg',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		db.exec(
			`INSERT INTO space_agents (id, space_id, name) VALUES ('${agentId}', 's1', 'Old Name')`
		);
		runMigration118(db);

		// Bind a node_execution to the agent and a session, then push a message.
		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES (
				'ne-rename', '${workflowRunId}', 'node-1', 'fallback', '${agentId}',
				'${nodeSessionId}', 'in_progress', NULL, ${now}, ${now}, NULL, ${now}
			)
		`);
		insertSdkMessage(db, { id: 'rename-msg-1', sessionId: nodeSessionId, isoNow });

		// Initial projection picks up the original name.
		let rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe('Old Name');

		// Rename the agent — trigger should refresh the label in place.
		db.exec(`UPDATE space_agents SET name = 'New Name' WHERE id = '${agentId}'`);
		rows = readProjection(db, taskId);
		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe('New Name');
		expect(rows[0].source_id).toBe('rename-msg-1');
	});

	test('space_agents UPDATE OF name updates the projection in place (no row churn)', () => {
		const orchSessionId = 'orch-session-stable';
		const nodeSessionId = 'node-session-stable';
		const workflowRunId = 'wr-stable-1';
		const taskId = 'task-stable-1';
		const agentId = 'agent-stable';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, nodeSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Stable proj_id',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		db.exec(
			`INSERT INTO space_agents (id, space_id, name) VALUES ('${agentId}', 's1', 'First Name')`
		);
		runMigration118(db);

		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES (
				'ne-stable', '${workflowRunId}', 'node-1', 'fallback', '${agentId}',
				'${nodeSessionId}', 'in_progress', NULL, ${now}, ${now}, NULL, ${now}
			)
		`);
		insertSdkMessage(db, { id: 'stable-msg-1', sessionId: nodeSessionId, isoNow });

		const before = db
			.prepare(
				`SELECT proj_id, label FROM task_thread_messages WHERE task_id = ? AND source_id = ?`
			)
			.get(taskId, 'stable-msg-1') as { proj_id: number; label: string };
		expect(before.label).toBe('First Name');

		// Rename — projection should refresh in place. The proj_id stays the same
		// (UPDATE not DELETE+INSERT) so existing LiveQuery readers don't see a
		// row churn — just a cell-level update.
		db.exec(`UPDATE space_agents SET name = 'Second Name' WHERE id = '${agentId}'`);
		const after = db
			.prepare(
				`SELECT proj_id, label FROM task_thread_messages WHERE task_id = ? AND source_id = ?`
			)
			.get(taskId, 'stable-msg-1') as { proj_id: number; label: string };
		expect(after.label).toBe('Second Name');
		expect(after.proj_id).toBe(before.proj_id);
	});

	test('space_agents UPDATE leaves orchestration and github rows untouched', () => {
		const orchSessionId = 'orch-session-iso';
		const nodeSessionId = 'node-session-iso';
		const workflowRunId = 'wr-iso-1';
		const taskId = 'task-iso-1';
		const agentId = 'agent-iso';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, nodeSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Isolation',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		db.exec(
			`INSERT INTO space_agents (id, space_id, name) VALUES ('${agentId}', 's1', 'Original')`
		);
		runMigration118(db);

		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES (
				'ne-iso', '${workflowRunId}', 'node-1', 'coder', '${agentId}',
				'${nodeSessionId}', 'in_progress', NULL, ${now}, ${now}, NULL, ${now}
			)
		`);

		// Project: an orchestration message, a node-agent message, and a github
		// event. Only the node-agent row should change after the rename.
		insertSdkMessage(db, { id: 'orch-iso-1', sessionId: orchSessionId, isoNow });
		insertSdkMessage(db, { id: 'node-iso-1', sessionId: nodeSessionId, isoNow });
		const baseGhCols = `id, space_id, task_id, source, delivery_id, event_type, action,
			repo_owner, repo_name, pr_number, pr_url, actor, actor_type, body, summary,
			external_url, external_id, occurred_at, dedupe_key, raw_payload, state,
			created_at, updated_at`;
		db.exec(`
			INSERT INTO space_github_events (${baseGhCols}) VALUES (
				'gh-iso-1', 's1', '${taskId}', 'webhook', 'gh-iso-1', 'pull_request', 'opened',
				'org', 'r', 1, 'https://example/iso', 'bot', 'User',
				'', 'Opened PR', 'https://example/iso', 'gh-iso-1', ${now}, 'gh-iso-1',
				'{}', 'routed', ${now}, ${now}
			)
		`);

		const before = readProjection(db, taskId);
		expect(before).toHaveLength(3);
		const beforeOrch = before.find((r) => r.kind === 'task_agent');
		const beforeNode = before.find((r) => r.kind === 'node_agent');
		const beforeGh = before.find((r) => r.kind === 'github');
		expect(beforeOrch).toBeDefined();
		expect(beforeNode).toBeDefined();
		expect(beforeGh).toBeDefined();
		expect(beforeOrch?.label).toBe('Task Agent');
		expect(beforeNode?.label).toBe('Original');
		expect(beforeGh?.label).toBe('GitHub');

		db.exec(`UPDATE space_agents SET name = 'Renamed' WHERE id = '${agentId}'`);

		const after = readProjection(db, taskId);
		expect(after).toHaveLength(3);
		const afterOrch = after.find((r) => r.kind === 'task_agent');
		const afterNode = after.find((r) => r.kind === 'node_agent');
		const afterGh = after.find((r) => r.kind === 'github');
		expect(afterOrch).toBeDefined();
		expect(afterNode).toBeDefined();
		expect(afterGh).toBeDefined();
		expect(afterOrch?.label).toBe('Task Agent');
		expect(afterNode?.label).toBe('Renamed');
		expect(afterGh?.label).toBe('GitHub');
	});

	test('space_agents UPDATE of unrelated columns does not modify the projection', () => {
		const orchSessionId = 'orch-session-noop';
		const nodeSessionId = 'node-session-noop';
		const workflowRunId = 'wr-noop-1';
		const taskId = 'task-noop-1';
		const agentId = 'agent-noop';

		insertSession(db, orchSessionId, 'space_task_agent', isoNow);
		insertSession(db, nodeSessionId, 'space_task_agent', isoNow);
		insertSpaceTask(db, {
			id: taskId,
			title: 'Noop',
			taskAgentSessionId: orchSessionId,
			workflowRunId,
			now,
		});
		// Add a description column for the noop UPDATE below.
		db.exec(`ALTER TABLE space_agents ADD COLUMN description TEXT`);
		db.exec(
			`INSERT INTO space_agents (id, space_id, name, description) VALUES ('${agentId}', 's1', 'Stable', 'old desc')`
		);
		runMigration118(db);

		db.exec(`
			INSERT INTO node_executions (
				id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				agent_session_id, status, result, created_at, started_at,
				completed_at, updated_at
			) VALUES (
				'ne-noop', '${workflowRunId}', 'node-1', 'coder', '${agentId}',
				'${nodeSessionId}', 'in_progress', NULL, ${now}, ${now}, NULL, ${now}
			)
		`);
		insertSdkMessage(db, { id: 'noop-msg-1', sessionId: nodeSessionId, isoNow });

		const before = readProjection(db, taskId);
		expect(before[0].label).toBe('Stable');

		// Update an unrelated column — the trigger is `OF name`, so this must be
		// a no-op (the WHEN guard would also reject same-name updates anyway).
		db.exec(`UPDATE space_agents SET description = 'new desc' WHERE id = '${agentId}'`);
		const after = readProjection(db, taskId);
		expect(after[0].label).toBe('Stable');
	});
});
