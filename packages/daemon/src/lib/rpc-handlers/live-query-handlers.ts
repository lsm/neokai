/**
 * LiveQuery RPC Handlers
 *
 * Defines the server-side named-query registry for the liveQuery.subscribe /
 * liveQuery.unsubscribe RPC protocol.  Clients send a query name + parameters;
 * the daemon resolves it to a pre-registered SQL template and row mapper.
 * Clients never send raw SQL.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { createEventMessage, parseJson, parseJsonOptional } from '@neokai/shared';
import type {
	LiveQuerySubscribeRequest,
	LiveQuerySubscribeResponse,
	LiveQueryUnsubscribeRequest,
	LiveQueryUnsubscribeResponse,
	LiveQuerySnapshotEvent,
	LiveQueryDeltaEvent,
} from '@neokai/shared';
import type {
	LiveQueryEngine,
	LiveQueryHandle,
	QueryDiff,
	ScopeExtractor,
} from '../../storage/live-query';
import { Logger } from '../logger';

// ============================================================================
// Named-query registry types
// ============================================================================

export interface NamedQuery {
	/** Parameterised SQL that will be executed by LiveQueryEngine */
	sql: string;
	/** Number of positional parameters the SQL expects */
	paramCount: number;
	/**
	 * Optional debounce for table-change reevaluation. Use only for expensive
	 * feeds fed by high-frequency writes, where latest-state delivery matters
	 * more than one event per row mutation.
	 */
	debounceMs?: number;
	/**
	 * Optional row transformer applied after every query execution.
	 * Must return a plain object whose keys match the frontend TypeScript types.
	 */
	mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Optional hook to extract metadata from raw query results (before mapRow).
	 * Called once per query evaluation; result is attached to snapshot/delta events.
	 *
	 * The bound query parameters are forwarded as a second argument so handlers
	 * that need to run a sidecar prepared statement (e.g., `spaceTaskMessages.
	 * byTask.compact`'s active-turn aggregation) can reuse the same param values
	 * the live query was subscribed with — they aren't otherwise visible to
	 * `mapResult`.
	 */
	mapResult?: (
		rawRows: Record<string, unknown>[],
		params: ReadonlyArray<unknown>
	) => Record<string, unknown> | undefined;
	/**
	 * Optional scope extractor for scoped invalidation.
	 *
	 * When a table change event carries scope information (e.g. the sessionId
	 * that was written to), the engine compares the extracted scope against
	 * the event's scope. Queries whose scope does not overlap are skipped,
	 * avoiding unnecessary SQL re-evaluation.
	 *
	 * For example, `messages.bySession` extracts `params[0]` as `sessionId`
	 * so that writing a message for session A does not re-evaluate queries
	 * subscribed to session B.
	 */
	scopeExtractor?: ScopeExtractor;
}

const DEBOUNCE_SDK_MESSAGES_MS = 100;
const DEBOUNCE_SESSION_GROUP_MESSAGES_MS = 150;
const DEBOUNCE_SPACE_TASK_FEEDS_MS = 250;

// ============================================================================
// Row mappers
// ============================================================================

/**
 * Map canonical task timeline rows into the SessionGroupMessage shape expected by the web client.
 * For SDK rows, inject `_taskMeta` directly into JSON content so TaskConversationRenderer can
 * render role/session context without relying on runtime mirroring.
 */
function mapSessionGroupMessageRow(row: Record<string, unknown>): Record<string, unknown> {
	const sourceType = row.sourceType;
	const groupId = String(row.groupId ?? '');
	const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
	const role = String(row.role ?? 'system');
	const messageType = String(row.messageType ?? 'status');
	const createdAt = Number(row.createdAt ?? Date.now());
	const iteration = Number(row.iteration ?? 0);
	const rawId = row.id;
	const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `row-${createdAt}`;
	const parentToolUseId = typeof row.parentToolUseId === 'string' ? row.parentToolUseId : null;

	let content = typeof row.content === 'string' ? row.content : String(row.content ?? '');

	if (sourceType === 'sdk') {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : String(id);
			const shortSessionId = (sessionId ?? '').slice(0, 8);
			const turnId = `turn_${groupId}_${iteration}_${shortSessionId}_${uuid}`;
			const enriched = {
				...parsed,
				_taskMeta: {
					authorRole: role,
					authorSessionId: sessionId ?? '',
					turnId,
					iteration,
				},
			};
			content = JSON.stringify(enriched);
		} catch {
			// Keep original content if parsing fails.
		}
	}

	return {
		id,
		groupId,
		sessionId,
		role,
		messageType,
		content,
		createdAt,
		parentToolUseId,
	};
}

/**
 * Map a raw SQLite row from `spaceTaskMessages.byTask` into a web-friendly
 * message envelope that preserves agent/task attribution.
 */
function mapSpaceTaskMessageRow(row: Record<string, unknown>): Record<string, unknown> {
	const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
	const role = String(row.role ?? 'system');
	const label = String(row.label ?? 'Agent');
	const kind =
		row.kind === 'github' ? 'github' : row.kind === 'task_agent' ? 'task_agent' : 'node_agent';
	const taskId = String(row.taskId ?? '');
	const taskTitle = String(row.taskTitle ?? '');
	const messageType = String(row.messageType ?? 'status');
	const createdAt = Number(row.createdAt ?? Date.now());
	const iteration = Number(row.iteration ?? 0);
	const rawId = row.id;
	const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `row-${createdAt}`;
	const parentToolUseId = typeof row.parentToolUseId === 'string' ? row.parentToolUseId : null;
	const origin = typeof row.origin === 'string' ? row.origin : null;
	// Optional backward-compat field from older compact-query variants.
	// Current compact SQL no longer emits this, but keep tolerant parsing so
	// historical rows/tests and alternate query variants remain safe.
	const sessionMessageCount =
		typeof row.sessionMessageCount === 'number' && Number.isFinite(row.sessionMessageCount)
			? Number(row.sessionMessageCount)
			: undefined;
	const turnIndex =
		typeof row.turnIndex === 'number' && Number.isFinite(row.turnIndex)
			? Number(row.turnIndex)
			: undefined;
	const turnHiddenMessageCount =
		typeof row.turnHiddenMessageCount === 'number' && Number.isFinite(row.turnHiddenMessageCount)
			? Number(row.turnHiddenMessageCount)
			: undefined;

	let content = typeof row.content === 'string' ? row.content : String(row.content ?? '');

	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : String(id);
		const shortSessionId = (sessionId ?? '').slice(0, 8);
		const turnId = `turn_${taskId}_${iteration}_${shortSessionId}_${uuid}`;
		content = JSON.stringify({
			...parsed,
			_taskMeta: {
				authorRole: role,
				authorLabel: label,
				authorKind: kind,
				authorSessionId: sessionId ?? '',
				taskId,
				taskTitle,
				turnId,
				iteration,
			},
		});
	} catch {
		// Keep original content when sdk_message is not valid JSON.
	}

	const mapped: Record<string, unknown> = {
		id,
		sessionId,
		kind,
		role,
		label,
		taskId,
		taskTitle,
		messageType,
		content,
		createdAt,
		origin,
		parentToolUseId,
	};
	if (sessionMessageCount !== undefined) {
		mapped.sessionMessageCount = sessionMessageCount;
	}
	if (turnIndex !== undefined) {
		mapped.turnIndex = turnIndex;
	}
	if (turnHiddenMessageCount !== undefined) {
		mapped.turnHiddenMessageCount = turnHiddenMessageCount;
	}
	return mapped;
}

// ============================================================================
// SQL definitions
// ============================================================================

const MCP_SERVERS_GLOBAL_SQL = `
SELECT
  id,
  name,
  description,
  source_type  AS sourceType,
  command,
  args,
  env,
  url,
  headers,
  enabled,
  created_at   AS createdAt,
  updated_at   AS updatedAt
FROM app_mcp_servers
ORDER BY name, id ASC
`.trim();

/**
 * Map a raw SQLite row from the `app_mcp_servers` table to the AppMcpServer
 * shape expected by the frontend.
 *
 * JSON blob columns: `args`, `env`, `headers`.
 * Boolean coercion: `enabled` — SQLite stores 0/1; convert to JS boolean.
 * snake_case mapping: `source_type` → `sourceType` (handled via AS alias in SQL).
 */
function mapMcpServerRow(row: Record<string, unknown>): Record<string, unknown> {
	// Mirror the repository's rowToServer logic: omit optional fields entirely when the
	// SQLite column is NULL rather than spreading null into the AppMcpServer object.
	// This keeps the LiveQuery path type-consistent with the RPC handler path.
	return {
		id: row.id,
		name: row.name,
		sourceType: row.sourceType,
		enabled: row.enabled === 1,
		...(row.description != null ? { description: row.description } : {}),
		...(row.command != null ? { command: row.command } : {}),
		...(row.url != null ? { url: row.url } : {}),
		...(row.args != null ? { args: JSON.parse(row.args as string) as string[] } : {}),
		...(row.env != null ? { env: JSON.parse(row.env as string) as Record<string, string> } : {}),
		...(row.headers != null
			? { headers: JSON.parse(row.headers as string) as Record<string, string> }
			: {}),
		...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
		...(row.updatedAt != null ? { updatedAt: row.updatedAt } : {}),
	};
}

const SKILLS_LIST_SQL = `
SELECT
  id,
  name,
  display_name        AS displayName,
  description,
  source_type         AS sourceType,
  config,
  enabled,
  built_in            AS builtIn,
  validation_status   AS validationStatus,
  created_at          AS createdAt
FROM skills
ORDER BY built_in DESC, created_at ASC, id ASC
`.trim();

