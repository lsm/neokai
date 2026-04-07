/**
 * Task Agent Tools — MCP tool handlers for the Task Agent session.
 *
 * These handlers implement the business logic for the 6 Task Agent tools:
 *   spawn_node_agent      — Spawn a sub-session for a workflow node's assigned agent
 *   check_node_status     — Poll the status of a running node agent sub-session
 *   report_result         — Mark the task as completed/failed and record the result
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
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { resolveAgentInit, buildCustomAgentTaskMessage } from '../agents/custom-agent';
import type { ChannelRouter } from '../runtime/channel-router';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	ReportResultSchema,
	RequestHumanInputSchema,
	ListGroupMembersSchema,
} from './task-agent-tool-schemas';
import { SendMessageSchema } from './node-agent-tool-schemas';
import { resolveNodeAgents } from '@neokai/shared';
import type {
	SpawnNodeAgentInput,
	CheckNodeStatusInput,
	ReportResultInput,
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
	/** Agent slot name from WorkflowNodeAgent.name (e.g. 'coder', 'reviewer') */
	agentName?: string;
	/** Workflow node ID — used to link the sub-session to its NodeExecution record */
	nodeId?: string;
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
	/**
	 * Node execution repository for idempotency checks in spawn_node_agent and
	 * querying execution state in list_group_members.
	 * Optional — if omitted, falls back to SpaceTask-based lookups.
	 */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Agent manager for resolving node agents. */
	agentManager: SpaceAgentManager;
	/** Task manager for validated status transitions. */
	taskManager: SpaceTaskManager;
	/** Sub-session factory for creating and querying agent sub-sessions. */
	sessionFactory: SubSessionFactory;
	/**
	 * Injects a message into an existing sub-session as a user turn.
	 * Called after spawn to deliver the node's task context message.
	 */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Called by the completion mechanism when a sub-session finishes.
	 * Provided by the TaskAgentManager; updates the node's SpaceTask to `completed`.
	 * The Task Agent handler registers this as the session completion callback.
	 */
	onSubSessionComplete: (nodeId: string, sessionId: string) => Promise<void>;
	/**
	 * DaemonHub instance for emitting task completion/failure events.
	 * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
	 */
	daemonHub?: DaemonHub;
	/**
	 * Factory to build a node agent MCP server for a spawned sub-session.
	 * Called in `spawn_node_agent` after resolving the session ID and agent name.
	 * Returns a McpServerConfig to attach to the sub-session's init.mcpServers.
	 * Optional — if omitted, no node agent MCP server is attached (e.g. in unit tests).
	 *
	 * @param sessionId   - The sub-session ID being started.
	 * @param agentName   - The agent slot name (used for channel routing).
	 * @param nodeTaskId  - The SpaceTask ID for this node (used by report_done).
	 */
	buildNodeAgentMcpServer?: (
		sessionId: string,
		agentName: string,
		nodeTaskId: string
	) => McpServerConfig;
	/**
	 * Channel router for gate-checked message routing between agents.
	 * When provided, the send_message tool uses it for channel validation and
	 * lazy node activation instead of constructing a ChannelResolver from run config.
	 * Optional — existing ChannelResolver-based routing is used as fallback.
	 */
	channelRouter?: ChannelRouter;
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
		nodeExecutionRepo,
		agentManager,
		taskManager,
		sessionFactory,
		messageInjector,
		onSubSessionComplete,
		daemonHub,
		buildNodeAgentMcpServer,
	} = config;

	return {
		/**
		 * Spawn a sub-session for a workflow node's assigned agent.
		 *
		 * Flow:
		 * 1. Validate the workflow run and workflow definition
		 * 2. Find the node by node_id in the workflow
		 * 3. Find the pending SpaceTask created by the WorkflowExecutor for this node
		 * 4. Resolve the agent session init via resolveAgentInit()
		 * 5. Create the sub-session via sessionFactory.create()
		 * 6. Register completion callback (onSubSessionComplete) via sessionFactory.onComplete()
		 * 7. Record the sub-session ID on the node task (BEFORE message injection, so
		 *    check_node_status can track the session even if injection later fails)
		 * 8. Transition main task from pending → in_progress if not already in_progress
		 * 9. Build and inject the task context message via messageInjector
		 *    (non-fatal if injection fails — sub-session is already running and trackable)
		 */
		async spawn_node_agent(args: SpawnNodeAgentInput): Promise<ToolResult> {
			const { node_id, instructions } = args;

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

			// Find the node
			const node = workflow.nodes.find((s) => s.id === node_id);
			if (!node) {
				return jsonResult({
					success: false,
					error: `Node not found: ${node_id} in workflow ${run.workflowId}`,
				});
			}

			// Resolve agent slots and member role early — needed for NodeExecution idempotency check.
			// Use resolveNodeAgents to get the agent list for this node.
			const nodeAgents = resolveNodeAgents(node);
			const primaryAgentId = nodeAgents[0]?.agentId;

			// Find the WorkflowNodeAgent slot for this node.
			// Use the first slot as the primary agent.
			const agentSlot = nodeAgents[0];

			// Use the slot's name (WorkflowNodeAgent.name) for channel routing and group membership.
			// Falls back to 'agent' if not available.
			const agentForMemberEarly = primaryAgentId ? agentManager.getById(primaryAgentId) : null;
			const memberRole = agentSlot?.name ?? agentForMemberEarly?.name ?? 'agent';

			// Idempotency guard: if a NodeExecution for this agent already has an agentSessionId,
			// return it without creating a duplicate. Prevents double-spawning from orphaning
			// the first session when the Task Agent retries a spawn_node_agent call.
			if (nodeExecutionRepo) {
				const existingExec = nodeExecutionRepo
					.listByNode(workflowRunId, node_id)
					.find((e) => e.agentName === memberRole);
				if (existingExec?.agentSessionId) {
					return jsonResult({
						success: true,
						sessionId: existingExec.agentSessionId,
						nodeId: node_id,
						nodeName: node.name,
						alreadySpawned: true,
					});
				}
			}

			// Find the pending task for this node (created when the workflow node was activated).
			// Task-to-node mapping uses title matching since workflowNodeId is no longer on SpaceTask.
			// Build the set of expected task titles from the node definition:
			// - Single-agent nodes: title = node.name
			// - Multi-agent nodes: titles = agents[].name (per-agent names)
			const allRunTasks = taskRepo.listByWorkflowRun(workflowRunId);
			const agentSlots = resolveNodeAgents(node);
			const expectedTitles = agentSlots.length > 1 ? agentSlots.map((a) => a.name) : [node.name];
			const titleSet = new Set(expectedTitles);
			const nodeTasks = allRunTasks.filter(
				(t) => titleSet.has(t.title) || t.title.includes(node.name) || t.title.includes(node_id)
			);
			if (nodeTasks.length === 0) {
				return jsonResult({
					success: false,
					error:
						`No task found for node "${node.name}" (id: ${node_id}). ` +
						`The node task may not have been created yet — check that the workflow run is active.`,
				});
			}

			// Use the most recently created task for this node.
			const nodeTask = nodeTasks[nodeTasks.length - 1];

			// Fallback idempotency guard via SpaceTask (when nodeExecutionRepo is unavailable).
			if (!nodeExecutionRepo && nodeTask.taskAgentSessionId) {
				return jsonResult({
					success: true,
					sessionId: nodeTask.taskAgentSessionId,
					nodeId: node_id,
					nodeName: node.name,
					taskId: nodeTask.id,
					alreadySpawned: true,
				});
			}

			// Build effectiveTask with optional instruction override
			const effectiveTask = instructions ? { ...nodeTask, description: instructions } : nodeTask;

			// Extract slot-level overrides when present.
			const slotOverrides: import('../agents/custom-agent').SlotOverrides = {
				model: agentSlot?.model,
				systemPrompt: agentSlot?.systemPrompt,
				instructions: agentSlot?.instructions,
			};

			// Generate a new session ID for the sub-session.
			// Note: the factory may assign a different ID internally. All subsequent code
			// uses `actualSessionId` returned by sessionFactory.create(), not subSessionId.
			// The subSessionId is embedded in the init only so the SDK can pre-wire it.
			const subSessionId = randomUUID();

			// Resolve the agent session init, applying per-slot overrides when present.
			if (!primaryAgentId) {
				return jsonResult({ success: false, error: `No agent assigned to node "${node.name}"` });
			}
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
					agentId: primaryAgentId,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: `Failed to resolve agent init: ${message}` });
			}

			// Attach node agent peer communication MCP server if a factory is provided.
			// The server is built with the slot role so it can validate channels using the
			// same role that was registered in the session group.
			// Pass nodeTask.id so report_done can mark the correct node task as completed.
			if (buildNodeAgentMcpServer) {
				const nodeMcpServer = buildNodeAgentMcpServer(subSessionId, memberRole, nodeTask.id);
				init = {
					...init,
					mcpServers: { ...init.mcpServers, 'node-agent': nodeMcpServer },
				};
			}

			// Create and start the sub-session
			let actualSessionId: string;
			try {
				actualSessionId = await sessionFactory.create(init, {
					agentId: primaryAgentId,
					agentName: memberRole,
					nodeId: node_id,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: `Failed to create sub-session: ${message}` });
			}

			// Register the completion callback — fires when the sub-session finishes.
			sessionFactory.onComplete(actualSessionId, async () => {
				await onSubSessionComplete(node_id, actualSessionId);
			});

			// Record the sub-session ID on the node task BEFORE message injection.
			// This ensures check_node_status can locate and track the session even if
			// the subsequent message injection fails.
			taskRepo.updateTask(nodeTask.id, {
				taskAgentSessionId: actualSessionId,
			});

			// Transition main task from open → in_progress (first node spawn)
			const mainTask = taskRepo.getTask(taskId);
			if (mainTask && mainTask.status === 'open') {
				try {
					await taskManager.setTaskStatus(taskId, 'in_progress');
				} catch {
					// Non-fatal — task may have already been transitioned elsewhere
				}
			}

			// Build the task context message and inject it into the sub-session.
			// This is non-fatal: if injection fails the sub-session still runs (and is
			// already trackable via taskAgentSessionId recorded above), just without its
			// initial task context. Return success with a warning field so the Task Agent
			// can still poll check_node_status.
			try {
				// resolveAgentInit() already validated that the agent exists, so this
				// getById() call should always succeed. If it somehow returns null after
				// resolveAgentInit() passed, that is a data inconsistency worth surfacing.
				const agent = agentManager.getById(primaryAgentId);
				if (!agent) {
					return jsonResult({
						success: true,
						sessionId: actualSessionId,
						nodeId: node_id,
						nodeName: node.name,
						taskId: nodeTask.id,
						warning:
							`Agent ${primaryAgentId} not found when building task message — ` +
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
					slotOverrides,
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
					nodeId: node_id,
					nodeName: node.name,
					taskId: nodeTask.id,
					warning: `Message injection failed: ${message}. Sub-session is running without initial task context.`,
				});
			}

			return jsonResult({
				success: true,
				sessionId: actualSessionId,
				nodeId: node_id,
				nodeName: node.name,
				taskId: nodeTask.id,
			});
		},

		/**
		 * Check the processing state of a node's sub-session.
		 *
		 * This is the primary mechanism for the Task Agent to detect sub-session completion.
		 * The Task Agent polls this tool after spawning a node agent.
		 *
		 * If node_id is omitted, checks the workflow run's current node.
		 * Returns status = 'completed' when the node task has been marked completed in the DB
		 * (which happens via the completion callback registered in spawn_node_agent).
		 */
		async check_node_status(args: CheckNodeStatusInput): Promise<ToolResult> {
			// node_id is required — no fallback to currentNodeId (field removed in migration 59)
			const nodeId = args.node_id;
			if (!nodeId) {
				return jsonResult({
					success: false,
					error: 'node_id is required. Call spawn_node_agent first and pass the node_id.',
				});
			}

			// Find task(s) for this node (filter by expected task titles, node name, or node ID).
			// Matches the same logic as spawn_node_agent: for multi-agent nodes, expected
			// task titles are per-agent names; for single-agent nodes, it's the node name.
			const allNodeTasks = taskRepo.listByWorkflowRun(workflowRunId);
			const workflow = workflowManager.getWorkflow(
				workflowRunRepo.getRun(workflowRunId)?.workflowId ?? ''
			);
			const targetNode = workflow?.nodes.find((n) => n.id === nodeId);
			let titleSet: Set<string> | undefined;
			if (targetNode) {
				const agentSlots = resolveNodeAgents(targetNode);
				titleSet = new Set(
					agentSlots.length > 1 ? agentSlots.map((a) => a.name) : [targetNode.name]
				);
			}
			const nodeTasks = allNodeTasks.filter(
				(t) =>
					(titleSet && titleSet.has(t.title)) ||
					(targetNode && t.title.includes(targetNode.name)) ||
					t.title.includes(nodeId)
			);

			if (nodeTasks.length === 0) {
				return jsonResult({
					success: true,
					nodeId,
					taskStatus: 'not_found',
					sessionStatus: 'not_started',
					message: 'No task found for this node. Has spawn_node_agent been called?',
				});
			}

			const nodeTask = nodeTasks[nodeTasks.length - 1];

			// Fast path: task already marked done by the completion callback
			if (nodeTask.status === 'done') {
				return jsonResult({
					success: true,
					nodeId,
					taskId: nodeTask.id,
					taskStatus: 'done',
					sessionStatus: 'completed',
					message: 'Node has completed successfully.',
				});
			}

			// If no sub-session has been started yet, report not_started
			if (!nodeTask.taskAgentSessionId) {
				return jsonResult({
					success: true,
					nodeId,
					taskId: nodeTask.id,
					taskStatus: nodeTask.status,
					sessionStatus: 'not_started',
					message: 'Sub-session not yet started for this node. Call spawn_node_agent.',
				});
			}

			// Query the sub-session processing state.
			// The guard above ensures taskAgentSessionId is non-null here.
			const state = sessionFactory.getProcessingState(nodeTask.taskAgentSessionId);
			if (!state) {
				return jsonResult({
					success: true,
					nodeId,
					taskId: nodeTask.id,
					taskStatus: nodeTask.status,
					sessionStatus: 'unknown',
					message:
						'Sub-session state not available. ' +
						'The session may have ended or been cleaned up before the completion callback fired.',
				});
			}

			if (state.isComplete) {
				return jsonResult({
					success: true,
					nodeId,
					taskId: nodeTask.id,
					taskStatus: nodeTask.status,
					sessionStatus: 'completed',
					error: state.error,
					message: state.error
						? `Sub-session ended with an error: ${state.error}`
						: 'Sub-session has completed. Waiting for completion callback to update task status.',
				});
			}

			return jsonResult({
				success: true,
				nodeId,
				taskId: nodeTask.id,
				taskStatus: nodeTask.status,
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
					execStatus === 'done'
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
	];

	return createSdkMcpServer({ name: 'task-agent', tools });
}

export type TaskAgentMcpServer = ReturnType<typeof createTaskAgentMcpServer>;
