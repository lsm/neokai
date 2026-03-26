/**
 * AgentMessageRouter — unified message delivery for step agents.
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
 * is used by step-agent-tools to deliver messages between live sessions at runtime.
 * TODO: Remove once TaskAgentManager wires up the workflow-level ChannelRouter for
 *   all sub-sessions and step-agent-tools can delegate to it directly.
 */

import type { SpaceSessionGroupRepository } from '../../../storage/repositories/space-session-group-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { ChannelResolver } from './channel-resolver';

export interface AgentMessageRouterConfig {
	/** Session group repository for looking up group members. */
	sessionGroupRepo: SpaceSessionGroupRepository;
	/** Returns the group ID for the current task. */
	getGroupId: () => string | undefined;
	/** Workflow run repository for loading channel topology. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Workflow run ID for loading channel topology from run config. */
	workflowRunId: string;
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
	 * or '*' (broadcast to all permitted targets).
	 */
	target: string;
	/** Message content to deliver. */
	message: string;
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
	 * Target roles that had no active sessions in the group.
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
	 *   2. Agent name match → DM/fan-out to all sessions with that role in the group
	 *   3. Node name match → fan-out to all agents mapped to that node (via nodeGroups)
	 *   4. No match → error with list of known reachable agents
	 *
	 * Authorization is checked against the declared channel topology before delivery.
	 * Returns a structured result — never throws.
	 */
	async deliverMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
		const { fromRole, fromSessionId, target, message } = params;
		const {
			sessionGroupRepo,
			getGroupId,
			workflowRunRepo,
			workflowRunId,
			messageInjector,
			nodeGroups,
		} = this.config;

		// --- Load group ---
		const groupId = getGroupId();
		if (!groupId) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason: 'No session group found. The group may not have been created yet.',
			};
		}
		const group = sessionGroupRepo.getGroup(groupId);
		if (!group) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason: `Session group ${groupId} not found.`,
			};
		}

		// --- Build channel resolver ---
		const run = workflowRunRepo.getRun(workflowRunId);
		const resolver = ChannelResolver.fromRunConfig(
			run?.config as Record<string, unknown> | undefined
		);

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

		// Peers: exclude self and task-agent
		const peers = group.members.filter(
			(m) => m.sessionId !== fromSessionId && m.role !== 'task-agent'
		);

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
		} else {
			// Try agent name match first (role string within the group)
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
				const prefixedMessage = `[Message from ${fromRole}]: ${message}`;
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
