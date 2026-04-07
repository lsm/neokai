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
 * - Message delivery is delegated to AgentMessageRouter for topology/gate validation.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonHub } from '../../daemon-hub';
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

function normalizeRoleToken(value: string): string {
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
	/** Role of this node agent (e.g., 'coder', 'reviewer'). */
	myRole: string;
	/**
	 * Optional role aliases that should be treated as equivalent to myRole for
	 * writer authorization checks (e.g., slot role + underlying agent name).
	 */
	myRoleAliases?: string[];
	/** ID of the parent task (used for error messages). */
	taskId: string;
	/** Space ID — used for event emission in report_done. */
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
	 * Node execution repository for report_done, list_peers, and send_message peer resolution.
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
	 * When provided, `write_gate` and `read_gate` run gate scripts before
	 * field evaluation. When absent, script-based gates report as open
	 * (sync-only path — documented limitation for `list_gates`).
	 */
	scriptExecutor?: GateScriptExecutorFn;
	/**
	 * Context for gate script execution (workspace path, gate/run IDs).
	 * Required when `scriptExecutor` is provided.
	 */
	scriptContext?: GateScriptExecutorContext;
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
		myRoleAliases,
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
	} = config;

	const roleAliases = new Set(
		[myRole, ...(myRoleAliases ?? [])]
			.map((value) => normalizeRoleToken(value))
			.filter((value) => value.length > 0)
	);

	return {
		/**
		 * List all peers (other group members) with their roles, statuses, session IDs,
		 * permitted channel connections, and completion state.
		 *
		 * Does NOT include self (filtered by `mySessionId`).
		 * Does NOT include the Task Agent (filtered by role 'task-agent').
		 *
		 * Returns permittedTargets: roles this agent can directly send to via send_message.
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
						ne.agentSessionId !== mySessionId && (ne.agentSessionId != null || ne.status === 'done')
				)
				.map((ne) => {
					const execStatus = ne.status;
					const memberStatus =
						execStatus === 'done'
							? ('completed' as const)
							: execStatus === 'blocked' || execStatus === 'cancelled'
								? ('failed' as const)
								: ('active' as const);
					return {
						sessionId: ne.agentSessionId ?? null,
						role: ne.agentName,
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
		 * Validates against declared channel topology — returns an error with
		 * available targets if not permitted.
		 */
		async send_message(args: SendMessageInput): Promise<ToolResult> {
			const { target, message, data } = args;

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
			// Determine this agent's node name from the workflow definition.
			// Falls back to myRole (agent slot name) for backward compatibility
			// when no workflow is available (e.g. direct MCP calls without a workflow).
			const myNode = workflow?.nodes.find((n) => n.id === workflowNodeId);
			const myNodeName = myNode?.name ?? myRole;

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
							ts === 'done'
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
				const withinNodeAgentNames = new Set([myRole, ...nodeExecs.map((e) => e.agentName)]);

				for (const ch of channels) {
					// Match channels where FROM is this agent's node name, slot name, or wildcard
					if (ch.from !== myNodeName && ch.from !== myRole && ch.from !== '*') continue;
					const tos = Array.isArray(ch.to) ? ch.to : [ch.to];
					for (const toNode of tos) {
						// Skip: same as source, already seen, or is a within-node agent
						if (toNode === myNodeName || toNode === myRole) continue;
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
				myAgentName: myRole,
				myNodeName,
				withinNodePeers,
				crossNodeTargets,
				reachabilityDeclared,
				message:
					`You can reach ${totalReachable} target(s) in total. ` +
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

			// Field-level authorization: check each key in data against field declarations.
			// For script-only gates (no fields), any data write is rejected since there are
			// no declared fields to validate against. Script execution populates gate data
			// internally; agents should not write to script-only gates directly.
			const fieldMap = new Map((gateDef.fields ?? []).map((f) => [f.name, f]));
			for (const key of Object.keys(data)) {
				const fieldDef = fieldMap.get(key);
				if (!fieldDef) {
					return jsonResult({
						success: false,
						error:
							`Field "${key}" is not declared in gate "${gateId}". ` +
							`Declared fields: ${(gateDef.fields ?? []).map((f) => f.name).join(', ') || '(none)'}.`,
					});
				}
				const writers = fieldDef.writers;
				const isAuthorized = writers.some((writer) => {
					const normalizedWriter = normalizeRoleToken(writer);
					return normalizedWriter === '*' || roleAliases.has(normalizedWriter);
				});
				if (!isAuthorized) {
					return jsonResult({
						success: false,
						error:
							`Role "${myRole}" is not authorized to write field "${key}" on gate "${gateId}". ` +
							`Allowed writers: ${writers.length > 0 ? writers.join(', ') : '(none)'}.`,
						allowedWriters: writers,
						myRole,
						myRoleAliases: [...roleAliases],
					});
				}
			}

			// Merge data into gate_data table
			let updated = gateDataRepo.merge(workflowRunId, gateId, data);

			// Re-evaluate gate with updated data. Uses scriptExecutor when available for
			// async script-based gates; otherwise falls back to field-only evaluation.
			const evalResult = await evaluateGate(
				gateDef,
				updated.data,
				scriptExecutor,
				scriptContext ? { ...scriptContext, gateId, gateData: updated.data } : undefined
			);

			// Persist script evaluation result to gate data for frontend transport.
			// Only set _scriptResult when a scriptExecutor actually ran (not when a
			// field-only check fails on a script-annotated gate without an executor).
			// Persisted to DB so re-fetches include the result.
			if (scriptExecutor && gateDef.script && !evalResult.open && evalResult.reason) {
				updated = gateDataRepo.merge(workflowRunId, gateId, {
					_scriptResult: { success: false, reason: evalResult.reason },
				});
			} else if (updated.data._scriptResult) {
				// Clean up stale _scriptResult from a previous failed script evaluation
				const { _scriptResult, ...rest } = updated.data;
				updated = gateDataRepo.set(workflowRunId, gateId, rest);
			}

			// TODO (P2): evaluateGate deep-merges script output into a local copy of
			// gateData, but the merged data is not returned to the caller. The event
			// below emits pre-script data. To fix, evaluateGate should return
			// { open, reason, mergedData? } so callers can persist/emit the merged state.

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

			// Notify UI about gate data change for real-time canvas updates.
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
		 * Updates the NodeExecution record for this agent (identified by
		 * workflowNodeId + myRole) to status 'done' and
		 * persists the optional summary. SpaceRuntime detects the state change and
		 * triggers workflow completion checks (end-node short-circuit or
		 * CompletionDetector safety net).
		 *
		 * After calling this tool, the node agent should stop and not perform
		 * further work — the task lifecycle is closed.
		 */
		async report_done(args: ReportDoneInput): Promise<ToolResult> {
			const { summary } = args;

			try {
				// Preferred path: update NodeExecution status to 'done'
				const nodeExecs = workflowRunId
					? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
					: [];
				const myExec = nodeExecs.find((e) => e.agentName === myRole);

				if (!myExec) {
					return jsonResult({
						success: false,
						error:
							`NodeExecution not found for agent "${myRole}" in node "${workflowNodeId}" ` +
							`(run: ${workflowRunId}). Cannot mark as done.`,
					});
				}

				nodeExecutionRepo.update(myExec.id, {
					status: 'done',
					result: summary ?? null,
				});

				return jsonResult({
					success: true,
					executionId: myExec.id,
					agentName: myRole,
					summary,
					message:
						'Step execution has been marked as completed. ' +
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
				'permitted channel connections, and completion state from node executions. ' +
				'Use this to discover which peers are active, what direct messaging channels are available, ' +
				'and whether peer executions have completed (including their completion summaries).',
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
			'write_gate',
			"Write (merge) data into a gate's runtime data store. " +
				'Each field you write must exist in the gate schema and your role must be in the field writers list. ' +
				'For map-type (vote) fields, use your nodeId as the map key so each node votes once. ' +
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
				'Marks the node execution as completed and persists an optional summary as the result. ' +
				'Call this when you have finished all assigned work. ' +
				'After calling this tool, stop — do not continue with further actions.',
			ReportDoneSchema.shape,
			(args) => handlers.report_done(args)
		),
	];

	return createSdkMcpServer({ name: 'node-agent', tools });
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
