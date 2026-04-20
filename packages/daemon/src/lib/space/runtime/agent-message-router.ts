/**
 * AgentMessageRouter — unified message delivery for node agents.
 *
 * Handles all message routing through a single code path — no separate within-node
 * vs cross-node logic. Target resolution:
 *   - Agent name: delivers as DM to all sessions with that agent name
 *   - Node name: fan-out to all agents in a named node (via nodeGroups)
 *   - '*': broadcast to all permitted targets
 *   - No match: returns clear error message
 *
 * Authorization is validated against the declared channel topology (via ChannelResolver)
 * before delivery.
 *
 * Note: This is distinct from ChannelRouter (channel-router.ts), which handles
 * workflow-level orchestration (lazy node activation, gate evaluation). This class
 * is used by node-agent-tools to deliver messages between live sessions at runtime.
 */

import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { WorkflowChannel } from '@neokai/shared';
import { ChannelResolver } from './channel-resolver';
import { ActivationError, ChannelGateBlockedError, type ChannelRouter } from './channel-router';

export interface AgentMessageRouterConfig {
	/** Node execution repository for looking up agent sessions by workflow run. */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Workflow run ID for looking up peer tasks. */
	workflowRunId: string;
	/** Workflow channel definitions for this run. */
	workflowChannels: WorkflowChannel[];
	/** Injects a message into a target session as a user turn. */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Optional channel router for workflow-level delivery checks and lazy node activation.
	 * When provided, send_message activates target nodes (and enforces gate/cycle checks)
	 * even before target agent sessions are spawned.
	 */
	channelRouter?: ChannelRouter;
	/**
	 * Optional map of node name → array of agent names in that node.
	 * When provided, enables fan-out delivery by node name.
	 */
	nodeGroups?: Record<string, string[]>;
	/**
	 * Optional injector for routing messages to the Task Agent helper session.
	 * Used when a node agent explicitly targets `task-agent`.
	 */
	taskAgentRouter?: (message: string) => Promise<{ sessionId: string }>;
}

export interface AgentMessageParams {
	/** Agent name of the sending agent. */
	fromAgentName: string;
	/** Session ID of the sending agent (excluded from delivery). */
	fromSessionId: string;
	/**
	 * Delivery target: an agent name (DM), a node name (fan-out),
	 * an array of agent names (multicast), or '*' (broadcast to all permitted targets).
	 */
	target: string | string[];
	/** Message content to deliver. */
	message: string;
	/**
	 * Optional structured data payload attached to the message.
	 * Included in the delivered message as a JSON appendix when present,
	 * making it available to the receiving agent for programmatic use
	 * (e.g. gate writes, task results, structured feedback).
	 */
	data?: Record<string, unknown>;
}

export interface AgentMessageResult {
	success: boolean | 'partial';
	delivered: Array<{ agentName: string; sessionId: string }>;
	failed: Array<{ agentName: string; sessionId: string; error: string }>;
	/** Set when success is false — human-readable reason for the failure. */
	reason?: string;
	/**
	 * Agent names that were requested but not permitted by channel topology.
	 * Populated on authorization failure.
	 */
	unauthorizedAgentNames?: string[];
	/**
	 * Agent names that are permitted by topology for this sender.
	 * Populated on authorization failure.
	 */
	permittedTargets?: string[];
	/**
	 * Target agent names that had no active sessions.
	 * Populated when delivery was attempted but no sessions were found.
	 */
	notFoundAgentNames?: string[];
}

import { Logger } from '../../logger';

const log = new Logger('agent-message-router');

export class AgentMessageRouter {
	constructor(private readonly config: AgentMessageRouterConfig) {}

