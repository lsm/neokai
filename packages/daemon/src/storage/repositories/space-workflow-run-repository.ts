/**
 * Space Workflow Run Repository
 *
 * Repository for SpaceWorkflowRun CRUD operations.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceWorkflowRun,
	WorkflowRunStatus,
	CreateWorkflowRunParams,
	WorkflowRunFailureReason,
} from '@neokai/shared';
import type { SQLiteValue } from '../types';
import { assertValidTransition } from '../../lib/space/runtime/workflow-run-status-machine';

export interface UpdateWorkflowRunParams {
	title?: string;
	description?: string;
	status?: WorkflowRunStatus;
	config?: Record<string, unknown>;
	failureReason?: WorkflowRunFailureReason | null;
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
			`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, description, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			params.spaceId,
			params.workflowId,
			params.title,
			params.description ?? '',
			'pending',
			null,
			0, // iteration_count (dead column, kept for backward compat)
			5, // max_iterations (dead column, kept for backward compat)
			params.goalId ?? null,
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
		if (params.config !== undefined) {
			fields.push('config = ?');
			values.push(JSON.stringify(params.config));
		}
		if (params.failureReason !== undefined) {
			fields.push('failure_reason = ?');
			values.push(params.failureReason);
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
	 * Update only the status of a run, bypassing lifecycle transition guards.
	 *
	 * Intended for test fixtures and internal helpers only — use transitionStatus()
	 * for all production code that changes run status.
	 */
	updateStatusUnchecked(id: string, status: WorkflowRunStatus): SpaceWorkflowRun | null {
		return this.updateRun(id, { status });
	}

	/**
	 * Atomically validate and apply a lifecycle status transition.
	 *
	 * Reads the current status from the DB, validates the requested transition
	 * against the WorkflowRunStatusMachine, and persists the new status only
	 * when the transition is allowed.
	 *
	 * @returns The updated run on success.
	 * @throws {Error} when the run is not found.
	 * @throws {Error} when the transition is not permitted by the lifecycle rules.
	 */
	transitionStatus(id: string, to: WorkflowRunStatus): SpaceWorkflowRun {
		const run = this.getRun(id);
		if (!run) throw new Error(`WorkflowRun not found: ${id}`);
		assertValidTransition(run.status, to, id);
		return this.updateRun(id, { status: to })!;
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
			status: row.status as WorkflowRunStatus,
			config,
			iterationCount: (row.iteration_count as number | undefined) ?? 0,
			maxIterations: (row.max_iterations as number | undefined) ?? 5,
			goalId: (row.goal_id as string | null) ?? undefined,
			failureReason: (row.failure_reason as WorkflowRunFailureReason | null) ?? undefined,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			completedAt: (row.completed_at as number | null) ?? undefined,
		};
	}
}
