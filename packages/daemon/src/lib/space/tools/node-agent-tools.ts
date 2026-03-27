/**
 * Node Agent Tools — MCP tool handlers for node agent sub-sessions.
 *
 * These handlers implement peer communication tools for node agents within
 * the same workflow step group:
 *
 *   list_peers   — discover other group members with roles and permitted channels
 *   send_message — primary channel-validated direct messaging tool
 *   report_done  — signal that this agent has completed its step task
 *
 * Communication model:
 * - Node agents communicate via declared channel topology (`send_message`).
 * - `list_peers` reveals who is in the group and what channels are available.
 *
 * Channel topology patterns supported:
 *   - Bidirectional point-to-point: A↔B (both directions permitted)
 *   - One-way: A→B (only A can send to B)
 *   - Fan-out one-way: hub→[spoke1, spoke2, ...]
 *   - Hub-spoke: hub↔spokes (hub sends to all, spokes only reply to hub)
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `NodeAgentToolsConfig`.
 * - `messageInjector` is backed by `injectSubSessionMessage` → `injectMessageIntoSession`
 *   → `session.messageQueue.enqueueWithId()`, which provides per-session write ordering.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonHub } from '../../daemon-hub';
import { Logger } from '../../logger';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { ChannelResolver } from '../runtime/channel-resolver';
import { evaluateGate } from '../runtime/gate-evaluator';
import type { AgentMessageRouter } from '../runtime/agent-message-router';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { SpaceWorkflow } from '@neokai/shared';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	ListPeersSchema,
	SendMessageSchema,
	ReportDoneSchema,
	ListReachableAgentsSchema,
	ListChannelsSchema,
	ListGatesSchema,
	ReadGateSchema,
	WriteGateSchema,
} from './node-agent-tool-schemas';
import type {
	ListPeersInput,
	SendMessageInput,
	ReportDoneInput,
	ListReachableAgentsInput,
	ListChannelsInput,
	ListGatesInput,
	ReadGateInput,
	WriteGateInput,
} from './node-agent-tool-schemas';

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('node-agent-tools');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createNodeAgentToolHandlers().
 * All fields are required unless noted — the caller (TaskAgentManager) wires them up.
 */
