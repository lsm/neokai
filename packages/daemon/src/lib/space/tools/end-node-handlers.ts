/**
 * End-node tool handlers.
 *
 * Factory for the two "terminal" MCP tool handlers exposed to end-node agents:
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
 *   - Both handlers return a `ToolResult` (never throw).
 *   - `onApproveTask` re-checks autonomy at call time as defense-in-depth;
 *     tool registration already gates the surface, but a racing autonomy-level
 *     downgrade between registration and invocation would otherwise slip
 *     through.
 *   - `onSubmitForApproval` sets `status='review'` plus pending-completion
 *     fields so the UI banner can route a human to approve/reject.
 */

import type { SpaceTask, SpaceWorkflow } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { DaemonHub } from '../../daemon-hub';
import { Logger } from '../../logger';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type {
	ApproveTaskInput,
	MarkCompleteInput,
	SubmitForApprovalInput,
} from './task-agent-tool-schemas';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';

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
	/** Workflow node ID of the calling agent — stored for pending fields. */
	workflowNodeId: string;
	/** Agent name calling the tool — for logging. */
	agentName: string;
	/** Task repository. */
	taskRepo: SpaceTaskRepository;
	/**
	 * Task manager bound to `spaceId`. Used by `submit_for_approval` so the
	 * agent path and the UI "Submit for Review" RPC share `submitTaskForReview`,
	 * which runs the centralised transition validator before stamping the
	 * pending-completion fields.
	 */
	taskManager: Pick<SpaceTaskManager, 'submitTaskForReview'>;
	/** Space manager — used to look up current autonomy level for approve_task. */
	spaceManager: Pick<SpaceManager, 'getSpace'>;
	/** Optional hub for emitting `space.task.updated` events after state changes. */
	daemonHub?: Pick<DaemonHub, 'emit'>;
}

export interface EndNodeHandlers {
	onApproveTask: (args: ApproveTaskInput) => Promise<ToolResult>;
	onSubmitForApproval: (args: SubmitForApprovalInput) => Promise<ToolResult>;
}

/**
 * Standalone factory for the `mark_complete` handler (PR 2/5). Separate from
 * `createEndNodeHandlers` because `mark_complete` is mirrored onto
 * post-approval sub-sessions — which are NOT necessarily end-node sessions —
 * and also onto the orchestration Task Agent's MCP surface directly.
 *
 * Transitions the task `approved → done` via `SpaceTaskManager.setTaskStatus`
 * (so the centralised transition validator runs), clears the post-approval
 * tracking fields, and emits a `space.task.updated` DaemonHub event.
 */
export interface MarkCompleteHandlerDeps {
	taskId: string;
	spaceId: string;
	/** Task repository — used to read the current status before transitioning. */
	taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
	/** Task manager — used to transition and update the task atomically. */
	taskManager: Pick<SpaceTaskManager, 'setTaskStatus' | 'updateTask'>;
	/** Optional hub for emitting `space.task.updated` events. */
	daemonHub?: Pick<DaemonHub, 'emit'>;
}

/**
 * Create a bound `mark_complete` handler. See the type-level doc on the
 * `mark_complete` tool registration in `task-agent-tools.ts` /
 * `node-agent-tools.ts` for the wider contract.
 */
export function createMarkCompleteHandler(
	deps: MarkCompleteHandlerDeps
): (args: MarkCompleteInput) => Promise<ToolResult> {
	const { taskId, spaceId, taskRepo, taskManager, daemonHub } = deps;

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

	return async (_args: MarkCompleteInput): Promise<ToolResult> => {
		const task = taskRepo.getTask(taskId);
		if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

		if (task.status !== 'approved') {
			return jsonResult({
				success: false,
				error:
					`task is not in \`approved\` status (current: \`${task.status}\`); did you mean \`approve_task\`? ` +
					`mark_complete only transitions an already-approved task from 'approved' to 'done'.`,
			});
		}

		try {
			// Single atomic write: status flip + post-approval-* cleanup. The
			// "exit approved" branch in `SpaceTaskManager.setTaskStatus` nulls
			// `postApprovalSessionId`, `postApprovalStartedAt`, and
			// `postApprovalBlockedReason` in the same UPDATE.
			const updated = await taskManager.setTaskStatus(taskId, 'done', {
				approvalSource: task.approvalSource ?? 'agent',
			});
			emitTaskUpdated(updated);
			log.info(
				`post-approval.complete: spaceId=${spaceId} taskId=${taskId} outcome=done mode=${task.postApprovalSessionId ? 'spawn' : 'inline'}`
			);
			return jsonResult({
				success: true,
				taskId,
				message: 'Post-approval work finished. Task transitioned to done.',
			});
		} catch (err) {
			return jsonResult({
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

/**
 * Create the two end-node tool handlers bound to a specific task/workflow/
 * agent context. The returned handlers are pure closures — repeated calls
 * with the same `deps` return independent instances.
 */
export function createEndNodeHandlers(deps: EndNodeHandlerDeps): EndNodeHandlers {
	const {
		taskId,
		spaceId,
		workflow,
		workflowNodeId,
		taskRepo,
		taskManager,
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
		//
		// Delegates to `SpaceTaskManager.submitTaskForReview` — the same helper
		// used by the UI "Submit for Review" RPC and the Task Agent's
		// `submit_for_approval` tool — so all three callers write identical
		// fields and the resulting `review` task is always banner-eligible.
		// -------------------------------------------------------------------
		onSubmitForApproval: async (args: SubmitForApprovalInput) => {
			const task = taskRepo.getTask(taskId);
			if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

			try {
				const updated = await taskManager.submitTaskForReview(taskId, {
					submittedByNodeId: workflowNodeId,
					reason: args.reason ?? null,
				});
				emitTaskUpdated(updated);
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
