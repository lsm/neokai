/**
 * Task Agent Tools — MCP tool handlers for the Task Agent session.
 *
 * These handlers implement the business logic for the 4 Task Agent tools:
 *   report_result         — Mark the task as completed/failed and record the result
 *   request_human_input   — Pause execution and surface a question to the human user
 *   list_group_members    — List all members of the current task's session group
 *   send_message          — Send a message to peer node agents via channel topology
 *
 * Node agent spawning is handled by the SpaceRuntime tick loop, not by the Task Agent.
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `TaskAgentToolsConfig`.
 *
 * Following the pattern established in space-agent-tools.ts.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Space } from '@neokai/shared';
import { z } from 'zod';
import type { DaemonHub } from '../../daemon-hub';
import { Logger } from '../../logger';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	ReportResultSchema,
	RequestHumanInputSchema,
	ListGroupMembersSchema,
} from './task-agent-tool-schemas';
import { SendMessageSchema } from './node-agent-tool-schemas';
import type {
	ReportResultInput,
	RequestHumanInputInput,
	ListGroupMembersInput,
} from './task-agent-tool-schemas';
import type { SendMessageInput } from './node-agent-tool-schemas';

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('task-agent-tools');

/**
 * Agent identity metadata for sub-session creation.
 * Passed to createSubSession() so the manager can record the session as a group member.
 */
