/**
 * Task Agent Tools — MCP tool handlers for the Task Agent session.
 *
 * These handlers implement the business logic for the 7 Task Agent tools:
 *   spawn_node_agent      — Spawn a sub-session for a workflow node's assigned agent
 *   check_node_status     — Poll the status of a running node agent sub-session
 *   report_result         — Mark the task as completed/failed and record the result
 *   report_workflow_done  — Explicitly mark the workflow run as completed
 *   request_human_input   — Pause execution and surface a question to the human user
 *   list_group_members    — List all members of the current task's session group
 *   send_message          — Send a message to peer node agents via channel topology
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `TaskAgentToolsConfig`.
 * - The `SubSessionFactory` abstraction allows tests to mock session creation/state.
 * - Session completion is signalled via two paths:
 *     1. Completion callback registered in spawn_node_agent (fires automatically)
 *     2. Polling via check_node_status (Task Agent polls this tool)
 *
 * Following the pattern established in space-agent-tools.ts.
 */

import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Space, McpServerConfig } from '@neokai/shared';
import type { DaemonHub } from '../../daemon-hub';
import { Logger } from '../../logger';
import type { AgentSessionInit } from '../../agent/agent-session';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { resolveAgentInit, buildCustomAgentTaskMessage } from '../agents/custom-agent';
import { ChannelResolver } from '../runtime/channel-resolver';
import type { ChannelRouter } from '../runtime/channel-router';
import type { CompletionDetector } from '../runtime/completion-detector';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	SpawnNodeAgentSchema,
	CheckNodeStatusSchema,
	ReportResultSchema,
	ReportWorkflowDoneSchema,
	RequestHumanInputSchema,
	ListGroupMembersSchema,
} from './task-agent-tool-schemas';
import { SendMessageSchema } from './node-agent-tool-schemas';
import { resolveNodeAgents } from '@neokai/shared';
import type {
	SpawnNodeAgentInput,
	CheckNodeStatusInput,
	ReportResultInput,
	ReportWorkflowDoneInput,
	RequestHumanInputInput,
	ListGroupMembersInput,
} from './task-agent-tool-schemas';
import type { SendMessageInput } from './node-agent-tool-schemas';

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('task-agent-tools');

// ---------------------------------------------------------------------------
// Sub-session state
// ---------------------------------------------------------------------------

/**
 * Processing state of a sub-session, as reported by SubSessionFactory.
 */
export interface SubSessionState {
	/** Whether the session is actively processing a query */
	isProcessing: boolean;
	/** Whether the session has reached a terminal state (no more processing) */
	isComplete: boolean;
	/** Error details if the session ended in an error state */
	error?: string;
}

// ---------------------------------------------------------------------------
// SubSessionFactory
// ---------------------------------------------------------------------------

/**
 * Agent identity metadata passed to SubSessionFactory.create() so the manager
 * can record the sub-session as a group member without re-fetching the agent.
 */
export interface SubSessionMemberInfo {
	/** ID of the SpaceAgent config this sub-session uses */
	agentId?: string;
	/** Freeform role string from SpaceAgent.role (e.g. 'coder', 'reviewer') */
	role?: string;
}

/**
 * Abstraction for creating and querying sub-sessions.
 * Injected into the config so tests can mock session behaviour without a real daemon.
 */
export interface SubSessionFactory {
	/**
	 * Creates and starts a new agent sub-session.
	 * Returns the session ID of the created session.
	 * The optional `memberInfo` carries agent identity metadata so the factory
	 * can register the session as a group member.
	 */
	create(init: AgentSessionInit, memberInfo?: SubSessionMemberInfo): Promise<string>;

	/**
	 * Returns the current processing state of a session, or null if the session
	 * is not known / has been cleaned up.
	 */
	getProcessingState(sessionId: string): SubSessionState | null;

