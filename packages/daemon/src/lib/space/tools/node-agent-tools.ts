/**
 * Node Agent Tools — MCP tool handlers for node agent sub-sessions.
 *
 * Action tools:
 *   send_message — channel-validated direct messaging; auto-writes gate data on gated channels
 *   save         — persist agent output (summary + structured data) to NodeExecution
 *
 * Discovery tools (read-only):
 *   list_peers            — discover other group members with agent names and permitted channels
 *   list_reachable_agents — list all reachable agents/nodes grouped by proximity
 *   list_channels         — list all channels declared in the workflow
 *   list_gates            — list all gates with current runtime data
 *   read_gate             — read current data for a specific gate
 *
 * Communication model:
 * - Node agents communicate via declared channel topology (`send_message`).
 * - When a channel is gated, the `data` payload in `send_message` is automatically
 *   merged into the gate's data store — no separate write_gate call needed.
 * - `save` stores the agent's result summary and structured output on NodeExecution
 *   for Task Agent visibility.
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `NodeAgentToolsConfig`.
 * - Message delivery is delegated to AgentMessageRouter for topology/gate validation.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonHub } from '../../daemon-hub';
import { ReportResultSchema } from './task-agent-tool-schemas';
import type { ReportResultInput } from './task-agent-tool-schemas';
import { Logger } from '../../logger';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { ChannelResolver } from '../runtime/channel-resolver';
import {
	evaluateGate,
	type GateScriptExecutorFn,
	type GateScriptExecutorContext,
} from '../runtime/gate-evaluator';
import type { AgentMessageRouter } from '../runtime/agent-message-router';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { SpaceWorkflow } from '@neokai/shared';
import { computeGateDefaults } from '@neokai/shared';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	ListPeersSchema,
	SendMessageSchema,
	SaveSchema,
	ListReachableAgentsSchema,
	ListChannelsSchema,
	ListGatesSchema,
	ReadGateSchema,
	WriteArtifactSchema,
	ListArtifactsSchema,
} from './node-agent-tool-schemas';
import type {
	ListPeersInput,
	SendMessageInput,
	SaveInput,
	ListReachableAgentsInput,
	ListChannelsInput,
	ListGatesInput,
	ReadGateInput,
	WriteArtifactInput,
	ListArtifactsInput,
} from './node-agent-tool-schemas';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('node-agent-tools');

function normalizeAgentNameToken(value: string): string {
	return value.trim().toLowerCase();
}

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
	/** Agent name of this node agent (e.g., 'coder', 'reviewer'). */
	myAgentName: string;
	/**
	 * Optional agent name aliases that should be treated as equivalent to myAgentName for
	 * writer authorization checks (e.g., slot name + underlying agent name).
	 */
	myAgentNameAliases?: string[];
	/** ID of the parent task (used for error messages). */
	taskId: string;
	/** Space ID — used for event emission in report_result. */
	spaceId: string;
	/**
	 * Pre-built channel resolver for this sub-session's topology.
	 * Created by TaskAgentManager at session spawn time from the workflow run config.
	 * An empty resolver (no channels) means send_message is unavailable for this session.
	 */
	channelResolver: ChannelResolver;
	/** Workflow run ID — used to query node execution state. */
	workflowRunId: string;
	/** Workflow node ID — used to query peer executions on the same node. */
	workflowNodeId: string;
	/**
	 * Node execution repository for report_result, list_peers, and send_message peer resolution.
	 */
	nodeExecutionRepo: NodeExecutionRepository;
	/**
	 * DaemonHub instance for emitting task update events.
	 * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
	 */
	daemonHub?: DaemonHub;
	/**
	 * Optional AgentMessageRouter for unified message delivery.
	 * send_message delegates all routing to AgentMessageRouter.
	 */
	agentMessageRouter: AgentMessageRouter;
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
	/**
	 * Optional script executor for async gate evaluation.
	 * When provided, `read_gate` and the gate-write path in `send_message` run
	 * gate scripts before field evaluation.
	 */
	scriptExecutor?: GateScriptExecutorFn;
	/**
	 * Context for gate script execution (workspace path, gate/run IDs).
	 * Required when `scriptExecutor` is provided.
	 */
	scriptContext?: GateScriptExecutorContext;
	/**
	 * Optional callback for the `report_result` tool.
	 * When provided, a `report_result` tool is added to the MCP server —
	 * intended for the end node of a workflow so it can close the workflow run.
	 * When absent, `report_result` is not available to this node agent.
	 */
	onReportResult?: (args: ReportResultInput) => Promise<ToolResult>;
	/**
	 * Resolves the space's current autonomy level.
	 * When provided, agent gate writes via send_message are blocked when
	 * space autonomy < gate.requiredLevel (default 5 if gate has no requiredLevel).
	 */
	getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
	/**
	 * Workflow run artifact repository for write_artifact / list_artifacts tools.
	 * Optional — when absent, artifact tools are not registered.
	 */
	artifactRepo?: WorkflowRunArtifactRepository;
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
		myAgentName,
		myAgentNameAliases,
		spaceId,
		channelResolver,
		workflowRunId,
		workflowNodeId,
		nodeExecutionRepo,
		daemonHub,
		agentMessageRouter,
		workflow,
		gateDataRepo,
		onGateDataChanged,
		scriptExecutor,
		scriptContext,
		getSpaceAutonomyLevel,
	} = config;

	const agentNameAliases = new Set(
		[myAgentName, ...(myAgentNameAliases ?? [])]
			.map((value) => normalizeAgentNameToken(value))
			.filter((value) => value.length > 0)
	);

	return {
		/**
		 * List all peers (other group members) with their agent names, statuses, session IDs,
		 * permitted channel connections, and completion state.
		 *
		 * Does NOT include self (filtered by `mySessionId`).
		 * Always includes `task-agent` as a reachable coordinator target.
		 *
		 * Returns permittedTargets: agent names this agent can directly send to via send_message.
		 * Returns completionState per peer: execution status, completion summary, and completedAt.
		 * Returns nodeCompletionState: all executions on this workflow node with their completion state.
		 */
		async list_peers(_args: ListPeersInput): Promise<ToolResult> {
			const resolver = channelResolver;
			const nodeExecs = workflowRunId
				? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
				: [];

			// Exclude self (by agentSessionId) and include peers with a session or completed state
			const peers = nodeExecs
				.filter(
					(ne) =>
						ne.agentSessionId !== mySessionId && (ne.agentSessionId != null || ne.status === 'idle')
				)
				.map((ne) => {
					const execStatus = ne.status;
					const memberStatus =
						execStatus === 'idle'
							? ('completed' as const)
							: execStatus === 'blocked' || execStatus === 'cancelled'
								? ('failed' as const)
								: ('active' as const);
					return {
						sessionId: ne.agentSessionId ?? null,
						agentName: ne.agentName,
						agentId: ne.agentId ?? null,
						status: memberStatus,
						completionState: {
							agentName: ne.agentName,
							taskStatus: ne.status,
							completionSummary: ne.result ?? null,
							completedAt: ne.completedAt ?? null,
						},
					};
				});

			const nodeCompletionState = nodeExecs.map((ne) => ({
				agentName: ne.agentName,
				taskStatus: ne.status,
				completionSummary: ne.result ?? null,
				completedAt: ne.completedAt ?? null,
			}));

			const topologyTargets = resolver.getPermittedTargets(myAgentName);
			const permittedTargets = [...topologyTargets, 'task-agent'];
			const channelTopologyDeclared = !resolver.isEmpty();

			return jsonResult({
				success: true,
				myAgentName,
				peers,
				nodeCompletionState,
				permittedTargets,
				channelTopologyDeclared,
				message:
					`Found ${peers.length} peer(s). ` +
					`Permitted direct targets via send_message: ${permittedTargets.join(', ')}. ` +
					`Use "task-agent" to escalate blockers or request human input.`,
			});
		},

		/**
		 * Send a message to a peer agent by name (DM), a node by name (fan-out),
		 * or broadcast to all permitted targets.
		 *
		 * Validates against declared channel topology — returns an error with
		 * available targets if not permitted.
		 *
		 * When `data` is provided and the target channel is gated, the data is
		 * automatically merged into the gate's data store before delivery.
		 * Gate re-evaluation fires after the merge — if the gate opens the message
		 * is delivered immediately; otherwise it is held until the condition passes.
		 */
		async send_message(args: SendMessageInput): Promise<ToolResult> {
			const { target, message, data } = args;

			// Auto gate-write: if data is provided and the outbound channel to this
			// target is gated, merge the data into the gate before delivery.
			// This allows agents to satisfy gate conditions as part of a single send call.
			let gateWriteResult: { gateId: string; gateOpen: boolean } | null = null;
			if (data && workflow) {
				const targetName = Array.isArray(target) ? null : target;
				if (targetName && targetName !== '*' && targetName !== 'task-agent') {
					const node = workflow.nodes.find((n) => n.id === workflowNodeId);
					const myNodeName = node?.name ?? myAgentName;
					const fromRefs = new Set([myAgentName, myNodeName]);

					const gatedChannel = (workflow.channels ?? []).find((ch) => {
						if (!ch.gateId) return false;
						if (ch.from !== '*' && !fromRefs.has(ch.from)) return false;
						const tos = Array.isArray(ch.to) ? ch.to : [ch.to];
						return tos.some((to) => to === targetName || to === myNodeName || to === myAgentName);
					});

					if (gatedChannel?.gateId) {
						const gateId = gatedChannel.gateId;
						const gates = workflow.gates ?? [];
						const gateDef = gates.find((g) => g.id === gateId);

						if (gateDef) {
							// Per-field two-path authorization for agent gate writes:
							//   Writers path: field has a non-empty writers list and this agent matches one
							//     (including '*' wildcard) → workflow author made an explicit trust decision → allow,
							//     no autonomy check.
							//   Autonomy path: field has no writers or an empty writers list
							//     → require space.autonomyLevel >= gate.requiredLevel (default 5 when unset).
							// Human approval via spaceWorkflowRun.approveGate RPC is not affected.
							const effectiveRequiredLevel = gateDef.requiredLevel ?? 5;
							const spaceLevel = getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 0;

							const fieldMap = new Map((gateDef.fields ?? []).map((f) => [f.name, f]));
							const authorizedData: Record<string, unknown> = {};
							for (const [key, value] of Object.entries(data)) {
								const fieldDef = fieldMap.get(key);
								if (!fieldDef) continue;

								let fieldAllowed = false;
								if (fieldDef.writers.length > 0) {
									// Writers path: check if this agent matches a declared writer
									fieldAllowed = fieldDef.writers.some((writer) => {
										const normalized = normalizeAgentNameToken(writer);
										return normalized === '*' || agentNameAliases.has(normalized);
									});
								} else if (getSpaceAutonomyLevel) {
									// Autonomy path: no writers declared — require sufficient space autonomy
									fieldAllowed = spaceLevel >= effectiveRequiredLevel;
								}

								if (fieldAllowed) authorizedData[key] = value;
							}

							if (Object.keys(authorizedData).length > 0) {
								const updated = gateDataRepo.merge(workflowRunId, gateId, {
									...authorizedData,
									approvalSource: 'agent',
								});
								const evalResult = await evaluateGate(
									gateDef,
									updated.data,
									scriptExecutor,
									scriptContext ? { ...scriptContext, gateId, gateData: updated.data } : undefined
								);
								gateWriteResult = { gateId, gateOpen: evalResult.open };

								// Multi-round review history: every time the reviewer writes a
								// `review_url` to this gate, append an append-only artifact row
								// so we get one record per cycle (cycle 0, 1, 2 …) without any
								// deduplication. The per-cycle artifactKey makes each write a
								// distinct row even though the table uses upsert semantics.
								//
								// Note: `comment_urls` is not a gate field (so it's stripped from
								// `authorizedData`), but we still want to persist it alongside the
								// review for the audit trail — pull it straight from the original
								// `data` payload the reviewer supplied.
								if (
									config.artifactRepo &&
									gateId === 'review-posted-gate' &&
									typeof authorizedData.review_url === 'string' &&
									authorizedData.review_url.length > 0
								) {
									try {
										const priorReviews = config.artifactRepo.listByRun(workflowRunId, {
											artifactType: 'review',
										});
										const cycle = priorReviews.length;
										const artifactData: Record<string, unknown> = {
											review_url: authorizedData.review_url,
											cycle,
											submittedAt: new Date().toISOString(),
										};
										const rawCommentUrls = (data as Record<string, unknown>).comment_urls;
										if (
											Array.isArray(rawCommentUrls) &&
											rawCommentUrls.every((u) => typeof u === 'string')
										) {
											artifactData.comment_urls = rawCommentUrls;
										}
										config.artifactRepo.upsert({
											id: crypto.randomUUID(),
											runId: workflowRunId,
											nodeId: workflowNodeId,
											artifactType: 'review',
											artifactKey: `cycle-${cycle}`,
											data: artifactData,
										});
									} catch (err) {
										log.warn(
											`Failed to append review artifact for run "${workflowRunId}":`,
											err instanceof Error ? err.message : String(err)
										);
									}
								}

								if (onGateDataChanged) {
									void onGateDataChanged(workflowRunId, gateId).catch((err) => {
										log.warn(
											`onGateDataChanged failed for gate "${gateId}" in run "${workflowRunId}":`,
											err instanceof Error ? err.message : String(err)
										);
									});
								}

								if (daemonHub) {
									void daemonHub
										.emit('space.gateData.updated', {
											sessionId: 'global',
											spaceId,
											runId: workflowRunId,
											gateId,
											data: updated.data,
										})
										.catch((err) => {
											log.warn(`Failed to emit space.gateData.updated for gate "${gateId}":`, err);
										});
								}
							}
						}
					}
				}
			}

			const result = await agentMessageRouter.deliverMessage({
				fromAgentName: myAgentName,
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
					unauthorizedAgentNames: result.unauthorizedAgentNames,
					permittedTargets: result.permittedTargets,
					notFoundAgentNames: result.notFoundAgentNames,
					gateWrite: gateWriteResult ?? undefined,
				});
			}

			if (result.success === 'partial') {
				return jsonResult({
					success: 'partial',
					delivered: result.delivered,
					failed: result.failed,
					notFoundAgentNames: result.notFoundAgentNames,
					gateWrite: gateWriteResult ?? undefined,
					message: `Message delivered to ${result.delivered.length} peer(s) but failed for ${result.failed.length} peer(s).`,
				});
			}

			return jsonResult({
				success: true,
				delivered: result.delivered,
				notFoundAgentNames: result.notFoundAgentNames,
				gateWrite: gateWriteResult ?? undefined,
				message:
					`Message delivered to ${result.delivered.length} peer(s): ` +
					result.delivered.map((t) => `${t.agentName} (${t.sessionId})`).join(', ') +
					'.',
			});
		},

		/**
		 * List all agents and nodes this agent can reach, grouped as:
		 *   - withinNodePeers: agents in the same workflow node (current group members)
		 *   - crossNodeTargets: agents/nodes reachable via declared cross-node paths
		 *   - taskAgent: always included as a coordinator target (target: "task-agent")
		 *
		 * Uses agent-friendly terminology — no mention of channels or policies.
		 * Gate status is included for cross-node targets so agents know whether
		 * a target may require conditions to be met before delivery is permitted.
		 */
		async list_reachable_agents(_args: ListReachableAgentsInput): Promise<ToolResult> {
			// Determine this agent's node name from the workflow definition.
			// Falls back to myAgentName (agent slot name) for backward compatibility
			// when no workflow is available (e.g. direct MCP calls without a workflow).
			const myNode = workflow?.nodes.find((n) => n.id === workflowNodeId);
			const myNodeName = myNode?.name ?? myAgentName;

			// Within-node peers: other agents in the same node
			const nodeExecs = workflowRunId
				? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
				: [];
			const withinNodePeers = nodeExecs
				.filter((e) => e.agentSessionId !== mySessionId)
				.map((e) => {
					const ts = e.status;
					return {
						agentName: e.agentName,
						status:
							ts === 'idle'
								? ('completed' as const)
								: ts === 'blocked' || ts === 'cancelled'
									? ('failed' as const)
									: ('active' as const),
					};
				});

			// Use channels from the resolver (which was built from the workflow channels at spawn time)
			// or fall back to workflow.channels directly. This ensures the handler works both
			// when a full workflow is available and when only a channel resolver is provided.
			const channels =
				channelResolver.getChannels().length > 0
					? channelResolver.getChannels()
					: (workflow?.channels ?? []);
			const reachabilityDeclared = channels.length > 0;

			// Cross-node targets: channels where FROM node is this agent's node
			type CrossNodeTarget = {
				nodeName: string;
				gate: { type: string; isGated: boolean; description?: string };
			};
			const crossNodeTargets: CrossNodeTarget[] = [];

			if (reachabilityDeclared && myNodeName) {
				const gatesById = new Map((workflow?.gates ?? []).map((g) => [g.id, g]));
				const seen = new Set<string>();

				// Track within-node agent names to exclude them from cross-node targets
				const withinNodeAgentNames = new Set([myAgentName, ...nodeExecs.map((e) => e.agentName)]);

				for (const ch of channels) {
					// Match channels where FROM is this agent's node name, slot name, or wildcard
					if (ch.from !== myNodeName && ch.from !== myAgentName && ch.from !== '*') continue;
					const tos = Array.isArray(ch.to) ? ch.to : [ch.to];
					for (const toNode of tos) {
						// Skip: same as source, already seen, or is a within-node agent
						if (toNode === myNodeName || toNode === myAgentName) continue;
						if (seen.has(toNode)) continue;
						if (withinNodeAgentNames.has(toNode)) continue; // within-node agent → not cross-node
						seen.add(toNode);
						const gateEntity = ch.gateId ? gatesById.get(ch.gateId) : undefined;
						const gateType = gateEntity
							? (gateEntity.fields ?? []).some((f) => f.type === 'map' && f.check.op === 'count')
								? 'count'
								: 'check'
							: 'none';
						const entry: CrossNodeTarget = {
							nodeName: toNode,
							gate: { type: gateType, isGated: gateEntity !== undefined },
						};
						if (gateEntity?.description) entry.gate.description = gateEntity.description;
						crossNodeTargets.push(entry);
					}
				}
			}

			const totalReachable = withinNodePeers.length + crossNodeTargets.length;
			const crossNodeSummary =
				crossNodeTargets.length > 0
					? ` Cross-node targets: ${crossNodeTargets.map((t) => t.nodeName).join(', ')}.`
					: '';

			return jsonResult({
				success: true,
				myAgentName,
				myNodeName,
				withinNodePeers,
				crossNodeTargets,
				taskAgent: {
					target: 'task-agent',
					description: 'Workflow coordinator. Use to escalate blockers or request human input.',
				},
				reachabilityDeclared,
				message:
					`You can reach ${totalReachable} target(s) plus the task-agent coordinator. ` +
					`Within-node peers: ${withinNodePeers.length > 0 ? withinNodePeers.map((p) => p.agentName).join(', ') : 'none'}.` +
					crossNodeSummary +
					` Send to "task-agent" to escalate blockers or request human input.`,
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
		 * A channel can be gated via `gateId`, which references a Gate entity
		 * in `workflow.gates`; use `list_gates` to see current gate data and status.
		 * `hasGate` is true when a gateId is set.
		 */
		async list_channels(_args: ListChannelsInput): Promise<ToolResult> {
			const channels = workflow?.channels ?? [];
			const result = channels.map((ch) => ({
				channelId: ch.id ?? null,
				from: ch.from,
				to: ch.to,
				maxCycles: ch.maxCycles ?? null,
				label: ch.label ?? null,
				hasGate: ch.gateId !== undefined,
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
					fields: gate.fields ?? [],
					description: gate.description ?? null,
					currentData: record?.data ?? computeGateDefaults(gate.fields ?? []),
				};
			});
			return jsonResult({
				success: true,
				gates: gateResults,
				total: gateResults.length,
				nodeId: workflowNodeId,
				message:
					`Found ${gateResults.length} gate(s). ` +
					`Your nodeId is "${workflowNodeId}" — use it as the map key for vote-counting (map field) gates.`,
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
			const currentData = record?.data ?? computeGateDefaults(gateDef.fields ?? []);

			// Evaluate current gate status. Uses scriptExecutor when available for
			// async script-based gates; otherwise falls back to field-only evaluation.
			const evalResult = await evaluateGate(
				gateDef,
				currentData,
				scriptExecutor,
				scriptContext ? { ...scriptContext, gateId, gateData: currentData } : undefined
			);

			return jsonResult({
				success: true,
				gateId,
				fields: gateDef.fields ?? [],
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
		 * Persist this agent's output to the NodeExecution record.
		 *
		 * Call whenever you have produced output worth recording — at any point
		 * during your work, not just at the end. Can be called multiple times;
		 * each call overwrites the previous summary and data.
		 *
		 * `summary` and `data` are independent — provide either or both.
		 */
		async save(args: SaveInput): Promise<ToolResult> {
			const { summary, data } = args;

			if (summary === undefined && data === undefined) {
				return jsonResult({
					success: false,
					error: 'At least one of `summary` or `data` must be provided.',
				});
			}

			try {
				const nodeExecs = workflowRunId
					? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
					: [];
				const myExec = nodeExecs.find((e) => e.agentName === myAgentName);

				if (!myExec) {
					return jsonResult({
						success: false,
						error:
							`NodeExecution not found for agent "${myAgentName}" in node "${workflowNodeId}" ` +
							`(run: ${workflowRunId}). Cannot save output.`,
					});
				}

				const updates: { result?: string | null; data?: Record<string, unknown> | null } = {};
				if (summary !== undefined) updates.result = summary;
				if (data !== undefined) updates.data = data;

				nodeExecutionRepo.update(myExec.id, updates);

				return jsonResult({
					success: true,
					executionId: myExec.id,
					agentName: myAgentName,
					savedSummary: summary ?? null,
					savedData: data ?? null,
					message: 'Output saved to execution record.',
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		// ── Artifact tools ────────────────────────────────────────────────

		async write_artifact(args: WriteArtifactInput): Promise<ToolResult> {
			const { artifactRepo } = config;
			if (!artifactRepo) {
				return jsonResult({ success: false, error: 'Artifact repository not available.' });
			}
			try {
				const record = artifactRepo.upsert({
					id: crypto.randomUUID(),
					runId: workflowRunId,
					nodeId: workflowNodeId,
					artifactType: args.artifactType,
					artifactKey: args.artifactKey,
					data: args.data,
				});
				return jsonResult({
					success: true,
					artifact: {
						id: record.id,
						runId: record.runId,
						nodeId: record.nodeId,
						artifactType: record.artifactType,
						artifactKey: record.artifactKey,
					},
					message: `Artifact "${args.artifactType}" written successfully.`,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async list_artifacts(args: ListArtifactsInput): Promise<ToolResult> {
			const { artifactRepo } = config;
			if (!artifactRepo) {
				return jsonResult({ success: false, error: 'Artifact repository not available.' });
			}
			try {
				const artifacts = artifactRepo.listByRun(workflowRunId, {
					nodeId: args.nodeId,
					artifactType: args.artifactType,
				});
				return jsonResult({
					success: true,
					artifacts: artifacts.map((a) => ({
						id: a.id,
						nodeId: a.nodeId,
						artifactType: a.artifactType,
						artifactKey: a.artifactKey,
						data: a.data,
						createdAt: a.createdAt,
						updatedAt: a.updatedAt,
					})),
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
	const { onReportResult } = config;

	const tools = [
		tool(
			'list_peers',
			'List all other agents in this workflow node group with their agent names, statuses, session IDs, ' +
				'permitted channel connections, and output state from node executions. ' +
				'Use this to discover which peers are active, what direct messaging channels are available, ' +
				'and what output peers have saved (including their summaries).',
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
				'Each entry includes `hasGate` (true when a gate guards the channel) and `gateId`.',
			ListChannelsSchema.shape,
			(args) => handlers.list_channels(args)
		),
		tool(
			'list_gates',
			'List all gates declared in this workflow with their field schemas and current runtime data. ' +
				'Gates guard channels — a message on a gated channel is held until all gate fields pass their checks. ' +
				'Use this to see what data each gate currently holds and whether any gate is open. ' +
				'Your nodeId is included — use it as the map key when writing to map-type (vote) fields.',
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
			'send_message',
			'Send a message to a peer agent by name (DM), a node by name (fan-out), or broadcast to all permitted targets. ' +
				"Use agent name for DM (e.g. 'coder'), node name for fan-out, or '*' for broadcast. " +
				'Validates against declared channel topology — returns an error with available targets if not permitted. ' +
				'When the target channel is gated, the optional `data` payload is automatically merged into the gate ' +
				'and gate re-evaluation fires — no separate gate write needed.',
			SendMessageSchema.shape,
			(args) => handlers.send_message(args)
		),
		tool(
			'save',
			'Persist your output to the execution record. ' +
				'Provide a human-readable `summary`, structured `data` (key-value pairs), or both. ' +
				'Can be called multiple times — each call overwrites previous values. ' +
				'Use `data` for machine-readable artifacts like pr_url, commit_sha, test_results.',
			SaveSchema.shape,
			(args) => handlers.save(args)
		),
		...(config.artifactRepo
			? [
					tool(
						'write_artifact',
						'Write a typed artifact (PR, commit set, test result, deployment) to the workflow run. ' +
							'Artifacts are visible in the UI and to downstream nodes. ' +
							'Uses upsert — writing the same (type, key) pair updates the existing artifact.',
						WriteArtifactSchema.shape,
						(args) => handlers.write_artifact(args)
					),
					tool(
						'list_artifacts',
						'List artifacts for the current workflow run. ' +
							'Optionally filter by nodeId or artifactType.',
						ListArtifactsSchema.shape,
						(args) => handlers.list_artifacts(args)
					),
				]
			: []),
		...(onReportResult
			? [
					tool(
						'report_result',
						'Mark the workflow as completed, failed, or cancelled and record the final result. ' +
							'Only available to the end node of the workflow. ' +
							'Call this when the workflow has reached its terminal state.',
						ReportResultSchema.shape,
						(args) => onReportResult(args)
					),
				]
			: []),
	];

	return createSdkMcpServer({ name: 'node-agent', tools });
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
