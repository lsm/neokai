/**
 * Space Task Repository
 *
 * Repository for SpaceTask CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceTask,
	SpaceTaskStatus,
	CreateSpaceTaskParams,
	UpdateSpaceTaskParams,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

export class SpaceTaskRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb?: ReactiveDatabase
	) {}

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
					`INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, preferred_workflow_id, created_by_task_id, depends_on, task_agent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
					now,
					now
				);
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
	 * List tasks for a space, with optional status filter
	 */
	listBySpace(spaceId: string, includeArchived = false): SpaceTask[] {
		let query = `SELECT * FROM space_tasks WHERE space_id = ?`;
		if (!includeArchived) {
			query += ` AND status != 'archived'`;
		}
		query += ` ORDER BY updated_at DESC`;

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
	 * List tasks by status within a space
	 */
	listByStatus(spaceId: string, status: SpaceTaskStatus): SpaceTask[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE space_id = ? AND status = ? ORDER BY updated_at DESC`
		);
		const rows = stmt.all(spaceId, status) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
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
		if (params.pendingActionIndex !== undefined) {
			fields.push('pending_action_index = ?');
			values.push(params.pendingActionIndex ?? null);
		}
		if (params.pendingCheckpointType !== undefined) {
			fields.push('pending_checkpoint_type = ?');
			values.push(params.pendingCheckpointType ?? null);
		}
		if (params.reportedStatus !== undefined) {
			fields.push('reported_status = ?');
			values.push(params.reportedStatus ?? null);
		}
		if (params.reportedSummary !== undefined) {
			fields.push('reported_summary = ?');
			values.push(params.reportedSummary ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(`UPDATE space_tasks SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
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
			this.reactiveDb?.notifyChange('space_tasks');
		}
		return result.changes > 0;
	}

	/**
	 * Delete all tasks for a space
	 */
	deleteTasksForSpace(spaceId: string): void {
		this.db.prepare(`DELETE FROM space_tasks WHERE space_id = ?`).run(spaceId);
		this.reactiveDb?.notifyChange('space_tasks');
	}

	/**
	 * Promote open tasks created by a planning task (legacy method, kept for API compatibility)
	 */
	promoteDraftTasksByCreator(createdByTaskId: string): number {
		const result = this.db
			.prepare(
				`UPDATE space_tasks SET status = 'open', updated_at = ? WHERE created_by_task_id = ? AND status = 'open'`
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
	 * Returns tasks with status `in_progress` or `blocked` that have a
	 * non-null `task_agent_session_id`. Used by `TaskAgentManager.rehydrate()` on
	 * daemon restart to find Task Agent sessions that need to be restarted.
	 */
	listActiveWithTaskAgentSession(): SpaceTask[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE status IN ('in_progress', 'blocked') AND task_agent_session_id IS NOT NULL`
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
			result: (row.result as string | null) ?? null,
			dependsOn: JSON.parse((row.depends_on as string | null) ?? '[]') as string[],
			activeSession: (row.active_session as 'worker' | 'leader' | null) ?? null,
			taskAgentSessionId: (row.task_agent_session_id as string | null) ?? undefined,
			archivedAt: (row.archived_at as number | null) ?? null,
			blockReason: (row.block_reason as SpaceTask['blockReason']) ?? null,
			approvalSource: (row.approval_source as SpaceTask['approvalSource']) ?? null,
			approvalReason: (row.approval_reason as string | null) ?? null,
			approvedAt: (row.approved_at as number | null) ?? null,
			pendingActionIndex: (row.pending_action_index as number | null) ?? null,
			pendingCheckpointType:
				(row.pending_checkpoint_type as SpaceTask['pendingCheckpointType']) ?? null,
			reportedStatus: (row.reported_status as SpaceTask['reportedStatus']) ?? null,
			reportedSummary: (row.reported_summary as string | null) ?? null,
			createdAt: row.created_at as number,
			startedAt: (row.started_at as number | null) ?? null,
			completedAt: (row.completed_at as number | null) ?? null,
			updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
		};
	}
}
