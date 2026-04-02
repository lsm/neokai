/**
 * NodeExecutionManager - Workflow-internal execution state management
 *
 * Handles:
 * - Node execution status transitions with validation
 * - Terminal status checks for completion detection
 * - Agent session tracking per node execution
 *
 * This separates workflow-internal state from the user-facing SpaceTask.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { NodeExecution, NodeExecutionStatus, UpdateNodeExecutionParams } from '@neokai/shared';

/**
 * Valid node execution status transitions.
 * Maps current status -> allowed next statuses.
 *
 * Lifecycle:
 *   pending     → in_progress, cancelled
 *   in_progress → done, blocked, cancelled
 *   done        → in_progress (reactivation)
 *   blocked     → in_progress (retry), cancelled
 *   cancelled   → in_progress (retry)
 */
export const VALID_NODE_EXECUTION_TRANSITIONS: Record<NodeExecutionStatus, NodeExecutionStatus[]> =
	{
		pending: ['in_progress', 'cancelled'],
		in_progress: ['done', 'blocked', 'cancelled'],
		done: ['in_progress'], // Reactivation — allows re-running a completed node
		blocked: ['in_progress', 'cancelled'],
		cancelled: ['in_progress'], // Retry
	};

/**
 * Terminal node execution statuses — these represent final states where
 * no further processing will occur.
 */
export const TERMINAL_NODE_EXECUTION_STATUSES = new Set<NodeExecutionStatus>(['done', 'cancelled']);

/**
 * Check if a node execution status transition is valid.
 */
export function isValidNodeExecutionTransition(
	from: NodeExecutionStatus,
	to: NodeExecutionStatus
): boolean {
	return VALID_NODE_EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Check if a node execution status is terminal (done or cancelled).
 */
export function isNodeExecutionTerminal(status: NodeExecutionStatus): boolean {
	return TERMINAL_NODE_EXECUTION_STATUSES.has(status);
}

export class NodeExecutionManager {
	private repo: NodeExecutionRepository;

	constructor(private db: BunDatabase) {
		this.repo = new NodeExecutionRepository(db);
	}

	/**
	 * Get a node execution by ID.
	 */
	getById(id: string): NodeExecution | null {
		return this.repo.getById(id);
	}

	/**
	 * List all node executions for a workflow run.
	 */
	listByWorkflowRun(workflowRunId: string): NodeExecution[] {
		return this.repo.listByWorkflowRun(workflowRunId);
	}

	/**
	 * List node executions for a specific node within a workflow run.
	 */
	listByNode(workflowRunId: string, workflowNodeId: string): NodeExecution[] {
		return this.repo.listByNode(workflowRunId, workflowNodeId);
	}

	/**
	 * Update a node execution with partial updates.
	 */
	update(id: string, params: UpdateNodeExecutionParams): NodeExecution | null {
		return this.repo.update(id, params);
	}

	/**
	 * Transition a node execution to a new status with validation.
	 *
	 * @throws {Error} when the transition is invalid or the execution is not found.
	 */
	setExecutionStatus(id: string, newStatus: NodeExecutionStatus): NodeExecution {
		const execution = this.repo.getById(id);
		if (!execution) {
			throw new Error(`NodeExecution not found: ${id}`);
		}

		if (!isValidNodeExecutionTransition(execution.status, newStatus)) {
			throw new Error(
				`Invalid node execution status transition from '${execution.status}' to '${newStatus}'. ` +
					`Allowed: ${VALID_NODE_EXECUTION_TRANSITIONS[execution.status].join(', ') || 'none'}`
			);
		}

		const updated = this.repo.updateStatus(id, newStatus);
		if (!updated) {
			throw new Error(`Failed to update node execution: ${id}`);
		}

		return updated;
	}

	/**
	 * Update the agent session ID for a node execution.
	 */
	setAgentSessionId(id: string, agentSessionId: string | null): NodeExecution | null {
		return this.repo.updateSessionId(id, agentSessionId);
	}

	/**
	 * Delete a node execution by ID.
	 */
	delete(id: string): boolean {
		return this.repo.delete(id);
	}

	/**
	 * Delete all node executions for a workflow run.
	 */
	deleteByWorkflowRun(workflowRunId: string): void {
		this.repo.deleteByWorkflowRun(workflowRunId);
	}
}