export interface NodeAgentToolsConfig {
	/** Session ID of this node agent (used to exclude self from list_peers). */
	mySessionId: string;
	/** Role of this node agent (e.g., 'coder', 'reviewer'). */
	myRole: string;
	/** ID of the parent task (used for error messages). */
	taskId: string;
	/** ID of the step-level SpaceTask this agent is executing. Used by report_done. */
	stepTaskId: string;
	/** Space ID — used for event emission in report_done. */
	spaceId: string;
	/**
	 * Pre-built channel resolver for this sub-session's topology.
	 * Created by TaskAgentManager at session spawn time from the workflow run config.
	 * An empty resolver (no channels) means send_message is unavailable for this session.
	 */
	channelResolver: ChannelResolver;
	/** Workflow run ID — used with spaceTaskRepo to query node completion state. */
	workflowRunId: string;
	/** Space task repository for querying completion state. */
	spaceTaskRepo: SpaceTaskRepository;
	/** Workflow node ID — used to query peer tasks on the same node. */
	workflowNodeId: string;
	/**
	 * Injects a message into a peer sub-session as a user turn.
	 * Used by `send_message` to deliver messages to target sessions.
	 */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/** Task manager for validated status transitions. Used by report_done. */
	taskManager: SpaceTaskManager;
	/**
	 * DaemonHub instance for emitting task update events.
	 * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
	 */
	daemonHub?: DaemonHub;
	/**
	 * Optional AgentMessageRouter for unified message delivery.
	 * When provided, send_message delegates all routing to AgentMessageRouter.
	 * When absent, legacy topology-based routing is used directly.
	 * TODO: Remove legacy path once TaskAgentManager injects AgentMessageRouter for all sub-sessions.
	 */
	agentMessageRouter?: AgentMessageRouter;
	/**
	 * Workflow definition for this task.
	 * Used by list_channels, list_gates, read_gate, write_gate to access channel and
	 * gate definitions. Null when the task has no workflow assigned.
	 */
	workflow: SpaceWorkflow | null;
	/**
	 * Gate data repository for reading and writing gate runtime data.
	 * Used by list_gates, read_gate, write_gate.
	 */
	gateDataRepo: GateDataRepository;
	/**
	 * Callback invoked after a gate data write to trigger re-evaluation and
	 * potential lazy node activation for any channels referencing the changed gate.
	 *
	 * Called by `write_gate` after every successful data merge (fire-and-forget).
	 * When provided, blocked target nodes are auto-activated the moment their gate
	 * condition is satisfied — enabling vote-counting and push-on-write semantics.
	 * When absent, nodes are activated at the next `deliverMessage` call instead.
	 */
	onGateDataChanged?: (runId: string, gateId: string) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions for the node agent peer communication tools.
 * Returns a map of tool name → async handler function.
 */
export function createNodeAgentToolHandlers(config: NodeAgentToolsConfig) {
	const {
		mySessionId,
		myRole,
		taskId,
		stepTaskId,
		spaceId,
		channelResolver,
		workflowRunId,
		spaceTaskRepo,
		workflowNodeId,
		messageInjector,
		taskManager,
		daemonHub,
		agentMessageRouter,
		workflow,
		gateDataRepo,
		onGateDataChanged,
	} = config;

	return {
		/**
		 * List all peers (other group members) with their roles, statuses, session IDs,
		 * permitted channel connections, and completion state from space_tasks.
		 *
		 * Does NOT include self (filtered by `mySessionId`).
		 * Does NOT include the Task Agent (filtered by role 'task-agent').
		 *
		 * Returns permittedTargets: roles this agent can directly send to via send_message.
		 * Returns completionState per peer: task status, completion summary, and completedAt.
		 * Returns nodeCompletionState: all tasks on this workflow node with their completion state.
		 */
		async list_peers(_args: ListPeersInput): Promise<ToolResult> {
			// Load all tasks on this workflow node from the DB
			const nodeTasks =
				workflowRunId && workflowNodeId
					? spaceTaskRepo
							.listByWorkflowRun(workflowRunId)
							.filter((t) => t.workflowNodeId === workflowNodeId)
					: [];

			const resolver = channelResolver;

			// Build peers from all node tasks, excluding self and task-agent.
			// Includes completed tasks (taskAgentSessionId may be null) so callers
			// can see completion state even after the peer session has ended.
			// Tasks with no session are excluded unless they are completed (post-session completion).
			const peers = nodeTasks
				.filter(
					(t) =>
						t.agentName !== 'task-agent' &&
						t.taskAgentSessionId !== mySessionId &&
						(t.taskAgentSessionId != null || t.status === 'completed')
				)
				.map((t) => {
					const taskStatus = t.status;
					const memberStatus =
						taskStatus === 'completed'
							? ('completed' as const)
							: taskStatus === 'needs_attention' || taskStatus === 'cancelled'
								? ('failed' as const)
								: ('active' as const);
					return {
						sessionId: t.taskAgentSessionId ?? null,
						role: t.agentName ?? 'agent',
						agentId: t.customAgentId ?? null,
						status: memberStatus,
						completionState: {
							agentName: t.agentName ?? null,
							taskStatus: t.status,
							completionSummary: t.completionSummary ?? null,
							completedAt: t.completedAt ?? null,
						},
					};
				});

			const nodeCompletionState = nodeTasks.map((t) => ({
				agentName: t.agentName ?? null,
				taskStatus: t.status,
				completionSummary: t.completionSummary ?? null,
				completedAt: t.completedAt ?? null,
			}));

			const permittedTargets = resolver.getPermittedTargets(myRole);
			const channelTopologyDeclared = !resolver.isEmpty();

			return jsonResult({
				success: true,
				myRole,
				peers,
				nodeCompletionState,
				permittedTargets,
				channelTopologyDeclared,
				message:
					`Found ${peers.length} peer(s). ` +
					(channelTopologyDeclared
						? `Permitted direct targets via send_message: ${permittedTargets.length > 0 ? permittedTargets.join(', ') : 'none'}.`
						: 'No channel topology declared.'),
			});
		},

		/**
		 * Send a message to a peer agent by name (DM), a node by name (fan-out),
		 * or broadcast to all permitted targets.
		 *
		 * When a AgentMessageRouter is configured, delegates all routing to it.
		 * Otherwise uses legacy topology-based routing directly.
		 *
		 * Validates against declared channel topology — returns an error with
		 * available targets if not permitted.
		 */
		async send_message(args: SendMessageInput): Promise<ToolResult> {
			const { target, message, data } = args;

			// --- New path: delegate to AgentMessageRouter when available ---
			if (agentMessageRouter) {
				const result = await agentMessageRouter.deliverMessage({
					fromRole: myRole,
					fromSessionId: mySessionId,
					target,
					message,
					data,
				});

				if (!result.success) {
					return jsonResult({
						success: false,
						error: result.reason ?? 'Message delivery failed.',
						delivered: result.delivered.length > 0 ? result.delivered : undefined,
						failed: result.failed.length > 0 ? result.failed : undefined,
						unauthorizedRoles: result.unauthorizedRoles,
						permittedTargets: result.permittedTargets,
						notFoundRoles: result.notFoundRoles,
					});
				}

				if (result.success === 'partial') {
					return jsonResult({
						success: 'partial',
						delivered: result.delivered,
						failed: result.failed,
						notFoundRoles: result.notFoundRoles,
						message: `Message delivered to ${result.delivered.length} peer(s) but failed for ${result.failed.length} peer(s).`,
					});
				}

				return jsonResult({
					success: true,
					delivered: result.delivered,
					notFoundRoles: result.notFoundRoles,
					message:
						`Message delivered to ${result.delivered.length} peer(s): ` +
						result.delivered.map((t) => `${t.role} (${t.sessionId})`).join(', ') +
						'.',
				});
			}

			// --- Legacy path: direct topology-based routing (no ChannelRouter injected) ---
			const resolver = channelResolver;

			if (resolver.isEmpty()) {
				return jsonResult({
					success: false,
					error:
						'No channel topology declared for this step. ' +
						'Direct messaging via send_message is not available.',
				});
			}

			// Resolve target roles
			let targetRoles: string[];

			if (target === '*') {
				const permitted = resolver.getPermittedTargets(myRole);
				if (permitted.length === 0) {
					return jsonResult({
						success: false,
						error:
							`No permitted targets for role '${myRole}' in the declared channel topology. ` +
							`Broadcast ('*') requires at least one permitted outgoing channel.`,
						availableTargets: [],
					});
				}
				targetRoles = permitted;
			} else if (Array.isArray(target)) {
				targetRoles = target;
			} else {
				targetRoles = [target];
			}

			// Validate authorization
			const unauthorizedRoles = targetRoles.filter((role) => !resolver.canSend(myRole, role));
			if (unauthorizedRoles.length > 0) {
				const permittedTargets = resolver.getPermittedTargets(myRole);
				return jsonResult({
					success: false,
					error:
						`Channel topology does not permit '${myRole}' to send to: ${unauthorizedRoles.join(', ')}. ` +
						`Permitted targets: ${permittedTargets.length > 0 ? permittedTargets.join(', ') : 'none'}.`,
					unauthorizedRoles,
					permittedTargets,
				});
			}

			// Find peer sessions via task repo
			const legacyNodeTasks =
				workflowRunId && workflowNodeId
					? spaceTaskRepo
							.listByWorkflowRun(workflowRunId)
							.filter((t) => t.workflowNodeId === workflowNodeId && t.taskAgentSessionId)
					: [];
			const peers = legacyNodeTasks
				.filter((t) => t.taskAgentSessionId !== mySessionId)
				.map((t) => ({ sessionId: t.taskAgentSessionId!, role: t.agentName ?? 'agent' }));
			const delivered: Array<{ role: string; sessionId: string }> = [];
			const notFound: string[] = [];
			const failed: Array<{ role: string; sessionId: string; error: string }> = [];

			for (const targetRole of targetRoles) {
				const targetSessions = peers.filter((m) => m.role === targetRole);
				if (targetSessions.length === 0) {
					notFound.push(targetRole);
					continue;
				}
				for (const targetMember of targetSessions) {
					// Include structured data as a JSON appendix when present
					const dataAppendix =
						data && Object.keys(data).length > 0
							? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
							: '';
					const prefixedMessage = `[Message from ${myRole}]: ${message}${dataAppendix}`;
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
						`Use list_peers to check which peers are currently active.`,
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
		 * List all agents and nodes this agent can reach, grouped as:
		 *   - withinNodePeers: agents in the same workflow node (current group members)
		 *   - crossNodeTargets: agents/nodes reachable via declared cross-node paths
		 *
		 * Uses agent-friendly terminology — no mention of channels or policies.
		 * Gate status is included for cross-node targets so agents know whether
		 * a target may require conditions to be met before delivery is permitted.
		 *
		 * Does NOT include self or the task-agent coordinator.
		 */
		async list_reachable_agents(_args: ListReachableAgentsInput): Promise<ToolResult> {
			const resolver = channelResolver;

			// Load peer tasks from DB
			const reachableNodeTasks =
				workflowRunId && workflowNodeId
					? spaceTaskRepo
							.listByWorkflowRun(workflowRunId)
							.filter((t) => t.workflowNodeId === workflowNodeId && t.taskAgentSessionId)
					: [];

			// Within-node peers: tasks on this node excluding self
			const withinNodePeers = reachableNodeTasks
				.filter((t) => t.taskAgentSessionId !== mySessionId)
				.map((t) => {
					const ts = t.status;
					return {
						agentName: t.agentName ?? 'agent',
						status:
							ts === 'completed'
								? ('completed' as const)
								: ts === 'needs_attention' || ts === 'cancelled'
									? ('failed' as const)
									: ('active' as const),
					};
				});

			const reachabilityDeclared = !resolver.isEmpty();

			// Cross-node targets: outgoing channel entries where the target role is NOT
			// already in the current node tasks (i.e., it lives on a different node).
			const withinNodeRoles = new Set(reachableNodeTasks.map((t) => t.agentName ?? 'agent'));

			type CrossNodeTarget = {
				agentName: string;
				isFanOut: boolean;
				gate: { type: string; isGated: boolean; description?: string };
			};
			const crossNodeTargets: CrossNodeTarget[] = [];

			if (reachabilityDeclared) {
				const seen = new Set<string>();
				for (const ch of resolver.getResolvedChannels()) {
					if (ch.fromRole !== myRole) continue;
					if (withinNodeRoles.has(ch.toRole)) continue; // within-node — already listed above
					if (seen.has(ch.toRole)) continue; // deduplicate (e.g. bidirectional split)
					seen.add(ch.toRole);

					const gate = ch.gate;
					const gateType = gate?.type ?? 'none';
					// A gate is "blocking" (isGated) when a condition must be evaluated at delivery
					// time — i.e. anything other than no gate at all or an 'always' gate.
					const isGated = gate !== undefined && gate.type !== 'always' && gate.type !== undefined;
					const entry: CrossNodeTarget = {
						agentName: ch.toRole,
						isFanOut: ch.isFanOut ?? false,
						gate: { type: gateType, isGated },
					};
					if (gate?.description) {
						entry.gate.description = gate.description;
					}
					crossNodeTargets.push(entry);
				}
			}

			const totalReachable = withinNodePeers.length + crossNodeTargets.length;
			const crossNodeSummary =
				crossNodeTargets.length > 0
					? ` Cross-node targets: ${crossNodeTargets.map((t) => t.agentName).join(', ')}.`
					: '';

			return jsonResult({
				success: true,
				myAgentName: myRole,
				withinNodePeers,
				crossNodeTargets,
				reachabilityDeclared,
				message:
					`You can reach ${totalReachable} agent(s) in total. ` +
					`Within-node peers: ${withinNodePeers.length > 0 ? withinNodePeers.map((p) => p.agentName).join(', ') : 'none'}.` +
					crossNodeSummary,
			});
		},

		/**
		 * List all channels declared in this workflow.
		 *
		 * Returns the messaging topology for the current workflow run —
		 * channels define which agents can communicate and whether a gate
		 * guards the channel. Use this to understand the full channel map
		 * before calling list_reachable_agents or send_message.
		 *
		 * A channel can be gated via:
		 * - `gateId` (new separated architecture, M1.1): references a Gate entity
		 *   in `workflow.gates`; use `list_gates` to see current gate data and status.
		 * - `gate` (legacy inline condition): an inline WorkflowCondition object.
		 * `hasGate` is true when either path is set.
		 */
		async list_channels(_args: ListChannelsInput): Promise<ToolResult> {
			const channels = workflow?.channels ?? [];
			const result = channels.map((ch) => ({
				channelId: ch.id ?? null,
				from: ch.from,
				to: ch.to,
				direction: ch.direction,
				isCyclic: ch.isCyclic ?? false,
				label: ch.label ?? null,
				// True when the channel is gated via either the new gateId reference
				// or the legacy inline gate condition.
				hasGate: ch.gate !== undefined || ch.gateId !== undefined,
				// Gate ID for new-architecture channels; null for legacy inline gates.
				gateId: ch.gateId ?? null,
			}));
			return jsonResult({
				success: true,
				channels: result,
				total: result.length,
				message: `Found ${result.length} channel(s) in workflow "${workflow?.name ?? 'unknown'}".`,
			});
		},

		/**
		 * List all gates declared in this workflow with their current runtime data.
		 *
		 * Gates guard channels — a message on a gated channel is held until the
		 * gate condition passes. Use this to understand what conditions are
		 * currently evaluated and what data has been written to each gate.
		 *
		 * Your nodeId is included in the response — use it as the map key when
		 * writing to count-condition gates (vote gates) so each node's vote
		 * counts exactly once.
		 */
		async list_gates(_args: ListGatesInput): Promise<ToolResult> {
			const gates = workflow?.gates ?? [];
			const gateResults = gates.map((gate) => {
				const record = gateDataRepo.get(workflowRunId, gate.id);
				return {
					gateId: gate.id,
					condition: gate.condition,
					description: gate.description ?? null,
					allowedWriterRoles: gate.allowedWriterRoles,
					currentData: record?.data ?? gate.data,
				};
			});
			return jsonResult({
				success: true,
				gates: gateResults,
				total: gateResults.length,
				nodeId: workflowNodeId,
				message:
					`Found ${gateResults.length} gate(s). ` +
					`Your nodeId is "${workflowNodeId}" — use it as the map key for vote-counting (count condition) gates.`,
			});
		},

		/**
		 * Read the current runtime data for a specific gate.
		 *
		 * Returns the live data from the gate_data table for this workflow run.
		 * Use this to inspect the current state of a gate before deciding
		 * whether to write to it.
		 */
		async read_gate(args: ReadGateInput): Promise<ToolResult> {
			const { gateId } = args;

			// Verify gate exists in this workflow
			const gates = workflow?.gates ?? [];
			const gateDef = gates.find((g) => g.id === gateId);
			if (!gateDef) {
				return jsonResult({
					success: false,
					error: `Gate "${gateId}" not found in this workflow.`,
					availableGateIds: gates.map((g) => g.id),
				});
			}

			const record = gateDataRepo.get(workflowRunId, gateId);
			const currentData = record?.data ?? gateDef.data;

			// Evaluate current gate status
			const evalResult = evaluateGate({ ...gateDef, data: currentData });

			return jsonResult({
				success: true,
				gateId,
				data: currentData,
				gateOpen: evalResult.open,
				reason: evalResult.reason ?? null,
				updatedAt: record?.updatedAt ?? null,
				message: evalResult.open
					? `Gate "${gateId}" is currently OPEN.`
					: `Gate "${gateId}" is currently CLOSED: ${evalResult.reason ?? 'condition not met'}.`,
			});
		},

		/**
		 * Write data to a gate's runtime data store (merge semantics).
		 *
		 * Authorization: your role must be in the gate's allowedWriterRoles,
		 * or the list must contain '*' (allow all).
		 *
		 * Merge semantics: top-level keys in `data` overwrite existing entries.
		 * Nested objects are replaced wholesale (not deep-merged).
		 *
		 * For vote-counting gates (count conditions), use your nodeId as the
		 * map key so each node counts only once. Your nodeId is returned in the JSON response.
		 *
		 * Writing triggers gate re-evaluation — the response includes whether
		 * the gate is now open so you know if the gated channel is unblocked.
		 */
		async write_gate(args: WriteGateInput): Promise<ToolResult> {
			const { gateId, data } = args;

			// Verify gate exists in this workflow
			const gates = workflow?.gates ?? [];
			const gateDef = gates.find((g) => g.id === gateId);
			if (!gateDef) {
				return jsonResult({
					success: false,
					error: `Gate "${gateId}" not found in this workflow.`,
					availableGateIds: gates.map((g) => g.id),
				});
			}

			// Authorization check
			const allowed = gateDef.allowedWriterRoles;
			const isAuthorized = allowed.includes('*') || allowed.includes(myRole);
			if (!isAuthorized) {
				return jsonResult({
					success: false,
					error:
						`Role "${myRole}" is not authorized to write to gate "${gateId}". ` +
						`Allowed writer roles: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}.`,
					allowedWriterRoles: allowed,
					myRole,
				});
			}

			// Merge data into gate_data table
			const updated = gateDataRepo.merge(workflowRunId, gateId, data);

			// Re-evaluate gate with updated data
			const evalResult = evaluateGate({ ...gateDef, data: updated.data });

			// Trigger re-evaluation and lazy node activation for channels referencing
			// this gate (fire-and-forget — response is not delayed waiting for activation).
			if (onGateDataChanged) {
				void onGateDataChanged(workflowRunId, gateId).catch((err) => {
					log.warn(
						`onGateDataChanged failed for gate "${gateId}" in run "${workflowRunId}":`,
						err instanceof Error ? err.message : String(err)
					);
				});
			}

			return jsonResult({
				success: true,
				gateId,
				updatedData: updated.data,
				gateOpen: evalResult.open,
				reason: evalResult.reason ?? null,
				nodeId: workflowNodeId,
				message: evalResult.open
					? `Gate "${gateId}" is now OPEN — gated channel(s) are unblocked.`
					: `Gate "${gateId}" is still CLOSED after write: ${evalResult.reason ?? 'condition not met'}.`,
			});
		},

		/**
		 * Signal that this node agent has completed its work.
		 *
		 * Marks the step's SpaceTask as 'completed', persists the optional summary
		 * as the task result, and emits a `space.task.updated` event for real-time UI.
		 *
		 * After calling this tool, the node agent should stop and not perform
		 * further work — the task lifecycle is closed.
		 */
		async report_done(args: ReportDoneInput): Promise<ToolResult> {
			const { summary } = args;

			try {
				const updatedTask = await taskManager.setTaskStatus(stepTaskId, 'completed', {
					result: summary,
				});

				// Emit DaemonHub event so the UI is notified of the step task completion.
				if (daemonHub) {
					void daemonHub
						.emit('space.task.updated', {
							sessionId: 'global',
							spaceId,
							taskId: stepTaskId,
							task: updatedTask,
						})
						.catch((err) => {
							log.warn(
								`Failed to emit space.task.updated for step task ${stepTaskId} (parent ${taskId}): ` +
									`${err instanceof Error ? err.message : String(err)}`
							);
						});
				}

				return jsonResult({
					success: true,
					stepTaskId,
					summary,
					message:
						'Step task has been marked as completed. ' +
						'Your work is done — stop here and do not continue.',
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
 * Create an MCP server exposing all node agent peer communication tools.
 * Pass the returned server to the AgentSessionInit.mcpServers for node agent sessions.
 */
export function createNodeAgentMcpServer(config: NodeAgentToolsConfig) {
	const handlers = createNodeAgentToolHandlers(config);

	const tools = [
		tool(
			'list_peers',
			'List all other agents in this workflow step group with their roles, statuses, session IDs, ' +
				'permitted channel connections, and completion state from space_tasks. ' +
				'Use this to discover which peers are active, what direct messaging channels are available, ' +
				'and whether peer tasks have completed (including their completion summaries).',
			ListPeersSchema.shape,
			(args) => handlers.list_peers(args)
		),
		tool(
			'list_reachable_agents',
			'List all agents and nodes this agent can reach, grouped as within-node peers ' +
				'(agents in the same workflow node) and cross-node targets (agents/nodes on other nodes). ' +
				'Gate status is included for each cross-node target so you know whether a condition ' +
				'must pass before delivery is permitted. ' +
				'Use this before sending a message to understand who you can reach and whether any gates apply.',
			ListReachableAgentsSchema.shape,
			(args) => handlers.list_reachable_agents(args)
		),
		tool(
			'list_channels',
			'List all channels declared in this workflow. ' +
				'Channels define the messaging topology — which agents can communicate and whether a gate ' +
				'guards the channel. Use this to understand the full channel map for this workflow run. ' +
				'Each entry includes `hasGate` (true when a gate guards the channel) and `gateId` ' +
				'(non-null when using the new separated gate architecture — use `list_gates` to read gate state).',
			ListChannelsSchema.shape,
			(args) => handlers.list_channels(args)
		),
		tool(
			'list_gates',
			'List all gates declared in this workflow with their current runtime data and condition. ' +
				'Gates guard channels — a message on a gated channel is held until the gate condition passes. ' +
				'Use this to see what data each gate currently holds and whether any gate is open. ' +
				'Your nodeId is included — use it as the map key when writing to count-condition (vote) gates.',
			ListGatesSchema.shape,
			(args) => handlers.list_gates(args)
		),
		tool(
			'read_gate',
			'Read the current runtime data for a specific gate. ' +
				'Returns the live data from the gate_data table and whether the gate is currently open.',
			ReadGateSchema.shape,
			(args) => handlers.read_gate(args)
		),
		tool(
			'write_gate',
			"Write (merge) data into a gate's runtime data store. " +
				"Your role must be in the gate's allowedWriterRoles. " +
				'For vote-counting (count condition) gates, use your nodeId as the map key so each node votes once. ' +
				'After writing, gate re-evaluation is triggered — the response tells you if the gate is now open. ' +
				'When the gate opens, blocked target nodes are automatically activated by the workflow runtime.',
			WriteGateSchema.shape,
			(args) => handlers.write_gate(args)
		),
		tool(
			'send_message',
			'Send a message to a peer agent by name (DM), a node by name (fan-out), or broadcast to all permitted targets. ' +
				"Use agent role name for DM (e.g. 'coder'), node name for fan-out, or '*' for broadcast. " +
				'Validates against declared channel topology — returns an error with available targets if not permitted. ' +
				'Include structured data in the optional `data` field for gate writes or machine-readable payloads.',
			SendMessageSchema.shape,
			(args) => handlers.send_message(args)
		),
		tool(
			'report_done',
			'Signal that this node agent has completed its work. ' +
				'Marks the step task as completed and persists an optional summary as the result. ' +
				'Call this when you have finished all assigned work. ' +
				'After calling this tool, stop — do not continue with further actions.',
			ReportDoneSchema.shape,
			(args) => handlers.report_done(args)
		),
	];

	return createSdkMcpServer({ name: 'node-agent', tools });
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
