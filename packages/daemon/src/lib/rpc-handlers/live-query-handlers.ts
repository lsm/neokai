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
import { createEventMessage } from '@neokai/shared';
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
  CAST(COALESCE(json_extract(sm.sdk_message, '$._taskMeta.iteration'), 0) AS INTEGER) AS iteration
FROM target_group tg
JOIN session_group_members gm ON gm.group_id = tg.id
JOIN sdk_messages sm ON sm.session_id = gm.session_id
WHERE (sm.message_type != 'user' OR COALESCE(sm.send_status, 'sent') IN ('sent', 'failed'))
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
  0                             AS iteration
FROM target_group tg
JOIN task_group_events e ON e.group_id = tg.id
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
			mapRow: mapSessionGroupMessageRow,
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

	// Cache prepared statements once at setup time — compiled once per handler
	// registration, not once per subscribe call (which would add compilation
	// overhead on every subscribe RPC invocation).
	const stmtRoom = db.prepare('SELECT id FROM rooms WHERE id = ?');
	const stmtGroup = db.prepare('SELECT ref_id, group_type FROM session_groups WHERE id = ?');
	const stmtTask = db.prepare('SELECT room_id FROM tasks WHERE id = ?');

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
		const namedQuery = NAMED_QUERY_REGISTRY.get(queryName);
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
		if (queryName === 'tasks.byRoom' || queryName === 'goals.byRoom') {
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

				let message: ReturnType<typeof createEventMessage>;

				if (diff.type === 'snapshot') {
					const eventData: LiveQuerySnapshotEvent = {
						subscriptionId,
						rows: applyMapRows(diff.rows),
						version: diff.version,
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
