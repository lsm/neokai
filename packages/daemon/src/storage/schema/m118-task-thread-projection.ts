/**
 * Migration 118 — Materialise the task-thread message projection.
 *
 * Until this migration the LiveQuery feeds `spaceTaskMessages.byTask` and
 * `spaceTaskMessages.byTask.compact` rebuilt the per-task timeline on every
 * read by joining `space_tasks` → `sessions` / `node_executions` →
 * `sdk_messages` (plus a github leg) and applying window functions for turn
 * grouping, terminal/renderable classification, and per-turn caps. That
 * round trip touches the full session history and re-parses every
 * `sdk_message` JSON blob; on long workflow runs it dominates feed
 * re-evaluation latency.
 *
 * The projection lifts the join + JSON work to *write* time. Each
 * `sdk_message` and `space_github_event` is fanned out into one row per
 * matching task in `task_thread_messages` with the derived shape the feed
 * needs: role/label/title/kind/origin, plus pre-computed `is_terminal` and
 * `is_renderable` flags, plus the cached `iteration` and
 * `parent_tool_use_id`. Reads then become indexed scans of one task's worth
 * of rows with simple window functions for turn grouping.
 *
 * Maintenance is via SQLite triggers (no application-level hooks needed):
 *   - sdk_messages INSERT/UPDATE/DELETE → fan-out / refresh / clear.
 *   - space_github_events INSERT/UPDATE/DELETE → github leg.
 *   - space_tasks INSERT → project existing sdk_messages / github events when
 *     a task is created with session linkage already present.
 *   - space_tasks UPDATE (task_agent_session_id / workflow_run_id / title)
 *     → reproject when session linkage moves.
 *   - node_executions UPDATE (agent_session_id / workflow_run_id / agent_id /
 *     agent_name) → reproject when a node binds to a session, or its
 *     workflow run / agent attribution changes.
 *   - space_tasks DELETE → cascading clear.
 *   - node_executions DELETE → clear node-leg projection rows.
 *   - space_agents UPDATE OF name → refresh node-agent labels for projection
 *     rows owned by executions of the renamed agent.
 *
 * The projection key `(task_id, source, source_id)` is unique so the same
 * source row can never produce duplicates, even if a task's session
 * linkage changes mid-flight (the trigger always deletes-then-reinserts).
 *
 * Rewinds and replays are handled implicitly: `deleteMessagesAfter` /
 * `deleteMessagesAtAndAfter` issue plain `DELETE FROM sdk_messages` which
 * fires the AFTER DELETE trigger and clears the matching projection rows.
 *
 * Backfill: any pre-existing `sdk_messages` / `space_github_events` are
 * projected once at migration time using the same join semantics as the
 * triggers. Re-running the migration is a no-op (the table + triggers are
 * idempotent and the unique constraint means backfill `INSERT OR IGNORE`s).
 */

import type { Database as BunDatabase } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS task_thread_messages (
  proj_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('sdk', 'github')),
  source_id TEXT NOT NULL,
  session_id TEXT,
  node_execution_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('task_agent', 'node_agent', 'github')),
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  task_title TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  origin TEXT,
  created_at INTEGER NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  parent_tool_use_id TEXT,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  is_renderable INTEGER NOT NULL DEFAULT 1,
  UNIQUE(task_id, source, source_id)
)
`.trim();

const INDEX_DDL: ReadonlyArray<string> = [
	`CREATE INDEX IF NOT EXISTS idx_ttm_task_created
	 ON task_thread_messages(task_id, created_at, source_id)`,
	`CREATE INDEX IF NOT EXISTS idx_ttm_task_session_created
	 ON task_thread_messages(task_id, session_id, created_at, source_id)`,
	`CREATE INDEX IF NOT EXISTS idx_ttm_session_created
	 ON task_thread_messages(session_id, created_at, source_id)`,
	`CREATE INDEX IF NOT EXISTS idx_ttm_source
	 ON task_thread_messages(source, source_id)`,
];

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

/**
 * Convert an ISO-8601 timestamp text column to milliseconds since the Unix
 * epoch, matching the `createdAt` shape the live-query SQL emits today.
 */
function tsMsExpr(timestampExpr: string): string {
	return `CAST((julianday(${timestampExpr}) - 2440587.5) * 86400000 AS INTEGER)`;
}

/**
 * Iteration metadata is attached to messages by the runtime via the
 * `_taskMeta.iteration` JSON field. Default to 0 when absent.
 */
function iterationExpr(jsonContentExpr: string): string {
	return `CAST(COALESCE(json_extract(${jsonContentExpr}, '$._taskMeta.iteration'), 0) AS INTEGER)`;
}

/**
 * Build the `is_renderable` boolean from the SDK message JSON.
 *
 * Mirrors the predicate inside the previous compact-feed CTE with one
 * alignment fix: user rows are non-renderable only when the content
 * array contains **exclusively** tool_result blocks (no visible text).
 * The original CTE inadvertently marked as non-renderable any user row
 * that contained even a single tool_result block, including rows with
 * mixed content (tool_result + text). That divergence is now corrected.
 *
 *   - User rows whose content is exclusively tool_result blocks are non-
 *     renderable (they render as null in compact UI).
 *   - Assistant rows whose content array exists but lacks any tool_use,
 *     non-empty text, or non-empty thinking block are non-renderable.
 *   - Everything else is renderable.
 */
function renderableExpr(typeExpr: string, jsonContentExpr: string): string {
	return `
