/**
 * Space Node Execution RPC Handlers
 *
 * RPC handlers for NodeExecution queries:
 * - nodeExecution.list - Lists node executions for a workflow run
 */

import type { MessageHub } from '@neokai/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';

/**
 * Register RPC handlers for NodeExecution queries.
 */
export function setupNodeExecutionHandlers(
	messageHub: MessageHub,
	nodeExecutionRepo: NodeExecutionRepository
): void {
	// ─── nodeExecution.list ─────────────────────────────────────────────────
	messageHub.onRequest('nodeExecution.list', async (data) => {
		const params = data as { workflowRunId: string };

		if (!params.workflowRunId) {
			throw new Error('workflowRunId is required');
		}

		const executions = nodeExecutionRepo.listByWorkflowRun(params.workflowRunId);

		return { executions };
	});
}