/**
 * Map a raw SQLite row from the `skills` table to the AppSkill shape expected
 * by the frontend.
 *
 * JSON blob column: `config` — parsed to JS object; omitted when NULL.
 * Boolean coercion: `enabled`, `builtIn` — SQLite stores 0/1; convert to JS boolean.
 */
function mapSkillRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		id: row.id,
		name: row.name,
		displayName: row.displayName,
		description: row.description,
		sourceType: row.sourceType,
		...(row.config != null ? { config: JSON.parse(row.config as string) as unknown } : {}),
		enabled: row.enabled === 1,
		builtIn: row.builtIn === 1,
		validationStatus: row.validationStatus,
		...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
	};
}

/**
 * SQL for `mcpEnablement.bySpace`. Returns a row per registry entry, with the
 * per-space override (if any) applied. Columns match SpaceMcpEntry so the
 * frontend can use the LiveQuery result without a separate RPC roundtrip.
 *
 * `overridden` is 1 when the entry has an explicit `mcp_enablement` row for
 * this (space, server) pair, else 0. `enabled` is the effective state:
 * override if present, else the registry's global `enabled` flag.
 */
const MCP_ENABLEMENT_BY_SPACE_SQL = `
SELECT
  ams.id                                                       AS serverId,
  ams.name                                                     AS name,
  ams.description                                              AS description,
  ams.source_type                                              AS sourceType,
  ams.source                                                   AS source,
  ams.source_path                                              AS sourcePath,
  ams.enabled                                                  AS globallyEnabled,
  CASE WHEN me.enabled IS NOT NULL THEN 1 ELSE 0 END           AS overridden,
  COALESCE(me.enabled, ams.enabled)                            AS enabled
FROM app_mcp_servers ams
LEFT JOIN mcp_enablement me
  ON me.server_id = ams.id
 AND me.scope_type = 'space'
 AND me.scope_id = ?
ORDER BY ams.source ASC, ams.created_at IS NULL, ams.created_at ASC, ams.id ASC
`.trim();

function mapMcpEnablementBySpaceRow(row: Record<string, unknown>): Record<string, unknown> {
	const sourceRaw = typeof row.source === 'string' ? row.source : null;
	const normalisedSource =
		sourceRaw === 'builtin' || sourceRaw === 'imported' || sourceRaw === 'user'
			? sourceRaw
			: 'user';
	const out: Record<string, unknown> = {
		serverId: row.serverId,
		name: row.name,
		sourceType: row.sourceType,
		source: normalisedSource,
		globallyEnabled: row.globallyEnabled === 1,
		overridden: row.overridden === 1,
		enabled: row.enabled === 1,
	};
	if (row.description != null) out.description = row.description;
	if (row.sourcePath != null) out.sourcePath = row.sourcePath;
	return out;
}

function formatTaskActivityLabel(value: unknown, fallback: string): string {
	if (typeof value !== 'string' || value.trim() === '') return fallback;
	return value
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function mapSpaceTaskActivityRow(row: Record<string, unknown>): Record<string, unknown> {
	const kind =
		row.kind === 'github' ? 'github' : row.kind === 'task_agent' ? 'task_agent' : 'node_agent';
	const rawRole =
		typeof row.role === 'string' ? row.role : kind === 'task_agent' ? 'task-agent' : kind;
	const rawLabel = typeof row.label === 'string' ? row.label : rawRole;

	return {
		...row,
		kind,
		nodeExecution:
			kind === 'node_agent'
				? {
						nodeExecutionId: row.nodeExecutionId,
						nodeId: row.workflowNodeId,
						agentName: row.agentName,
						status: row.executionStatus,
						result: row.executionResult ?? null,
					}
				: null,
		label:
			kind === 'task_agent'
				? 'Task Agent'
				: kind === 'github'
					? 'GitHub'
					: formatTaskActivityLabel(rawLabel, 'Agent'),
		role: rawRole,
		messageCount: Number(row.messageCount ?? 0),
	};
}

/**
 * Neo messages query — SDK messages from the persistent neo:global session.
 * Returns messages ordered oldest-first (ascending timestamp) so the frontend
 * can render a chronological chat history.
 *
 * Pagination: LIMIT / OFFSET params (positional, required).
 */
const NEO_MESSAGES_SQL = `
SELECT
  id,
  session_id      AS sessionId,
  message_type    AS messageType,
  message_subtype AS messageSubtype,
  sdk_message     AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
  send_status     AS sendStatus,
  origin
FROM sdk_messages
WHERE session_id = 'neo:global'
ORDER BY timestamp ASC, id ASC
LIMIT ? OFFSET ?
`.trim();

/**
 * Neo activity log query — audit log of Neo agent tool invocations.
 * Returns entries ordered newest-first so the activity feed shows recent actions.
 *
 * Pagination: LIMIT / OFFSET params (positional, required).
 * Default limit of 50 entries per page prevents unbounded result sets.
 */
const NEO_ACTIVITY_SQL = `
SELECT
  id,
  tool_name   AS toolName,
  input,
  output,
  status,
  error,
  target_type AS targetType,
  target_id   AS targetId,
  undoable,
  undo_data   AS undoData,
  created_at  AS createdAt
FROM neo_activity_log
ORDER BY created_at DESC, id DESC
LIMIT ? OFFSET ?
`.trim();

/**
 * Map a raw neo_activity_log row — converts the SQLite integer `undoable`
 * column (0 / 1) to a JS boolean.
 */
function mapNeoActivityRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		...row,
		undoable: row.undoable === 1,
	};
}

/**
 * Node executions by workflow run — returns all node execution records
 * for a given workflow run, ordered by creation time ascending.
 *
 * Used by the frontend to show per-node execution status in the workflow canvas.
 */
const NODE_EXECUTIONS_BY_RUN_SQL = `
SELECT
  id,
  workflow_run_id  AS workflowRunId,
  workflow_node_id AS workflowNodeId,
  agent_name       AS agentName,
  agent_id         AS agentId,
  agent_session_id AS agentSessionId,
  status,
  result,
  created_at       AS createdAt,
  started_at       AS startedAt,
  completed_at     AS completedAt,
  updated_at       AS updatedAt
FROM node_executions
WHERE workflow_run_id = ?
ORDER BY created_at ASC, id ASC
`.trim();

const WORKFLOW_RUN_ARTIFACTS_BY_RUN_SQL = `
SELECT
  id,
  run_id        AS runId,
  node_id       AS nodeId,
  artifact_type AS artifactType,
  artifact_key  AS artifactKey,
  data,
  created_at    AS createdAt,
  updated_at    AS updatedAt
FROM workflow_run_artifacts
WHERE run_id = ?
ORDER BY created_at ASC, id ASC
`.trim();

function mapArtifactRow(row: Record<string, unknown>): Record<string, unknown> {
	const raw = row.data as string | null;
	let data: Record<string, unknown> = {};
	if (raw) {
		try {
			data = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			log.warn(`Corrupted artifact JSON for id=${row.id} — returning empty data`);
		}
	}
	return { ...row, data };
}

/**
 * Canonical task timeline query (no projection table):
 * - SDK messages are read directly from sdk_messages joined through session_group_members.
 * - Group/system events are read from task_group_events.
 *
 * A single groupId parameter is threaded via `target_group` CTE and consumed by both branches.
 */
const SESSION_GROUP_MESSAGES_BY_GROUP_SQL = `
WITH target_group AS (
  SELECT id
  FROM session_groups
  WHERE id = ?
)
SELECT
  'sdk'                         AS sourceType,
  sm.id                         AS id,
  tg.id                         AS groupId,
  sm.session_id                 AS sessionId,
  CASE
    WHEN gm.role = 'leader' THEN 'leader'
    WHEN gm.role = 'worker' AND sm.session_id LIKE 'general:%' THEN 'general'
    WHEN gm.role = 'worker' AND sm.session_id LIKE 'planner:%' THEN 'planner'
    WHEN gm.role = 'worker' AND sm.session_id LIKE 'coder:%' THEN 'coder'
    WHEN gm.role = 'worker' THEN 'coder'
    ELSE gm.role
  END                           AS role,
  sm.message_type               AS messageType,
  sm.sdk_message                AS content,
  CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
  CAST(COALESCE(json_extract(sm.sdk_message, '$._taskMeta.iteration'), 0) AS INTEGER) AS iteration,
  json_extract(sm.sdk_message, '$.parent_tool_use_id') AS parentToolUseId
FROM target_group tg
JOIN session_group_members gm ON gm.group_id = tg.id
JOIN sdk_messages sm ON sm.session_id = gm.session_id
WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
UNION ALL
SELECT
  'event'                       AS sourceType,
  'event:' || e.id              AS id,
  tg.id                         AS groupId,
  NULL                          AS sessionId,
  'system'                      AS role,
  CASE
    WHEN e.kind = 'leader_summary' THEN 'leader_summary'
    WHEN e.kind = 'rate_limited' THEN 'rate_limited'
    WHEN e.kind = 'model_fallback' THEN 'model_fallback'
    ELSE 'status'
  END                           AS messageType,
  CASE
    WHEN e.kind IN ('rate_limited', 'model_fallback') THEN COALESCE(e.payload_json, e.kind)
    ELSE COALESCE(json_extract(e.payload_json, '$.text'), e.kind)
  END                           AS content,
  e.created_at                  AS createdAt,
  0                             AS iteration,
  NULL                          AS parentToolUseId
FROM target_group tg
JOIN task_group_events e ON e.group_id = tg.id
ORDER BY createdAt ASC, id ASC
`.trim();

