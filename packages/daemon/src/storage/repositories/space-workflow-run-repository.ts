/**
 * Space Workflow Run Repository
 *
 * Repository for SpaceWorkflowRun CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { SpaceWorkflowRun, WorkflowRunStatus, CreateWorkflowRunParams } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export interface UpdateWorkflowRunParams {
	title?: string;
	description?: string;
	status?: WorkflowRunStatus;
	currentStepId?: string;
	config?: Record<string, unknown>;
}

export class SpaceWorkflowRunRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new workflow run
	 */
	createRun(params: CreateWorkflowRunParams): SpaceWorkflowRun {
		const id = generateUUID();
		const now = Date.now();

		const stmt = this.db.prepare(
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, description, current_step_index, current_step_id, status, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.spaceId,
			params.workflowId,
			params.title,
			params.description ?? '',
			0, // keep current_step_index for backward compat
			params.currentStepId,
			'pending',
			null,
			now,
			now
		);

		return this.getRun(id)!;
	}

	/**
	 * Get a workflow run by ID
	 */
	getRun(id: string): SpaceWorkflowRun | null {
		const stmt = this.db.prepare(`SELECT * FROM space_workflow_runs WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;
		return this.rowToRun(row);
	}

	/**
	 * List workflow runs for a space
	 */
	listBySpace(spaceId: string): SpaceWorkflowRun[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_workflow_runs WHERE space_id = ? ORDER BY created_at DESC`
		);
		const rows = stmt.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToRun(r));
	}

	/**
	 * List in-progress workflow runs for a space.
	 *
	 * Only `in_progress` runs are returned — `pending` is a transient state that
	 * exists only briefly inside `startWorkflowRun` between `createRun` and the
	 * `updateStatus('in_progress')` call. Including `pending` here would cause
	 * a run that failed mid-creation to be rehydrated without a task and silently
	 * loop forever in the executor map.
	 */
	getActiveRuns(spaceId: string): SpaceWorkflowRun[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_workflow_runs WHERE space_id = ? AND status = 'in_progress' ORDER BY created_at ASC`
		);
		const rows = stmt.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToRun(r));
	}

	/**
	 * List runs that need an executor on startup: in_progress and needs_attention.
	 *
	 * This superset of getActiveRuns() is used exclusively by rehydrateExecutors()
	 * so that runs blocked at a human gate (needs_attention) get an executor
	 * reloaded on restart. Without this, a run waiting for human approval would
	 * be permanently stuck after a process restart.
	 *
	 * `pending` is still excluded for the same reason as in getActiveRuns().
	 */
	getRehydratableRuns(spaceId: string): SpaceWorkflowRun[] {
		const stmt = this.db.prepare(
			`SELECT * FROM space_workflow_runs WHERE space_id = ? AND status IN ('in_progress', 'needs_attention') ORDER BY created_at ASC`
		);
		const rows = stmt.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToRun(r));
	}

	/**
	 * Update a workflow run with partial updates
	 */
	updateRun(id: string, params: UpdateWorkflowRunParams): SpaceWorkflowRun | null {
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

			if (params.status === 'completed' || params.status === 'cancelled') {
				fields.push('completed_at = ?');
				values.push(Date.now());
			}
		}
		if (params.currentStepId !== undefined) {
			fields.push('current_step_id = ?');
			values.push(params.currentStepId);
		}
		if (params.config !== undefined) {
			fields.push('config = ?');
			values.push(JSON.stringify(params.config));
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			values.push(Date.now());
			values.push(id);
			const stmt = this.db.prepare(
				`UPDATE space_workflow_runs SET ${fields.join(', ')} WHERE id = ?`
			);
			stmt.run(...values);
		}

		return this.getRun(id);
	}

	/**
	 * Advance the current step ID for a run
	 */
	updateCurrentStep(id: string, stepId: string): SpaceWorkflowRun | null {
		return this.updateRun(id, { currentStepId: stepId });
	}

	/**
	 * Update only the status of a run
	 */
	updateStatus(id: string, status: WorkflowRunStatus): SpaceWorkflowRun | null {
		return this.updateRun(id, { status });
	}

	/**
	 * Delete a workflow run by ID
	 */
	deleteRun(id: string): boolean {
		const stmt = this.db.prepare(`DELETE FROM space_workflow_runs WHERE id = ?`);
		const result = stmt.run(id);
		return result.changes > 0;
	}

	/**
	 * Convert a database row to a SpaceWorkflowRun object
	 */
	private rowToRun(row: Record<string, unknown>): SpaceWorkflowRun {
		const rawConfig = row.config as string | null;
		const config = rawConfig ? (JSON.parse(rawConfig) as Record<string, unknown>) : undefined;

		return {
			id: row.id as string,
			spaceId: row.space_id as string,
			workflowId: row.workflow_id as string,
			title: row.title as string,
			description: (row.description as string | null) ?? undefined,
			currentStepId: (row.current_step_id as string | null) ?? '',
			status: row.status as WorkflowRunStatus,
			config,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			completedAt: (row.completed_at as number | null) ?? undefined,
		};
	}
}