	/**
	 * Registers a callback that is invoked once when the given session completes
	 * (transitions to a terminal state). The callback is called at most once.
	 */
	onComplete(sessionId: string, callback: () => Promise<void>): void;
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
	/**
	 * Full Space object — needed for agent init and task message building.
	 * The space ID is available as `space.id`.
	 */
	space: Space;
	/** ID of the active workflow run for this task. */
	workflowRunId: string;
	/** Absolute path to the workspace — forwarded to agent sessions. */
	workspacePath: string;
	/** Workflow manager for loading workflow definitions. */
	workflowManager: SpaceWorkflowManager;
	/** Task repository for direct DB reads. */
	taskRepo: SpaceTaskRepository;
	/** Workflow run repository for reading and updating runs. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Agent manager for resolving node agents. */
	agentManager: SpaceAgentManager;
	/** Task manager for validated status transitions. */
	taskManager: SpaceTaskManager;
	/** Sub-session factory for creating and querying agent sub-sessions. */
	sessionFactory: SubSessionFactory;
	/**
	 * Injects a message into an existing sub-session as a user turn.
	 * Called after spawn to deliver the step's task context message.
	 */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Called by the completion mechanism when a sub-session finishes.
	 * Provided by the TaskAgentManager; updates the step's SpaceTask to `completed`.
	 * The Task Agent handler registers this as the session completion callback.
	 */
	onSubSessionComplete: (stepId: string, sessionId: string) => Promise<void>;
	/**
	 * DaemonHub instance for emitting task completion/failure events.
	 * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
	 */
	daemonHub?: DaemonHub;
	/**
	 * Factory to build a node agent MCP server for a spawned sub-session.
	 * Called in `spawn_node_agent` after resolving the session ID and agent role.
	 * Returns a McpServerConfig to attach to the sub-session's init.mcpServers.
	 * Optional — if omitted, no node agent MCP server is attached (e.g. in unit tests).
	 *
	 * @param sessionId   - The sub-session ID being started.
	 * @param role        - The slot role for the agent (used for channel routing).
	 * @param stepTaskId  - The SpaceTask ID for this step (used by report_done).
	 */
	buildNodeAgentMcpServer?: (
		sessionId: string,
		role: string,
		stepTaskId: string
	) => McpServerConfig;
	/**
	 * Channel router for gate-checked message routing between agents.
	 * When provided, the send_message tool uses it for channel validation and
	 * lazy node activation instead of constructing a ChannelResolver from run config.
	 * Optional — existing ChannelResolver-based routing is used as fallback.
	 */
	channelRouter?: ChannelRouter;
	/**
	 * Completion detector for validating all-agents-done state.
	 * When provided, report_workflow_done checks that all node agent tasks have
	 * reached a terminal status before marking the workflow run as completed.
	 * Optional — if omitted, no completion pre-check is performed.
	 */
	completionDetector?: CompletionDetector;
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
		workspacePath,
		workflowManager,
		taskRepo,
		workflowRunRepo,
		agentManager,
		taskManager,
		sessionFactory,
		messageInjector,
		onSubSessionComplete,
		daemonHub,
		buildNodeAgentMcpServer,
		completionDetector,
	} = config;

	return {
		/**
		 * Spawn a sub-session for a workflow step's assigned agent.
		 *
		 * Flow:
		 * 1. Validate the workflow run and workflow definition
		 * 2. Find the step by step_id in the workflow
		 * 3. Find the pending SpaceTask created by the WorkflowExecutor for this step
		 * 4. Resolve the agent session init via resolveAgentInit()
		 * 5. Create the sub-session via sessionFactory.create()
		 * 6. Register completion callback (onSubSessionComplete) via sessionFactory.onComplete()
		 * 7. Record the sub-session ID on the step task (BEFORE message injection, so
		 *    check_node_status can track the session even if injection later fails)
		 * 8. Transition main task from pending → in_progress if not already in_progress
		 * 9. Build and inject the task context message via messageInjector
		 *    (non-fatal if injection fails — sub-session is already running and trackable)
		 */
		async spawn_node_agent(args: SpawnNodeAgentInput): Promise<ToolResult> {
			const { step_id, instructions } = args;

			// Load the workflow run
			const run = workflowRunRepo.getRun(workflowRunId);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${workflowRunId}` });
			}

			// Load the workflow definition
			const workflow = workflowManager.getWorkflow(run.workflowId);
			if (!workflow) {
				return jsonResult({ success: false, error: `Workflow not found: ${run.workflowId}` });
			}

			// Find the step
			const step = workflow.nodes.find((s) => s.id === step_id);
			if (!step) {
				return jsonResult({
					success: false,
					error: `Step not found: ${step_id} in workflow ${run.workflowId}`,
				});
			}

			// Find the pending task for this step (created when the workflow node was activated)
			const allRunTasks = taskRepo.listByWorkflowRun(workflowRunId);
			const stepTasks = allRunTasks.filter((t) => t.workflowNodeId === step_id);
			if (stepTasks.length === 0) {
				return jsonResult({
					success: false,
					error:
						`No task found for step "${step.name}" (id: ${step_id}). ` +
						`The step task may not have been created yet — check that the workflow run is active.`,
				});
			}

			// Use the most recently created task for this step.
			const stepTask = stepTasks[stepTasks.length - 1];

			// Idempotency guard: if this step already has a tracked sub-session, return it
			// without creating a duplicate. Prevents double-spawning from orphaning the first
			// session when the Task Agent retries a spawn_node_agent call.
			if (stepTask.taskAgentSessionId) {
				return jsonResult({
					success: true,
					sessionId: stepTask.taskAgentSessionId,
					stepId: step_id,
					stepName: step.name,
					taskId: stepTask.id,
					alreadySpawned: true,
				});
			}

			// Ensure customAgentId is set — fall back to the primary node agent ID for preset agents.
			// WorkflowExecutor sets customAgentId to undefined for coder/general preset roles,
			// but those agents are still SpaceAgent records. Use resolveNodeAgents to get the
			// correct primary agentId regardless of whether the step uses agentId or agents[].
			const nodeAgents = resolveNodeAgents(step);
			const primaryAgentId = nodeAgents[0]?.agentId;
			const effectiveTask = {
				...stepTask,
				customAgentId: stepTask.customAgentId ?? primaryAgentId,
			};

			// Apply optional instruction override
			if (instructions) {
				effectiveTask.description = instructions;
			}

			// Find the WorkflowNodeAgent slot that spawned this task.
			// When agentName is stored on the task (migration 51+), use it for an exact match.
			// This correctly handles nodes where the same agentId appears multiple times with
			// different agent names (e.g. "strict-reviewer" and "quick-reviewer"): each task
			// was created with its own agentName, so the lookup is unambiguous.
			// For tasks created before migration 51 (no agentName), fall back to find-by-agentId,
			// which always returns the first matching slot — acceptable for legacy data.

			const agentSlot = effectiveTask.agentName
				? nodeAgents.find((a) => a.name === effectiveTask.agentName)
				: nodeAgents.find((a) => a.agentId === effectiveTask.customAgentId);

			// Extract slot-level overrides (model and systemPrompt) if present.
			// Always construct the object; undefined values are handled downstream
			// (createCustomAgentInit guards on !== undefined for each field).
			// When agentSlot is undefined (stale agentName: the workflow was edited after
			// the task was created and the slot no longer exists), both fields are undefined
			// and no override is applied — the base agent config is used as-is.
			const slotOverrides = { model: agentSlot?.model, systemPrompt: agentSlot?.systemPrompt };

			// Generate a new session ID for the sub-session.
			// Note: the factory may assign a different ID internally. All subsequent code
			// uses `actualSessionId` returned by sessionFactory.create(), not subSessionId.
			// The subSessionId is embedded in the init only so the SDK can pre-wire it.
			const subSessionId = randomUUID();

			// Resolve the agent session init, applying per-slot overrides when present.
			let init: AgentSessionInit;
			try {
				init = resolveAgentInit({
					task: effectiveTask,
					space,
					agentManager,
					sessionId: subSessionId,
					workspacePath,
					workflowRun: run,
					workflow,
					slotOverrides,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: `Failed to resolve agent init: ${message}` });
			}

			// Resolve agent identity for group membership tracking.
			// resolveAgentInit() already validated the agent exists, so this lookup
			// should always succeed — null here would be a data inconsistency.
			const agentForMember = agentManager.getById(effectiveTask.customAgentId!);

			// Use the slot's name (WorkflowNodeAgent.name) for channel routing and group membership.
			// This ensures that when the same agent appears multiple times in a node with different
			// slot names (e.g. "strict-reviewer" and "quick-reviewer"), each session is registered
			// with its unique slot name so ChannelResolver.canSend() checks work correctly.
			// Falls back to the base agent's role, then 'agent' if neither is available.
			const memberRole = agentSlot?.name ?? agentForMember?.role ?? 'agent';

			// Attach node agent peer communication MCP server if a factory is provided.
			// The server is built with the slot role so it can validate channels using the
			// same role that was registered in the session group.
			// Pass stepTask.id so report_done can mark the correct step task as completed.
			if (buildNodeAgentMcpServer) {
				const stepMcpServer = buildNodeAgentMcpServer(subSessionId, memberRole, stepTask.id);
				init = {
					...init,
					mcpServers: { ...init.mcpServers, 'node-agent': stepMcpServer },
				};
			}

			// Create and start the sub-session
			let actualSessionId: string;
			try {
				actualSessionId = await sessionFactory.create(init, {
					agentId: effectiveTask.customAgentId ?? undefined,
					role: memberRole,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: `Failed to create sub-session: ${message}` });
			}

			// Register the completion callback — fires when the sub-session finishes.
			sessionFactory.onComplete(actualSessionId, async () => {
				await onSubSessionComplete(step_id, actualSessionId);
			});

			// Record the sub-session ID on the step task BEFORE message injection.
			// This ensures check_node_status can locate and track the session even if
			// the subsequent message injection fails.
			taskRepo.updateTask(stepTask.id, {
				taskAgentSessionId: actualSessionId,
				currentStep: `Running agent for step: ${step.name}`,
			});

			// Transition main task from pending → in_progress (first step spawn)
			const mainTask = taskRepo.getTask(taskId);
			if (mainTask && mainTask.status === 'pending') {
				try {
					await taskManager.setTaskStatus(taskId, 'in_progress');
				} catch {
					// Non-fatal — task may have already been transitioned elsewhere
				}
			}

			// Update main task's currentStep to reflect which step is being executed
			taskRepo.updateTask(taskId, { currentStep: `Executing step: ${step.name}` });

			// Build the task context message and inject it into the sub-session.
			// This is non-fatal: if injection fails the sub-session still runs (and is
			// already trackable via taskAgentSessionId recorded above), just without its
			// initial task context. Return success with a warning field so the Task Agent
			// can still poll check_node_status.
			try {
				// resolveAgentInit() already validated that the agent exists, so this
				// getById() call should always succeed. If it somehow returns null after
				// resolveAgentInit() passed, that is a data inconsistency worth surfacing.
				const agent = agentManager.getById(effectiveTask.customAgentId!);
				if (!agent) {
					return jsonResult({
						success: true,
						sessionId: actualSessionId,
						stepId: step_id,
						stepName: step.name,
						taskId: stepTask.id,
						warning:
							`Agent ${effectiveTask.customAgentId} not found when building task message — ` +
							`sub-session is running without initial task context. This should not happen.`,
					});
				}
				const taskMessage = buildCustomAgentTaskMessage({
					customAgent: agent,
					task: effectiveTask,
					workflowRun: run,
					workflow,
					space,
					sessionId: actualSessionId,
					workspacePath,
				});
				await messageInjector(actualSessionId, taskMessage);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Return success:true because the sub-session was created, the completion
				// callback is registered, and taskAgentSessionId is persisted. The Task Agent
				// can still track completion via check_node_status. The warning informs it
				// that the sub-session started without its initial task context message.
				return jsonResult({
					success: true,
					sessionId: actualSessionId,
					stepId: step_id,
					stepName: step.name,
					taskId: stepTask.id,
					warning: `Message injection failed: ${message}. Sub-session is running without initial task context.`,
				});
			}

			return jsonResult({
				success: true,
				sessionId: actualSessionId,
				stepId: step_id,
				stepName: step.name,
				taskId: stepTask.id,
			});
		},

		/**
		 * Check the processing state of a node's sub-session.
		 *
		 * This is the primary mechanism for the Task Agent to detect sub-session completion.
		 * The Task Agent polls this tool after spawning a node agent.
		 *
		 * If step_id is omitted, checks the workflow run's current step.
		 * Returns status = 'completed' when the step task has been marked completed in the DB
		 * (which happens via the completion callback registered in spawn_node_agent).
		 */
		async check_node_status(args: CheckNodeStatusInput): Promise<ToolResult> {
			// step_id is required — no fallback to currentNodeId (field removed in migration 59)
			const stepId = args.step_id;
			if (!stepId) {
				return jsonResult({
					success: false,
					error: 'step_id is required. Call spawn_node_agent first and pass the step_id.',
				});
			}

			// Find task(s) for this step
			const stepTasks = taskRepo
				.listByWorkflowRun(workflowRunId)
				.filter((t) => t.workflowNodeId === stepId);

			if (stepTasks.length === 0) {
				return jsonResult({
					success: true,
					stepId,
					taskStatus: 'not_found',
					sessionStatus: 'not_started',
					message: 'No task found for this step. Has spawn_node_agent been called?',
				});
			}

			const stepTask = stepTasks[stepTasks.length - 1];

			// Fast path: task already marked completed by the completion callback
			if (stepTask.status === 'completed') {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: 'completed',
					sessionStatus: 'completed',
					message: 'Step has completed successfully.',
				});
			}

			// If no sub-session has been started yet, report not_started
			if (!stepTask.taskAgentSessionId) {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: stepTask.status,
					sessionStatus: 'not_started',
					message: 'Sub-session not yet started for this step. Call spawn_node_agent.',
				});
			}

			// Query the sub-session processing state.
			// The guard above ensures taskAgentSessionId is non-null here.
			const state = sessionFactory.getProcessingState(stepTask.taskAgentSessionId);
			if (!state) {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: stepTask.status,
					sessionStatus: 'unknown',
					message:
						'Sub-session state not available. ' +
						'The session may have ended or been cleaned up before the completion callback fired.',
				});
			}

			if (state.isComplete) {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: stepTask.status,
					sessionStatus: 'completed',
					error: state.error,
					message: state.error
						? `Sub-session ended with an error: ${state.error}`
						: 'Sub-session has completed. Waiting for completion callback to update task status.',
				});
			}

			return jsonResult({
				success: true,
				stepId,
				taskId: stepTask.id,
				taskStatus: stepTask.status,
				sessionStatus: state.isProcessing ? 'running' : 'idle',
				message: state.isProcessing
					? 'Sub-session is actively processing. Check back soon.'
					: 'Sub-session is idle (not currently processing). It may be waiting for input.',
			});
		},

		/**
		 * Report the final outcome of the task and close the task lifecycle.
		 *
		 * Updates the main SpaceTask status to one of:
		 *   completed        — task succeeded; summary records the result
		 *   needs_attention  — task requires human intervention; error describes the issue
		 *   cancelled        — task was cancelled
		 */
		async report_result(args: ReportResultInput): Promise<ToolResult> {
			const { status, summary, error: errorDetail } = args;

			const mainTask = taskRepo.getTask(taskId);
			if (!mainTask) {
				return jsonResult({ success: false, error: `Task not found: ${taskId}` });
			}

			try {
				await taskManager.setTaskStatus(taskId, status, {
					result: summary,
					error: errorDetail,
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
					const eventName = status === 'completed' ? 'space.task.completed' : 'space.task.failed';
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
		 * Explicitly mark the workflow run as completed.
		 *
		 * Use this tool when all node agents have finished and you are certain the
		 * overall workflow is done. It:
		 *   1. Validates the workflow run exists and is still in_progress
		 *   2. Marks the workflow run as completed (sets completedAt)
		 *   3. Marks the main task as completed via report_result logic
		 *   4. Emits a space.task.completed event so listeners are notified
		 *
		 * The SpaceRuntime tick loop will detect the completed run status on the next
		 * tick and emit a workflow_run_completed notification to the Space Agent.
		 */
		async report_workflow_done(args: ReportWorkflowDoneInput): Promise<ToolResult> {
			const { summary } = args;

			const run = workflowRunRepo.getRun(workflowRunId);
			if (!run) {
				return jsonResult({
					success: false,
					error: `Workflow run not found: ${workflowRunId}`,
				});
			}

			if (run.status !== 'in_progress') {
				return jsonResult({
					success: false,
					error:
						`Cannot mark workflow run as completed when status is "${run.status}". ` +
						`Workflow run must be in_progress.`,
					currentStatus: run.status,
				});
			}

			// Validate that all node agents have reached terminal status before
			// allowing an explicit workflow completion. This guards against the Task
			// Agent calling report_workflow_done prematurely while agents are still
			// running.
			if (completionDetector) {
				const wfDef = workflowManager.getWorkflow(run.workflowId);
				const channels = wfDef?.channels ?? [];
				const nodes = wfDef?.nodes ?? [];
				if (!completionDetector.isComplete(workflowRunId, channels, nodes)) {
					return jsonResult({
						success: false,
						error:
							'Not all node agents have reached a terminal state yet. ' +
							'Wait for all agents to complete (check via check_node_status) ' +
							'before calling report_workflow_done.',
					});
				}
			}

			const mainTask = taskRepo.getTask(taskId);
			if (!mainTask) {
				return jsonResult({ success: false, error: `Task not found: ${taskId}` });
			}

			try {
				// Mark the workflow run as completed — SpaceRuntime tick will detect this
				// and emit workflow_run_completed via the notification sink.
				workflowRunRepo.updateStatus(workflowRunId, 'completed');

				// Mark the main task as completed (mirrors report_result logic).
				await taskManager.setTaskStatus(taskId, 'completed', {
					result: summary,
				});

				// Emit DaemonHub event so the Space Agent is notified.
				if (daemonHub) {
					void daemonHub
						.emit('space.task.completed', {
							sessionId: 'global',
							taskId,
							spaceId: space.id,
							status: 'completed',
							summary: summary ?? '',
							workflowRunId,
							taskTitle: mainTask.title,
						})
						.catch((err) => {
							log.warn(
								`Failed to emit space.task.completed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
							);
						});
				}

				return jsonResult({
					success: true,
					workflowRunId,
					taskId,
					summary,
					message:
						'Workflow run has been marked as completed. ' +
						'The main task has also been closed. Stop here — do not call any further tools.',
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * List all members of the current task's session group.
		 *
		 * Returns every member (including the Task Agent itself) with:
		 *   - sessionId, role, agentId, status
		 *   - permittedTargets: roles this member can send to per channel topology
		 *   - completionState: task status and completion summary for this member's slot task
		 *
		 * Also returns nodeCompletionState — all tasks on the current node with their completion state.
		 *
		 * The channel topology is read from the active workflow run's config
		 * (`run.config._resolvedChannels` — stored by SpaceRuntime at step-start).
		 * If no channels are declared, `permittedTargets` is empty for all members.
		 *
		 * The Task Agent itself is listed as a member (role: 'task-agent').
		 */
		async list_group_members(_args: ListGroupMembersInput): Promise<ToolResult> {
			// Build ChannelResolver from the active workflow run's config
			const run = workflowRunRepo.getRun(workflowRunId);
			const resolver = ChannelResolver.fromRunConfig(
				run?.config as Record<string, unknown> | undefined
			);

			// Get all tasks for this workflow run with active sub-sessions
			const allRunTasks = taskRepo.listByWorkflowRun(workflowRunId);
			const activeTasks = allRunTasks.filter((t) => t.taskAgentSessionId);

			const members = activeTasks.map((t) => {
				const ts = t.status;
				const memberStatus =
					ts === 'completed'
						? 'completed'
						: ts === 'needs_attention' || ts === 'cancelled'
							? 'failed'
							: 'active';
				return {
					sessionId: t.taskAgentSessionId!,
					role: t.agentName ?? 'agent',
					agentId: t.customAgentId ?? null,
					status: memberStatus,
					permittedTargets: resolver.getPermittedTargets(t.agentName ?? 'agent'),
					completionState: {
						agentName: t.agentName ?? null,
						taskStatus: t.status,
						completionSummary: t.completionSummary ?? null,
						completedAt: t.completedAt ?? null,
					},
				};
			});

			const nodeCompletionState = allRunTasks.map((t) => ({
				agentName: t.agentName ?? null,
				taskStatus: t.status,
				completionSummary: t.completionSummary ?? null,
				completedAt: t.completedAt ?? null,
			}));

			return jsonResult({
				success: true,
				members,
				nodeCompletionState,
				channelTopologyDeclared: !resolver.isEmpty(),
				message:
					`Run has ${members.length} active member(s). ` +
					(resolver.isEmpty()
						? 'No channel topology declared.'
						: `Channel topology is active and enforced.`),
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
		 *   - `target: 'coder'` — point-to-point to a single role
		 *   - `target: '*'` — broadcast to all permitted targets
		 *   - `target: ['coder', 'reviewer']` — multicast to multiple roles
		 *
		 * The Task Agent's role is `'task-agent'`. Default bidirectional channels
		 * are auto-created between the Task Agent and all node agent roles at
		 * step-start, so the Task Agent can reach all peers by default.
		 */
		async send_message(args: SendMessageInput): Promise<ToolResult> {
			const { target, message } = args;

			const run = workflowRunRepo.getRun(workflowRunId);
			const resolver = ChannelResolver.fromRunConfig(
				run?.config as Record<string, unknown> | undefined
			);

			// When no channel topology is declared, all send_message calls fail.
			if (resolver.isEmpty()) {
				return jsonResult({
					success: false,
					error:
						`No channel topology declared for this step. ` +
						`Direct messaging via send_message is not available.`,
				});
			}

			// Resolve target roles from the target argument
			let targetRoles: string[];

			if (target === '*') {
				// Broadcast: expand to all permitted targets
				const permitted = resolver.getPermittedTargets('task-agent');
				if (permitted.length === 0) {
					return jsonResult({
						success: false,
						error:
							`No permitted targets for role 'task-agent' in the declared channel topology. ` +
							`Broadcast ('*') requires at least one permitted outgoing channel.`,
						availableTargets: [],
					});
				}
				targetRoles = permitted;
			} else if (Array.isArray(target)) {
				// Multicast: validate each requested role
				targetRoles = target;
			} else {
				// Point-to-point: single role
				targetRoles = [target];
			}

			// Validate all requested target roles against channel topology
			const unauthorizedRoles = targetRoles.filter((role) => !resolver.canSend('task-agent', role));
			if (unauthorizedRoles.length > 0) {
				const permittedTargets = resolver.getPermittedTargets('task-agent');
				return jsonResult({
					success: false,
					error:
						`Channel topology does not permit 'task-agent' to send to: ${unauthorizedRoles.join(', ')}. ` +
						`Permitted targets: ${permittedTargets.length > 0 ? permittedTargets.join(', ') : 'none'}.`,
					unauthorizedRoles,
					permittedTargets,
				});
			}

			// Find peer sessions via task repo (exclude tasks without sessions)
			const sendPeers = taskRepo
				.listByWorkflowRun(workflowRunId)
				.filter((t) => t.taskAgentSessionId)
				.map((t) => ({ sessionId: t.taskAgentSessionId!, role: t.agentName ?? 'agent' }));
			const delivered: Array<{ role: string; sessionId: string }> = [];
			const notFound: string[] = [];
			const failed: Array<{ role: string; sessionId: string; error: string }> = [];

			// Best-effort delivery: attempt all targets, aggregate errors.
			for (const targetRole of targetRoles) {
				const targetSessions = sendPeers.filter((m) => m.role === targetRole);
				if (targetSessions.length === 0) {
					notFound.push(targetRole);
					continue;
				}
				for (const targetMember of targetSessions) {
					const prefixedMessage = `[Message from task-agent]: ${message}`;
					try {
						await messageInjector(targetMember.sessionId, prefixedMessage);
						delivered.push({ role: targetRole, sessionId: targetMember.sessionId });
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						failed.push({ role: targetRole, sessionId: targetMember.sessionId, error: errMsg });
					}
				}
			}

			if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
				return jsonResult({
					success: false,
					error:
						`No active sessions found for target role(s): ${notFound.join(', ')}. ` +
						`Use list_group_members to check which peers are currently active.`,
					notFoundRoles: notFound,
				});
			}

			if (failed.length > 0) {
				return jsonResult({
					success: delivered.length > 0 ? 'partial' : false,
					delivered,
					failed,
					notFoundRoles: notFound.length > 0 ? notFound : undefined,
					message:
						delivered.length > 0
							? `Message delivered to ${delivered.length} peer(s) but failed for ${failed.length} peer(s).`
							: `Message delivery failed for all ${failed.length} target(s).`,
				});
			}

			return jsonResult({
				success: true,
				delivered,
				notFoundRoles: notFound.length > 0 ? notFound : undefined,
				message:
					`Message delivered to ${delivered.length} peer(s): ` +
					delivered.map((t) => `${t.role} (${t.sessionId})`).join(', ') +
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

			// Only transition to needs_attention from valid states.
			// Valid transitions: in_progress → needs_attention, review → needs_attention.
			const canTransition = mainTask.status === 'in_progress' || mainTask.status === 'review';

			if (!canTransition) {
				return jsonResult({
					success: false,
					error:
						`Cannot request human input when task status is "${mainTask.status}". ` +
						`Task must be in_progress or review.`,
				});
			}

			// The `error` field stores the full question + context for complete diagnostic context.
			// The `currentStep` field stores just the bare question for UI display — it is
			// intentionally shorter than `error` to fit the summary display in the task list.
			const questionWithContext = questionContext
				? `${question}\n\nContext: ${questionContext}`
				: question;

			try {
				await taskManager.setTaskStatus(taskId, 'needs_attention', {
					error: questionWithContext,
				});

				// Update currentStep to the bare question for visible UI display
				taskRepo.updateTask(taskId, { currentStep: question });

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
			'spawn_node_agent',
			"Start a sub-session for a workflow node's assigned agent. " +
				'Call this to execute each workflow step. ' +
				'Returns the session ID of the spawned sub-session.',
			SpawnNodeAgentSchema.shape,
			(args) => handlers.spawn_node_agent(args)
		),
		tool(
			'check_node_status',
			'Poll the status of a running node agent sub-session. ' +
				'Call this periodically after spawn_node_agent to detect when a step has completed.',
			CheckNodeStatusSchema.shape,
			(args) => handlers.check_node_status(args)
		),
		tool(
			'report_result',
			'Mark the task as completed, failed, or cancelled and record the result summary. ' +
				'Call this when the workflow reaches a terminal step or an unrecoverable error occurs.',
			ReportResultSchema.shape,
			(args) => handlers.report_result(args)
		),
		tool(
			'report_workflow_done',
			'Explicitly mark the entire workflow run as completed and close the main task. ' +
				'Call this when all node agents have finished and the workflow is fully done. ' +
				'This bypasses the automatic all-agents-done detector and immediately marks the run completed.',
			ReportWorkflowDoneSchema.shape,
			(args) => handlers.report_workflow_done(args)
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
			'List all members of the current task session group with their session IDs, roles, and permitted channels. ' +
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
	];

	return createSdkMcpServer({ name: 'task-agent', tools });
}

export type TaskAgentMcpServer = ReturnType<typeof createTaskAgentMcpServer>;