const SPACE_TASK_ACTIVITY_BY_TASK_SQL = `
WITH target_task AS (
  SELECT *
  FROM space_tasks
  WHERE id = ?
),
-- Leg 1: orchestration task (the Task Agent's own task)
orchestration AS (
  SELECT
    tt.task_agent_session_id AS session_id,
    'task_agent' AS kind,
    'Task Agent' AS label,
    'task-agent' AS role,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status,
    NULL AS node_execution_id,
    NULL AS workflow_node_id,
    NULL AS agent_name,
    NULL AS execution_status,
    NULL AS execution_result,
    NULL AS execution_updated_at
  FROM target_task tt
  JOIN sessions s ON s.id = tt.task_agent_session_id
  WHERE tt.task_agent_session_id IS NOT NULL
    AND s.type = 'space_task_agent'
),
-- Leg 2: node agents via node_executions
node_agents AS (
  SELECT
    ne.agent_session_id AS session_id,
    'node_agent' AS kind,
    COALESCE(sa.name, ne.agent_name, 'agent') AS label,
    ne.agent_name AS role,
    tt.id AS task_id,
    tt.title AS task_title,
    tt.status AS task_status,
    ne.id AS node_execution_id,
    ne.workflow_node_id AS workflow_node_id,
    ne.agent_name AS agent_name,
    ne.status AS execution_status,
    ne.result AS execution_result,
    ne.updated_at AS execution_updated_at
  FROM node_executions ne
  JOIN target_task tt
    ON tt.workflow_run_id IS NOT NULL
   AND ne.workflow_run_id = tt.workflow_run_id
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
  WHERE ne.agent_session_id IS NOT NULL
),
-- Union both legs
all_sessions AS (
  SELECT * FROM orchestration
  UNION ALL
  SELECT * FROM node_agents
),
-- Deduplicate session IDs to prevent fan-out in message_stats JOIN
unique_session_ids AS (
  SELECT DISTINCT session_id FROM all_sessions
),
message_stats AS (
  SELECT
    sm.session_id,
    COUNT(*) AS messageCount,
    MAX(CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER)) AS lastMessageAt
  FROM sdk_messages sm
  JOIN unique_session_ids usi ON usi.session_id = sm.session_id
  GROUP BY sm.session_id
)
SELECT
  ase.session_id AS id,
  ase.session_id AS sessionId,
  ase.kind AS kind,
  ase.label AS label,
  ase.role AS role,
  CASE
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'done' THEN 'completed'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'cancelled' THEN 'interrupted'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'blocked' THEN 'failed'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'pending' THEN 'queued'
    WHEN ase.kind = 'node_agent' AND ase.execution_status = 'in_progress' THEN 'active'
    WHEN ase.task_status = 'done' THEN 'completed'
    WHEN ase.task_status = 'cancelled' THEN 'interrupted'
    WHEN ase.task_status = 'blocked' THEN 'failed'
    WHEN json_extract(s.processing_state, '$.status') = 'processing' THEN 'active'
    WHEN json_extract(s.processing_state, '$.status') = 'queued' THEN 'queued'
    WHEN json_extract(s.processing_state, '$.status') = 'waiting_for_input' THEN 'waiting_for_input'
    WHEN json_extract(s.processing_state, '$.status') = 'interrupted' THEN 'interrupted'
    WHEN ase.task_status = 'open' THEN 'queued'
    ELSE 'idle'
  END AS state,
  json_extract(s.processing_state, '$.status') AS processingStatus,
  json_extract(s.processing_state, '$.phase') AS processingPhase,
  COALESCE(ms.messageCount, 0) AS messageCount,
  ase.task_id AS taskId,
  ase.task_title AS taskTitle,
  ase.task_status AS taskStatus,
  ase.node_execution_id AS nodeExecutionId,
  ase.workflow_node_id AS workflowNodeId,
  ase.agent_name AS agentName,
  ase.execution_result AS executionResult,
  ase.task_id AS currentStep,
  NULL AS error,
  NULL AS completionSummary,
  CAST(
    MAX(
      COALESCE(st.updated_at, 0),
      COALESCE(ase.execution_updated_at, 0),
      COALESCE(CAST((julianday(s.last_active_at) - 2440587.5) * 86400000 AS INTEGER), 0)
    ) AS INTEGER
  ) AS updatedAt,
  ms.lastMessageAt AS lastMessageAt
FROM all_sessions ase
LEFT JOIN sessions s ON s.id = ase.session_id
LEFT JOIN space_tasks st ON st.id = ase.task_id
LEFT JOIN message_stats ms ON ms.session_id = ase.session_id
ORDER BY
  CASE WHEN ase.task_id = (SELECT id FROM target_task) THEN 0 ELSE 1 END,
  CASE WHEN ase.kind = 'task_agent' THEN 0 ELSE 1 END,
  updatedAt DESC,
  st.created_at ASC,
  ase.task_id ASC,
  st.id ASC
`.trim();

/**
 * Shared CTE block for `spaceTaskMessages.byTask*` queries.
 *
 * Produces a `joined` row set — one row per (session, sdk_message) pair — that
 * the variant queries then either emit as-is (full) or slice with window
 * functions (compact).
 *
 * The final variant must append its own `SELECT ... FROM ranked|joined ORDER BY`.
 */
const SPACE_TASK_MESSAGES_BASE_CTE = `
WITH target_task AS (
  SELECT *
  FROM space_tasks
  WHERE id = ?
),
-- Leg 1: orchestration task (the Task Agent's own task)
orchestration AS (
  SELECT
    tt.task_agent_session_id AS session_id,
    'task_agent' AS kind,
    'task-agent' AS role,
    'Task Agent' AS label,
    NULL AS node_execution_id,
    tt.id AS task_id,
    tt.title AS task_title
  FROM target_task tt
  JOIN sessions s ON s.id = tt.task_agent_session_id
  WHERE tt.task_agent_session_id IS NOT NULL
    AND s.type = 'space_task_agent'
),
-- Leg 2: node agents via node_executions
node_agents AS (
  SELECT
    ne.agent_session_id AS session_id,
    'node_agent' AS kind,
    ne.agent_name AS role,
    COALESCE(sa.name, ne.agent_name, 'agent') AS label,
    ne.id AS node_execution_id,
    tt.id AS task_id,
    tt.title AS task_title
  FROM node_executions ne
  JOIN target_task tt
    ON tt.workflow_run_id IS NOT NULL
   AND ne.workflow_run_id = tt.workflow_run_id
  LEFT JOIN space_agents sa ON sa.id = ne.agent_id
  WHERE ne.agent_session_id IS NOT NULL
),
-- Union both legs
all_sessions AS (
  SELECT * FROM orchestration
  UNION ALL
  SELECT * FROM node_agents
),
github_events AS (
  SELECT
    ge.id AS id,
    NULL AS sessionId,
    'github' AS kind,
    'github' AS role,
    'GitHub' AS label,
    NULL AS nodeExecutionId,
    tt.id AS taskId,
    tt.title AS taskTitle,
    'github_pr_activity' AS messageType,
    json_object(
      'type', 'user',
      'uuid', ge.id,
      'message', json_object(
        'role', 'user',
        'content', json_array(json_object('type', 'text', 'text', '[GitHub] ' || ge.summary || char(10) || ge.external_url))
      )
    ) AS content,
    'system' AS origin,
    ge.occurred_at AS createdAt,
    0 AS iteration,
    NULL AS parentToolUseId
  FROM target_task tt
  JOIN space_github_events ge ON ge.task_id = tt.id
  WHERE ge.state IN ('routed', 'delivered')
),
joined AS (
  SELECT * FROM github_events
  UNION ALL
  SELECT
    sm.id AS id,
    sm.session_id AS sessionId,
    ase.kind AS kind,
    ase.role AS role,
    ase.label AS label,
    ase.node_execution_id AS nodeExecutionId,
    ase.task_id AS taskId,
    ase.task_title AS taskTitle,
    sm.message_type AS messageType,
    sm.sdk_message AS content,
    sm.origin AS origin,
    CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
    CAST(COALESCE(json_extract(sm.sdk_message, '$._taskMeta.iteration'), 0) AS INTEGER) AS iteration,
    json_extract(sm.sdk_message, '$.parent_tool_use_id') AS parentToolUseId
  FROM all_sessions ase
  JOIN sdk_messages sm ON sm.session_id = ase.session_id
  WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
)
`.trim();

/**
 * Legacy/full variant — emits every joined row. Used by the verbose renderer
 * and as a fallback when a caller genuinely needs the full history.
 */
const SPACE_TASK_MESSAGES_BY_TASK_SQL = `
${SPACE_TASK_MESSAGES_BASE_CTE}
SELECT
  id,
  sessionId,
  kind,
  role,
  label,
  nodeExecutionId,
  taskId,
  taskTitle,
  messageType,
  content,
  origin,
  createdAt,
  iteration,
  parentToolUseId
FROM joined
ORDER BY createdAt ASC, id ASC
`.trim();

/** Maximum non-terminal rows to keep per (session, turn) in compact mode. */
export const SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT = 5;

/**
 * Compact variant — server-side turn compaction for task threads.
 *
 * Turn model (per session):
 *   - A turn is rows between terminal result messages.
 *   - Turn 1 starts at the first row in the session.
 *   - A terminal row (`messageType = 'result'`) closes the current turn and
 *     belongs to that turn.
 *
 * Visibility:
 *   - Keep ALL terminal rows.
 *   - Keep ALL `system` rows (init / compact_boundary). These carry per-exec
 *     metadata (model, cwd, tools, mcp servers…) that the UI surfaces as
 *     dropdowns or banner cards; they're rare (≤2 per session) so passing
 *     them through unconditionally is cheap, and dropping them on long turns
 *     would silently break the affordance.
 *   - Keep only the last N renderable non-terminal rows per session-turn.
 *   - Rows that are known to render as `null` in compact UI (currently
 *     `user` messages whose content is tool_result blocks) are excluded from
 *     the non-terminal cap and omitted from compact payloads.
 *   - Return rows globally ordered by `(createdAt ASC, id ASC)`.
 */
const SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL = `
${SPACE_TASK_MESSAGES_BASE_CTE},
session_turns AS (
  SELECT
    j.*,
    CASE
      WHEN j.messageType = 'result' THEN 1
      ELSE 0
    END AS isTerminal,
    CASE
      -- Drop user rows whose content is exclusively tool_result blocks — they
      -- render as null in the compact UI and would otherwise consume slots
      -- in the per-turn cap without contributing visible content.
      WHEN j.messageType = 'user'
        AND json_type(j.content, '$.message.content') = 'array'
        AND EXISTS (
        SELECT 1
        FROM json_each(json_extract(j.content, '$.message.content')) AS je
        WHERE json_extract(je.value, '$.type') = 'tool_result'
      ) THEN 0
      -- Drop assistant rows that have *no* renderable content — i.e. the
      -- content array exists but every block is either an empty/whitespace
      -- text block or has no non-empty thinking/tool_use sibling. These
      -- show up rarely in practice but bloat the per-turn cap when they
      -- do; the active-turn summary applies the same filter so server and
      -- client agree on what counts as visible activity.
      WHEN j.messageType = 'assistant'
        AND json_type(j.content, '$.message.content') = 'array'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(json_extract(j.content, '$.message.content')) AS je
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
    END AS isRenderable,
    COALESCE(
      SUM(CASE WHEN j.messageType = 'result' THEN 1 ELSE 0 END) OVER (
        PARTITION BY j.sessionId
        ORDER BY j.createdAt ASC, j.id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) + 1 AS turnIndex
  FROM joined j
),
ranked AS (
  SELECT
    st.*,
    CASE
      WHEN st.isTerminal = 0 AND st.isRenderable = 1 THEN ROW_NUMBER() OVER (
        PARTITION BY st.sessionId, st.turnIndex, st.isTerminal, st.isRenderable
        ORDER BY st.createdAt DESC, st.id DESC
      )
      ELSE NULL
    END AS nonTerminalRankDesc,
    CASE
      WHEN st.isTerminal = 0 AND st.isRenderable = 1 AND st.messageType = 'user' THEN ROW_NUMBER() OVER (
        PARTITION BY st.sessionId, st.turnIndex, st.isTerminal, st.isRenderable, st.messageType
        ORDER BY st.createdAt ASC, st.id ASC
      )
      ELSE NULL
    END AS userRowRankAsc
  FROM session_turns st
),
scored AS (
  SELECT
    r.*,
    CASE
      WHEN r.isTerminal = 0 AND r.isRenderable = 1 AND r.nonTerminalRankDesc <= ${SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT}
        THEN 1
      ELSE 0
    END AS isTailVisible,
    CASE
      WHEN r.isTerminal = 0 AND r.isRenderable = 1 AND r.messageType = 'user' AND r.userRowRankAsc = 1
        THEN 1
      ELSE 0
    END AS isInitialUserVisible,
    -- System rows (init / compact_boundary) are sidecar metadata, not real
    -- messages — exclude them from both the total and visible counts so the
    -- "N hidden" badge reflects user/assistant turns only.
    SUM(CASE WHEN r.isTerminal = 0 AND r.isRenderable = 1 AND r.messageType != 'system' THEN 1 ELSE 0 END) OVER (
      PARTITION BY r.sessionId, r.turnIndex
    ) AS totalRenderableNonTerminalInTurn,
    SUM(
      CASE
        WHEN r.isTerminal = 0 AND r.isRenderable = 1 AND r.messageType != 'system'
          AND (
            (r.nonTerminalRankDesc <= ${SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT})
            OR (r.messageType = 'user' AND r.userRowRankAsc = 1)
          )
          THEN 1
        ELSE 0
      END
    ) OVER (
      PARTITION BY r.sessionId, r.turnIndex
    ) AS visibleRenderableNonTerminalInTurn
  FROM ranked r
),
selected AS (
  SELECT
    s.*
  FROM scored s
  WHERE
    s.isTerminal = 1
    -- Always include system rows (init / compact_boundary). Without this they
    -- would be dropped on any non-trivial turn (the system:init row sits at
    -- position 1 of every session, far outside the tail of 5). System rows
    -- are inherently rare so passing them through here is cheap and keeps the
    -- per-exec metadata dropdowns working consistently.
    OR s.messageType = 'system'
    OR (
      s.isTerminal = 0
      AND s.isRenderable = 1
      AND (s.isTailVisible = 1 OR s.isInitialUserVisible = 1)
    )
)
SELECT
  id,
  sessionId,
  kind,
  role,
  label,
  nodeExecutionId,
  taskId,
  taskTitle,
  messageType,
  content,
  origin,
  createdAt,
  turnIndex,
  CASE
    WHEN totalRenderableNonTerminalInTurn > visibleRenderableNonTerminalInTurn
      THEN totalRenderableNonTerminalInTurn - visibleRenderableNonTerminalInTurn
    ELSE 0
  END AS turnHiddenMessageCount,
  iteration,
  parentToolUseId
FROM selected
ORDER BY createdAt ASC, id ASC
`.trim();

/**
 * SQL for the active-turn activity summary that ships alongside the compact
 * feed.
 *
 * Per the design in task #131: the running roster on the Space task view is
 * supposed to summarise the *currently active* turn — every tool_use, text,
 * thinking block, plus user-row activity (real human input + synthetic
 * agent→agent handoffs). The compact feed query keeps only the last 5
 * non-terminal renderable rows per `(session, turn)`, which is right for the
 * feed but too narrow for the roster.
 *
 * Strategy:
 *   1. Reuse the base CTE chain to identify per-session turns (turnIndex is
 *      the cumulative count of `result` rows preceding each row, plus one).
 *   2. For each session, find the highest turnIndex with no terminal row yet —
 *      that's the *active* turn. Closed turns are intentionally excluded.
 *   3. Walk every row of the active turn (NOT the compacted slice). For
 *      assistant rows, explode the SDK content blocks via `json_each` and
 *      classify each one (`tool_use` / `text` / `thinking`). For user rows,
 *      emit a single entry tagged either `__user_message` (human input) or
 *      `__user_replay` (synthetic handoff) per `isReplay`. Empty/whitespace
 *      `text` and `thinking` blocks are filtered out — they're noise. User
 *      rows whose content is exclusively `tool_result` blocks are dropped
 *      (mirrors the compact-feed transmission filter).
 *   4. Order the union deterministically: `(sessionId, ts, rowId, blockIdx)`
 *      so chronological sequence is preserved across rows AND across
 *      multiple content blocks within a single row.
 *
 * The JS-side `mapResult` hook for `spaceTaskMessages.byTask.compact` runs
 * this SQL with the same `?1 = task_id` param the compact subscription was
 * bound with, then aggregates the per-entry rows by sessionId into the
 * `ActiveTurnSummary[]` shape consumers expect. Closed turns produce zero
 * rows here and so simply don't appear in the metadata payload.
 */
