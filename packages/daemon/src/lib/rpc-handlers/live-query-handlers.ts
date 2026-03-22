/**
 * LiveQuery RPC Handlers
 *
 * Defines the server-side named-query registry for the liveQuery.subscribe /
 * liveQuery.unsubscribe RPC protocol.  Clients send a query name + parameters;
 * the daemon resolves it to a pre-registered SQL template and row mapper.
 * Clients never send raw SQL.
 */

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
		linkedTaskIds: JSON.parse((row.linkedTaskIds as string | null) ?? '[]') as string[],
		metrics: JSON.parse((row.metrics as string | null) ?? '{}') as Record<string, number>,
		structuredMetrics:
			row.structuredMetrics != null
				? (JSON.parse(row.structuredMetrics as string) as unknown[])
				: undefined,
		schedule: row.schedule != null ? (JSON.parse(row.schedule as string) as unknown) : undefined,
		schedulePaused: row.schedulePaused === 1,
	};
}

// ============================================================================
// SQL definitions
// ============================================================================

const TASKS_BY_ROOM_SQL = `
SELECT
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
  updated_at          AS updatedAt
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

/**
 * session_group_messages is an append-only table populated in Milestone 4.
 * The registry entry is defined here so the liveQuery.subscribe handler can
 * validate query names at subscription time without coupling to that milestone.
 */
const SESSION_GROUP_MESSAGES_BY_GROUP_SQL = `
SELECT
  id,
  group_id    AS groupId,
  session_id  AS sessionId,
  role,
  message_type AS messageType,
  content,
  created_at  AS createdAt
FROM session_group_messages
WHERE group_id = ?
ORDER BY created_at ASC, id ASC
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
			// No JSON blobs; all columns are scalar.
		},
	],
]);
