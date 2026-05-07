/**
 * NodeExecutionRepository
 *
 * Repository for NodeExecution CRUD operations.
 *
 * Records the execution of a single agent slot within a workflow run's node.
 * One row is created per (workflowRunId, workflowNodeId, agentName) triple.
 * This separates workflow-internal state from the user-facing SpaceTask.
 *
 * Table: node_executions
 *   - FK to space_workflow_runs ON DELETE CASCADE
 *   - FK to space_agents ON DELETE SET NULL
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { createLogger, generateUUID } from '@neokai/shared';
import type {
	NodeExecution,
	NodeExecutionStatus,
	CreateNodeExecutionParams,
	UpdateNodeExecutionParams,
} from '@neokai/shared';
import type { SQLiteValue } from '../types';

const log = createLogger('kai:daemon:storage:node-execution-repo');

// Per-process set of error fingerprints already warned about. Without this,
// a busy execution-update loop would emit one warning per UPSERT — drown
// the log for what is almost always a "test harness without sessions
// table" or a "session row not yet committed" race.
const warnedSwallowedErrors = new Set<string>();

export class NodeExecutionRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Wrap a task_session_map mutation so a missing FK target table
	 * (e.g. `sessions`, `node_executions`) doesn't bubble. SQLite validates
	 * FK target tables at *prepare* time, so when a unit-test harness
	 * builds only a subset of the schema the prepare throws synchronously.
	 * Production always has every parent table, so this guard is a pure
	 * no-op outside test harnesses.
	 *
	 * Also tolerates runtime FK constraint violations: with sessions FK
	 * enforced, a node execution that points at a session id with no
	 * matching `sessions(id)` row can no longer be mapped — we treat that
	 * as "session not yet tracked, skip the map row" rather than throwing,
	 * matching the fail-closed semantics of `upsertTaskAgentSessionMap`.
	 *
	 * Both swallowed cases emit a deduplicated warning so genuine bugs
	 * (e.g. an FK target table being dropped in production) don't stay
	 * invisible. Anything else still throws.
	 */
	private tryRunMapMutation(fn: () => void, context: string): void {
		try {
			fn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const noSuchTable = /no such table/i.test(message);
			const fkViolation = /FOREIGN KEY constraint failed/i.test(message);
			if (noSuchTable || fkViolation) {
				const kind = noSuchTable ? 'no-such-table' : 'fk-violation';
				const fingerprint = `node-execution:${kind}:${context}`;
				if (!warnedSwallowedErrors.has(fingerprint)) {
					warnedSwallowedErrors.add(fingerprint);
					log.warn(
						`task_session_map mutation skipped (${kind}) at ${context}: ${message}. ` +
							`Further occurrences of this fingerprint will be suppressed.`
					);
				}
				return;
			}
			throw err;
		}
	}

	/**
	 * Create a new node execution record.
	 * Throws on constraint violations (e.g., duplicate UNIQUE key).
	 */
	create(params: CreateNodeExecutionParams): NodeExecution {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO node_executions
				    (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				     agent_session_id, status, result, data, created_at, started_at,
				     completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.workflowRunId,
				params.workflowNodeId,
				params.agentName,
				params.agentId ?? null,
				params.agentSessionId ?? null,
				params.status ?? 'pending',
				null,
				null,
				now,
				null,
				null,
				now
			);

		if (params.agentSessionId) {
			this.syncTaskSessionMapForExecution(id, params.agentSessionId, now);
		}

		return this.getById(id)!;
	}

	/**
	 * Create a node execution record, ignoring if a duplicate already exists.
	 *
	 * Uses INSERT OR IGNORE to handle concurrent activateNode() calls gracefully.
	 * If a record with the same (workflow_run_id, workflow_node_id, agent_name)
	 * already exists (UNIQUE constraint), the insert is silently skipped and
	 * the existing record is returned.
	 *
	 * @returns The newly created record, or the existing record if a duplicate was found.
	 */
	createOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT OR IGNORE INTO node_executions
					    (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
					     agent_session_id, status, result, data, created_at, started_at,
					     completed_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.workflowRunId,
				params.workflowNodeId,
				params.agentName,
				params.agentId ?? null,
				params.agentSessionId ?? null,
				params.status ?? 'pending',
				null,
				null,
				now,
				null,
				null,
				now
			);

		// If the insert was ignored (duplicate), return the existing record.
		const inserted = this.getById(id);
		if (inserted) {
			if (params.agentSessionId) {
				this.syncTaskSessionMapForExecution(id, params.agentSessionId, now);
			}
			return inserted;
		}

		// Duplicate — find the existing record by unique key.
		const existing = this.db
			.prepare(
				`SELECT * FROM node_executions
				        WHERE workflow_run_id = ? AND workflow_node_id = ? AND agent_name = ?
				        ORDER BY created_at ASC LIMIT 1`
			)
			.get(params.workflowRunId, params.workflowNodeId, params.agentName) as
			| Record<string, unknown>
			| undefined;

		if (existing) {
			const existingExecution = this.rowToNodeExecution(existing);
			if (existingExecution.agentSessionId) {
				this.syncTaskSessionMapForExecution(
					existingExecution.id,
					existingExecution.agentSessionId,
					existingExecution.createdAt
				);
			}
			return existingExecution;
		}
		const fallback = this.getById(id);
		if (fallback) return fallback;
		throw new Error(
			`node_execution record not found after INSERT OR IGNORE for (${params.workflowRunId}, ${params.workflowNodeId}, ${params.agentName})`
		);
	}

	/**
	 * Get a node execution by ID
	 */
	getById(id: string): NodeExecution | null {
		const row = this.db.prepare(`SELECT * FROM node_executions WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;

		if (!row) return null;
		return this.rowToNodeExecution(row);
	}

	/**
	 * List all node executions for a workflow run
	 */
	listByWorkflowRun(workflowRunId: string): NodeExecution[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM node_executions WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC`
			)
			.all(workflowRunId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToNodeExecution(r));
	}

	/**
	 * List node executions for a specific node within a workflow run
	 */
	listByNode(workflowRunId: string, workflowNodeId: string): NodeExecution[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM node_executions
				        WHERE workflow_run_id = ? AND workflow_node_id = ?
				        ORDER BY created_at ASC, id ASC`
			)
			.all(workflowRunId, workflowNodeId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToNodeExecution(r));
	}

	/**
	 * Update a node execution with partial updates
	 */
	update(id: string, params: UpdateNodeExecutionParams): NodeExecution | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);

			// Auto-stamp timestamps only when the caller does NOT provide
			// an explicit value — avoids duplicate SET entries in the SQL.
			if (params.status === 'in_progress' && params.startedAt === undefined) {
				fields.push('started_at = ?');
				values.push(Date.now());
			} else if (
				(params.status === 'idle' ||
					params.status === 'blocked' ||
					params.status === 'cancelled') &&
				params.completedAt === undefined
			) {
				fields.push('completed_at = ?');
				values.push(Date.now());
			}
		}
		// Snapshot the agent session id BEFORE the UPDATE so we can detect
		// rebind/clear transitions and reconcile task_session_map after the
		// canonical column has been written.
		let priorSessionId: string | null = null;
		if (params.agentSessionId !== undefined) {
			fields.push('agent_session_id = ?');
			values.push(params.agentSessionId ?? null);
			const existing = this.getById(id);
			priorSessionId = existing?.agentSessionId ?? null;
		}
		if (params.result !== undefined) {
			fields.push('result = ?');
			values.push(params.result ?? null);
		}
		if (params.data !== undefined) {
			fields.push('data = ?');
			values.push(params.data !== null ? JSON.stringify(params.data) : null);
		}
		if (params.startedAt !== undefined) {
			fields.push('started_at = ?');
			values.push(params.startedAt ?? null);
		}
		if (params.completedAt !== undefined) {
			fields.push('completed_at = ?');
			values.push(params.completedAt ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			this.db
				.prepare(`UPDATE node_executions SET ${fields.join(', ')} WHERE id = ?`)
				.run(...values);
		}

		// Reconcile task_session_map AFTER the canonical column has been
		// written. Doing this post-update lets `removeTaskSessionMapForExecution`'s
		// rebuild query see the new state of `node_executions.agent_session_id`,
		// so a clear/rebind that genuinely removes the last reference doesn't
		// accidentally re-insert from the just-updated row.
		if (params.agentSessionId !== undefined) {
			if (priorSessionId && priorSessionId !== params.agentSessionId) {
				this.removeTaskSessionMapForExecution(id, priorSessionId);
			}
			if (params.agentSessionId) {
				this.syncTaskSessionMapForExecution(id, params.agentSessionId, Date.now());
			} else if (priorSessionId) {
				this.removeTaskSessionMapForExecution(id, priorSessionId);
			}
		}

		return this.getById(id);
	}

	/**
	 * Update only the status of a node execution, with automatic timestamp stamping.
	 */
	updateStatus(id: string, status: NodeExecutionStatus): NodeExecution | null {
		return this.update(id, { status });
	}

	/**
	 * Update the agent session ID for a node execution.
	 * Used when an agent sub-session is created or cleared.
	 */
	updateSessionId(id: string, agentSessionId: string | null): NodeExecution | null {
		return this.update(id, { agentSessionId });
	}

	/**
	 * Delete a node execution by ID
	 */
	delete(id: string): boolean {
		// Capture (task_id, session_id) pairs this execution contributes to BEFORE
		// the delete, so we can rebuild the map after the row is gone. Reading
		// from task_session_map (rather than recomputing via node_executions) is
		// sufficient because the map is kept in sync at write time.
		let affectedPairs: Array<{ taskId: string; sessionId: string }> = [];
		try {
			affectedPairs = this.db
				.prepare(
					`SELECT task_id AS taskId, session_id AS sessionId
					 FROM task_session_map
					 WHERE kind = 'node_agent' AND node_execution_id = ?`
				)
				.all(id) as Array<{ taskId: string; sessionId: string }>;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!/no such table/i.test(message)) {
				throw err;
			}
		}

		const result = this.db.prepare(`DELETE FROM node_executions WHERE id = ?`).run(id);
		if (result.changes > 0) {
			// Drop the rows owned by this execution, then rebuild any
			// (task_id, session_id) pair that another node_execution still
			// references. This preserves shared-session mappings — long-lived
			// agent sessions reused across executions stay attached to the
			// task's timeline as long as at least one execution still binds them.
			this.tryRunMapMutation(() => {
				this.db
					.prepare(
						`DELETE FROM task_session_map WHERE kind = 'node_agent' AND node_execution_id = ?`
					)
					.run(id);
			}, 'delete:dropExecutionRows');
			for (const pair of affectedPairs) {
				this.rebuildNodeAgentMapForTaskSession(pair.taskId, pair.sessionId);
			}
		}
		return result.changes > 0;
	}

	/**
	 * Find a node execution by its agent session ID.
	 * Returns the most relevant active/latest match or null if none exists.
	 *
	 * A long-lived named agent session can be reused across multiple workflow
	 * node executions. Prefer active executions so runtime MCP self-heal rebuilds
	 * node-agent with the current node context rather than an older completed row.
	 */
	getByAgentSessionId(agentSessionId: string): NodeExecution | null {
		return this.listByAgentSessionId(agentSessionId)[0] ?? null;
	}

	/**
	 * List node executions bound to an agent session, with active/latest rows first.
	 */
	listByAgentSessionId(agentSessionId: string): NodeExecution[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM node_executions
				 WHERE agent_session_id = ?
				 ORDER BY
					   CASE status
					     WHEN 'in_progress' THEN 0
					     WHEN 'waiting_rebind' THEN 1
					     WHEN 'blocked' THEN 2
					     WHEN 'pending' THEN 3
					     ELSE 4
					   END,
				   updated_at DESC,
				   created_at DESC,
				   id DESC`
			)
			.all(agentSessionId) as Record<string, unknown>[];

		return rows.map((row) => this.rowToNodeExecution(row));
	}

	/**
	 * Delete all node executions for a workflow run
	 */
	deleteByWorkflowRun(workflowRunId: string): void {
		// Drop dependent task_session_map rows first so we don't leave orphan
		// entries pointing at deleted node executions. Redundant under the
		// new FK ON DELETE CASCADE on node_execution_id but kept for harnesses
		// without FKs enabled.
		this.tryRunMapMutation(() => {
			this.db
				.prepare(
					`DELETE FROM task_session_map
					 WHERE kind = 'node_agent'
					   AND node_execution_id IN (
					     SELECT id FROM node_executions WHERE workflow_run_id = ?
					   )`
				)
				.run(workflowRunId);
		}, 'deleteByWorkflowRun');
		this.db.prepare(`DELETE FROM node_executions WHERE workflow_run_id = ?`).run(workflowRunId);
	}

	/**
	 * Maintain the node_agent leg of task_session_map for a given execution.
	 *
	 * The mapping is fan-out: a workflow run with N nodes covering K tasks emits
	 * N×K rows, one per (task_id, session_id) pair. This is fine because the
	 * map is the single source of truth for "which sessions does this task's
	 * timeline include" and read paths JOIN on `task_id`.
	 *
	 * Resolves the agent's display label (`task_session_map.label`) from
	 * `space_agents.name` when possible, falling back to `node_executions.agent_name`
	 * — matches the precedence the live-query handlers used to compute inline.
	 */
	private syncTaskSessionMapForExecution(
		executionId: string,
		sessionId: string,
		createdAt: number
	): void {
		this.tryRunMapMutation(() => {
			const stmt = this.db.prepare(
				`INSERT OR REPLACE INTO task_session_map (
					task_id, session_id, kind, role, label, node_execution_id, created_at
				)
				SELECT
					st.id AS task_id,
					? AS session_id,
					'node_agent' AS kind,
					ne.agent_name AS role,
					COALESCE(sa.name, ne.agent_name, 'agent') AS label,
					ne.id AS node_execution_id,
					? AS created_at
				FROM node_executions ne
				JOIN space_tasks st
					ON st.workflow_run_id IS NOT NULL
					AND ne.workflow_run_id = st.workflow_run_id
				LEFT JOIN space_agents sa ON sa.id = ne.agent_id
				WHERE ne.id = ?`
			);
			stmt.run(sessionId, createdAt, executionId);
		}, 'syncTaskSessionMapForExecution');
	}

	/**
	 * Remove the node_agent leg of task_session_map for a given execution + session
	 * pair. Called when an agent_session_id flips to a different value or is cleared.
	 *
	 * Because the map is keyed by `(task_id, session_id)` and `INSERT OR REPLACE`
	 * lets the latest writer "own" the row, naïvely deleting by
	 * `(node_execution_id, session_id)` would drop the only mapping for a session
	 * that another execution still references — long-lived agent sessions are
	 * explicitly reused across executions in this repo. Instead, drop the rows
	 * owned by this execution and rebuild each affected `(task_id, session_id)`
	 * from any remaining execution that still binds the same session.
	 */
	private removeTaskSessionMapForExecution(executionId: string, sessionId: string): void {
		this.tryRunMapMutation(() => {
			const affectedPairs = this.db
				.prepare(
					`SELECT task_id AS taskId
					 FROM task_session_map
					 WHERE kind = 'node_agent' AND node_execution_id = ? AND session_id = ?`
				)
				.all(executionId, sessionId) as Array<{ taskId: string }>;

			this.db
				.prepare(
					`DELETE FROM task_session_map
					 WHERE kind = 'node_agent' AND node_execution_id = ? AND session_id = ?`
				)
				.run(executionId, sessionId);

			for (const { taskId } of affectedPairs) {
				this.rebuildNodeAgentMapForTaskSession(taskId, sessionId);
			}
		}, 'removeTaskSessionMapForExecution');
	}

	/**
	 * Re-derive the `task_session_map` node_agent row for a `(task_id, session_id)`
	 * pair from any remaining `node_executions` that still bind that session to the
	 * same task's workflow run. No-op if no such execution exists, which is the
	 * correct behaviour: the session genuinely no longer contributes to the task.
	 */
	private rebuildNodeAgentMapForTaskSession(taskId: string, sessionId: string): void {
		this.tryRunMapMutation(() => {
			this.db
				.prepare(
					`INSERT OR REPLACE INTO task_session_map (
						task_id, session_id, kind, role, label, node_execution_id, created_at
					)
					SELECT
						st.id AS task_id,
						ne.agent_session_id AS session_id,
						'node_agent' AS kind,
						ne.agent_name AS role,
						COALESCE(sa.name, ne.agent_name, 'agent') AS label,
						ne.id AS node_execution_id,
						COALESCE(ne.created_at, strftime('%s','now') * 1000) AS created_at
					FROM node_executions ne
					JOIN space_tasks st
						ON st.workflow_run_id IS NOT NULL
						AND ne.workflow_run_id = st.workflow_run_id
					LEFT JOIN space_agents sa ON sa.id = ne.agent_id
					WHERE st.id = ?
						AND ne.agent_session_id = ?
					ORDER BY ne.updated_at DESC, ne.created_at DESC, ne.id DESC
					LIMIT 1`
				)
				.run(taskId, sessionId);
		}, 'rebuildNodeAgentMapForTaskSession');
	}

	/**
	 * Convert a database row to a NodeExecution object
	 */
	private rowToNodeExecution(row: Record<string, unknown>): NodeExecution {
		const rawData = row.data as string | null | undefined;
		let parsedData: Record<string, unknown> | null = null;
		if (rawData) {
			try {
				parsedData = JSON.parse(rawData) as Record<string, unknown>;
			} catch {
				parsedData = null;
			}
		}
		return {
			id: row.id as string,
			workflowRunId: row.workflow_run_id as string,
			workflowNodeId: row.workflow_node_id as string,
			agentName: row.agent_name as string,
			agentId: (row.agent_id as string | null) ?? null,
			agentSessionId: (row.agent_session_id as string | null) ?? null,
			status: row.status as NodeExecutionStatus,
			result: (row.result as string | null) ?? null,
			data: parsedData,
			createdAt: row.created_at as number,
			startedAt: (row.started_at as number | null) ?? null,
			completedAt: (row.completed_at as number | null) ?? null,
			updatedAt: row.updated_at as number,
		};
	}
}