export const SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL = `
${SPACE_TASK_MESSAGES_BASE_CTE},
session_turns AS (
  SELECT
    j.id,
    j.sessionId,
    j.kind,
    j.role,
    j.label,
    j.taskId,
    j.taskTitle,
    j.messageType,
    j.content,
    j.createdAt,
    j.iteration,
    j.parentToolUseId,
    COALESCE(
      SUM(CASE WHEN j.messageType = 'result' THEN 1 ELSE 0 END) OVER (
        PARTITION BY j.sessionId
        ORDER BY j.createdAt ASC, j.id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) + 1 AS turnIndex
  FROM joined j
),
session_max_turn AS (
  SELECT sessionId, MAX(turnIndex) AS maxTurnIndex
  FROM session_turns
  GROUP BY sessionId
),
active_turn AS (
  -- The latest turn per session that has not yet seen a terminal result row.
  SELECT
    smt.sessionId AS sessionId,
    smt.maxTurnIndex AS turnIndex
  FROM session_max_turn smt
  WHERE NOT EXISTS (
    SELECT 1
    FROM session_turns st
    WHERE st.sessionId = smt.sessionId
      AND st.turnIndex = smt.maxTurnIndex
      AND st.messageType = 'result'
  )
),
active_rows AS (
  SELECT st.*
  FROM session_turns st
  JOIN active_turn at
    ON at.sessionId = st.sessionId
   AND at.turnIndex = st.turnIndex
),
-- One row per assistant content block (tool_use / non-empty text / thinking).
assistant_entries AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    ar.id AS rowId,
    CAST(je.key AS INTEGER) AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    json_extract(je.value, '$.type') AS blockType,
    json_extract(je.value, '$.name') AS toolName,
    json_extract(je.value, '$.input') AS toolInput,
    json_extract(je.value, '$.text') AS textValue,
    json_extract(je.value, '$.thinking') AS thinkingValue
  FROM active_rows ar,
       json_each(json_extract(ar.content, '$.message.content')) je
  WHERE ar.messageType = 'assistant'
    AND json_type(ar.content, '$.message.content') = 'array'
    AND (
      json_extract(je.value, '$.type') = 'tool_use'
      OR (
        json_extract(je.value, '$.type') = 'text'
        AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
      )
      OR (
        json_extract(je.value, '$.type') = 'thinking'
        AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
      )
    )
),
-- One row per user-typed message row (real human or synthetic replay).
user_entries AS (
  SELECT
    ar.sessionId AS sessionId,
    ar.turnIndex AS turnIndex,
    ar.createdAt AS ts,
    ar.id AS rowId,
    -1 AS blockIdx,
    json_extract(ar.content, '$.uuid') AS uuid,
    CASE
      WHEN COALESCE(CAST(json_extract(ar.content, '$.isReplay') AS INTEGER), 0) = 1
        THEN '__user_replay'
      ELSE '__user_message'
    END AS blockType,
    NULL AS toolName,
    NULL AS toolInput,
    -- Extract the plain-text body of the message.
    -- - String content → use directly.
    -- - Array content → concatenate text blocks.
    -- - Otherwise → empty string.
    CASE
      WHEN json_type(ar.content, '$.message.content') = 'text'
        THEN json_extract(ar.content, '$.message.content')
      WHEN json_type(ar.content, '$.message.content') = 'array' THEN (
        SELECT GROUP_CONCAT(json_extract(je.value, '$.text'), ' ')
        FROM json_each(json_extract(ar.content, '$.message.content')) je
        WHERE json_extract(je.value, '$.type') = 'text'
          AND COALESCE(json_extract(je.value, '$.text'), '') != ''
      )
      ELSE ''
    END AS textValue,
    NULL AS thinkingValue
  FROM active_rows ar
  WHERE ar.messageType = 'user'
    -- Skip user rows whose content is exclusively tool_result blocks (or
    -- mixes tool_result with empty/whitespace-only text blocks). Such rows
    -- render as null in the compact feed and would otherwise produce a
    -- blank rail entry — the GROUP_CONCAT above already filters empty text,
    -- so the row would survive the filter with textValue = NULL.
    --
    -- Mirrors the assistant-entries filter on lines above, which also
    -- excludes empty-text blocks from contributing to the roster.
    AND NOT (
      json_type(ar.content, '$.message.content') = 'array'
      AND EXISTS (
        SELECT 1
        FROM json_each(json_extract(ar.content, '$.message.content')) je
        WHERE json_extract(je.value, '$.type') = 'tool_result'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(ar.content, '$.message.content')) je
        WHERE json_extract(je.value, '$.type') = 'text'
          AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
      )
    )
)
SELECT
  sessionId,
  turnIndex,
  ts,
  rowId,
  blockIdx,
  uuid,
  blockType,
  toolName,
  toolInput,
  textValue,
  thinkingValue
FROM assistant_entries
UNION ALL
SELECT
  sessionId,
  turnIndex,
  ts,
  rowId,
  blockIdx,
  uuid,
  blockType,
  toolName,
  toolInput,
  textValue,
  thinkingValue
FROM user_entries
ORDER BY sessionId ASC, ts ASC, rowId ASC, blockIdx ASC
`.trim();

// ============================================================================
// Active-turn entry aggregation
// ============================================================================

const ACTIVITY_PREVIEW_MAX_LEN = 200;

/**
 * Collapse arbitrary text into a single line and cap its length so the
 * server-side preview matches what the rail can render without further work.
 * Mirrors the client-side `oneLine` shape so trailing ellipses and whitespace
 * collapsing line up byte-for-byte across server and client.
 */
function activityOneLine(value: string, max = ACTIVITY_PREVIEW_MAX_LEN): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (collapsed.length === 0) return '';
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function activityStringProp(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	return typeof value === 'string' ? value : '';
}

function activityPathBase(path: string): string {
	const parts = path.split('/').filter(Boolean);
	return parts[parts.length - 1] || path;
}

function activityPreviewFromTodoInput(input: Record<string, unknown>): string {
	const todos = input.todos;
	if (!Array.isArray(todos)) return 'Update todos';
	const todoItems = todos
		.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
		.map((item) => {
			const content = activityStringProp(item, 'content');
			const activeForm = activityStringProp(item, 'activeForm');
			const status = activityStringProp(item, 'status');
			return { content, activeForm, status };
		});
	const running = todoItems.find((item) => item.status === 'in_progress');
	if (running) {
		return activityOneLine(`Running: ${running.activeForm || running.content || 'todo item'}`);
	}
	const completed = [...todoItems].reverse().find((item) => item.status === 'completed');
	if (completed?.content) return activityOneLine(`Marked done: ${completed.content}`);
	const pending = todoItems.find((item) => item.status === 'pending');
	if (pending?.content) return activityOneLine(`Added task: ${pending.content}`);
	const count = todoItems.length;
	return count ? `${count} todo${count !== 1 ? 's' : ''}` : 'Update todos';
}

