/**
 * AgentMessageRouter — unified message delivery for node agents.
 *
 * Handles all message routing through a single code path — no separate within-node
 * vs cross-node logic. Target resolution:
 *   - Agent name (role string): delivers as DM to all sessions with that role
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

import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { ResolvedChannel } from '@neokai/shared';
import { ChannelResolver } from './channel-resolver';

export interface AgentMessageRouterConfig {
	/** Task repository for looking up peer sessions by workflow run and node. */
	spaceTaskRepo: SpaceTaskRepository;
	/**
	 * Node execution repository for looking up agent sessions by workflow run.
	 * When provided, peer resolution uses NodeExecution.agentSessionId instead
	 * of SpaceTask.taskAgentSessionId for node agent sessions.
	 */
	nodeExecutionRepo?: NodeExecutionRepository;
	/** Workflow run ID for looking up peer tasks. */
	workflowRunId: string;
	/** Pre-resolved channel topology for this step. */
	resolvedChannels: ResolvedChannel[];
	/** Injects a message into a target session as a user turn. */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Optional map of node name → array of agent roles in that node.
	 * When provided, enables fan-out delivery by node name.
	 */
	nodeGroups?: Record<string, string[]>;
}

export interface AgentMessageParams {
	/** Role of the sending agent. */
	fromRole: string;
	/** Session ID of the sending agent (excluded from delivery). */
	fromSessionId: string;
	/**
	 * Delivery target: an agent role name (DM), a node name (fan-out),
	 * an array of role names (multicast), or '*' (broadcast to all permitted targets).
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
	delivered: Array<{ role: string; sessionId: string }>;
	failed: Array<{ role: string; sessionId: string; error: string }>;
	/** Set when success is false — human-readable reason for the failure. */
	reason?: string;
	/**
	 * Roles that were requested but not permitted by channel topology.
	 * Populated on authorization failure — matches legacy path response shape.
	 */
	unauthorizedRoles?: string[];
	/**
	 * Roles that are permitted by topology for this sender.
	 * Populated on authorization failure — matches legacy path response shape.
	 */
	permittedTargets?: string[];
	/**
	 * Target roles that had no active sessions.
	 * Populated when delivery was attempted but no sessions were found.
	 */
	notFoundRoles?: string[];
}

export class AgentMessageRouter {
	constructor(private readonly config: AgentMessageRouterConfig) {}

	/**
	 * Deliver a message to the specified target.
	 *
	 * Resolution order:
	 *   1. '*' → broadcast to all topology-permitted targets
	 *   2. Agent name match → DM/fan-out to all sessions with that role in the node
	 *   3. Node name match → fan-out to all agents mapped to that node (via nodeGroups)
	 *   4. No match → error with list of known reachable agents
	 *
	 * Authorization is checked against the declared channel topology before delivery.
	 * Returns a structured result — never throws.
	 */
	async deliverMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
		const { fromRole, fromSessionId, target, message, data } = params;
		const {
			spaceTaskRepo,
			nodeExecutionRepo,
			workflowRunId,
			resolvedChannels,
			messageInjector,
			nodeGroups,
		} = this.config;

		// --- Build channel resolver ---
		const resolver = new ChannelResolver(resolvedChannels);

		// Channel topology required
		if (resolver.isEmpty()) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					'No channel topology declared for this step. ' +
					'Direct messaging via send_message is not available.',
			};
		}

		// --- Load peers from node_executions (workflow-internal state) ---
		// When nodeExecutionRepo is available, use it as the primary source for
		// node agent sessions. Fall back to space_tasks for backward compat.
		let peers: Array<{ sessionId: string; role: string }>;
		if (nodeExecutionRepo) {
			const executions = nodeExecutionRepo
				.listByWorkflowRun(workflowRunId)
				.filter((e) => e.agentSessionId);
			peers = executions
				.filter((e) => e.agentSessionId !== fromSessionId)
				.map((e) => ({ sessionId: e.agentSessionId!, role: e.agentName }));
		} else {
			const allRunTasks = spaceTaskRepo
				.listByWorkflowRun(workflowRunId)
				.filter((t) => t.taskAgentSessionId);
			peers = allRunTasks
				.filter((t) => t.taskAgentSessionId !== fromSessionId)
				.map((t) => ({ sessionId: t.taskAgentSessionId!, role: t.title ?? 'agent' }));
		}

		// --- Resolve target roles ---
		let targetRoles: string[];

		if (target === '*') {
			// Broadcast: expand to all topology-permitted targets
			const permitted = resolver.getPermittedTargets(fromRole);
			if (permitted.length === 0) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: `No permitted targets for role '${fromRole}' in the declared channel topology.`,
				};
			}
			targetRoles = permitted;
		} else if (Array.isArray(target)) {
			// Multicast: explicit list of role names
			targetRoles = target;
		} else {
			// Try agent name match first (role string within the node peers)
			const agentMatchRoles = peers.filter((m) => m.role === target).map((m) => m.role);

			if (agentMatchRoles.length > 0) {
				// Agent name → DM (or fan-out if multiple agents share the role)
				targetRoles = [target];
			} else if (nodeGroups && nodeGroups[target]) {
				// Node name match → fan-out to all agents in that node
				targetRoles = nodeGroups[target];
			} else {
				// No match — unknown target
				const knownRoles = [...new Set(peers.map((m) => m.role))].sort();
				const nodeNames = nodeGroups ? Object.keys(nodeGroups) : [];
				const allTargets = [...knownRoles, ...nodeNames];
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

		// --- Authorization check ---
		const unauthorized = targetRoles.filter((r) => !resolver.canSend(fromRole, r));
		if (unauthorized.length > 0) {
			const permitted = resolver.getPermittedTargets(fromRole);
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`Channel topology does not permit '${fromRole}' to send to: ${unauthorized.join(', ')}. ` +
					`Permitted targets: ${permitted.length > 0 ? permitted.join(', ') : 'none'}.`,
				unauthorizedRoles: unauthorized,
				permittedTargets: permitted,
			};
		}

		// --- Deliver to all resolved sessions (best-effort) ---
		const delivered: Array<{ role: string; sessionId: string }> = [];
		const notFound: string[] = [];
		const failed: Array<{ role: string; sessionId: string; error: string }> = [];

		for (const role of targetRoles) {
			const roleSessions = peers.filter((m) => m.role === role);
			if (roleSessions.length === 0) {
				notFound.push(role);
				continue;
			}
			for (const member of roleSessions) {
				// Include structured data as a JSON appendix when present
				const dataAppendix =
					data && Object.keys(data).length > 0
						? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
						: '';
				const prefixedMessage = `[Message from ${fromRole}]: ${message}${dataAppendix}`;
				try {
					await messageInjector(member.sessionId, prefixedMessage);
					delivered.push({ role, sessionId: member.sessionId });
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					failed.push({ role, sessionId: member.sessionId, error: errMsg });
				}
			}
		}

		if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`No active sessions found for target role(s): ${notFound.join(', ')}. ` +
					`Use list_peers to check which peers are currently active.`,
				notFoundRoles: notFound,
			};
		}

		if (delivered.length === 0 && failed.length > 0) {
			return {
				success: false,
				delivered,
				failed,
				notFoundRoles: notFound.length > 0 ? notFound : undefined,
			};
		}
		if (failed.length > 0) {
			return {
				success: 'partial',
				delivered,
				failed,
				notFoundRoles: notFound.length > 0 ? notFound : undefined,
			};
		}
		return {
			success: true,
			delivered,
			failed,
			notFoundRoles: notFound.length > 0 ? notFound : undefined,
		};
	}
}