	/**
	 * Deliver a message to the specified target.
	 *
	 * Resolution order:
	 *   1. '*' → broadcast to all topology-permitted targets
	 *   2. Agent name match → DM/fan-out to all sessions with that agent name in the node
	 *   3. Node name match → fan-out to all agents mapped to that node (via nodeGroups)
	 *   4. No match → error with list of known reachable agents
	 *
	 * Authorization is checked against the declared channel topology before delivery.
	 * Returns a structured result — never throws.
	 */
	async deliverMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
		const { fromAgentName, fromSessionId, target, message, data } = params;
		const {
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels,
			messageInjector,
			channelRouter,
			nodeGroups,
			taskAgentRouter,
		} = this.config;

		// --- Build channel resolver + slot-to-node translation map ---
		const resolver = new ChannelResolver(workflowChannels);
		// Channels use node names as addresses. Build a reverse map from agent slot name
		// → node name so the router can translate 'coder' → 'Code' before calling canSend.
		const slotToNode = new Map<string, string>();
		if (nodeGroups) {
			for (const [nodeName, slots] of Object.entries(nodeGroups)) {
				for (const slot of slots) {
					slotToNode.set(slot, nodeName);
				}
			}
		}
		const resolveNodeName = (slotOrNode: string) => slotToNode.get(slotOrNode) ?? slotOrNode;
		const fromNodeName = resolveNodeName(fromAgentName);
		const requestedTargets =
			target === '*' ? ['*'] : Array.isArray(target) ? [...target] : [target];
		const wantsTaskAgent = target !== '*' && requestedTargets.includes('task-agent');