CASE
  WHEN ${typeExpr} = 'user'
    AND json_type(${jsonContentExpr}, '$.message.content') = 'array'
    AND EXISTS (
      SELECT 1
      FROM json_each(json_extract(${jsonContentExpr}, '$.message.content')) AS je
      WHERE json_extract(je.value, '$.type') = 'tool_result'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(json_extract(${jsonContentExpr}, '$.message.content')) AS je
      WHERE json_extract(je.value, '$.type') = 'text'
        AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
    ) THEN 0
  WHEN ${typeExpr} = 'assistant'
    AND json_type(${jsonContentExpr}, '$.message.content') = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(json_extract(${jsonContentExpr}, '$.message.content')) AS je
      WHERE json_extract(je.value, '$.type') = 'tool_use'
         OR (
           json_extract(je.value, '$.type') = 'text'
           AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
         )
         OR (
           json_extract(je.value, '$.type') = 'thinking'
           AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
         )
    ) THEN 0
  ELSE 1
END
`.trim();
}

/**
 * The compact feed historically excluded user rows that hadn't been
 * `consumed` (or `failed`) yet — those represent in-flight enqueued
 * input that the agent hasn't seen. The same predicate gates the
 * projection so deferred user rows never leak into the feed.
 */
function userVisibilityWhereForNew(): string {
	return `(NEW.message_type != 'user' OR COALESCE(NEW.send_status, 'consumed') IN ('consumed', 'failed'))`;
}

/**
 * Common SDK-message column list shared between INSERT and backfill.
 * `<task>`, `<kind>`, `<role>`, `<label>`, `<title>`, `<nodeExec>` are placeholders
 * supplied by the caller (e.g. `tt.id`, `'task_agent'`, etc.).
 */
interface SdkProjectionShape {
	taskId: string;
	kind: string;
	role: string;
	label: string;
	title: string;
	nodeExecId: string;
	sessionId: string;
	messageId: string;
	messageType: string;
	content: string;
	origin: string;
	timestamp: string;
}

function sdkSelectColumns(s: SdkProjectionShape): string {
	return `
${s.taskId} AS task_id,
'sdk' AS source,
${s.messageId} AS source_id,
${s.sessionId} AS session_id,
${s.nodeExecId} AS node_execution_id,
${s.kind} AS kind,
${s.role} AS role,
${s.label} AS label,
${s.title} AS task_title,
${s.messageType} AS message_type,
${s.content} AS content,
${s.origin} AS origin,
${tsMsExpr(s.timestamp)} AS created_at,
${iterationExpr(s.content)} AS iteration,
json_extract(${s.content}, '$.parent_tool_use_id') AS parent_tool_use_id,
CASE WHEN ${s.messageType} = 'result' THEN 1 ELSE 0 END AS is_terminal,
${renderableExpr(s.messageType, s.content)} AS is_renderable
`.trim();
}

function projectionColumns(): string {
	return `(
  task_id, source, source_id, session_id, node_execution_id, kind, role, label,
  task_title, message_type, content, origin, created_at, iteration,
  parent_tool_use_id, is_terminal, is_renderable
)`;
}

/**
 * Orchestration leg INSERT body — projects a single sdk_message row into
 * `task_thread_messages` for every `space_task` whose
 * `task_agent_session_id` matches `<sessionExpr>`.
 *
 * Callers supply the alias for the source-message identity (NEW.id /
 * sm.id) plus the column expressions that yield the SDK row's payload.
 */
function buildOrchestrationInsert(opts: {
	tableSource: string;
	sessionRef: string;
	sdkShape: SdkProjectionShape;
}): string {
	return `
INSERT OR IGNORE INTO task_thread_messages
${projectionColumns()}
SELECT
${sdkSelectColumns({
	...opts.sdkShape,
	taskId: 'tt.id',
	kind: `'task_agent'`,
	role: `'task-agent'`,
	label: `'Task Agent'`,
	title: 'tt.title',
	nodeExecId: 'NULL',
})}
FROM ${opts.tableSource}
JOIN space_tasks tt ON tt.task_agent_session_id = ${opts.sessionRef}
JOIN sessions s ON s.id = tt.task_agent_session_id
WHERE tt.task_agent_session_id IS NOT NULL
  AND s.type = 'space_task_agent'