function activityPreviewFromQuestionInput(input: Record<string, unknown>): string {
	const questions = input.questions;
	if (!Array.isArray(questions) || questions.length === 0) return 'Ask user';
	const firstQuestion = questions.find(
		(question): question is Record<string, unknown> => !!question && typeof question === 'object'
	);
	const text = firstQuestion ? activityStringProp(firstQuestion, 'question') : '';
	if (!text) return `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
	const suffix = questions.length > 1 ? ` (+${questions.length - 1})` : '';
	return `${activityOneLine(text, 60)}${suffix}`;
}

/**
 * Pick a human-friendly preview from a tool_use input object. The branch order
 * mirrors the SDK tool registry summaries where possible so compact roster
 * lines carry the same primary meaning as full chat tool blocks.
 */
function activityPreviewFromToolInput(toolName: string, input: Record<string, unknown>): string {
	if (toolName.startsWith('mcp__')) {
		return '';
	}
	switch (toolName) {
		case 'Bash': {
			const description = activityStringProp(input, 'description');
			if (description) return activityOneLine(description);
			return activityOneLine(activityStringProp(input, 'command'));
		}
		case 'Write':
		case 'Edit': {
			const filePath = activityStringProp(input, 'file_path');
			return filePath ? activityOneLine(activityPathBase(filePath)) : '';
		}
		case 'MultiEdit': {
			const filePath = activityStringProp(input, 'file_path');
			return filePath ? activityOneLine(activityPathBase(filePath)) : '';
		}
		case 'Read': {
			const filePath = activityStringProp(input, 'file_path');
			return filePath ? activityOneLine(activityPathBase(filePath)) : '';
		}
		case 'NotebookEdit': {
			const notebookPath = activityStringProp(input, 'notebook_path');
			return notebookPath ? activityOneLine(activityPathBase(notebookPath)) : '';
		}
		case 'Glob':
		case 'Grep':
			return activityOneLine(activityStringProp(input, 'pattern'), 50);
		case 'WebFetch':
			return activityOneLine(activityStringProp(input, 'url'), 50);
		case 'WebSearch':
			return activityOneLine(activityStringProp(input, 'query'), 50);
		case 'Task':
			return activityOneLine(activityStringProp(input, 'description') || 'Task execution');
		case 'Agent':
			return activityOneLine(activityStringProp(input, 'description') || 'Agent execution');
		case 'TaskOutput':
			return activityOneLine(activityStringProp(input, 'task_id') || 'Task output');
		case 'TaskStop':
			return activityOneLine(
				activityStringProp(input, 'task_id') || activityStringProp(input, 'shell_id') || 'Stop task'
			);
		case 'BashOutput': {
			const bashId = activityStringProp(input, 'bash_id');
			return `Shell: ${bashId.slice(0, 8) || 'unknown'}`;
		}
		case 'KillShell': {
			const shellId = activityStringProp(input, 'shell_id');
			return `Shell: ${shellId.slice(0, 8) || 'unknown'}`;
		}
		case 'TodoWrite':
			return activityPreviewFromTodoInput(input);
		case 'ListMcpResourcesTool':
			return activityOneLine(activityStringProp(input, 'server') || 'All servers');
		case 'ReadMcpResourceTool':
			return activityOneLine(activityStringProp(input, 'uri'), 50);
		case 'AskUserQuestion':
			return activityPreviewFromQuestionInput(input);
		case 'EnterPlanMode':
			return 'Entering plan mode';
		case 'ExitPlanMode':
			return 'Exiting plan mode';
		case 'TimeMachine':
			return activityOneLine(activityStringProp(input, 'message_prefix'), 40);
		default: {
			const keys = Object.keys(input);
			if (keys.length === 0) return '';
			const firstKey = keys[0];
			const firstVal = input[firstKey];
			if (typeof firstVal === 'string') return activityOneLine(firstVal, 40);
			return `${firstKey}: …`;
		}
	}
}

/**
 * Aggregate the per-entry rows produced by `SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL`
 * into the `ActiveTurnSummary[]` payload the client consumes.
 *
 * Each row corresponds to a single activity entry (one assistant content
 * block, or one user-row entry). Rows are already chronologically sorted by
 * the SQL — we only need to group by sessionId and translate the raw
 * `blockType` discriminator into the public `ActivityEntry.kind` shape, while
 * computing previews / unwrapping `tool_use.input` JSON server-side.
 *
 * Exported for unit-test coverage.
 */
export function buildActiveTurnSummariesFromRows(
	rows: Record<string, unknown>[]
): Array<{ sessionId: string; turnIndex: number; entries: Record<string, unknown>[] }> {
	const bySession = new Map<
		string,
		{ sessionId: string; turnIndex: number; entries: Record<string, unknown>[] }
	>();

	for (const row of rows) {
		const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
		if (!sessionId) continue;
		const turnIndex = Number(row.turnIndex ?? 0);
		const ts = Number(row.ts ?? 0);
		const uuid = typeof row.uuid === 'string' ? row.uuid : '';
		const blockType = typeof row.blockType === 'string' ? row.blockType : '';

		let entry: Record<string, unknown> | null = null;
		if (blockType === 'tool_use') {
			const toolName = typeof row.toolName === 'string' ? row.toolName : '';
			const rawInput = row.toolInput;
			let parsedInput: Record<string, unknown> = {};
			if (typeof rawInput === 'string') {
				try {
					const maybe = JSON.parse(rawInput);
					if (maybe && typeof maybe === 'object') {
						parsedInput = maybe as Record<string, unknown>;
					}
				} catch {
					// Leave parsedInput empty — preview falls through to `tool_name: …`.
				}
			} else if (rawInput && typeof rawInput === 'object') {
				parsedInput = rawInput as Record<string, unknown>;
			}
			entry = {
				kind: 'tool_use',
				toolName,
				preview: activityPreviewFromToolInput(toolName, parsedInput),
				ts,
				uuid,
			};
		} else if (blockType === 'text') {
			const text = typeof row.textValue === 'string' ? row.textValue : '';
			if (text.trim().length === 0) continue;
			entry = { kind: 'text', text: activityOneLine(text), ts, uuid };
		} else if (blockType === 'thinking') {
			const thinking = typeof row.thinkingValue === 'string' ? row.thinkingValue : '';
			if (thinking.trim().length === 0) continue;
			entry = { kind: 'thinking', preview: thinking.trim(), ts, uuid };
		} else if (blockType === '__user_message') {
			const text = typeof row.textValue === 'string' ? row.textValue : '';
			entry = { kind: 'user_message', text: activityOneLine(text), ts, uuid };
		} else if (blockType === '__user_replay') {
			const text = typeof row.textValue === 'string' ? row.textValue : '';
			entry = { kind: 'agent_handoff', text: activityOneLine(text), ts, uuid };
		}
		if (!entry) continue;

		let summary = bySession.get(sessionId);
		if (!summary) {
			summary = { sessionId, turnIndex, entries: [] };
			bySession.set(sessionId, summary);
		}
		summary.entries.push(entry);
	}

	return Array.from(bySession.values());
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Server-side named-query registry.
 *
 * Keys are opaque identifiers sent by the client in `LiveQuerySubscribeRequest.queryName`.
 * Each entry specifies the SQL template, expected parameter count, and an optional
 * row mapper that performs post-processing (JSON parsing, type coercion).
 *
 * Exported for use in `liveQuery.subscribe` / `liveQuery.unsubscribe` handlers
 * and for direct inspection in unit tests.
 */

/**
 * SQL for `sessions.list` LiveQuery.
 *
 * Returns all user-visible sessions (excludes internal room/space/agent sessions).
 * Filters out room/space sessions by checking session_context for roomId/spaceId.
 * Includes archived sessions so the client can toggle visibility.
 */
const SESSIONS_LIST_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.workspace_path as workspacePath,
  s.created_at as createdAt,
  s.last_active_at as lastActiveAt,
  s.status as status,
  s.config as config,
  s.metadata as metadata,
  s.is_worktree as is_worktree,
  s.worktree_path as worktree_path,
  s.main_repo_path as main_repo_path,
  s.worktree_branch as worktree_branch,
  s.git_branch as gitBranch,
  s.sdk_session_id as sdkSessionId,
  s.available_commands as available_commands,
  s.processing_state as processingState,
  s.archived_at as archivedAt,
  s.type as type,
  s.session_context as session_context,
  (SELECT COUNT(*) FROM sessions s2
   WHERE s2.type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
   AND json_extract(s2.session_context, '$.roomId') IS NULL
   AND json_extract(s2.session_context, '$.spaceId') IS NULL) as _totalCount,
  (SELECT COUNT(*) FROM sessions s3
   WHERE s3.type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
   AND json_extract(s3.session_context, '$.roomId') IS NULL
   AND json_extract(s3.session_context, '$.spaceId') IS NULL
   AND s3.status = 'archived') as _archivedCount
FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
  AND (s.status != 'archived' OR ?1 = 1)
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

/**
 * SQL for counting ALL user-visible sessions regardless of archived status.
 * Used to provide an accurate totalCount even when the visible session list is empty
 * (e.g. when all sessions are archived and showArchived=false).
 */
const SESSIONS_TOTAL_COUNT_SQL = `
SELECT COUNT(*) as cnt FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
`.trim();

/**
 * SQL for counting only archived user-visible sessions.
 * Used to provide an accurate archivedCount even when the visible session list is empty.
 */
const SESSIONS_ARCHIVED_COUNT_SQL = `
SELECT COUNT(*) as cnt FROM sessions s
WHERE s.type NOT IN ('lobby', 'spaces_global', 'neo', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
  AND json_extract(s.session_context, '$.roomId') IS NULL
  AND json_extract(s.session_context, '$.spaceId') IS NULL
  AND s.status = 'archived'
`.trim();

/**
 * Map a raw SQLite sessions row to a SessionInfo object.
 *
 * Handles:
 * - JSON parsing of config, metadata, session_context, available_commands
 * - Worktree metadata reconstruction from flat columns
 * - Type coercion for is_worktree (integer → boolean)
 */
function mapSessionRow(row: Record<string, unknown>): Record<string, unknown> {
	const isWorktree = row.is_worktree === 1;
	const worktree = isWorktree
		? {
				isWorktree: true as const,
				worktreePath: row.worktree_path as string,
				mainRepoPath: row.main_repo_path as string,
				branch: row.worktree_branch as string,
			}
		: undefined;

	const availableCommands =
		row.available_commands && typeof row.available_commands === 'string'
			? (JSON.parse(row.available_commands) as string[])
			: undefined;

	const sessionContext =
		row.session_context && typeof row.session_context === 'string'
			? parseJsonOptional(row.session_context)
			: undefined;

	return {
		id: row.id,
		title: row.title,
		workspacePath: row.workspacePath,
		createdAt: row.createdAt,
		lastActiveAt: row.lastActiveAt,
		status: row.status,
		config: parseJson(row.config as string, {}),
		metadata: parseJson(row.metadata as string, {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		}),
		worktree,
		gitBranch: (row.gitBranch as string | null) ?? undefined,
		sdkSessionId: (row.sdkSessionId as string | null) ?? undefined,
		availableCommands,
		processingState: (row.processingState as string | null) ?? undefined,
		archivedAt: (row.archivedAt as string | null) ?? undefined,
		type: (row.type as string | null) ?? 'worker',
		context: sessionContext,
	};
}

const SPACE_SESSIONS_BY_SPACE_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.status as status,
  (unixepoch(s.last_active_at) - 0) * 1000 as lastActiveAt
FROM sessions s
INNER JOIN spaces sp ON sp.id = ?
CROSS JOIN json_each(sp.session_ids) j
WHERE j.value = s.id AND s.status != 'archived' AND s.type != 'space_chat'
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

/**
 * SQL for `messages.bySession` LiveQuery.
 *
 * Returns SDK messages for a session in the same shape that
 * `SDKMessageRepository.getSDKMessages()` produces:
 *   - Top-level messages (no `parent_tool_use_id`), limited to the most recent
 *     N rows (by timestamp DESC).
 *   - Plus subagent messages (rows whose `parent_tool_use_id` is a tool_use id
 *     emitted by one of those top-level assistant rows).
 *   - User messages with `send_status = 'deferred'` or `'enqueued'` are
 *     excluded, matching the RPC behavior.
 *
 * Parameters (positional, via `?1` / `?2`):
 *   ?1 — session_id (used twice because the CTE references sdk_messages twice)
 *   ?2 — top-level row limit (default 100 from the client)
 *
 * Mapping: the raw row carries the JSON-serialised SDK message in `content`,
 * plus `timestamp` (epoch ms), `sendStatus`, and `origin`.  `mapMessageRow`
 * inflates the JSON and merges the extras to produce a ChatMessage-shaped
 * object.
 */
const MESSAGES_BY_SESSION_SQL = `
WITH top_level AS (
  SELECT
    id,
    sdk_message,
    timestamp,
    send_status,
    origin
  FROM sdk_messages
  WHERE session_id = ?1
    AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
    AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
  ORDER BY timestamp DESC, id DESC
  LIMIT ?2
),
tool_use_ids AS (
  SELECT DISTINCT json_extract(je.value, '$.id') AS id
  FROM top_level,
       json_each(json_extract(top_level.sdk_message, '$.message.content')) AS je
  WHERE json_extract(top_level.sdk_message, '$.type') = 'assistant'
    AND json_extract(je.value, '$.type') = 'tool_use'
    AND json_extract(je.value, '$.id') IS NOT NULL
),
subagent AS (
  SELECT
    sm.id AS id,
    sm.sdk_message AS sdk_message,
    sm.timestamp AS timestamp,
    sm.send_status AS send_status,
    sm.origin AS origin
  FROM sdk_messages sm
  WHERE sm.session_id = ?1
    AND EXISTS (
      SELECT 1
      FROM tool_use_ids tui
      WHERE tui.id = json_extract(sm.sdk_message, '$.parent_tool_use_id')
    )
    AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
)
SELECT
  id,
  sdk_message                                                       AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)    AS timestamp,
  send_status                                                       AS sendStatus,
  origin                                                            AS origin
FROM top_level
UNION ALL
SELECT
  id,
  sdk_message                                                       AS content,
  CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)    AS timestamp,
  send_status                                                       AS sendStatus,
  origin                                                            AS origin