		// Channel topology required
		if (resolver.isEmpty() && !(wantsTaskAgent && taskAgentRouter)) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					'No channel topology declared for this node. ' +
					'Direct messaging via send_message is not available.',
			};
		}

		// --- Load peers from node_executions (workflow-internal state) ---
		const executions = nodeExecutionRepo
			.listByWorkflowRun(workflowRunId)
			.filter((e) => e.agentSessionId);
		if (executions.length === 0) {
			log.warn(
				`[AgentMessageRouter] nodeExecutionRepo returned no sessions with agentSessionId for run ${workflowRunId} — ` +
					`peers will be empty. Check that NodeExecution.agentSessionId is being written at spawn time.`
			);
		}
		const peers: Array<{ sessionId: string; agentName: string }> = executions
			.filter((e) => e.agentSessionId !== fromSessionId)
			.map((e) => ({ sessionId: e.agentSessionId!, agentName: e.agentName }));

		// --- Resolve target agent names ---
		let targetAgentNames: string[];

		if (target === '*') {
			// Broadcast: expand to all topology-permitted targets
			// getPermittedTargets returns node names; translate back to slot names for delivery
			const permittedNodes = resolver.getPermittedTargets(fromNodeName);
			if (permittedNodes.length === 0) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: `No permitted targets for agent '${fromAgentName}' in the declared channel topology.`,
				};
			}
			// Map node names back to slot names for delivery (or keep node name for fan-out)
			targetAgentNames = permittedNodes;
		} else if (Array.isArray(target)) {
			// Multicast: explicit list of agent names
			targetAgentNames = target;
		} else if (target === 'task-agent' && taskAgentRouter) {
			targetAgentNames = ['task-agent'];
		} else {
			// Try agent name match first (agent name within the node peers)
			const agentMatches = peers.filter((m) => m.agentName === target).map((m) => m.agentName);

			if (agentMatches.length > 0) {
				// Agent name → DM (or fan-out if multiple agents share the name)
				targetAgentNames = [target];
			} else if (nodeGroups && nodeGroups[target]) {
				// Node name match → fan-out to all agents in that node
				targetAgentNames = nodeGroups[target];
			} else {
				// No match — unknown target
				const knownAgentNames = [...new Set(peers.map((m) => m.agentName))].sort();
				const nodeNames = nodeGroups ? Object.keys(nodeGroups) : [];
				const allTargets = [...knownAgentNames, ...nodeNames];
				if (taskAgentRouter) allTargets.push('task-agent');
				return {
					success: false,
					delivered: [],
					failed: [],
					reason:
						`Unknown target '${target}': no agent or node found with this name. ` +
						(allTargets.length > 0
							? `Reachable targets: ${allTargets.join(', ')}.`
							: 'No reachable targets available.'),
				};
			}
		}

		// --- Authorization check (translate slot names → node names for canSend) ---
		const topologyTargets = targetAgentNames.filter((r) => r !== 'task-agent');
		const unauthorized = topologyTargets.filter(
			(r) => !resolver.canSend(fromNodeName, resolveNodeName(r))
		);
		if (unauthorized.length > 0) {
			const permittedNodes = resolver.getPermittedTargets(fromNodeName);
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`Channel topology does not permit '${fromAgentName}' to send to: ${unauthorized.join(', ')}. ` +
					`Permitted targets: ${permittedNodes.length > 0 ? permittedNodes.join(', ') : 'none'}.`,
				unauthorizedAgentNames: unauthorized,
				permittedTargets: permittedNodes,
			};
		}

		// --- Workflow-level delivery checks + lazy node activation ---
		// This ensures cross-node messages can activate downstream nodes even when
		// target sessions do not exist yet.
		const activatedTargets = new Set<string>();
		if (channelRouter) {
			for (const agentName of targetAgentNames) {
				if (agentName === 'task-agent') continue;
				try {
					const routed = await channelRouter.deliverMessage(
						workflowRunId,
						fromAgentName,
						agentName,
						message
					);
					if (routed.activatedTasks && routed.activatedTasks.length > 0) {
						activatedTargets.add(agentName);
					}
				} catch (err) {
					if (err instanceof ChannelGateBlockedError) {
						return {
							success: false,
							delivered: [],
							failed: [],
							reason: err.message,
						};
					}
					if (err instanceof ActivationError) {
						return {
							success: false,
							delivered: [],
							failed: [],
							reason: err.message,
						};
					}
					return {
						success: false,
						delivered: [],
						failed: [],
						reason: err instanceof Error ? err.message : String(err),
					};
				}
			}
		}

		// --- Deliver to all resolved sessions (best-effort) ---
		const delivered: Array<{ agentName: string; sessionId: string }> = [];
		const notFound: string[] = [];
		const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];

		for (const agentName of targetAgentNames) {
			if (agentName === 'task-agent') {
				if (!taskAgentRouter) {
					notFound.push(agentName);
					continue;
				}
				const dataAppendix =
					data && Object.keys(data).length > 0
						? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
						: '';
				const prefixedMessage = `[Message from ${fromAgentName}]: ${message}${dataAppendix}`;
				try {
					const routed = await taskAgentRouter(prefixedMessage);
					delivered.push({ agentName, sessionId: routed.sessionId });
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					failed.push({ agentName, sessionId: 'task-agent', error: errMsg });
				}
				continue;
			}
			const agentSessions = peers.filter((m) => m.agentName === agentName);
			if (agentSessions.length === 0) {
				// No active session yet, but the channel router successfully activated
				// the target node in this call. Treat as accepted delivery initiation.
				if (activatedTargets.has(agentName)) {
					continue;
				}
				notFound.push(agentName);
				continue;
			}
			for (const member of agentSessions) {
				// Include structured data as a JSON appendix when present
				const dataAppendix =
					data && Object.keys(data).length > 0
						? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
						: '';
				const prefixedMessage = `[Message from ${fromAgentName}]: ${message}${dataAppendix}`;
				try {
					await messageInjector(member.sessionId, prefixedMessage);
					delivered.push({ agentName, sessionId: member.sessionId });
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					failed.push({ agentName, sessionId: member.sessionId, error: errMsg });
				}
			}
		}

		if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`No active sessions found for target agent(s): ${notFound.join(', ')}. ` +
					`Use list_peers to check which peers are currently active.`,
				notFoundAgentNames: notFound,
			};
		}

		if (delivered.length === 0 && failed.length > 0) {
			return {
				success: false,
				delivered,
				failed,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
			};
		}
		if (failed.length > 0) {
			return {
				success: 'partial',
				delivered,
				failed,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
			};
		}
		return {
			success: true,
			delivered,
			failed,
			notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
		};
	}
}
