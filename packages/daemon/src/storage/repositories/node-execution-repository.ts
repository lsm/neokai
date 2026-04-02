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
import { generateUUID } from '@neokai/shared';
import type {
	NodeExecution,
	NodeExecutionStatus,
	CreateNodeExecutionParams,
	UpdateNodeExecutionParams,
} from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class NodeExecutionRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new node execution record
	 */
	create(params: CreateNodeExecutionParams): NodeExecution {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO node_executions
				    (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				     agent_session_id, status, result, created_at, started_at,
				     completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.workflowRunId,
				params.workflowNodeId,
				params.agentName,
				params.agentId,
				params.agentSessionId ?? null,
				params.status ?? 'pending',
				// result is only set via update() after the agent calls report_done
				null,
				now,
				null,
				null,
				now
			);

		return this.getById(id)!;
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
				(params.status === 'done' ||
					params.status === 'blocked' ||
					params.status === 'cancelled') &&
				params.completedAt === undefined
			) {
				fields.push('completed_at = ?');
				values.push(Date.now());
			}
		}
		if (params.agentSessionId !== undefined) {
			fields.push('agent_session_id = ?');
			values.push(params.agentSessionId ?? null);
		}
		if (params.result !== undefined) {
			fields.push('result = ?');
			values.push(params.result ?? null);
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
		const result = this.db.prepare(`DELETE FROM node_executions WHERE id = ?`).run(id);
		return result.changes > 0;
	}

	/**
	 * Delete all node executions for a workflow run
	 */
	deleteByWorkflowRun(workflowRunId: string): void {
		this.db.prepare(`DELETE FROM node_executions WHERE workflow_run_id = ?`).run(workflowRunId);
	}

	/**
	 * Convert a database row to a NodeExecution object
	 */
	private rowToNodeExecution(row: Record<string, unknown>): NodeExecution {
		return {
			id: row.id as string,
			workflowRunId: row.workflow_run_id as string,
			workflowNodeId: row.workflow_node_id as string,
			agentName: row.agent_name as string,
			agentId: (row.agent_id as string | null) ?? null,
			agentSessionId: (row.agent_session_id as string | null) ?? null,
			status: row.status as NodeExecutionStatus,
			result: (row.result as string | null) ?? null,
			createdAt: row.created_at as number,
			startedAt: (row.started_at as number | null) ?? null,
			completedAt: (row.completed_at as number | null) ?? null,
			updatedAt: row.updated_at as number,
		};
	}
}
