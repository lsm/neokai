/**
 * Space Node Execution RPC Handlers
 *
 * RPC handlers for NodeExecution queries:
 * - nodeExecution.list - Lists node executions for a workflow run (requires spaceId)
 * - nodeExecution.create - Creates a node execution record (E2E test infrastructure only)
 */

import type { MessageHub, NodeExecutionStatus } from '@neokai/shared';
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

	// ─── nodeExecution.create (E2E test infrastructure only) ────────────────
	//
	// Creates a node execution record directly. Used by E2E tests to simulate
	// node activation without spinning up a real agent session or channel router.
	// Disabled in production to prevent unauthorized state manipulation.
	if (process.env.NODE_ENV !== 'production')
		messageHub.onRequest('nodeExecution.create', async (data) => {
			const params = data as {
				workflowRunId: string;
				workflowNodeId: string;
				agentName: string;
				status?: NodeExecutionStatus;
			};

			if (!params.workflowRunId) throw new Error('workflowRunId is required');
			if (!params.workflowNodeId) throw new Error('workflowNodeId is required');
			if (!params.agentName) throw new Error('agentName is required');

			const run = workflowRunRepo.getRun(params.workflowRunId);
			if (!run) throw new Error(`WorkflowRun not found: ${params.workflowRunId}`);

			const execution = nodeExecutionRepo.createOrIgnore({
				workflowRunId: params.workflowRunId,
				workflowNodeId: params.workflowNodeId,
				agentName: params.agentName,
				status: params.status ?? 'in_progress',
			});

			// If a specific status was requested and it differs from the created record
			// (e.g., createOrIgnore returned an existing 'pending' record), update it.
			if (params.status && execution.status !== params.status) {
				const updated = nodeExecutionRepo.update(execution.id, { status: params.status });
				if (updated) return { execution: updated };
			}

			return { execution };
		});
}
