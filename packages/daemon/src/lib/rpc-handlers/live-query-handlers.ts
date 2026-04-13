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
import type { LiveQueryEngine, LiveQueryHandle } from '../../storage/live-query';
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
	 * Optional row transformer applied after every query execution.
	 * Must return a plain object whose keys match the frontend TypeScript types.
	 */
	mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Optional hook to extract metadata from raw query results (before mapRow).
	 * Called once per query evaluation; result is attached to snapshot/delta events.
	 */
	mapResult?: (rawRows: Record<string, unknown>[]) => Record<string, unknown> | undefined;
}

// ============================================================================
// Row mappers
// ============================================================================

/**
 * Map a raw SQLite row from the `tasks` table (with camelCase AS aliases) to
 * the NeoTask shape expected by the frontend.
 *
 * JSON blob columns: `dependsOn` (stored as `depends_on`).
 * All other snake_case→camelCase conversions are handled by AS aliases in the
 * SQL itself so this mapper only handles post-processing that SQL cannot do.
 */
function mapTaskRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		...row,
		dependsOn: JSON.parse((row.dependsOn as string | null) ?? '[]') as string[],
	};
}

/**
 * Map a raw SQLite row from the `goals` table (with camelCase AS aliases) to
 * the RoomGoal shape expected by the frontend.
 *
 * JSON blob columns:
 *   - `linkedTaskIds` (stored as `linked_task_ids`)
 *   - `metrics`       (stored as `metrics`)
 *   - `structuredMetrics` (stored as `structured_metrics`) — optional, null-safe
 *   - `schedule`      (stored as `schedule`)               — optional, null-safe
 *
 * Boolean coercion:
 *   - `schedulePaused` — SQLite stores 0/1; convert to JS boolean
 *
 * snake_case exceptions (per TypeScript type):
 *   - `planning_attempts`    — kept as-is (not aliased in SQL, not converted here)
 *   - `goal_review_attempts` — kept as-is (not aliased in SQL, not converted here)
 */
function mapGoalRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		...row,
		linkedTaskIds: parseJson<string[]>((row.linkedTaskIds as string | null) ?? '[]', []),
		metrics: parseJson<Record<string, number>>((row.metrics as string | null) ?? '{}', {}),
		structuredMetrics: parseJsonOptional(row.structuredMetrics as string | null),
		schedule: parseJsonOptional(row.schedule as string | null),
		schedulePaused: row.schedulePaused === 1,
	};
}

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
	const kind = row.kind === 'task_agent' ? 'task_agent' : 'node_agent';
	const taskId = String(row.taskId ?? '');
	const taskTitle = String(row.taskTitle ?? '');
	const messageType = String(row.messageType ?? 'status');
	const createdAt = Number(row.createdAt ?? Date.now());
	const iteration = Number(row.iteration ?? 0);
	const rawId = row.id;
	const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : `row-${createdAt}`;
	const parentToolUseId = typeof row.parentToolUseId === 'string' ? row.parentToolUseId : null;

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

	return {
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
		parentToolUseId,
	};
}

// ============================================================================
// SQL definitions
// ============================================================================

/**
 * Shared column list for task queries — avoids duplicating the SELECT clause.
 */
const TASKS_SELECT_COLUMNS = `
  id,
  room_id             AS roomId,
  title,
  description,
  status,
  priority,
  progress,
  current_step        AS currentStep,
  result,
  error,
  depends_on          AS dependsOn,
  created_at          AS createdAt,
  started_at          AS startedAt,
  completed_at        AS completedAt,
  task_type           AS taskType,
  assigned_agent      AS assignedAgent,
  created_by_task_id  AS createdByTaskId,
  archived_at         AS archivedAt,
  active_session      AS activeSession,
  pr_url              AS prUrl,
  pr_number           AS prNumber,
  pr_created_at       AS prCreatedAt,
  input_draft         AS inputDraft,
  updated_at          AS updatedAt,
  short_id            AS shortId`;

/**
 * Default task query: excludes archived tasks.
 * The sidebar and dashboard almost never need archived tasks, so filtering
 * them server-side saves bandwidth and client memory.
 */
const TASKS_BY_ROOM_SQL = `
SELECT ${TASKS_SELECT_COLUMNS}
FROM tasks
WHERE room_id = ? AND status != 'archived'
ORDER BY created_at DESC, id DESC
`.trim();