FROM subagent
ORDER BY timestamp ASC, id ASC
`.trim();

/**
 * Map a raw `messages.bySession` row into a ChatMessage-shaped object.
 *
 * Mirrors the behaviour of `SDKMessageRepository.getSDKMessages()`:
 *   - Parse the `sdk_message` JSON blob and spread its fields onto the output.
 *   - Override `origin` with the DB column value — explicit `undefined` is
 *     preserved so any SDK-level `origin?: SDKMessageOrigin` object gets
 *     stripped in favour of NeoKai's `MessageOrigin` string.
 *   - Attach `timestamp` (epoch ms, computed SQL-side).
 *   - Attach `sendStatus` only when the DB column equals `'failed'`, so the UI
 *     can render the retry affordance without carrying 'consumed' through the
 *     message stream.
 *   - Attach `id` so client-side LiveQuery diffing is stable even when the
 *     SDK message lacks a `uuid`.
 */
function mapMessageRow(row: Record<string, unknown>): Record<string, unknown> {
	const contentRaw = row.content;
	let parsed: Record<string, unknown> = {};
	if (typeof contentRaw === 'string') {
		try {
			parsed = JSON.parse(contentRaw) as Record<string, unknown>;
		} catch {
			// Corrupted JSON — return a sentinel object so the client doesn't crash.
			parsed = { type: 'unknown', rawContent: contentRaw };
		}
	}

	const extras: Record<string, unknown> = {
		id: row.id,
		timestamp: typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp ?? 0),
		origin: row.origin != null ? row.origin : undefined,
	};
	if (row.sendStatus === 'failed') {
		extras.sendStatus = 'failed';
	}

	return { ...parsed, ...extras };
}

export const NAMED_QUERY_REGISTRY = new Map<string, NamedQuery>([
	[
		'sessionGroupMessages.byGroup',
		{
			sql: SESSION_GROUP_MESSAGES_BY_GROUP_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SESSION_GROUP_MESSAGES_MS,
			mapRow: mapSessionGroupMessageRow,
		},
	],
	[
		'spaceTaskActivity.byTask',
		{
			sql: SPACE_TASK_ACTIVITY_BY_TASK_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapSpaceTaskActivityRow,
		},
	],
	[
		'spaceTaskMessages.byTask',
		{
			sql: SPACE_TASK_MESSAGES_BY_TASK_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapSpaceTaskMessageRow,
		},
	],
	[
		'spaceTaskMessages.byTask.compact',
		{
			sql: SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL,
			paramCount: 1,
			debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
			mapRow: mapSpaceTaskMessageRow,
		},
	],
	[
		'mcpServers.global',
		{
			sql: MCP_SERVERS_GLOBAL_SQL,
			paramCount: 0,
			mapRow: mapMcpServerRow,
		},
	],
	[
		'skills.list',
		{
			sql: SKILLS_LIST_SQL,
			paramCount: 0,
			mapRow: mapSkillRow,
		},
	],
	[
		'mcpEnablement.bySpace',
		{
			sql: MCP_ENABLEMENT_BY_SPACE_SQL,
			paramCount: 1,
			mapRow: mapMcpEnablementBySpaceRow,
		},
	],
	[
		'neo.messages',
		{
			sql: NEO_MESSAGES_SQL,
			paramCount: 2,
			// neo.messages always queries session_id = 'neo:global'
			scopeExtractor: () => ({ sessionId: 'neo:global' }),
		},
	],
	[
		'neo.activity',
		{
			sql: NEO_ACTIVITY_SQL,
			paramCount: 2,
			mapRow: mapNeoActivityRow,
		},
	],
	[
		'nodeExecutions.byRun',
		{
			sql: NODE_EXECUTIONS_BY_RUN_SQL,
			paramCount: 1,
		},
	],
	[
		'workflowRunArtifacts.byRun',
		{
			sql: WORKFLOW_RUN_ARTIFACTS_BY_RUN_SQL,
			paramCount: 1,
			mapRow: mapArtifactRow,
		},
	],
	[
		'spaceSessions.bySpace',
		{
			sql: SPACE_SESSIONS_BY_SPACE_SQL,
			paramCount: 1,
		},
	],
	[
		'messages.bySession',
		{
			sql: MESSAGES_BY_SESSION_SQL,
			paramCount: 2,
			debounceMs: DEBOUNCE_SDK_MESSAGES_MS,
			mapRow: mapMessageRow,
			scopeExtractor: (params) => ({ sessionId: params[0] as string }),
		},
	],
	[
		'sessions.list',
		{
			sql: SESSIONS_LIST_SQL,
			paramCount: 1,
			mapRow: mapSessionRow,
			mapResult: (rawRows) => {
				if (rawRows.length > 0 && rawRows[0]._totalCount != null) {
					return {
						totalCount: rawRows[0]._totalCount as number,
						archivedCount: (rawRows[0]._archivedCount as number | null) ?? 0,
					};
				}
				return { totalCount: 0, archivedCount: 0 };
			},
		},
	],
]);

// ============================================================================
// Logger
// ============================================================================

const log = new Logger('live-query-handlers');

// ============================================================================
// RPC handler setup
// ============================================================================

/**
 * Register `liveQuery.subscribe` and `liveQuery.unsubscribe` RPC handlers.
 *
 * Returns a cleanup function that disposes all active subscriptions and
 * unregisters the client-disconnect listener.
 */
export function setupLiveQueryHandlers(
	messageHub: MessageHub,
	liveQueries: LiveQueryEngine,
	db: BunDatabase
): () => void {
	// Map<clientId → Map<subscriptionId → LiveQueryHandle>>
	const subscriptions = new Map<string, Map<string, LiveQueryHandle<Record<string, unknown>>>>();

	// Build a local registry that overrides sessions.list with a closure capturing db.
	// This ensures totalCount and archivedCount metadata are accurate even when the
	// visible session list is empty (e.g. all sessions are archived, showArchived=false).
	const stmtSessionsTotalCount = db.prepare(SESSIONS_TOTAL_COUNT_SQL);
	const stmtSessionsArchivedCount = db.prepare(SESSIONS_ARCHIVED_COUNT_SQL);

	// Sidecar prepared statement for the compact-thread mapResult: emits one
	// row per activity entry in each session's currently-active turn. The
	// compact thread query itself caps rows per turn at 5; this sidecar is
	// the uncapped feed used to drive the running roster on the task view.
	//
	// Prepared lazily on first use so daemon startup doesn't depend on every
	// table referenced by the CTE chain (e.g. `node_executions`) being live
	// yet. Preparing eagerly here regressed test setups whose minimal schema
	// hadn't run the migration that creates that table.
	let _stmtActiveTurnEntries: ReturnType<BunDatabase['prepare']> | null = null;
	const getStmtActiveTurnEntries = () => {
		if (!_stmtActiveTurnEntries) {
			_stmtActiveTurnEntries = db.prepare(SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL);
		}
		return _stmtActiveTurnEntries;
	};

	const sessionsListBase = NAMED_QUERY_REGISTRY.get('sessions.list')!;
	const activeRegistry = new Map(NAMED_QUERY_REGISTRY);

	// Override the compact-thread query so each evaluation also computes the
	// active-turn activity summary alongside the compact rows. Wired through
	// the metadata channel so existing snapshot/delta plumbing carries it
	// without a parallel subscription.
	const compactThreadBase = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!;
	activeRegistry.set('spaceTaskMessages.byTask.compact', {
		...compactThreadBase,
		mapResult: (_rawRows, params) => {
			const taskId = params[0];
			if (typeof taskId !== 'string' || taskId.length === 0) return undefined;
			const entryRows = getStmtActiveTurnEntries().all(taskId) as Record<string, unknown>[];
			const summaries = buildActiveTurnSummariesFromRows(entryRows);
			// Always emit the field so the client sees an authoritative empty
			// list rather than a stale value from a prior snapshot.
			return { activeTurnSummaries: summaries };
		},
	});

	activeRegistry.set('sessions.list', {
		...sessionsListBase,
		mapResult: (rawRows) => {
			if (rawRows.length > 0 && rawRows[0]._totalCount != null) {
				return {
					totalCount: rawRows[0]._totalCount as number,
					archivedCount: (rawRows[0]._archivedCount as number | null) ?? 0,
				};
			}
			// When no visible sessions exist (e.g. all archived and showArchived=false),
			// run direct count queries so hasArchivedSessions correctly shows the toggle.
			const totalRow = stmtSessionsTotalCount.get() as { cnt: number } | undefined;
			const archivedRow = stmtSessionsArchivedCount.get() as { cnt: number } | undefined;
			return {
				totalCount: totalRow?.cnt ?? 0,
				archivedCount: archivedRow?.cnt ?? 0,
			};
		},
	});

	// Cache prepared statements once at setup time — compiled once per handler
	// registration, not once per subscribe call (which would add compilation
	// overhead on every subscribe RPC invocation).
	const stmtRoom = db.prepare('SELECT id FROM rooms WHERE id = ?');
	const stmtGroup = db.prepare('SELECT ref_id, group_type FROM session_groups WHERE id = ?');
	const stmtTask = db.prepare('SELECT room_id FROM tasks WHERE id = ?');
	const stmtSpace = db.prepare('SELECT id FROM spaces WHERE id = ?');
	const stmtSession = db.prepare('SELECT id FROM sessions WHERE id = ?');

	// -------------------------------------------------------------------------
	// liveQuery.subscribe
	// -------------------------------------------------------------------------

	messageHub.onRequest('liveQuery.subscribe', (data, context) => {
		const { queryName, params, subscriptionId } = data as LiveQuerySubscribeRequest;
		const { clientId, sessionId } = context;

		// 1. Require WebSocket clientId
		if (!clientId) {
			throw new Error('liveQuery.subscribe requires a WebSocket connection (clientId absent)');
		}

		// 2. Resolve query from registry
		const namedQuery = activeRegistry.get(queryName);
		if (!namedQuery) {
			throw new Error(`Unknown query name: "${queryName}"`);
		}

		// 3. Validate parameter count
		if (params.length !== namedQuery.paramCount) {
			throw new Error(
				`Query "${queryName}" expects ${namedQuery.paramCount} parameter(s), got ${params.length}`
			);
		}

		// 4. Authorization checks
		if (queryName === 'sessionGroupMessages.byGroup') {
			const groupId = params[0] as string;
			const group = stmtGroup.get(groupId) as { ref_id: string; group_type: string } | null;
			if (!group) {
				throw new Error(`Unauthorized: session group "${groupId}" not found`);
			}
			if (group.group_type === 'task') {
				// For task-typed groups, verify the full group → task → room chain.
				// This ensures the requesting client has access to the room the task belongs to.
				const task = stmtTask.get(group.ref_id) as { room_id: string } | null;
				if (!task) {
					throw new Error(`Unauthorized: task "${group.ref_id}" not found`);
				}
				if (!stmtRoom.get(task.room_id)) {
					throw new Error(`Unauthorized: room "${task.room_id}" not found`);
				}
			}
			// Non-task group types (e.g., 'workflow', 'global') are authorized by group
			// existence alone.  All current non-task groups are internal daemon constructs
			// not directly reachable by client-supplied IDs without prior knowledge.
			// If new group types with finer-grained access control are introduced, extend
			// this block with the appropriate chain validation.
		} else if (
			queryName === 'spaceTaskActivity.byTask' ||
			queryName === 'spaceTaskMessages.byTask' ||
			queryName === 'spaceTaskMessages.byTask.compact'
		) {
			const taskId = params[0] as string;
			let spaceTask: { space_id: string } | null = null;
			try {
				spaceTask = db.prepare('SELECT space_id FROM space_tasks WHERE id = ?').get(taskId) as {
					space_id: string;
				} | null;
			} catch {
				spaceTask = null;
			}
			if (!spaceTask) {
				throw new Error(`Unauthorized: space task "${taskId}" not found`);
			}
		} else if (queryName === 'spaceSessions.bySpace' || queryName === 'mcpEnablement.bySpace') {
			const spaceId = params[0] as string;
			if (!stmtSpace.get(spaceId)) {
				throw new Error(`Unauthorized: space "${spaceId}" not found`);
			}
		} else if (queryName === 'messages.bySession') {
			// Verify the session exists. We intentionally do not restrict by
			// session type (users can view their own worker, room_chat, space_chat,
			// task_agent, etc. sessions), and the WebSocket clientId check above
			// already requires an active connection.
			const targetSessionId = params[0] as string;
			if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
				throw new Error('Unauthorized: messages.bySession requires a non-empty sessionId');
			}
			if (!stmtSession.get(targetSessionId)) {
				throw new Error(`Unauthorized: session "${targetSessionId}" not found`);
			}
			// Validate the limit parameter is a positive integer so bad input
			// (e.g. NaN, negative numbers) doesn't silently produce an empty result
			// set that the client would interpret as "no messages".
			const limit = params[1];
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 10000) {
				throw new Error(
					`Unauthorized: messages.bySession limit must be an integer in [1, 10000], got ${String(limit)}`
				);
			}
		}

		// 5. Get or create client subscription map
		let clientSubs = subscriptions.get(clientId);
		if (!clientSubs) {
			clientSubs = new Map();
			subscriptions.set(clientId, clientSubs);
		}

		// 6. Handle subscriptionId collision — dispose existing handle silently
		const existing = clientSubs.get(subscriptionId);
		if (existing) {
			log.debug(
				`liveQuery.subscribe: replacing subscription ${subscriptionId} for client ${clientId}`
			);
			existing.dispose();
			clientSubs.delete(subscriptionId);
		}

		// 7. Subscribe to LiveQueryEngine
		const { sql, mapRow } = namedQuery;
		const applyMapRow = (row: Record<string, unknown>) => (mapRow ? mapRow(row) : row);
		const applyMapRows = (rows: Record<string, unknown>[]) => rows.map(applyMapRow);

		// Track whether the synchronous snapshot delivery failed so we can
		// dispose the handle after subscribe() returns.  The snapshot is fired
		// inside liveQueries.subscribe() before it returns the handle, so we
		// cannot call handle.dispose() directly during the callback.
		let snapshotDeliveryFailed = false;

		const handle = liveQueries.subscribe(
			sql,
			params,
			(diff: QueryDiff<Record<string, unknown>>) => {
				const router = messageHub.getRouter();
				if (!router) {
					// Router not yet registered or already torn down.  Mark snapshot
					// as failed so the handle is disposed after subscribe() returns;
					// for deltas this is a no-op since the engine will never fire
					// another callback after the handle is disposed.
					log.warn(
						`liveQuery: router unavailable; skipping event (clientId=${clientId}, subscriptionId=${subscriptionId})`
					);
					if (diff.type === 'snapshot') {
						snapshotDeliveryFailed = true;
					}
					return;
				}

				// Metadata is computed by LiveQueryEngine once per cached query
				// evaluation so identical subscriptions share expensive sidecars
				// like the compact task feed's active-turn aggregation.
				const metadata = diff.metadata;

				let message: ReturnType<typeof createEventMessage>;

				if (diff.type === 'snapshot') {
					const eventData: LiveQuerySnapshotEvent = {
						subscriptionId,
						rows: applyMapRows(diff.rows),
						version: diff.version,
						...(metadata ? { metadata } : {}),
					};
					message = createEventMessage({
						method: 'liveQuery.snapshot',
						data: eventData,
						sessionId,
					});
				} else {
					const eventData: LiveQueryDeltaEvent = {
						subscriptionId,
						added: diff.added ? applyMapRows(diff.added) : undefined,
						removed: diff.removed ? applyMapRows(diff.removed) : undefined,
						updated: diff.updated ? applyMapRows(diff.updated) : undefined,
						version: diff.version,
						...(metadata ? { metadata } : {}),
					};
					message = createEventMessage({
						method: 'liveQuery.delta',
						data: eventData,
						sessionId,
					});
				}

				const sent = router.sendToClient(clientId, message);
				if (!sent) {
					if (diff.type === 'snapshot') {
						// handle not yet assigned; defer cleanup to after subscribe() returns
						snapshotDeliveryFailed = true;
						log.warn(
							`liveQuery: snapshot delivery failed for client ${clientId}; subscription ${subscriptionId} will be disposed`
						);
					} else {
						// Delta: client disconnected — dispose now (handle is assigned)
						log.warn(
							`liveQuery: delta delivery failed for client ${clientId}; disposing subscription ${subscriptionId}`
						);
						handle.dispose();
						const subs = subscriptions.get(clientId);
						if (subs) {
							subs.delete(subscriptionId);
							if (subs.size === 0) subscriptions.delete(clientId);
						}
					}
				}
			},
			{
				debounceMs: namedQuery.debounceMs,
				getMetadata: namedQuery.mapResult,
				scopeExtractor: namedQuery.scopeExtractor,
			}
		);

		// If snapshot delivery failed (no router or client not found), clean up
		// immediately and return ok — this is not a protocol error from the
		// client's perspective.
		if (snapshotDeliveryFailed) {
			handle.dispose();
			return { ok: true } satisfies LiveQuerySubscribeResponse;
		}

		// 8. Track the handle
		clientSubs.set(subscriptionId, handle);
		log.debug(
			`liveQuery.subscribe: registered subscription ${subscriptionId} for client ${clientId}, query=${queryName}`
		);

		return { ok: true } satisfies LiveQuerySubscribeResponse;
	});

	// -------------------------------------------------------------------------
	// liveQuery.unsubscribe
	// -------------------------------------------------------------------------

	messageHub.onRequest('liveQuery.unsubscribe', (data, context) => {
		const { subscriptionId } = data as LiveQueryUnsubscribeRequest;
		const { clientId } = context;

		if (!clientId) {
			throw new Error('liveQuery.unsubscribe requires a WebSocket connection (clientId absent)');
		}

		const clientSubs = subscriptions.get(clientId);
		const handle = clientSubs?.get(subscriptionId);
		if (handle) {
			handle.dispose();
			clientSubs!.delete(subscriptionId);
			if (clientSubs!.size === 0) subscriptions.delete(clientId);
			log.debug(
				`liveQuery.unsubscribe: disposed subscription ${subscriptionId} for client ${clientId}`
			);
		} else {
			log.debug(
				`liveQuery.unsubscribe: subscription ${subscriptionId} not found for client ${clientId}`
			);
		}

		return { ok: true } satisfies LiveQueryUnsubscribeResponse;
	});

	// -------------------------------------------------------------------------
	// Client disconnect cleanup
	// -------------------------------------------------------------------------

	const unsubDisconnect = messageHub.onClientDisconnect((disconnectedClientId) => {
		const clientSubs = subscriptions.get(disconnectedClientId);
		if (!clientSubs || clientSubs.size === 0) return;

		log.debug(
			`liveQuery: client ${disconnectedClientId} disconnected; disposing ${clientSubs.size} subscription(s)`
		);
		for (const [, handle] of clientSubs) {
			handle.dispose();
		}
		subscriptions.delete(disconnectedClientId);
	});

	// -------------------------------------------------------------------------
	// Cleanup function
	// -------------------------------------------------------------------------

	return () => {
		// Dispose all active handles before unregistering the disconnect listener.
		// This ensures handles are cleaned up against the live engine before it
		// may be disposed by the caller (e.g., createDaemonApp shutdown sequence).
		for (const [, clientSubs] of subscriptions) {
			for (const [, handle] of clientSubs) {
				handle.dispose();
			}
		}
		subscriptions.clear();
		unsubDisconnect();
	};
}
