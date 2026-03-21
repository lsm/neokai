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
import type { SQLiteValue } from '../types';

export class SpaceTaskRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new space task
	 */
	createTask(params: CreateSpaceTaskParams): SpaceTask {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO space_tasks (id, space_id, title, description, status, priority, task_type, assigned_agent, custom_agent_id, workflow_run_id, workflow_step_id, created_by_task_id, depends_on, task_agent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.spaceId,
			params.title,
			params.description,
			params.status ?? 'pending',
			params.priority ?? 'normal',
			params.taskType ?? null,
			params.assignedAgent ?? 'coder',
			params.customAgentId ?? null,
			params.workflowRunId ?? null,
			params.workflowStepId ?? null,
			params.createdByTaskId ?? null,
			JSON.stringify(params.dependsOn ?? []),
			params.taskAgentSessionId ?? null,
			now,
			now
		);

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
			query += ` AND archived_at IS NULL`;
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
			`SELECT * FROM space_tasks WHERE workflow_run_id = ? AND archived_at IS NULL ORDER BY created_at ASC`
		);
		const rows = stmt.all(workflowRunId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToSpaceTask(r));
	}

	/**
	 * List tasks by status within a space
	 */
	listByStatus(spaceId: string, status: SpaceTaskStatus): SpaceTask[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_tasks WHERE space_id = ? AND status = ? AND archived_at IS NULL ORDER BY updated_at DESC`
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
				// needs_attention or cancelled. This records when the most recent work began,
				// not when the task was originally created. Mirrors TaskRepository behavior.
				fields.push('started_at = ?');
				values.push(Date.now());
			} else if (
				params.status === 'completed' ||
				params.status === 'needs_attention' ||
				params.status === 'cancelled'
			) {
				fields.push('completed_at = ?');
				values.push(Date.now());
			}
		}
		if (params.priority !== undefined) {
			fields.push('priority = ?');
			values.push(params.priority);
		}
		if (params.taskType !== undefined) {
			fields.push('task_type = ?');
			values.push(params.taskType ?? null);
		}
		if (params.assignedAgent !== undefined) {
			fields.push('assigned_agent = ?');
			values.push(params.assignedAgent ?? null);
		}
		if (params.customAgentId !== undefined) {
			fields.push('custom_agent_id = ?');
			values.push(params.customAgentId ?? null);
		}
		if (params.workflowRunId !== undefined) {
			fields.push('workflow_run_id = ?');
			values.push(params.workflowRunId ?? null);
		}
		if (params.workflowStepId !== undefined) {
			fields.push('workflow_step_id = ?');
			values.push(params.workflowStepId ?? null);
		}
		if (params.progress !== undefined) {
			fields.push('progress = ?');
			values.push(params.progress ?? null);
		}
		if (params.currentStep !== undefined) {
			fields.push('current_step = ?');
			values.push(params.currentStep ?? null);
		}
		if (params.result !== undefined) {
			fields.push('result = ?');
			values.push(params.result ?? null);
		}
		if (params.error !== undefined) {
			fields.push('error = ?');
			values.push(params.error ?? null);
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
			(params.status === 'completed' ||
				params.status === 'needs_attention' ||
				params.status === 'cancelled')
		) {
			fields.push('active_session = ?');
			values.push(null);
		}
		if (params.prUrl !== undefined) {
			fields.push('pr_url = ?');
			values.push(params.prUrl ?? null);
		}
		if (params.prNumber !== undefined) {
			fields.push('pr_number = ?');
			values.push(params.prNumber ?? null);
		}
		if (params.prCreatedAt !== undefined) {
			fields.push('pr_created_at = ?');
			values.push(params.prCreatedAt ?? null);
		}
		if (params.inputDraft !== undefined) {
			fields.push('input_draft = ?');
			values.push(params.inputDraft ?? null);
		}
		if (params.taskAgentSessionId !== undefined) {
			fields.push('task_agent_session_id = ?');
			values.push(params.taskAgentSessionId ?? null);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(`UPDATE space_tasks SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
		}

		return this.getTask(id);
	}

	/**
	 * Archive a task by setting archived_at timestamp
	 */
	archiveTask(id: string): SpaceTask | null {
		const now = Date.now();
		const stmt = this.db.prepare(
			`UPDATE space_tasks SET archived_at = ?, updated_at = ? WHERE id = ?`
		);
		stmt.run(now, now, id);
		return this.getTask(id);
	}

	/**
	 * Delete a task by ID
	 */
	deleteTask(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM space_tasks WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Delete all tasks for a space
	 */
	deleteTasksForSpace(spaceId: string): void {
		this.db.prepare(`DELETE FROM space_tasks WHERE space_id = ?`).run(spaceId);
	}

	/**
	 * Promote draft tasks created by a planning task to pending
	 */
	promoteDraftTasksByCreator(createdByTaskId: string): number {
		const result = this.db
			.prepare(
				`UPDATE space_tasks SET status = 'pending', updated_at = ? WHERE created_by_task_id = ? AND status = 'draft'`
			)
			.run(Date.now(), createdByTaskId);
		return result.changes;
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
	 * Get draft tasks created by a specific planning task
	 */
	getDraftTasksByCreator(createdByTaskId: string): SpaceTask[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_tasks WHERE created_by_task_id = ? AND status = 'draft' ORDER BY created_at ASC`
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
			title: row.title as string,
			description: (row.description as string) ?? '',
			status: row.status as SpaceTask['status'],
			priority: row.priority as SpaceTask['priority'],
			taskType: (row.task_type as SpaceTask['taskType'] | null) ?? undefined,
			assignedAgent: (row.assigned_agent as SpaceTask['assignedAgent'] | null) ?? undefined,
			customAgentId: (row.custom_agent_id as string | null) ?? undefined,
			workflowRunId: (row.workflow_run_id as string | null) ?? undefined,
			workflowStepId: (row.workflow_step_id as string | null) ?? undefined,
			createdByTaskId: (row.created_by_task_id as string | null) ?? undefined,
			progress: (row.progress as number | null) ?? undefined,
			currentStep: (row.current_step as string | null) ?? undefined,
			result: (row.result as string | null) ?? undefined,
			error: (row.error as string | null) ?? undefined,
			dependsOn: JSON.parse(row.depends_on as string) as string[],
			inputDraft: (row.input_draft as string | null) ?? undefined,
			activeSession: (row.active_session as 'worker' | 'leader' | null) ?? null,
			taskAgentSessionId: (row.task_agent_session_id as string | null) ?? undefined,
			prUrl: (row.pr_url as string | null) ?? undefined,
			prNumber: (row.pr_number as number | null) ?? undefined,
			prCreatedAt: (row.pr_created_at as number | null) ?? undefined,
			archivedAt: (row.archived_at as number | null) ?? undefined,
			createdAt: row.created_at as number,
			startedAt: (row.started_at as number | null) ?? undefined,
			completedAt: (row.completed_at as number | null) ?? undefined,
			updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
		};
	}
}
