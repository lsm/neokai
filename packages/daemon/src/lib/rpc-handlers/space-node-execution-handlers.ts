/**
 * Space Node Execution RPC Handlers
 *
 * RPC handlers for NodeExecution queries:
 * - nodeExecution.list - Lists node executions for a workflow run (requires spaceId)
 */

import type { MessageHub } from '@neokai/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';

/**
 * Register RPC handlers for NodeExecution queries.
 */
export function setupNodeExecutionHandlers(
	messageHub: MessageHub,
	nodeExecutionRepo: NodeExecutionRepository,
	workflowRunRepo: SpaceWorkflowRunRepository
): void {
	// ─── nodeExecution.list ─────────────────────────────────────────────────
	messageHub.onRequest('nodeExecution.list', async (data) => {
		const params = data as { workflowRunId: string; spaceId: string };

		if (!params.workflowRunId) {
			throw new Error('workflowRunId is required');
		}
		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Ownership check — reject cross-space access
		const run = workflowRunRepo.getRun(params.workflowRunId);
		if (!run || run.spaceId !== params.spaceId) {
			throw new Error(`WorkflowRun not found: ${params.workflowRunId}`);
		}

		const executions = nodeExecutionRepo.listByWorkflowRun(params.workflowRunId);

		return { executions };
	});
}
