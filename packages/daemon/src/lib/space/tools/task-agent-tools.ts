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
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type {
	PendingAgentMessageRepository,
	PendingAgentMessageRecord,
} from '../../../storage/repositories/pending-agent-message-repository';
import type { TaskAgentManager } from '../runtime/task-agent-manager';
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

function normalizeAgentNameToken(value: string): string {
	return value.trim().toLowerCase();
}

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
	/**
	 * Workflow manager for resolving gate definitions.
	 * Required for approve_gate autonomy enforcement to look up gate.requiredLevel.
	 */
	workflowManager?: SpaceWorkflowManager;
	/**
	 * Resolves the space's current autonomy level.
	 * Required for approve_gate autonomy enforcement: agent approvals are rejected
	 * when space autonomy < gate.requiredLevel (default 5 if gate has no requiredLevel).
	 */
	getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
	/**
	 * The calling agent's name (e.g., 'task-agent'). Used for gate writer authorization
	 * in approve_gate: the writers path is taken only when writers include this name or '*'.
	 * When omitted, only '*' in writers can match (falls back to autonomy path otherwise).
	 */
	myAgentName?: string;
	/**
	 * Optional name aliases for the calling agent. Checked alongside myAgentName during
	 * writer authorization.
	 */
	myAgentNameAliases?: string[];
	/**
	 * Persistent queue for messages whose target node-agent session is not yet
	 * active. When provided, send_message queues such messages instead of
	 * failing; TaskAgentManager flushes the queue when the target activates.
	 * Optional — when absent, the old "no active sessions found" error stands.
	 */
	pendingMessageRepo?: PendingAgentMessageRepository;
	/**
	 * Injects a message into the Space Agent chat session for this space.
	 * When provided, `send_message({ target: 'space-agent', ... })` escalates
	 * directly to the Space Agent without routing through a human.
	 */
	spaceAgentInjector?: (spaceId: string, message: string) => Promise<void>;
	/**
	 * Optional observability hook — fired whenever a message is queued for
	 * later delivery via `pendingMessageRepo`. Tests can capture this to
	 * assert queue behavior without touching DB.
	 */
	onMessageQueued?: (record: PendingAgentMessageRecord) => void;
	/**
	 * TaskAgentManager instance for direct session lookup by agent name.
	 * When provided, send_message uses `getSubSessionByAgentName` and
	 * `getAgentNamesForTask` to resolve live sessions by name rather than
	 * filtering NodeExecution records by status. Sessions persist until the
	 * task is archived, so status-filtered lookup is no longer needed.
	 */
	taskAgentManager?: TaskAgentManager;
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
		workflowManager,
		getSpaceAutonomyLevel,
		myAgentName,
		myAgentNameAliases,
		pendingMessageRepo,
		spaceAgentInjector,
		onMessageQueued,
		taskAgentManager,
	} = config;

	const agentNameAliases = new Set(
		[myAgentName, ...(myAgentNameAliases ?? [])]
			.filter((v): v is string => typeof v === 'string')
			.map((v) => normalizeAgentNameToken(v))
			.filter((v) => v.length > 0)
	);

	/** Reserved agent name used by Task Agent to escalate directly to the Space Agent. */
	const SPACE_AGENT_TARGET = 'space-agent';

	/** Emit DaemonHub event + invoke observability hook when a message is queued. */
	function emitQueued(record: PendingAgentMessageRecord): void {
		onMessageQueued?.(record);
		if (!daemonHub) return;
		void daemonHub
			.emit('space.pendingMessage.queued', {
				sessionId: 'global',
				spaceId: space.id,
				workflowRunId,
				taskId: record.taskId,
				targetAgentName: record.targetAgentName,
				targetKind: record.targetKind,
				messageId: record.id,
				attempts: record.attempts,
				maxAttempts: record.maxAttempts,
				expiresAt: record.expiresAt,
				deduped: false,
			})
			.catch(() => {});
	}

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
		 *   - `target: 'space-agent'` — escalation to the Space Agent chat session
		 *
		 * The Task Agent's agent name is `'task-agent'`. Default bidirectional channels
		 * are auto-created between the Task Agent and all node agents at
		 * node-start, so the Task Agent can reach all peers by default.
		 *
		 * Queue-until-active:
		 *   If the target node agent has a declared NodeExecution row but no active
		 *   session (e.g. during reopen/startup races), the message is persisted to
		 *   the pending queue and auto-delivered the moment that sub-session becomes
		 *   active. See `PendingAgentMessageRepository`.
		 *
		 * Idempotency:
		 *   Callers can pass an `idempotency_key` to de-duplicate repeat sends.
		 *   The key is scoped to `(workflowRunId, targetAgentName)`.
		 */
		async send_message(args: SendMessageInput & { idempotency_key?: string }): Promise<ToolResult> {
			const { target, message } = args;
			const idempotencyKey = args.idempotency_key ?? null;
			let targetAgentNames: string[];

			// Agent names that have a live session (DB-driven lookup).
			// These are reachable regardless of NodeExecution status — sessions persist
			// until the task is archived, not until the node execution completes.
			const liveAgentNames = taskAgentManager
				? await taskAgentManager.getAgentNamesForTask(taskId)
				: [];

			// Agent names declared in any NodeExecution for this run — used to detect
			// "agent exists but not yet spawned" (queueable) vs "unknown agent" (hard error).
			const allExecutions = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
			const declaredAgentNames = [...new Set(allExecutions.map((e) => e.agentName))];

			if (target === '*') {
				if (liveAgentNames.length === 0) {
					return jsonResult({
						success: false,
						error:
							`No active workflow agent sessions found for this run. ` +
							`Broadcast ('*') requires at least one active target.`,
						availableTargets: liveAgentNames,
					});
				}
				targetAgentNames = liveAgentNames;
			} else if (Array.isArray(target)) {
				targetAgentNames = target;
			} else {
				targetAgentNames = [target];
			}
			const delivered: Array<{ agentName: string; sessionId: string }> = [];
			const queued: Array<{
				agentName: string;
				targetKind: 'node_agent' | 'space_agent';
				messageId: string;
				deduped: boolean;
			}> = [];
			const notFound: string[] = [];
			const failed: Array<{ agentName: string; sessionId?: string; error: string }> = [];

			// Best-effort delivery: attempt all targets, aggregate errors.
			for (const targetAgentName of targetAgentNames) {
				const prefixedMessage = `[Message from task-agent]: ${message}`;

				// --- Space Agent escalation path --------------------------------
				if (targetAgentName === SPACE_AGENT_TARGET) {
					if (spaceAgentInjector) {
						try {
							await spaceAgentInjector(space.id, prefixedMessage);
							delivered.push({
								agentName: targetAgentName,
								sessionId: `space:chat:${space.id}`,
							});
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							// Queue for later delivery when possible.
							if (pendingMessageRepo) {
								const { record, deduped } = pendingMessageRepo.enqueue({
									workflowRunId,
									spaceId: space.id,
									taskId,
									targetKind: 'space_agent',
									targetAgentName: SPACE_AGENT_TARGET,
									message,
									idempotencyKey,
								});
								queued.push({
									agentName: targetAgentName,
									targetKind: 'space_agent',
									messageId: record.id,
									deduped,
								});
								if (!deduped) emitQueued(record);
								log.warn(
									`send_message: Space Agent injection failed (${errMsg}); queued message ${record.id} for retry`
								);
							} else {
								failed.push({ agentName: targetAgentName, error: errMsg });
							}
						}
					} else if (pendingMessageRepo) {
						// No injector available right now (e.g. Space chat session not yet provisioned);
						// persist the message so it can be delivered once infrastructure is ready.
						const { record, deduped } = pendingMessageRepo.enqueue({
							workflowRunId,
							spaceId: space.id,
							taskId,
							targetKind: 'space_agent',
							targetAgentName: SPACE_AGENT_TARGET,
							message,
							idempotencyKey,
						});
						queued.push({
							agentName: targetAgentName,
							targetKind: 'space_agent',
							messageId: record.id,
							deduped,
						});
						if (!deduped) emitQueued(record);
					} else {
						failed.push({
							agentName: targetAgentName,
							error:
								'Space Agent escalation is not available in this context ' +
								'(no injector and no pending-message queue configured).',
						});
					}
					continue;
				}

				// --- Node-agent path --------------------------------------------
				// Look up the live session directly by agent name. Sessions remain alive
				// for the full task lifetime (until archive), so no status filter is needed.
				const liveSession = taskAgentManager
					? await taskAgentManager.getSubSessionByAgentName(taskId, targetAgentName)
					: null;
				if (!liveSession) {
					// Agent is declared but hasn't been spawned yet (pre-first-execution).
					// Queue the message if we have the pending-message repo, else fall back to notFound.
					const isDeclaredInRun = declaredAgentNames.includes(targetAgentName);
					if (isDeclaredInRun && pendingMessageRepo) {
						const { record, deduped } = pendingMessageRepo.enqueue({
							workflowRunId,
							spaceId: space.id,
							taskId,
							targetKind: 'node_agent',
							targetAgentName,
							message,
							idempotencyKey,
						});
						queued.push({
							agentName: targetAgentName,
							targetKind: 'node_agent',
							messageId: record.id,
							deduped,
						});
						if (!deduped) emitQueued(record);
						continue;
					}
					notFound.push(targetAgentName);
					continue;
				}
				// Deliver directly to the live session. injectSubSessionMessage calls
				// ensureQueryStarted() so an idle session is automatically restarted.
				try {
					await messageInjector(liveSession.session.id, prefixedMessage);
					delivered.push({ agentName: targetAgentName, sessionId: liveSession.session.id });
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					failed.push({
						agentName: targetAgentName,
						sessionId: liveSession.session.id,
						error: errMsg,
					});
				}
			}

			// If the only outcome was "notFound" with nothing delivered or queued, return hard error.
			if (
				notFound.length > 0 &&
				delivered.length === 0 &&
				queued.length === 0 &&
				failed.length === 0
			) {
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
					success: delivered.length > 0 || queued.length > 0 ? 'partial' : false,
					delivered,
					queued: queued.length > 0 ? queued : undefined,
					failed,
					notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
					message:
						delivered.length + queued.length > 0
							? `Message delivered/queued for ${delivered.length + queued.length} peer(s) but failed for ${failed.length} peer(s).`
							: `Message delivery failed for all ${failed.length} target(s).`,
				});
			}

			const summaryParts: string[] = [];
			if (delivered.length > 0) {
				summaryParts.push(
					`delivered to ${delivered.length} peer(s): ` +
						delivered.map((t) => `${t.agentName} (${t.sessionId})`).join(', ')
				);
			}
			if (queued.length > 0) {
				summaryParts.push(
					`queued for ${queued.length} peer(s) pending activation: ` +
						queued.map((t) => t.agentName).join(', ')
				);
			}
			return jsonResult({
				success: true,
				delivered,
				queued: queued.length > 0 ? queued : undefined,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
				message: summaryParts.length > 0 ? `Message ${summaryParts.join('; ')}.` : 'No action.',
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

			// Per-field two-path authorization for agent-originated approvals.
			// Writers path: 'approved' field's writers includes this agent's name or '*' → allow.
			// Autonomy path: writers don't include this agent (or empty writers) → require
			// space.autonomyLevel >= gate.requiredLevel (default 5).
			// Human approval via spaceWorkflowRun.approveGate RPC is not subject to this check.
			if (args.approved && workflowManager && getSpaceAutonomyLevel) {
				const workflow = workflowManager.getWorkflow(run.workflowId);
				const gateDef = (workflow?.gates ?? []).find((g) => g.id === args.gate_id);
				const approvedField = (gateDef?.fields ?? []).find((f) => f.name === 'approved');
				const writers = approvedField?.writers ?? [];
				const writerMatches = writers.some((w) => {
					const normalized = normalizeAgentNameToken(w);
					return normalized === '*' || agentNameAliases.has(normalized);
				});

				if (!writerMatches) {
					// Autonomy path: this agent is not in the writers list
					const effectiveRequiredLevel = gateDef?.requiredLevel ?? 5;
					const spaceLevel = await getSpaceAutonomyLevel(space.id);
					if (spaceLevel < effectiveRequiredLevel) {
						return jsonResult({
							success: false,
							error:
								`Agent approval blocked: gate "${args.gate_id}" requires autonomy level ` +
								`${effectiveRequiredLevel} but space autonomy is ${spaceLevel}. ` +
								`Increase space autonomy level or request human approval.`,
						});
					}
				}
				// Writers path: writerMatches → no autonomy check needed
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
					approvalSource: 'agent',
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
					approvalSource: 'agent',
				});

				if (run.status !== 'blocked') {
					workflowRunRepo.transitionStatus(workflowRunId, 'blocked');
				}
				workflowRunRepo.updateRun(workflowRunId, { failureReason: 'humanRejected' });

				// Block the canonical task with gate_rejected reason
				const mainTask = taskRepo.getTask(taskId);
				if (mainTask && mainTask.status !== 'blocked') {
					await taskManager.setTaskStatus(taskId, 'blocked', {
						result: args.reason ?? 'Gate rejected',
						blockReason: 'gate_rejected',
					});
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
				"Use target 'space-agent' to escalate to the Space Agent without human relay. " +
				'Messages for declared-but-inactive node agents are persisted to a queue and ' +
				'auto-delivered once that sub-session activates. ' +
				'Pass `idempotency_key` to de-duplicate repeated sends. ' +
				'The Task Agent has default bidirectional channels to all node agents.',
			{
				...SendMessageSchema.shape,
				idempotency_key: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Optional idempotency key. If set, re-sends with the same key for the same ' +
							'(workflowRunId, targetAgentName) are de-duplicated — the existing queued or ' +
							'delivered message is returned instead of being re-sent.'
					),
			},
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
