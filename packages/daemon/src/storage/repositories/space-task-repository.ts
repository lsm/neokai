/**
 * Space Task Repository
 *
 * Repository for SpaceTask CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { createLogger, generateUUID } from '@neokai/shared';
import type {
	SpaceTask,
	SpaceTaskStatus,
	CreateSpaceTaskParams,
	UpdateSpaceTaskParams,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

const log = createLogger('kai:daemon:storage:space-task-repo');

// Per-process set of error fingerprints already warned about. Without this,
// a busy task-agent loop would emit one warning per UPSERT — drown the log
// for what is almost always a "test harness without sessions table" or a
// "session row not yet committed" race that resolves on the next write.
const warnedSwallowedErrors = new Set<string>();

export class SpaceTaskRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb?: ReactiveDatabase
	) {}

	/**
	 * Wrap a task_session_map mutation so a missing FK target table (e.g.
	 * `sessions`, `node_executions`) doesn't bubble. SQLite validates FK
	 * target tables at *prepare* time, so when a unit-test harness builds
	 * only a subset of the schema the prepare throws synchronously. In
	 * production every parent table exists (createTables runs after
	 * migrations) so this guard is a pure no-op outside test harnesses.
	 *
	 * Also tolerates runtime FK constraint violations: with sessions FK
	 * enforced, mutations that reference an as-yet-unwritten `sessions(id)`
	 * row can no longer succeed — we treat that as "session not yet
	 * tracked, skip the map row" rather than throwing, matching the
	 * fail-closed semantics callers already expect from
	 * `upsertTaskAgentSessionMap`.
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
				const fingerprint = `space-task:${kind}:${context}`;
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
	 * Create a new space task
	 */
	createTask(params: CreateSpaceTaskParams): SpaceTask {
		const id = generateUUID();
		const now = Date.now();

		// Wrap SELECT MAX + INSERT in an explicit transaction to prevent concurrent
		// requests from computing the same task_number. SQLite serialises write
		// transactions, so the UNIQUE index is the safety net, but the transaction
		// ensures correctness without relying on constraint errors.
		const insertTx = this.db.transaction(() => {
			const nextNumber = (
				this.db
					.prepare(
						`SELECT COALESCE(MAX(task_number), 0) + 1 AS next FROM space_tasks WHERE space_id = ?`
					)
					.get(params.spaceId) as { next: number }
			).next;

			this.db
				.prepare(
					`INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, preferred_workflow_id, created_by_task_id, depends_on, task_agent_session_id, created_by, created_by_session, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					id,
					params.spaceId,
					nextNumber,
					params.title,
					params.description ?? '',
					params.status ?? 'open',
					params.priority ?? 'normal',
					JSON.stringify(params.labels ?? []),
					params.workflowRunId ?? null,
					params.preferredWorkflowId ?? null,
					params.createdByTaskId ?? null,
					JSON.stringify(params.dependsOn ?? []),
					params.taskAgentSessionId ?? null,
					params.createdBy ?? null,
					params.createdBySession ?? null,
					now,
					now
				);

			if (params.taskAgentSessionId) {
				this.upsertTaskAgentSessionMap(id, params.taskAgentSessionId, now);
			}

			// If the task is created already attached to a workflow run, seed
			// node_agent rows from any executions that already exist for that
			// run. Without this seed, `spaceTaskMessages.byTask*` (which JOINs
			// task_session_map directly) would miss every existing node-agent
			// session until some later execution write happens.
			if (params.workflowRunId) {
				this.seedNodeAgentSessionMapForRun(id, params.workflowRunId, now);
			}
		});

		insertTx();
		this.reactiveDb?.notifyChange('space_tasks');

		return this.getTask(id)!;
	}

	/**
	 * Get a task by ID
	 */
	getTask(id: string): SpaceTask | null {
		const stmt = this.db.prepare(`SELECT * FROM space_tasks WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToSpaceTask(row);
	}

	/**
	 * List tasks for a space, with optional status filter and pagination.
	 * When limit is not provided (or 0), returns all matching tasks (unbounded).
	 */
	listBySpace(spaceId: string, includeArchived = false, limit?: number, offset = 0): SpaceTask[] {
		let query = `SELECT * FROM space_tasks WHERE space_id = ?`;
		if (!includeArchived) {
			query += ` AND status != 'archived'`;
		}
		query += ` ORDER BY updated_at DESC, id DESC`;
		if (limit && limit > 0) {
			query += ` LIMIT ? OFFSET ?`;
			const stmt = this.db.prepare(query);
			const rows = stmt.all(spaceId, limit, offset) as Record<string, unknown>[];
			return rows.map((r) => this.rowToSpaceTask(r));
		}
		const stmt = this.db.prepare(query);
		const rows = stmt.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * List tasks for a workflow run
	 */
	listByWorkflowRun(workflowRunId: string): SpaceTask[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE workflow_run_id = ? AND status != 'archived' ORDER BY created_at ASC`
		);
		const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * List tasks for a workflow run, INCLUDING archived tasks.
	 *
	 * Archive is the authoritative tombstone for a task: once archived, no
	 * further inter-agent messages or node activations are permitted for the
	 * run. Callers that enforce that tombstone (e.g. `ChannelRouter`) must be
	 * able to see the archived task to throw the correct error — they cannot
	 * rely on `listByWorkflowRun()`, which filters archived tasks out.
	 */
	listByWorkflowRunIncludingArchived(workflowRunId: string): SpaceTask[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE workflow_run_id = ? ORDER BY created_at ASC`
		);
		const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * List standalone tasks for a space (tasks with no workflowRunId).
	 * The SQL-level filter avoids fetching workflow tasks that would be discarded by the caller.
	 */
	listStandaloneBySpace(spaceId: string, includeArchived = false): SpaceTask[] {
		let query = `SELECT * FROM space_tasks WHERE space_id = ? AND workflow_run_id IS NULL`;
		if (!includeArchived) {
			query += ` AND status != 'archived'`;
		}
		query += ` ORDER BY updated_at DESC`;

		const stmt = this.db.prepare(query);
		const rows = stmt.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * List tasks by status within a space, with optional pagination.
	 * When limit is not provided (or 0), returns all matching tasks (unbounded).
	 */
	listByStatus(spaceId: string, status: SpaceTaskStatus, limit?: number, offset = 0): SpaceTask[] {
		let query = `SELECT * FROM space_tasks WHERE space_id = ? AND status = ? ORDER BY updated_at DESC, id DESC`;
		if (limit && limit > 0) {
			query += ` LIMIT ? OFFSET ?`;
			const stmt = this.db.prepare(query);
			const rows = stmt.all(spaceId, status, limit, offset) as Record<string, unknown>[];
			return rows.map((r) => this.rowToSpaceTask(r));
		}
		const stmt = this.db.prepare(query);
		const rows = stmt.all(spaceId, status) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * Count tasks for a space, optionally filtered by status.
	 * Excludes archived by default, unless status is explicitly 'archived'.
	 */
	countBySpace(spaceId: string, status?: SpaceTaskStatus, includeArchived = false): number {
		let query = `SELECT COUNT(*) as count FROM space_tasks WHERE space_id = ?`;
		const params: SQLiteValue[] = [spaceId];
		// When the caller explicitly filters by 'archived', include archived rows
		// even if includeArchived is false — the status filter is the intent.
		if (!includeArchived && status !== 'archived') {
			query += ` AND status != 'archived'`;
		}
		if (status) {
			query += ` AND status = ?`;
			params.push(status);
		}
		const stmt = this.db.prepare(query);
		const row = stmt.get(...params) as { count: number } | undefined;
		return row?.count ?? 0;
	}

	/**
	 * Update a task with partial updates
	 */
	updateTask(id: string, params: UpdateSpaceTaskParams): SpaceTask | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.title !== undefined) {
			fields.push('title = ?');
			values.push(params.title);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description);
		}
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);

			if (params.status === 'in_progress') {
				// Always stamp started_at on entry to in_progress, including re-entries from
				// blocked or cancelled. This records when the most recent work began,
				// not when the task was originally created.
				fields.push('started_at = ?');
				values.push(Date.now());
				if (params.completedAt === undefined) {
					fields.push('completed_at = ?');
					values.push(null);
				}
			} else if (params.status === 'open') {
				if (params.completedAt === undefined) {
					fields.push('completed_at = ?');
					values.push(null);
				}
			} else if (
				params.status === 'done' ||
				params.status === 'blocked' ||
				params.status === 'cancelled'
			) {
				fields.push('completed_at = ?');
				values.push(Date.now());
			} else if (params.status === 'archived') {
				fields.push('archived_at = ?');
				values.push(Date.now());
			}
		}
		if (params.priority !== undefined) {
			fields.push('priority = ?');
			values.push(params.priority);
		}
		if (params.labels !== undefined) {
			fields.push('labels = ?');
			values.push(JSON.stringify(params.labels));
		}
		if (params.workflowRunId !== undefined) {
			fields.push('workflow_run_id = ?');
			values.push(params.workflowRunId ?? null);
		}
		if (params.preferredWorkflowId !== undefined) {
			fields.push('preferred_workflow_id = ?');
			values.push(params.preferredWorkflowId ?? null);
		}
		if (params.createdByTaskId !== undefined) {
			fields.push('created_by_task_id = ?');
			values.push(params.createdByTaskId ?? null);
		}
		if (params.result !== undefined) {
			fields.push('result = ?');
			values.push(params.result ?? null);
		}
		if (params.dependsOn !== undefined) {
			fields.push('depends_on = ?');
			values.push(JSON.stringify(params.dependsOn));
		}
		if (params.activeSession !== undefined) {
			fields.push('active_session = ?');
			values.push(params.activeSession ?? null);
		}
		// Auto-clear active_session when task reaches a terminal status
		if (
			params.activeSession === undefined &&
			(params.status === 'done' ||
				params.status === 'blocked' ||
				params.status === 'cancelled' ||
				params.status === 'archived')
		) {
			fields.push('active_session = ?');
			values.push(null);
		}
		if (params.taskAgentSessionId !== undefined) {
			fields.push('task_agent_session_id = ?');
			values.push(params.taskAgentSessionId ?? null);
			// task_session_map mutation for this is deferred until after the
			// UPDATE succeeds — see the post-update block below. Mutating it
			// up-front would risk leaving the map ahead of the canonical column
			// when a stale/nonexistent task id is passed.
		}
		if (params.startedAt !== undefined) {
			fields.push('started_at = ?');
			values.push(params.startedAt ?? null);
		}
		if (params.completedAt !== undefined) {
			fields.push('completed_at = ?');
			values.push(params.completedAt ?? null);
		}
		if (params.archivedAt !== undefined) {
			fields.push('archived_at = ?');
			values.push(params.archivedAt ?? null);
		}
		if (params.blockReason !== undefined) {
			fields.push('block_reason = ?');
			values.push(params.blockReason ?? null);
		}
		if (params.approvalSource !== undefined) {
			fields.push('approval_source = ?');
			values.push(params.approvalSource ?? null);
		}
		if (params.approvalReason !== undefined) {
			fields.push('approval_reason = ?');
			values.push(params.approvalReason ?? null);
		}
		if (params.approvedAt !== undefined) {
			fields.push('approved_at = ?');
			values.push(params.approvedAt ?? null);
		}
		if (params.pendingCheckpointType !== undefined) {
			fields.push('pending_checkpoint_type = ?');
			values.push(params.pendingCheckpointType ?? null);
		}
		if (params.pendingCompletionSubmittedByNodeId !== undefined) {
			fields.push('pending_completion_submitted_by_node_id = ?');
			values.push(params.pendingCompletionSubmittedByNodeId ?? null);
		}
		if (params.pendingCompletionSubmittedAt !== undefined) {
			fields.push('pending_completion_submitted_at = ?');
			values.push(params.pendingCompletionSubmittedAt ?? null);
		}
		if (params.pendingCompletionReason !== undefined) {
			fields.push('pending_completion_reason = ?');
			values.push(params.pendingCompletionReason ?? null);
		}
		if (params.reportedStatus !== undefined) {
			fields.push('reported_status = ?');
			values.push(params.reportedStatus ?? null);
		}
		if (params.reportedSummary !== undefined) {
			fields.push('reported_summary = ?');
			values.push(params.reportedSummary ?? null);
		}
		// Post-approval columns (PR 1/5 of the post-approval refactor — no
		// runtime consumer yet; PR 2 wires them up).
		if (params.postApprovalSessionId !== undefined) {
			fields.push('post_approval_session_id = ?');
			values.push(params.postApprovalSessionId ?? null);
		}
		if (params.postApprovalStartedAt !== undefined) {
			fields.push('post_approval_started_at = ?');
			values.push(params.postApprovalStartedAt ?? null);
		}
		if (params.postApprovalBlockedReason !== undefined) {
			fields.push('post_approval_blocked_reason = ?');
			values.push(params.postApprovalBlockedReason ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(`UPDATE space_tasks SET ${fields.join(', ')} WHERE id = ?`);
			const result = stmt.run(...values);

			// Only mutate task_session_map after we've confirmed the UPDATE
			// affected a row. Mutating it earlier (or unconditionally) would
			// leave denormalised state for stale/nonexistent task ids.
			if (result.changes > 0) {
				if (params.taskAgentSessionId !== undefined) {
					if (params.taskAgentSessionId) {
						this.upsertTaskAgentSessionMap(id, params.taskAgentSessionId, Date.now());
					} else {
						this.removeTaskAgentSessionMap(id);
					}
				}

				// When a task is detached from a workflow run (or moved to a
				// different one), drop stale node_agent rows and immediately
				// re-seed from any executions that already exist for the new
				// run. The read path (`spaceTaskMessages.byTask*`) joins
				// task_session_map directly, so leaving stale rows around
				// would surface sessions that no longer belong, and *not*
				// seeding for a target run that already has executions would
				// hide every node-agent session until some later execution
				// write fires. NodeExecutionRepository continues to keep the
				// map in sync for executions that land after this point.
				if (params.workflowRunId !== undefined) {
					this.tryRunMapMutation(() => {
						this.db
							.prepare(`DELETE FROM task_session_map WHERE task_id = ? AND kind = 'node_agent'`)
							.run(id);
					}, 'updateTask:clearNodeAgents');
					if (params.workflowRunId) {
						this.seedNodeAgentSessionMapForRun(id, params.workflowRunId, Date.now());
					}
				}
			}

			this.reactiveDb?.notifyChange('space_tasks');
		}

		return this.getTask(id);
	}

	/**
	 * Archive a task by setting status to 'archived' and archived_at timestamp.
	 * status = 'archived' is the canonical source of truth; archived_at is a derived timestamp.
	 */
	archiveTask(id: string): SpaceTask | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE space_tasks SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`
		);
		stmt.run(now, now, id);
		this.reactiveDb?.notifyChange('space_tasks');
		return this.getTask(id);
	}

	/**
	 * Delete a task by ID
	 */
	deleteTask(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM space_tasks WHERE id = ?`);
		const result = stmt.run(id);
		if (result.changes > 0) {
			// Redundant given the FK ON DELETE CASCADE on
			// task_session_map.task_id, but explicit for tests that don't
			// run with PRAGMA foreign_keys = ON or that build the schema
			// without the FK.
			this.tryRunMapMutation(() => {
				this.db.prepare(`DELETE FROM task_session_map WHERE task_id = ?`).run(id);
			}, 'deleteTask');
			this.reactiveDb?.notifyChange('space_tasks');
		}
		return result.changes > 0;
	}

	/**
	 * Delete all tasks for a space
	 */
	deleteTasksForSpace(spaceId: string): void {
		// Drop dependent task_session_map rows first so we don't leave orphan
		// entries pointing at deleted tasks. Redundant under the new FK
		// ON DELETE CASCADE but kept for harnesses without FKs enabled.
		this.tryRunMapMutation(() => {
			this.db
				.prepare(
					`DELETE FROM task_session_map
					 WHERE task_id IN (SELECT id FROM space_tasks WHERE space_id = ?)`
				)
				.run(spaceId);
		}, 'deleteTasksForSpace');
		this.db.prepare(`DELETE FROM space_tasks WHERE space_id = ?`).run(spaceId);
		this.reactiveDb?.notifyChange('space_tasks');
	}

	/**
	 * Promote draft tasks created by a planning task (legacy method, kept for API compatibility)
	 */
	promoteDraftTasksByCreator(createdByTaskId: string): number {
		const result = this.db
			.prepare(
				`UPDATE space_tasks SET status = 'open', updated_at = ? WHERE created_by_task_id = ? AND status = 'draft'`
			)
			.run(Date.now(), createdByTaskId);
		if (result.changes > 0) {
			this.reactiveDb?.notifyChange('space_tasks');
		}
		return result.changes;
	}

	/**
	 * List all tasks that have an active Task Agent session.
	 *
	 * Returns tasks with status `in_progress`, `review`, `blocked`, or `approved`
	 * that have a non-null `task_agent_session_id`. Used by
	 * `TaskAgentManager.rehydrate()` on daemon restart to find Task Agent
	 * sessions that need to be restarted.
	 *
	 * Status inclusions:
	 * - `'in_progress'` — actively being worked on; obvious rehydrate target.
	 * - `'review'` — workflow agents finished but a human/auto reviewer must
	 *   approve. The Task Agent session is still live: it owns the sub-session
	 *   map (coder/reviewer/etc.) and is the only path that can re-attach the
	 *   in-process `node-agent` / `space-agent-tools` MCP servers to those
	 *   sub-sessions after a daemon restart. Excluding `'review'` here was the
	 *   root cause of task #126: a coder/reviewer sub-session sitting at a gate
	 *   while the parent task waited in `'review'` lost both MCP servers across
	 *   a daemon restart, so `write_gate` / `read_gate` / `send_message` all
	 *   silently failed with "No such tool available".
	 * - `'blocked'` — task awaits human input but the Task Agent session must
	 *   stay live so unblocking messages reach it.
	 * - `'approved'` — the Task Agent can still be live while the post-approval
	 *   sub-session runs; `mark_complete` may transition the task back to
	 *   `in_progress` or to `done`, and the UI's `spaceTaskActivity.byTask`
	 *   LiveQuery depends on the session being rehydrated in-memory.
	 *
	 * Tasks in `'done'`/`'cancelled'`/`'archived'`/`'open'` are excluded:
	 * terminal states have their sessions torn down, and `'open'` tasks have
	 * no Task Agent yet.
	 */
	listActiveWithTaskAgentSession(): SpaceTask[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE status IN ('in_progress', 'review', 'blocked', 'approved') AND task_agent_session_id IS NOT NULL`
		);
		const rows = stmt.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * Get a task by its Task Agent session ID
	 */
	getTaskBySessionId(sessionId: string): SpaceTask | null {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE task_agent_session_id = ? LIMIT 1`
		);
		const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToSpaceTask(row);
	}

	/**
	 * Get a task by its space-scoped numeric ID
	 */
	getTaskByNumber(spaceId: string, taskNumber: number): SpaceTask | null {
		const row = this.db
			.prepare(`SELECT * FROM space_tasks WHERE space_id = ? AND task_number = ?`)
			.get(spaceId, taskNumber) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToSpaceTask(row);
	}

	/**
	 * Get open tasks created by a specific planning task
	 */
	getDraftTasksByCreator(createdByTaskId: string): SpaceTask[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_tasks WHERE created_by_task_id = ? AND status = 'open' ORDER BY created_at ASC`
			)
			.all(createdByTaskId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * Upsert the task_agent leg of task_session_map for a task.
	 *
	 * The Task Agent session is the orchestration session created for every
	 * `space_task` (when the task transitions out of `'open'`). Recording it in
	 * task_session_map lets the live-query handlers JOIN the table directly
	 * instead of walking `space_tasks → sessions` to discover the orchestration
	 * row.
	 *
	 * Drop any prior task_agent rows for this task before inserting the new
	 * one. The map's primary key is `(task_id, session_id)`, so a session
	 * change writes a new row rather than mutating the old one — leaving the
	 * stale row would falsely report the prior session as still belonging.
	 *
	 * Validate the session type before stamping. The map drives
	 * `spaceTaskMessages.byTask*`, which previously required
	 * `sessions.type = 'space_task_agent'` in its read SQL. Inserting an
	 * arbitrary session id here would surface that unrelated session's
	 * `sdk_messages` in the task timeline — a data-scope regression. If the
	 * session does not exist yet (created in a separate transaction earlier in
	 * the same flow) or is not a Task Agent, skip the map row; the canonical
	 * `space_tasks.task_agent_session_id` column has already been written, so
	 * no information is lost. If/when the session row lands as
	 * `space_task_agent`, callers (TaskAgentManager) reissue the upsert during
	 * normal lifecycle events.
	 */
	private upsertTaskAgentSessionMap(taskId: string, sessionId: string, createdAt: number): void {
		// Session-type validation. We require a `sessions` row of type
		// `space_task_agent` before binding the map. If the row is missing or
		// the type is wrong, refuse the insert and drop any prior task_agent
		// row to avoid leaving stale scope behind. This fails closed so a
		// task can't be mapped to an unvalidated session id whose type might
		// later resolve to something that widens the timeline.
		//
		// The `sessions` table is always present in production. In test
		// harnesses that build only the space-test schema and omit `sessions`,
		// the SELECT throws — we fall through and skip both the validation
		// and the subsequent map mutations (which themselves prepare against
		// FKs that target `sessions`) so unit tests focused on map
		// maintenance still work. Real production paths always have the
		// table.
		let sessionsTablePresent = true;
		let sessionType: string | undefined;
		try {
			const row = this.db.prepare(`SELECT type FROM sessions WHERE id = ?`).get(sessionId) as
				| { type: string }
				| undefined;
			sessionType = row?.type;
		} catch {
			sessionsTablePresent = false;
		}
		if (!sessionsTablePresent) {
			// Test harness without `sessions`. The FK on
			// `task_session_map.session_id` references `sessions(id)`, so
			// SQLite refuses to prepare any task_session_map mutation when
			// the parent table is absent. Skip silently — production always
			// has the table.
			return;
		}
		if (sessionType !== 'space_task_agent') {
			// Either the session row doesn't exist yet, or it exists but is
			// the wrong type. Either way, refuse to widen scope; drop any
			// prior task_agent row so we don't silently keep a stale bind.
			this.tryRunMapMutation(() => {
				this.db
					.prepare(`DELETE FROM task_session_map WHERE task_id = ? AND kind = 'task_agent'`)
					.run(taskId);
			}, 'upsertTaskAgentSessionMap:wrongType');
			return;
		}
		this.tryRunMapMutation(() => {
			this.db
				.prepare(
					`DELETE FROM task_session_map
					 WHERE task_id = ? AND kind = 'task_agent' AND session_id != ?`
				)
				.run(taskId, sessionId);
			this.db
				.prepare(
					`INSERT OR REPLACE INTO task_session_map (
						task_id, session_id, kind, role, label, node_execution_id, created_at
					) VALUES (?, ?, 'task_agent', 'task-agent', 'Task Agent', NULL, ?)`
				)
				.run(taskId, sessionId, createdAt);
		}, 'upsertTaskAgentSessionMap:upsert');
	}

	/**
	 * Drop the task_agent leg of task_session_map for a task. Used when the
	 * Task Agent session is cleared (e.g. archive flow).
	 */
	private removeTaskAgentSessionMap(taskId: string): void {
		this.tryRunMapMutation(() => {
			this.db
				.prepare(`DELETE FROM task_session_map WHERE task_id = ? AND kind = 'task_agent'`)
				.run(taskId);
		}, 'removeTaskAgentSessionMap');
	}

	/**
	 * Seed the node_agent leg of task_session_map for a task that's just been
	 * attached to a workflow run. For each existing `node_executions` row on
	 * the run with a non-null `agent_session_id`, derive the corresponding
	 * `(task_id, session_id)` mapping with the agent's display label.
	 *
	 * Without this seed, tasks created or moved onto a run that already has
	 * executions would be invisible to `spaceTaskMessages.byTask*` (which
	 * JOINs task_session_map directly) until some later execution write
	 * happens. That's the symmetric dual of the cleanup we already do when a
	 * task is detached from a run.
	 *
	 * No-op if the run has no executions yet — the
	 * NodeExecutionRepository write paths will populate the map as executions
	 * land.
	 */
	private seedNodeAgentSessionMapForRun(
		taskId: string,
		workflowRunId: string,
		createdAt: number
	): void {
		// task_session_map carries FK ON DELETE CASCADE references to
		// `sessions(id)` and `node_executions(id)`. SQLite validates FK target
		// tables exist at *prepare* time, so this INSERT throws when those
		// tables are absent — which is the common case in unit-test harnesses
		// that only build a subset of the schema. Production always has both
		// tables (createTables runs after migrations), so swallowing the
		// missing-table error here is safe and keeps the helper test-tolerant.
		this.tryRunMapMutation(() => {
			this.db
				.prepare(
					`INSERT OR REPLACE INTO task_session_map (
						task_id, session_id, kind, role, label, node_execution_id, created_at
					)
					SELECT
						? AS task_id,
						ne.agent_session_id AS session_id,
						'node_agent' AS kind,
						ne.agent_name AS role,
						COALESCE(sa.name, ne.agent_name, 'agent') AS label,
						ne.id AS node_execution_id,
						? AS created_at
					FROM node_executions ne
					LEFT JOIN space_agents sa ON sa.id = ne.agent_id
					WHERE ne.workflow_run_id = ?
						AND ne.agent_session_id IS NOT NULL`
				)
				.run(taskId, createdAt, workflowRunId);
		}, 'seedNodeAgentSessionMapForRun');
	}

	/**
	 * Convert a database row to a SpaceTask object
	 */
	private rowToSpaceTask(row: Record<string, unknown>): SpaceTask {
		return {
			id: row.id as string,
			spaceId: row.space_id as string,
			taskNumber: (row.task_number as number | null) ?? 0,
			title: row.title as string,
			description: (row.description as string) ?? '',
			status: row.status as SpaceTask['status'],
			priority: row.priority as SpaceTask['priority'],
			labels: JSON.parse((row.labels as string | null) ?? '[]') as string[],
			workflowRunId: (row.workflow_run_id as string | null) ?? undefined,
			preferredWorkflowId: (row.preferred_workflow_id as string | null) ?? undefined,
			createdByTaskId: (row.created_by_task_id as string | null) ?? undefined,
			createdBy: (row.created_by as string | null) ?? undefined,
			createdBySession: (row.created_by_session as string | null) ?? undefined,
			result: (row.result as string | null) ?? null,
			dependsOn: JSON.parse((row.depends_on as string | null) ?? '[]') as string[],
			activeSession: (row.active_session as 'worker' | 'leader' | null) ?? null,
			taskAgentSessionId: (row.task_agent_session_id as string | null) ?? undefined,
			archivedAt: (row.archived_at as number | null) ?? null,
			blockReason: (row.block_reason as SpaceTask['blockReason']) ?? null,
			approvalSource: (row.approval_source as SpaceTask['approvalSource']) ?? null,
			approvalReason: (row.approval_reason as string | null) ?? null,
			approvedAt: (row.approved_at as number | null) ?? null,
			pendingCheckpointType:
				(row.pending_checkpoint_type as SpaceTask['pendingCheckpointType']) ?? null,
			pendingCompletionSubmittedByNodeId:
				(row.pending_completion_submitted_by_node_id as string | null) ?? null,
			pendingCompletionSubmittedAt: (row.pending_completion_submitted_at as number | null) ?? null,
			pendingCompletionReason: (row.pending_completion_reason as string | null) ?? null,
			reportedStatus: (row.reported_status as SpaceTask['reportedStatus']) ?? null,
			reportedSummary: (row.reported_summary as string | null) ?? null,
			// Post-approval columns (PR 1/5 — schema only).
			postApprovalSessionId: (row.post_approval_session_id as string | null) ?? null,
			postApprovalStartedAt: (row.post_approval_started_at as number | null) ?? null,
			postApprovalBlockedReason: (row.post_approval_blocked_reason as string | null) ?? null,
			createdAt: row.created_at as number,
			startedAt: (row.started_at as number | null) ?? null,
			completedAt: (row.completed_at as number | null) ?? null,
			updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
		};
	}
}