`.trim();
}

/**
 * Node-agent leg INSERT body — projects a single sdk_message row into
 * `task_thread_messages` for every `space_task` whose `workflow_run_id`
 * matches an existing `node_executions.workflow_run_id` for
 * `<sessionExpr>`. The agent label resolves to `space_agents.name`
 * when available; otherwise the `node_executions.agent_name` (or the
 * literal "agent") is used.
 */
function buildNodeAgentInsert(opts: {
	tableSource: string;
	sessionRef: string;
	sdkShape: SdkProjectionShape;
}): string {
	return `
INSERT OR IGNORE INTO task_thread_messages
${projectionColumns()}
SELECT
${sdkSelectColumns({
	...opts.sdkShape,
	taskId: 'tt.id',
	kind: `'node_agent'`,
	role: 'ne.agent_name',
	label: `COALESCE(sa.name, ne.agent_name, 'agent')`,
	title: 'tt.title',
	nodeExecId: 'ne.id',
})}
FROM ${opts.tableSource}
JOIN node_executions ne ON ne.agent_session_id = ${opts.sessionRef}
JOIN space_tasks tt
  ON tt.workflow_run_id IS NOT NULL
 AND ne.workflow_run_id = tt.workflow_run_id
LEFT JOIN space_agents sa ON sa.id = ne.agent_id
`.trim();
}

/**
 * GitHub-event leg INSERT body — synthesise the same envelope the original
 * CTE emits (`type = 'user'` with a single text block carrying the summary +
 * external_url). `<source>` is either NEW (trigger) or `space_github_events`
 * (backfill).
 */
function buildGithubInsert(opts: {
	tableSource: string;
	idRef: string;
	taskRef: string;
	stateRef: string;
	summaryRef: string;
	urlRef: string;
	occurredAtRef: string;
}): string {
	return `
INSERT OR IGNORE INTO task_thread_messages
${projectionColumns()}
SELECT
  tt.id AS task_id,
  'github' AS source,
  ${opts.idRef} AS source_id,
  NULL AS session_id,
  NULL AS node_execution_id,
  'github' AS kind,
  'github' AS role,
  'GitHub' AS label,
  tt.title AS task_title,
  'github_pr_activity' AS message_type,
  json_object(
    'type', 'user',
    'uuid', ${opts.idRef},
    'message', json_object(
      'role', 'user',
      'content', json_array(json_object(
        'type', 'text',
        'text', '[GitHub] ' || ${opts.summaryRef} || char(10) || ${opts.urlRef}
      ))
    )
  ) AS content,
  'system' AS origin,
  ${opts.occurredAtRef} AS created_at,
  0 AS iteration,
  NULL AS parent_tool_use_id,
  0 AS is_terminal,
  1 AS is_renderable
FROM ${opts.tableSource}
JOIN space_tasks tt ON tt.id = ${opts.taskRef}
WHERE ${opts.stateRef} IN ('routed', 'delivered')
`.trim();
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const TRIGGER_NAMES: ReadonlyArray<string> = [
	'trg_ttm_after_insert_sdk',
	'trg_ttm_after_update_sdk',
	'trg_ttm_after_delete_sdk',
	'trg_ttm_after_insert_github',
	'trg_ttm_after_update_github',
	'trg_ttm_after_delete_github',
	'trg_ttm_after_insert_space_task',
	'trg_ttm_after_update_space_task',
	'trg_ttm_after_delete_space_task',
	'trg_ttm_after_update_node_exec',
	'trg_ttm_after_insert_node_exec',
	'trg_ttm_after_delete_node_exec',
	'trg_ttm_after_update_space_agent',
];

/** Map each trigger DDL to the table it's attached to so we can skip
 *  creation when running against a partial schema (test setups that
 *  pull in only a subset of the daemon tables).
 */
interface TriggerEntry {
	name: string;
	attachedTo: string;
	ddl: string;
}

const SDK_NEW_SHAPE: SdkProjectionShape = {
	taskId: '',
	kind: '',
	role: '',
	label: '',
	title: '',
	nodeExecId: '',
	sessionId: 'NEW.session_id',
	messageId: 'NEW.id',
	messageType: 'NEW.message_type',
	content: 'NEW.sdk_message',
	origin: 'NEW.origin',
	timestamp: 'NEW.timestamp',
};

const TRG_AFTER_INSERT_SDK = `
CREATE TRIGGER trg_ttm_after_insert_sdk
AFTER INSERT ON sdk_messages
WHEN ${userVisibilityWhereForNew()}
BEGIN
  ${buildOrchestrationInsert({
		tableSource: '(SELECT 1) AS _',
		sessionRef: 'NEW.session_id',
		sdkShape: SDK_NEW_SHAPE,
	})};

  ${buildNodeAgentInsert({
		tableSource: '(SELECT 1) AS _',
		sessionRef: 'NEW.session_id',
		sdkShape: SDK_NEW_SHAPE,
	})};