/**
 * All tasks including archived — used when the client explicitly needs the
 * full task history (e.g., the "Archived" tab in the dashboard).
 */
const TASKS_BY_ROOM_ALL_SQL = `
SELECT ${TASKS_SELECT_COLUMNS}
FROM tasks
WHERE room_id = ?
ORDER BY created_at DESC, id DESC
`.trim();

const GOALS_BY_ROOM_SQL = `
SELECT
  id,
  room_id                   AS roomId,
  title,
  description,
  status,
  priority,
  progress,
  linked_task_ids           AS linkedTaskIds,
  metrics,
  created_at                AS createdAt,
  updated_at                AS updatedAt,
  completed_at              AS completedAt,
  planning_attempts,
  goal_review_attempts,
  mission_type              AS missionType,
  autonomy_level            AS autonomyLevel,
  schedule,
  schedule_paused           AS schedulePaused,
  next_run_at               AS nextRunAt,
  structured_metrics        AS structuredMetrics,
  max_consecutive_failures  AS maxConsecutiveFailures,
  max_planning_attempts     AS maxPlanningAttempts,
  consecutive_failures      AS consecutiveFailures,
  replan_count              AS replanCount
FROM goals
WHERE room_id = ?
ORDER BY priority DESC, created_at ASC, id ASC
`.trim();

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

const MCP_ENABLEMENT_BY_ROOM_SQL = `
SELECT
  rme.server_id   AS serverId,
  rme.enabled,
  ams.name,
  ams.source_type AS sourceType,
  ams.description
FROM room_mcp_enablement rme
JOIN app_mcp_servers ams ON ams.id = rme.server_id
WHERE rme.room_id = ?
ORDER BY ams.id ASC
`.trim();

function mapMcpEnablementRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		...row,
		enabled: row.enabled === 1,
	};
}

const SKILLS_BY_ROOM_SQL = `
SELECT
  s.id,
  s.name,
  s.display_name AS displayName,
  s.description,
  s.source_type AS sourceType,
  s.config,
  s.built_in AS builtIn,
  s.validation_status AS validationStatus,
  s.created_at AS createdAt,
  CASE WHEN rso.enabled IS NOT NULL THEN rso.enabled ELSE s.enabled END AS enabled,
  CASE WHEN rso.skill_id IS NOT NULL THEN 1 ELSE 0 END AS overriddenByRoom
FROM skills s
LEFT JOIN room_skill_overrides rso ON rso.skill_id = s.id AND rso.room_id = ?
ORDER BY s.built_in DESC, s.created_at ASC, s.id ASC
`.trim();

function mapSkillByRoomRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		...row,
		config: JSON.parse(row.config as string),
		enabled: row.enabled === 1,
		builtIn: row.builtIn === 1,
		overriddenByRoom: row.overriddenByRoom === 1,
	};
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
	const kind = row.kind === 'task_agent' ? 'task_agent' : 'node_agent';
	const rawRole =
		typeof row.role === 'string' ? row.role : kind === 'task_agent' ? 'task-agent' : 'agent';
	const rawLabel = typeof row.label === 'string' ? row.label : rawRole;

	return {
		...row,
		kind,
		label: kind === 'task_agent' ? 'Task Agent' : formatTaskActivityLabel(rawLabel, 'Agent'),
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
    NULL AS workflow_node_id,
    NULL AS agent_name,
    NULL AS execution_status,
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
    ne.workflow_node_id AS workflow_node_id,
    ne.agent_name AS agent_name,
    ne.status AS execution_status,
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
  ase.workflow_node_id AS workflowNodeId,
  ase.agent_name AS agentName,
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

const SPACE_TASK_MESSAGES_BY_TASK_SQL = `
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
)
SELECT
  sm.id AS id,
  sm.session_id AS sessionId,
  ase.kind AS kind,
  ase.role AS role,
  ase.label AS label,
  ase.task_id AS taskId,
  ase.task_title AS taskTitle,
  sm.message_type AS messageType,
  sm.sdk_message AS content,
  CAST((julianday(sm.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS createdAt,
  CAST(COALESCE(json_extract(sm.sdk_message, '$._taskMeta.iteration'), 0) AS INTEGER) AS iteration,
  json_extract(sm.sdk_message, '$.parent_tool_use_id') AS parentToolUseId
FROM all_sessions ase
JOIN sdk_messages sm ON sm.session_id = ase.session_id
WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
ORDER BY createdAt ASC, id ASC
`.trim();

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

const SPACE_TASKS_NEEDING_ATTENTION_SQL = `
SELECT
  st.id AS id,
  st.title AS title,
  st.status AS status,
  st.block_reason AS blockReason,
  st.result AS result,
  st.task_number AS taskNumber,
  st.space_id AS spaceId,
  st.updated_at AS updatedAt
FROM space_tasks st
WHERE st.space_id = ?
  AND (
    st.status = 'review'
    OR (st.status = 'blocked' AND st.block_reason IN ('human_input_requested', 'gate_rejected'))
  )
ORDER BY st.updated_at DESC, st.id DESC
`.trim();

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

export const NAMED_QUERY_REGISTRY = new Map<string, NamedQuery>([
	[
		'tasks.byRoom',
		{
			sql: TASKS_BY_ROOM_SQL,
			paramCount: 1,
			mapRow: mapTaskRow,
		},
	],
	[
		'tasks.byRoom.all',
		{
			sql: TASKS_BY_ROOM_ALL_SQL,
			paramCount: 1,
			mapRow: mapTaskRow,
		},
	],
	[
		'goals.byRoom',
		{
			sql: GOALS_BY_ROOM_SQL,
			paramCount: 1,
			mapRow: mapGoalRow,
		},
	],
	[
		'sessionGroupMessages.byGroup',
		{
			sql: SESSION_GROUP_MESSAGES_BY_GROUP_SQL,
			paramCount: 1,
			mapRow: mapSessionGroupMessageRow,
		},
	],
	[
		'spaceTaskActivity.byTask',
		{
			sql: SPACE_TASK_ACTIVITY_BY_TASK_SQL,
			paramCount: 1,
			mapRow: mapSpaceTaskActivityRow,
		},
	],
	[
		'spaceTaskMessages.byTask',
		{
			sql: SPACE_TASK_MESSAGES_BY_TASK_SQL,
			paramCount: 1,
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
		'mcpEnablement.byRoom',
		{
			sql: MCP_ENABLEMENT_BY_ROOM_SQL,
			paramCount: 1,
			mapRow: mapMcpEnablementRow,
		},
	],
	[
		'skills.byRoom',
		{
			sql: SKILLS_BY_ROOM_SQL,
			paramCount: 1,
			mapRow: mapSkillByRoomRow,
		},
	],
	[
		'neo.messages',
		{
			sql: NEO_MESSAGES_SQL,
			paramCount: 2,
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
		'spaceTasks.needingAttention',
		{
			sql: SPACE_TASKS_NEEDING_ATTENTION_SQL,
			paramCount: 1,
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
	const sessionsListBase = NAMED_QUERY_REGISTRY.get('sessions.list')!;
	const activeRegistry = new Map(NAMED_QUERY_REGISTRY);
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
		if (
			queryName === 'tasks.byRoom' ||
			queryName === 'tasks.byRoom.all' ||
			queryName === 'goals.byRoom' ||
			queryName === 'mcpEnablement.byRoom' ||
			queryName === 'skills.byRoom'
		) {
			const roomId = params[0] as string;
			if (!stmtRoom.get(roomId)) {
				throw new Error(`Unauthorized: room "${roomId}" not found`);
			}
		} else if (queryName === 'sessionGroupMessages.byGroup') {
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
			queryName === 'spaceTaskMessages.byTask'
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
		} else if (queryName === 'spaceSessions.bySpace') {
			const spaceId = params[0] as string;
			if (!stmtSpace.get(spaceId)) {
				throw new Error(`Unauthorized: space "${spaceId}" not found`);
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
			(diff: {
				type: 'snapshot' | 'delta';
				rows: Record<string, unknown>[];
				added?: Record<string, unknown>[];
				removed?: Record<string, unknown>[];
				updated?: Record<string, unknown>[];
				version: number;
			}) => {
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

				// Extract metadata from raw rows (before mapRow strips internal columns)
				const metadata = namedQuery.mapResult?.(diff.rows as Record<string, unknown>[]);

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