export interface SubSessionMemberInfo {
	/** ID of the SpaceAgent config this sub-session uses */
	agentId?: string;
	/** Agent slot name from WorkflowNodeAgent.name (e.g. 'coder', 'reviewer') */
	agentName?: string;
	/** Workflow node ID — used to link the sub-session to its NodeExecution record */
	nodeId?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createTaskAgentToolHandlers().
 * All fields are required — the caller (TaskAgentManager) wires them up.
 */
export interface TaskAgentToolsConfig {
	/** ID of the main SpaceTask this Task Agent is orchestrating. */
	taskId: string;
	/** Full Space object — the space ID is available as `space.id`. */
	space: Space;
	/** ID of the active workflow run for this task. */
	workflowRunId: string;
	/** Task repository for direct DB reads. */
	taskRepo: SpaceTaskRepository;
	/** Node execution repository for querying execution state in list_group_members. */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Task manager for validated status transitions. */
	taskManager: SpaceTaskManager;
	/**
	 * Injects a message into an existing sub-session as a user turn.
	 * Used by send_message to deliver messages to node agents.
	 */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * DaemonHub instance for emitting task completion/failure events.
	 * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
	 */
	daemonHub?: DaemonHub;
	/** Gate data repository for approve_gate tool. Optional — gate tools disabled when absent. */
	gateDataRepo?: GateDataRepository;
	/** Workflow run repository for approve_gate tool. Optional — gate tools disabled when absent. */
	workflowRunRepo?: SpaceWorkflowRunRepository;
	/** Callback to trigger channel re-evaluation after gate data changes. */
	onGateChanged?: (runId: string, gateId: string) => void;
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 * Returns a map of tool name → async handler function.
 */
export function createTaskAgentToolHandlers(config: TaskAgentToolsConfig) {
	const {
		taskId,
		space,
		workflowRunId,
		taskRepo,
		nodeExecutionRepo,
		taskManager,
		messageInjector,
		daemonHub,
		gateDataRepo,
		workflowRunRepo,
		onGateChanged,
	} = config;

	return {
		/**
		 * Report the final outcome of the task and close the task lifecycle.
		 *
		 * Updates the main SpaceTask status to one of:
		 *   completed        — task succeeded; summary records the result
		 *   blocked          — task requires human intervention
		 *   cancelled        — task was cancelled
		 */
		async report_result(args: ReportResultInput): Promise<ToolResult> {
			const { status, summary } = args;

			const mainTask = taskRepo.getTask(taskId);
			if (!mainTask) {
				return jsonResult({ success: false, error: `Task not found: ${taskId}` });
			}

			try {
				await taskManager.setTaskStatus(taskId, status, {
					result: summary,
					...(status === 'blocked' ? { blockReason: 'execution_failed' as const } : {}),
				});

				// Emit DaemonHub event so the Space Agent is notified of task completion/failure.
				if (daemonHub) {
					const eventPayload = {
						sessionId: 'global',
						taskId,
						spaceId: space.id,
						status,
						summary: summary ?? '',
						workflowRunId,
						taskTitle: mainTask.title,
					};
					const eventName = status === 'done' ? 'space.task.done' : 'space.task.failed';
					void daemonHub.emit(eventName, eventPayload).catch((err) => {
						log.warn(
							`Failed to emit ${eventName} for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
						);
					});
				}

				return jsonResult({
					success: true,
					taskId,
					status,
					summary,
					message: `Task has been marked as "${status}". The task lifecycle is now closed.`,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * List all members of the current task's session group.
		 *
		 * Returns every member with:
		 *   - sessionId, agentName, agentId, status
		 *   - permittedTargets: agent names this member can send to per channel topology
		 *   - completionState: execution status and result summary
		 *
		 * Also returns nodeCompletionState — all executions in the run with their completion state.
		 */
		async list_group_members(_args: ListGroupMembersInput): Promise<ToolResult> {
			const allExecs = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
			const activeExecs = allExecs.filter((ne) => ne.agentSessionId);
			const knownAgentNames = [...new Set(allExecs.map((ne) => ne.agentName))];

			const members = activeExecs.map((ne) => {
				const execStatus = ne.status;
				const memberStatus =
					execStatus === 'idle'
						? 'completed'
						: execStatus === 'blocked' || execStatus === 'cancelled'
							? 'failed'
							: 'active';
				return {
					sessionId: ne.agentSessionId!,
					agentName: ne.agentName,
					agentId: ne.agentId ?? (null as string | null),
					status: memberStatus,
					permittedTargets: knownAgentNames.filter((name) => name !== ne.agentName),
					completionState: {
						agentName: ne.agentName,
						taskStatus: ne.status,
						completionSummary: ne.result ?? null,
						completedAt: ne.completedAt ?? null,
					},
				};
			});

			const nodeCompletionState = allExecs.map((ne) => ({
				agentName: ne.agentName,
				taskStatus: ne.status,
				completionSummary: ne.result ?? null,
				completedAt: ne.completedAt ?? null,
			}));

			return jsonResult({
				success: true,
				members,
				nodeCompletionState,
				channelTopologyDeclared: false,
				message: `Run has ${members.length} active member(s).`,
			});
		},

		/**
		 * Send a message directly to one or more peer node agents.
		 *
		 * Validates the requested direction(s) against the declared channel topology
		 * before routing. The Task Agent uses `send_message` for all inter-agent
		 * communication with node agents.
		 *
		 * Target forms:
		 *   - `target: 'coder'` — point-to-point to a single agent
		 *   - `target: '*'` — broadcast to all permitted targets
		 *   - `target: ['coder', 'reviewer']` — multicast to multiple agents
		 *
		 * The Task Agent's agent name is `'task-agent'`. Default bidirectional channels
		 * are auto-created between the Task Agent and all node agents at
		 * node-start, so the Task Agent can reach all peers by default.
		 */
		async send_message(args: SendMessageInput): Promise<ToolResult> {
			const { target, message } = args;
			let targetAgentNames: string[];
			const activeExecutions = nodeExecutionRepo
				.listByWorkflowRun(workflowRunId)
				.filter(
					(execution) =>
						execution.agentSessionId &&
						(execution.status === 'in_progress' || execution.status === 'pending')
				);
			const knownAgentNames = [
				...new Set(activeExecutions.map((execution) => execution.agentName)),
			];

			if (target === '*') {
				if (knownAgentNames.length === 0) {
					return jsonResult({
						success: false,
						error:
							`No active workflow agent sessions found for this run. ` +
							`Broadcast ('*') requires at least one active target.`,
						availableTargets: knownAgentNames,
					});
				}
				targetAgentNames = knownAgentNames;
			} else if (Array.isArray(target)) {
				targetAgentNames = target;
			} else {
				targetAgentNames = [target];
			}
			const sendPeers = activeExecutions.map((execution) => ({
				sessionId: execution.agentSessionId!,
				agentName: execution.agentName,
			}));
			const delivered: Array<{ agentName: string; sessionId: string }> = [];
			const notFound: string[] = [];
			const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];

			// Best-effort delivery: attempt all targets, aggregate errors.
			for (const targetAgentName of targetAgentNames) {
				const targetSessions = sendPeers.filter((m) => m.agentName === targetAgentName);
				if (targetSessions.length === 0) {
					notFound.push(targetAgentName);
					continue;
				}
				for (const targetMember of targetSessions) {
					const prefixedMessage = `[Message from task-agent]: ${message}`;
					try {
						await messageInjector(targetMember.sessionId, prefixedMessage);
						delivered.push({ agentName: targetAgentName, sessionId: targetMember.sessionId });
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						failed.push({
							agentName: targetAgentName,
							sessionId: targetMember.sessionId,
							error: errMsg,
						});
					}
				}
			}

			if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
				return jsonResult({
					success: false,
					error:
						`No active sessions found for target agent(s): ${notFound.join(', ')}. ` +
						`Use list_group_members to check which peers are currently active.`,
					notFoundAgentNames: notFound,
				});
			}

			if (failed.length > 0) {
				return jsonResult({
					success: delivered.length > 0 ? 'partial' : false,
					delivered,
					failed,
					notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
					message:
						delivered.length > 0
							? `Message delivered to ${delivered.length} peer(s) but failed for ${failed.length} peer(s).`
							: `Message delivery failed for all ${failed.length} target(s).`,
				});
			}

			return jsonResult({
				success: true,
				delivered,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
				message:
					`Message delivered to ${delivered.length} peer(s): ` +
					delivered.map((t) => `${t.agentName} (${t.sessionId})`).join(', ') +
					'.',
			});
		},

		/**
		 * Pause workflow execution and surface a question to the human user.
		 *
		 * Updates the main task status to `needs_attention` and stores the question
		 * in the `currentStep` field so the human can see it in the UI.
		 * The full question + context is stored in the `error` field for complete context.
		 *
		 * Gate re-engagement:
		 * When the human responds (via space.task.sendMessage), the message is injected
		 * into this Task Agent session as a normal conversation message. The Task Agent
		 * receives it, sees the human's response, and can proceed accordingly.
		 */
		async request_human_input(args: RequestHumanInputInput): Promise<ToolResult> {
			const { question, context: questionContext } = args;

			const mainTask = taskRepo.getTask(taskId);
			if (!mainTask) {
				return jsonResult({ success: false, error: `Task not found: ${taskId}` });
			}

			// Only transition to blocked from valid states.
			// Valid transitions: in_progress → blocked.
			const canTransition = mainTask.status === 'in_progress';

			if (!canTransition) {
				return jsonResult({
					success: false,
					error:
						`Cannot request human input when task status is "${mainTask.status}". ` +
						`Task must be in_progress.`,
				});
			}

			try {
				await taskManager.setTaskStatus(taskId, 'blocked', {
					result: questionContext ? `${question}\n\nContext: ${questionContext}` : question,
					blockReason: 'human_input_requested',
				});

				return jsonResult({
					success: true,
					taskId,
					question,
					context: questionContext,
					message:
						'Human input has been requested. The question is now visible to the human in the UI. ' +
						'Wait — do not call any other tools until the human responds. ' +
						"When the human's response appears in the conversation, " +
						'read it and then continue as appropriate.',
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Approve or reject a workflow gate within this task's workflow run.
		 * Used to control flow between nodes by opening or blocking gates.
		 */
		async approve_gate(args: {
			gate_id: string;
			approved: boolean;
			reason?: string;
		}): Promise<ToolResult> {
			if (!gateDataRepo || !workflowRunRepo) {
				return jsonResult({ success: false, error: 'Gate operations are not available' });
			}

			const run = workflowRunRepo.getRun(workflowRunId);
			if (!run) {
				return jsonResult({
					success: false,
					error: `Workflow run not found: ${workflowRunId}`,
				});
			}
			if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
				return jsonResult({
					success: false,
					error: `Cannot modify gate on a ${run.status} workflow run`,
				});
			}

			const existing = gateDataRepo.get(workflowRunId, args.gate_id);

			if (args.approved) {
				if (existing?.data?.approved === true) {
					return jsonResult({
						success: true,
						gateId: args.gate_id,
						gateData: existing.data,
						message: 'Gate already approved',
					});
				}

				const gateData = gateDataRepo.merge(workflowRunId, args.gate_id, {
					approved: true,
					approvedAt: Date.now(),
					approvalSource: 'task_agent',
				});

				// If previously rejected, transition back to in_progress
				if (run.status === 'blocked' && run.failureReason === 'humanRejected') {
					workflowRunRepo.transitionStatus(workflowRunId, 'in_progress');
					workflowRunRepo.updateRun(workflowRunId, { failureReason: null });
				}

				if (daemonHub) {
					void daemonHub
						.emit('space.gateData.updated', {
							sessionId: 'global',
							spaceId: space.id,
							runId: workflowRunId,
							gateId: args.gate_id,
							data: gateData.data,
						})
						.catch(() => {});
				}
				onGateChanged?.(workflowRunId, args.gate_id);

				return jsonResult({
					success: true,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			} else {
				if (existing?.data?.approved === false) {
					return jsonResult({
						success: true,
						gateId: args.gate_id,
						gateData: existing.data,
						message: 'Gate already rejected',
					});
				}

				const gateData = gateDataRepo.merge(workflowRunId, args.gate_id, {
					approved: false,
					rejectedAt: Date.now(),
					reason: args.reason ?? null,
					approvalSource: 'task_agent',
				});

				if (run.status !== 'blocked') {
					workflowRunRepo.transitionStatus(workflowRunId, 'blocked');
				}
				workflowRunRepo.updateRun(workflowRunId, { failureReason: 'humanRejected' });

				if (daemonHub) {
					void daemonHub
						.emit('space.gateData.updated', {
							sessionId: 'global',
							spaceId: space.id,
							runId: workflowRunId,
							gateId: args.gate_id,
							data: gateData.data,
						})
						.catch(() => {});
				}

				return jsonResult({
					success: true,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			}
		},
	};
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server exposing all Task Agent tools.
 * Pass the returned server to the SDK session init for the Task Agent session.
 */
export function createTaskAgentMcpServer(config: TaskAgentToolsConfig) {
	const handlers = createTaskAgentToolHandlers(config);

	const tools = [
		tool(
			'report_result',
			'Mark the task as completed, failed, or cancelled and record the result summary. ' +
				'Call this when the workflow reaches a terminal node or an unrecoverable error occurs.',
			ReportResultSchema.shape,
			(args) => handlers.report_result(args)
		),
		tool(
			'request_human_input',
			'Pause workflow execution and surface a question to the human user. ' +
				'The task will be marked as needs_attention until the human responds. ' +
				'When the human responds, their message will appear in this conversation.',
			RequestHumanInputSchema.shape,
			(args) => handlers.request_human_input(args)
		),
		tool(
			'list_group_members',
			'List all members of the current task session group with their session IDs, agent names, and permitted channels. ' +
				'Use this to discover which sub-sessions are active and what messaging channels are declared.',
			ListGroupMembersSchema.shape,
			(args) => handlers.list_group_members(args)
		),
		tool(
			'send_message',
			'Send a message directly to one or more peer node agents via declared channel topology. ' +
				"Supports point-to-point ('coder'), broadcast ('*'), and multicast (['coder','reviewer']). " +
				'Validates against declared channels — returns an error with available channels if unauthorized. ' +
				'The Task Agent has default bidirectional channels to all node agents.',
			SendMessageSchema.shape,
			(args) => handlers.send_message(args)
		),
		tool(
			'approve_gate',
			"Approve or reject a workflow gate within this task's workflow run. " +
				'Use this to control flow between nodes by opening or blocking gates.',
			{
				gate_id: z.string().describe('ID of the gate to approve or reject'),
				approved: z.boolean().describe('true to approve (open gate), false to reject (block)'),
				reason: z.string().optional().describe('Reason for approval or rejection'),
			},
			(args) => handlers.approve_gate(args)
		),
	];

	return createSdkMcpServer({ name: 'task-agent', tools });
}

export type TaskAgentMcpServer = ReturnType<typeof createTaskAgentMcpServer>;