END
`.trim();

const TRG_AFTER_UPDATE_SDK = `
CREATE TRIGGER trg_ttm_after_update_sdk
AFTER UPDATE ON sdk_messages
BEGIN
  -- Always clear the old projection: the message identity is the same but
  -- payload, status, or session may have shifted. The user-visibility WHEN
  -- clause that filters INSERTs cannot be applied to an UPDATE-side delete
  -- (we'd leave a stale projection for rows transitioning back to deferred).
  DELETE FROM task_thread_messages
  WHERE source = 'sdk' AND source_id = OLD.id;

  -- Re-project under the post-update payload, applying the same visibility
  -- predicate the INSERT trigger uses.
  ${buildOrchestrationInsert({
		tableSource: `(SELECT 1) AS _`,
		sessionRef: 'NEW.session_id',
		sdkShape: SDK_NEW_SHAPE,
	})}
  AND ${userVisibilityWhereForNew()};

  ${buildNodeAgentInsert({
		tableSource: `(SELECT 1) AS _`,
		sessionRef: 'NEW.session_id',
		sdkShape: SDK_NEW_SHAPE,
	})}
  AND ${userVisibilityWhereForNew()};
END
`.trim();

const TRG_AFTER_DELETE_SDK = `
CREATE TRIGGER trg_ttm_after_delete_sdk
AFTER DELETE ON sdk_messages
BEGIN
  DELETE FROM task_thread_messages
  WHERE source = 'sdk' AND source_id = OLD.id;
END
`.trim();

const TRG_AFTER_INSERT_GITHUB = `
CREATE TRIGGER trg_ttm_after_insert_github
AFTER INSERT ON space_github_events
WHEN NEW.task_id IS NOT NULL AND NEW.state IN ('routed', 'delivered')
BEGIN
  ${buildGithubInsert({
		tableSource: '(SELECT 1) AS _',
		idRef: 'NEW.id',
		taskRef: 'NEW.task_id',
		stateRef: 'NEW.state',
		summaryRef: 'NEW.summary',
		urlRef: 'NEW.external_url',
		occurredAtRef: 'NEW.occurred_at',
	})};
END
`.trim();

const TRG_AFTER_UPDATE_GITHUB = `
CREATE TRIGGER trg_ttm_after_update_github
AFTER UPDATE ON space_github_events
BEGIN
  DELETE FROM task_thread_messages
  WHERE source = 'github' AND source_id = OLD.id;

  ${buildGithubInsert({
		tableSource: '(SELECT 1) AS _',
		idRef: 'NEW.id',
		taskRef: 'NEW.task_id',
		stateRef: 'NEW.state',
		summaryRef: 'NEW.summary',
		urlRef: 'NEW.external_url',
		occurredAtRef: 'NEW.occurred_at',
	})}
  AND NEW.task_id IS NOT NULL;
END
`.trim();

const TRG_AFTER_DELETE_GITHUB = `
CREATE TRIGGER trg_ttm_after_delete_github
AFTER DELETE ON space_github_events
BEGIN
  DELETE FROM task_thread_messages
  WHERE source = 'github' AND source_id = OLD.id;
END
`.trim();

/**
 * `space_tasks` UPDATE — the row identity is unchanged but its session
 * linkage may have moved. Drop every projection row keyed on the OLD task
 * id, then re-project from `sdk_messages` (orchestration leg + node-agent
 * leg) and `space_github_events`.
 *
 * The `WHEN` clause limits firing to the columns that affect projection
 * content (session linkage, run linkage, title). Routine metadata changes
 * such as `status` or `description` updates are ignored, avoiding a full
 * re-projection on long-running tasks.
 */
const TRG_AFTER_UPDATE_SPACE_TASK = `
CREATE TRIGGER trg_ttm_after_update_space_task
AFTER UPDATE ON space_tasks
WHEN COALESCE(OLD.task_agent_session_id, '') IS NOT COALESCE(NEW.task_agent_session_id, '')
   OR COALESCE(OLD.workflow_run_id, '') IS NOT COALESCE(NEW.workflow_run_id, '')
   OR OLD.title IS NOT NEW.title
BEGIN
  DELETE FROM task_thread_messages WHERE task_id = OLD.id;

  -- Orchestration leg: every sdk_message in the (possibly new) task agent
  -- session, gated by the same user-visibility predicate.
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
${sdkSelectColumns({
	taskId: 'NEW.id',
	kind: `'task_agent'`,
	role: `'task-agent'`,
	label: `'Task Agent'`,
	title: 'NEW.title',
	nodeExecId: 'NULL',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
  FROM sdk_messages sm
  JOIN sessions s ON s.id = sm.session_id
  WHERE NEW.task_agent_session_id IS NOT NULL
    AND sm.session_id = NEW.task_agent_session_id
    AND s.type = 'space_task_agent'
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));

  -- Node-agent leg: every sdk_message reached via the (possibly new)
  -- workflow_run_id linkage.
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
${sdkSelectColumns({
	taskId: 'NEW.id',
	kind: `'node_agent'`,
	role: 'ne.agent_name',
	label: `COALESCE(sa.name, ne.agent_name, 'agent')`,
	title: 'NEW.title',
	nodeExecId: 'ne.id',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
  FROM sdk_messages sm
  JOIN node_executions ne ON ne.agent_session_id = sm.session_id
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
  WHERE NEW.workflow_run_id IS NOT NULL
    AND ne.workflow_run_id = NEW.workflow_run_id
    AND ne.agent_session_id IS NOT NULL
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));

  -- GitHub leg: re-project events whose task_id maps to NEW.id.
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
    NEW.id AS task_id,
    'github' AS source,
    ge.id AS source_id,
    NULL AS session_id,
    NULL AS node_execution_id,
    'github' AS kind,
    'github' AS role,
    'GitHub' AS label,
    NEW.title AS task_title,
    'github_pr_activity' AS message_type,
    json_object(
      'type', 'user',
      'uuid', ge.id,
      'message', json_object(
        'role', 'user',
        'content', json_array(json_object(
          'type', 'text',
          'text', '[GitHub] ' || ge.summary || char(10) || ge.external_url
        ))
      )
    ) AS content,
    'system' AS origin,
    ge.occurred_at AS created_at,
    0 AS iteration,
    NULL AS parent_tool_use_id,
    0 AS is_terminal,
    1 AS is_renderable
  FROM space_github_events ge
  WHERE ge.task_id = NEW.id
    AND ge.state IN ('routed', 'delivered');
END
`.trim();

const TRG_AFTER_INSERT_SPACE_TASK = `
CREATE TRIGGER trg_ttm_after_insert_space_task
AFTER INSERT ON space_tasks
WHEN NEW.task_agent_session_id IS NOT NULL OR NEW.workflow_run_id IS NOT NULL
BEGIN
  -- Orchestration leg: every sdk_message in the task agent session.
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
${sdkSelectColumns({
	taskId: 'NEW.id',
	kind: `'task_agent'`,
	role: `'task-agent'`,
	label: `'Task Agent'`,
	title: 'NEW.title',
	nodeExecId: 'NULL',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
  FROM sdk_messages sm
  JOIN sessions s ON s.id = sm.session_id
  WHERE NEW.task_agent_session_id IS NOT NULL
    AND sm.session_id = NEW.task_agent_session_id
    AND s.type = 'space_task_agent'
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));

  -- Node-agent leg: every sdk_message reached via the workflow_run_id linkage.
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
${sdkSelectColumns({
	taskId: 'NEW.id',
	kind: `'node_agent'`,
	role: 'ne.agent_name',
	label: `COALESCE(sa.name, ne.agent_name, 'agent')`,
	title: 'NEW.title',
	nodeExecId: 'ne.id',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
  FROM sdk_messages sm
  JOIN node_executions ne ON ne.agent_session_id = sm.session_id
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
  WHERE NEW.workflow_run_id IS NOT NULL
    AND ne.workflow_run_id = NEW.workflow_run_id
    AND ne.agent_session_id IS NOT NULL
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));

  -- GitHub leg: project events whose task_id maps to NEW.id.
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
    NEW.id AS task_id,
    'github' AS source,
    ge.id AS source_id,
    NULL AS session_id,
    NULL AS node_execution_id,
    'github' AS kind,
    'github' AS role,
    'GitHub' AS label,
    NEW.title AS task_title,
    'github_pr_activity' AS message_type,
    json_object(
      'type', 'user',
      'uuid', ge.id,
      'message', json_object(
        'role', 'user',
        'content', json_array(json_object(
          'type', 'text',
          'text', '[GitHub] ' || ge.summary || char(10) || ge.external_url
        ))
      )
    ) AS content,
    'system' AS origin,
    ge.occurred_at AS created_at,
    0 AS iteration,
    NULL AS parent_tool_use_id,
    0 AS is_terminal,
    1 AS is_renderable
  FROM space_github_events ge
  WHERE ge.task_id = NEW.id
    AND ge.state IN ('routed', 'delivered');
END
`.trim();

const TRG_AFTER_DELETE_SPACE_TASK = `
CREATE TRIGGER trg_ttm_after_delete_space_task
AFTER DELETE ON space_tasks
BEGIN
  DELETE FROM task_thread_messages WHERE task_id = OLD.id;
END
`.trim();

/**
 * `node_executions` UPDATE — fired both when an agent first binds to a
 * session (`agent_session_id` flips from NULL) and when a row's
 * `workflow_run_id` / `agent_id` / `agent_name` changes (rare). We delete
 * any projection rows previously attributed to the OLD execution id and
 * re-project for the NEW shape.
 *
 * A `WHEN` clause limits firing to the columns that affect projection
 * content. High-frequency status transitions (in_progress → idle, etc.)
 * are ignored, avoiding churn on long-running nodes.
 */
const TRG_AFTER_UPDATE_NODE_EXEC = `
CREATE TRIGGER trg_ttm_after_update_node_exec
AFTER UPDATE ON node_executions
WHEN COALESCE(OLD.agent_session_id, '') IS NOT COALESCE(NEW.agent_session_id, '')
   OR COALESCE(OLD.workflow_run_id, '') IS NOT COALESCE(NEW.workflow_run_id, '')
   OR COALESCE(OLD.agent_id, '') IS NOT COALESCE(NEW.agent_id, '')
   OR OLD.agent_name IS NOT NEW.agent_name
BEGIN
  DELETE FROM task_thread_messages
  WHERE source = 'sdk' AND node_execution_id = OLD.id;

  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
${sdkSelectColumns({
	taskId: 'tt.id',
	kind: `'node_agent'`,
	role: 'NEW.agent_name',
	label: `COALESCE(sa.name, NEW.agent_name, 'agent')`,
	title: 'tt.title',
	nodeExecId: 'NEW.id',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
  FROM sdk_messages sm
  JOIN space_tasks tt ON tt.workflow_run_id = NEW.workflow_run_id
  LEFT JOIN space_agents sa ON sa.id = NEW.agent_id
  WHERE NEW.agent_session_id IS NOT NULL
    AND sm.session_id = NEW.agent_session_id
    AND tt.workflow_run_id IS NOT NULL
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));
END
`.trim();

/**
 * `node_executions` INSERT — projection mirrors UPDATE, but driven on
 * fresh rows (`agent_session_id` may already be set). Common in tests
 * that pre-stage a node_execution before the agent has emitted any
 * messages — but defensive in case messages exist already.
 */
const TRG_AFTER_INSERT_NODE_EXEC = `
CREATE TRIGGER trg_ttm_after_insert_node_exec
AFTER INSERT ON node_executions
WHEN NEW.agent_session_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO task_thread_messages
  ${projectionColumns()}
  SELECT
${sdkSelectColumns({
	taskId: 'tt.id',
	kind: `'node_agent'`,
	role: 'NEW.agent_name',
	label: `COALESCE(sa.name, NEW.agent_name, 'agent')`,
	title: 'tt.title',
	nodeExecId: 'NEW.id',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
  FROM sdk_messages sm
  JOIN space_tasks tt ON tt.workflow_run_id = NEW.workflow_run_id
  LEFT JOIN space_agents sa ON sa.id = NEW.agent_id
  WHERE sm.session_id = NEW.agent_session_id
    AND tt.workflow_run_id IS NOT NULL
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));
END
`.trim();

const TRG_AFTER_DELETE_NODE_EXEC = `
CREATE TRIGGER trg_ttm_after_delete_node_exec
AFTER DELETE ON node_executions
BEGIN
  -- Step 1: drop projection rows that were attributed to this execution.
  --
  -- The projection picks one node_execution as the owner of any given
  -- (task, sdk message) pair (first insert wins via the unique constraint),
  -- so the rows tied to OLD.id may include messages whose underlying session
  -- is still referenced by another live node_execution. We tear down first…
  DELETE FROM task_thread_messages
  WHERE source = 'sdk' AND node_execution_id = OLD.id;

  -- Step 2: …then re-project from any surviving node_execution that still
  -- references the same agent_session_id.
  --
  -- Sessions can be reused across executions: TaskAgentManager.createSubSession()
  -- creates a fresh node_executions row pointing at an existing
  -- agent_session_id whenever a named agent is re-activated within the same
  -- task. Without this re-projection step, deleting one execution would orphan
  -- still-valid messages even though another execution for that session
  -- remains. The INSERT OR IGNORE guards against races and the WHEN clause
  -- avoids touching the projection when there's no session to re-project from.
  ${buildNodeAgentInsert({
		tableSource: 'sdk_messages sm',
		sessionRef: 'OLD.agent_session_id',
		sdkShape: {
			taskId: '',
			kind: '',
			role: '',
			label: '',
			title: '',
			nodeExecId: '',
			sessionId: 'sm.session_id',
			messageId: 'sm.id',
			messageType: 'sm.message_type',
			content: 'sm.sdk_message',
			origin: 'sm.origin',
			timestamp: 'sm.timestamp',
		},
	})}
  WHERE OLD.agent_session_id IS NOT NULL
    AND ne.id != OLD.id
    AND sm.session_id = OLD.agent_session_id
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'));
END
`.trim();

/**
 * `space_agents` UPDATE OF name — keep node-agent labels in sync with the
 * (mutable) agent's display name. The projection materialises
 * `COALESCE(sa.name, ne.agent_name, 'agent')` at write time, so without this
 * trigger an existing projection row keeps its stale label after
 * `SpaceAgentRepository.update({ name })` mutates the underlying agent.
 *
 * Scoped via `OF name` so updates to other columns are no-ops on the
 * projection. The `WHEN` clause guards against UPDATEs that don't actually
 * change the name (SQLite still fires the trigger otherwise). Only
 * `kind = 'node_agent'` rows reference `space_agents`; other kinds use a
 * literal label and are untouched here.
 */
const TRG_AFTER_UPDATE_SPACE_AGENT = `
CREATE TRIGGER trg_ttm_after_update_space_agent
AFTER UPDATE OF name ON space_agents
WHEN COALESCE(OLD.name, '') IS NOT COALESCE(NEW.name, '')
BEGIN
  UPDATE task_thread_messages
  SET label = COALESCE(
    NEW.name,
    (SELECT agent_name FROM node_executions WHERE id = task_thread_messages.node_execution_id),
    'agent'
  )
  WHERE source = 'sdk'
    AND kind = 'node_agent'
    AND node_execution_id IN (
      SELECT id FROM node_executions WHERE agent_id = NEW.id
    );
END
`.trim();

const TRIGGER_DDL: ReadonlyArray<TriggerEntry> = [
	{ name: 'trg_ttm_after_insert_sdk', attachedTo: 'sdk_messages', ddl: TRG_AFTER_INSERT_SDK },
	{ name: 'trg_ttm_after_update_sdk', attachedTo: 'sdk_messages', ddl: TRG_AFTER_UPDATE_SDK },
	{ name: 'trg_ttm_after_delete_sdk', attachedTo: 'sdk_messages', ddl: TRG_AFTER_DELETE_SDK },
	{
		name: 'trg_ttm_after_insert_github',
		attachedTo: 'space_github_events',
		ddl: TRG_AFTER_INSERT_GITHUB,
	},
	{
		name: 'trg_ttm_after_update_github',
		attachedTo: 'space_github_events',
		ddl: TRG_AFTER_UPDATE_GITHUB,
	},
	{
		name: 'trg_ttm_after_delete_github',
		attachedTo: 'space_github_events',
		ddl: TRG_AFTER_DELETE_GITHUB,
	},
	{
		name: 'trg_ttm_after_insert_space_task',
		attachedTo: 'space_tasks',
		ddl: TRG_AFTER_INSERT_SPACE_TASK,
	},
	{
		name: 'trg_ttm_after_update_space_task',
		attachedTo: 'space_tasks',
		ddl: TRG_AFTER_UPDATE_SPACE_TASK,
	},
	{
		name: 'trg_ttm_after_delete_space_task',
		attachedTo: 'space_tasks',
		ddl: TRG_AFTER_DELETE_SPACE_TASK,
	},
	{
		name: 'trg_ttm_after_update_node_exec',
		attachedTo: 'node_executions',
		ddl: TRG_AFTER_UPDATE_NODE_EXEC,
	},
	{
		name: 'trg_ttm_after_insert_node_exec',
		attachedTo: 'node_executions',
		ddl: TRG_AFTER_INSERT_NODE_EXEC,
	},
	{
		name: 'trg_ttm_after_delete_node_exec',
		attachedTo: 'node_executions',
		ddl: TRG_AFTER_DELETE_NODE_EXEC,
	},
	{
		name: 'trg_ttm_after_update_space_agent',
		attachedTo: 'space_agents',
		ddl: TRG_AFTER_UPDATE_SPACE_AGENT,
	},
];

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

function backfillSdkOrchestration(): string {
	return `
INSERT OR IGNORE INTO task_thread_messages
${projectionColumns()}
SELECT
${sdkSelectColumns({
	taskId: 'tt.id',
	kind: `'task_agent'`,
	role: `'task-agent'`,
	label: `'Task Agent'`,
	title: 'tt.title',
	nodeExecId: 'NULL',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
FROM sdk_messages sm
JOIN space_tasks tt ON tt.task_agent_session_id = sm.session_id
JOIN sessions s ON s.id = tt.task_agent_session_id
WHERE tt.task_agent_session_id IS NOT NULL
  AND s.type = 'space_task_agent'
  AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
`.trim();
}

function backfillSdkNodeAgents(): string {
	return `
INSERT OR IGNORE INTO task_thread_messages
${projectionColumns()}
SELECT
${sdkSelectColumns({
	taskId: 'tt.id',
	kind: `'node_agent'`,
	role: 'ne.agent_name',
	label: `COALESCE(sa.name, ne.agent_name, 'agent')`,
	title: 'tt.title',
	nodeExecId: 'ne.id',
	sessionId: 'sm.session_id',
	messageId: 'sm.id',
	messageType: 'sm.message_type',
	content: 'sm.sdk_message',
	origin: 'sm.origin',
	timestamp: 'sm.timestamp',
})}
FROM sdk_messages sm
JOIN node_executions ne ON ne.agent_session_id = sm.session_id
JOIN space_tasks tt
  ON tt.workflow_run_id IS NOT NULL
 AND ne.workflow_run_id = tt.workflow_run_id
LEFT JOIN space_agents sa ON sa.id = ne.agent_id
WHERE ne.agent_session_id IS NOT NULL
  AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
`.trim();
}

function backfillGithub(): string {
	return `
INSERT OR IGNORE INTO task_thread_messages
${projectionColumns()}
SELECT
  tt.id AS task_id,
  'github' AS source,
  ge.id AS source_id,
  NULL AS session_id,
  NULL AS node_execution_id,
  'github' AS kind,
  'github' AS role,
  'GitHub' AS label,
  tt.title AS task_title,
  'github_pr_activity' AS message_type,
  json_object(
    'type', 'user',
    'uuid', ge.id,
    'message', json_object(
      'role', 'user',
      'content', json_array(json_object(
        'type', 'text',
        'text', '[GitHub] ' || ge.summary || char(10) || ge.external_url
      ))
    )
  ) AS content,
  'system' AS origin,
  ge.occurred_at AS created_at,
  0 AS iteration,
  NULL AS parent_tool_use_id,
  0 AS is_terminal,
  1 AS is_renderable
FROM space_github_events ge
JOIN space_tasks tt ON tt.id = ge.task_id
WHERE ge.task_id IS NOT NULL
  AND ge.state IN ('routed', 'delivered')
`.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(db: BunDatabase, tableName: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!row;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply migration 118. Idempotent: re-running on a database that already
 * has the projection table + triggers is a no-op (the table uses CREATE
 * IF NOT EXISTS, triggers are dropped + recreated, and backfill writes
 * collide on the unique constraint).
 *
 * The order of operations matters:
 *   1. Create the table.
 *   2. Create indexes.
 *   3. Backfill BEFORE the triggers exist — otherwise the
 *      `INSERT OR IGNORE` no-ops collide with trigger reprojection on
 *      `space_tasks` UPDATE writes that the application may emit during
 *      this migration. (Rare but safer.)
 *   4. Create triggers.
 */
export function runMigration118External(db: BunDatabase): void {
	if (!tableExists(db, 'sdk_messages')) {
		return;
	}

	db.exec(TABLE_DDL);
	for (const ddl of INDEX_DDL) {
		db.exec(ddl);
	}

	// Backfill — only run for legs whose source tables exist. Tests that
	// pull in just a subset of the schema (e.g. live-query smoke tests)
	// won't have space_tasks/node_executions; the backfill silently skips
	// those legs.
	const haveSpaceTasks = tableExists(db, 'space_tasks');
	const haveSessions = tableExists(db, 'sessions');
	const haveNodeExec = tableExists(db, 'node_executions');
	const haveSpaceAgents = tableExists(db, 'space_agents');
	const haveGithubEvents = tableExists(db, 'space_github_events');

	if (haveSpaceTasks && haveSessions) {
		db.exec(backfillSdkOrchestration());
	}
	if (haveSpaceTasks && haveNodeExec && haveSpaceAgents) {
		db.exec(backfillSdkNodeAgents());
	}
	if (haveSpaceTasks && haveGithubEvents) {
		db.exec(backfillGithub());
	}

	// Triggers — drop first for idempotency. CREATE TRIGGER tolerates
	// missing referenced tables in the *body* (resolved on fire), but
	// requires the *attached* table (the one in the `ON ...` clause) to
	// exist. Skip triggers whose attached table isn't present so partial
	// test schemas don't blow up. Additionally, the projection is
	// meaningless without `space_tasks` / `node_executions` /
	// `space_agents` / `sessions` (every body either joins to them or
	// dispatches into a CTE that does); if any are absent we skip the
	// whole trigger network so legacy tests inserting into
	// `sdk_messages` without the full Space schema don't fail at fire
	// time.
	for (const name of TRIGGER_NAMES) {
		db.exec(`DROP TRIGGER IF EXISTS ${name}`);
	}
	if (!haveSpaceTasks || !haveSessions || !haveNodeExec || !haveSpaceAgents) {
		return;
	}
	for (const entry of TRIGGER_DDL) {
		if (!tableExists(db, entry.attachedTo)) continue;
		db.exec(entry.ddl);
	}
}
