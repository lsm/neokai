/**
 * End-node tool handlers (Design v2 — Task #39).
 *
 * Factory for the three "terminal" MCP tool handlers exposed to end-node agents:
 *   - report_result       — APPEND-ONLY audit. Does NOT mutate task state.
 *   - approve_task        — Agent self-close. Gated by space.autonomyLevel >=
 *                           workflow.completionAutonomyLevel.
 *   - submit_for_approval — Request human sign-off. Always available.
 *
 * These were previously inline closures inside
 * `SpaceTaskAgentManager.buildNodeAgentMcpServer`. Extracting them here lets
 * them be unit-tested directly (see `end-node-handlers.test.ts`) and keeps the
 * manager focused on orchestration.
 *
 * Contract notes:
 *   - All three handlers return a `ToolResult` (never throw).
 *   - `onReportResult` never touches `reportedStatus`; splitting audit from
 *     closure is the whole point of the refactor.
 *   - `onApproveTask` re-checks autonomy at call time as defense-in-depth;
 *     tool registration already gates the surface, but a racing autonomy-level
 *     downgrade between registration and invocation would otherwise slip
 *     through.
 *   - `onSubmitForApproval` sets `status='review'` plus pending-completion
 *     fields so the UI banner can route a human to approve/reject.
 */

import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceTaskReportResultRepository } from '../../../storage/repositories/space-task-report-result-repository';
import type { SpaceManager } from '../managers/space-manager';
import type { DaemonHub } from '../../daemon-hub';
import type { SpaceTask, SpaceWorkflow } from '@neokai/shared';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';
import type {
	ApproveTaskInput,
	ReportResultInput,
	SubmitForApprovalInput,
} from './task-agent-tool-schemas';
import { Logger } from '../../logger';

const log = new Logger('end-node-handlers');

/**
 * Dependencies for building end-node handlers. All fields are required EXCEPT
 * `daemonHub` — when absent the handlers still succeed, they just do not emit
 * lifecycle events (used in unit tests).
 */
export interface EndNodeHandlerDeps {
	/** Task being finalized. */
	taskId: string;
	/** Space the task belongs to. Needed for autonomy lookup + event payloads. */
	spaceId: string;
	/** Workflow the task was executed under. Needed for completionAutonomyLevel. */
	workflow: SpaceWorkflow | null;
	/** Workflow node ID of the calling agent — stored for audit + pending fields. */
	workflowNodeId: string;
	/** Agent name calling the tool — written to the audit log. */
	agentName: string;
	/** Task repository. */
	taskRepo: SpaceTaskRepository;
	/** Append-only report result repository (used by report_result). */
	taskReportResultRepo: SpaceTaskReportResultRepository;
	/** Space manager — used to look up current autonomy level for approve_task. */
	spaceManager: Pick<SpaceManager, 'getSpace'>;
	/** Optional hub for emitting `space.task.updated` events after state changes. */
	daemonHub?: Pick<DaemonHub, 'emit'>;
}

export interface EndNodeHandlers {
	onReportResult: (args: ReportResultInput) => Promise<ToolResult>;
	onApproveTask: (args: ApproveTaskInput) => Promise<ToolResult>;
	onSubmitForApproval: (args: SubmitForApprovalInput) => Promise<ToolResult>;
}

/**
 * Create the three end-node tool handlers bound to a specific task/workflow/
 * agent context. The returned handlers are pure closures — repeated calls
 * with the same `deps` return independent instances.
 */
export function createEndNodeHandlers(deps: EndNodeHandlerDeps): EndNodeHandlers {
	const {
		taskId,
		spaceId,
		workflow,
		workflowNodeId,
		agentName,
		taskRepo,
		taskReportResultRepo,
		spaceManager,
		daemonHub,
	} = deps;

	const emitTaskUpdated = (task: SpaceTask): void => {
		if (!daemonHub) return;
		void daemonHub
			.emit('space.task.updated', { sessionId: 'global', spaceId, taskId, task })
			.catch((err: unknown) => {
				log.warn(
					`Failed to emit space.task.updated for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
				);
			});
	};

	return {
		// -------------------------------------------------------------------
		// report_result — APPEND-ONLY. Never mutates task state.
		// -------------------------------------------------------------------
		onReportResult: async (args: ReportResultInput) => {
			const task = taskRepo.getTask(taskId);
			if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

			try {
				taskReportResultRepo.append({
					taskId,
					spaceId,
					workflowNodeId,
					agentName,
					summary: args.summary,
					evidence: args.evidence ?? null,
				});
				return jsonResult({
					success: true,
					taskId,
					summary: args.summary,
					message:
						'Result recorded to audit log. This does NOT close the task — call approve_task (if available) or submit_for_approval to finalize.',
				});
			} catch (err) {
				return jsonResult({
					success: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		// -------------------------------------------------------------------
		// approve_task — self-close. Re-checks autonomy at call time.
		// -------------------------------------------------------------------
		onApproveTask: async (_args: ApproveTaskInput) => {
			const space = await spaceManager.getSpace(spaceId);
			const currentLevel = space?.autonomyLevel ?? 1;
			const required = workflow?.completionAutonomyLevel ?? 5;
			if (currentLevel < required) {
				return jsonResult({
					success: false,
					error: `approve_task not permitted: space autonomy level ${currentLevel} < workflow completionAutonomyLevel ${required}. Use submit_for_approval to request human review.`,
				});
			}

			const task = taskRepo.getTask(taskId);
			if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

			try {
				const updated = taskRepo.updateTask(taskId, {
					reportedStatus: 'done',
					// Clear any pending-completion state in case a prior submit_for_approval
					// set it; approval supersedes the pending request.
					pendingCheckpointType: null,
					pendingCompletionSubmittedByNodeId: null,
					pendingCompletionSubmittedAt: null,
					pendingCompletionReason: null,
				});
				if (updated) emitTaskUpdated(updated);
				return jsonResult({
					success: true,
					taskId,
					message:
						'Task approved for completion. The completion-action pipeline will now resolve terminal status.',
				});
			} catch (err) {
				return jsonResult({
					success: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		// -------------------------------------------------------------------
		// submit_for_approval — human sign-off. Always available to end nodes.
		// -------------------------------------------------------------------
		onSubmitForApproval: async (args: SubmitForApprovalInput) => {
			const task = taskRepo.getTask(taskId);
			if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

			try {
				const updated = taskRepo.updateTask(taskId, {
					status: 'review',
					pendingCheckpointType: 'task_completion',
					pendingCompletionSubmittedByNodeId: workflowNodeId,
					pendingCompletionSubmittedAt: Date.now(),
					pendingCompletionReason: args.reason ?? null,
				});
				if (updated) emitTaskUpdated(updated);
				return jsonResult({
					success: true,
					taskId,
					message: `Task submitted for human review${args.reason ? ` (reason: ${args.reason})` : ''}. A human must approve or reject via the UI before the workflow continues.`,
				});
			} catch (err) {
				return jsonResult({
					success: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
