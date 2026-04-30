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
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
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
	/**
	 * Optional persistent queue for messages whose target session is not yet active.
	 * When provided, a message whose target is declared in the workflow topology or
	 * node_executions (but has no live session yet) is queued instead of failing.
	 * The queue is drained when TaskAgentManager activates the target session.
	 */
	pendingMessageRepo?: PendingAgentMessageRepository;
	/**
	 * Space ID — required when pendingMessageRepo is provided (used when enqueueing).
	 */
	spaceId?: string;
	/**
	 * Task ID — stored on queued messages for diagnostics and filtering.
	 * Optional; defaults to null.
	 */
	taskId?: string;
	/**
	 * Ensures a workflow-node target has a live session before message delivery.
	 * This is intentionally separate from gate evaluation: gates may hold message
	 * content, but they must never prevent the receiving agent from being activated.
	 */
	activateTargetSession?: (
		agentName: string
	) => Promise<Array<{ agentName: string; sessionId: string }>>;
	/**
	 * Optional callback fired after a message is persisted to `pendingMessageRepo`
	 * for a declared-but-inactive target. This is now only a diagnostic/backstop
	 * path; successful send_message results must reflect live delivery, not queueing.
	 *
	 * Fires only for non-deduped enqueues (deduped = message already in queue).
	 */
	onMessageQueued?: (agentName: string) => void;
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
	/**
	 * Messages that were queued for later delivery because the target session
	 * was not yet active. Populated when pendingMessageRepo is configured and
	 * the target is a declared-but-inactive node agent.
	 */
	queued?: Array<{ agentName: string; messageId: string }>;
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
			pendingMessageRepo,
			spaceId,
			taskId,
			activateTargetSession,
			onMessageQueued,
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

		// --- Load ALL executions (for target resolution and declared-agent detection) ---
		// We load ALL executions — not just those with agentSessionId — so we can detect
		// agents that are declared but not yet active (pending activation by the tick loop).
		// This prevents "Unknown target" errors for agents whose sessions haven't spawned yet.
		const allExecutions = nodeExecutionRepo.listByWorkflowRun(workflowRunId);

		// Peers with live sessions — used for direct message injection.
		const execWithSession = allExecutions.filter(
			(e) => e.agentSessionId && e.agentSessionId !== fromSessionId
		);
		if (execWithSession.length === 0 && allExecutions.length > 0) {
			log.warn(
				`[AgentMessageRouter] nodeExecutionRepo has ${allExecutions.length} execution(s) for run ${workflowRunId} ` +
					`but none have an agentSessionId yet — will attempt activation/queuing.`
			);
		}
		let peers: Array<{ sessionId: string; agentName: string }> = execWithSession.map((e) => ({
			sessionId: e.agentSessionId!,
			agentName: e.agentName,
		}));

		// All declared agent names (with or without a live session) for target resolution.
		// Source 1: node_executions (lazily created on first activation).
		// Source 2: workflow definition — every slot declared in any node group is a
		//   legitimate peer name even before its node_execution row exists. nodeGroups
		//   is derived from `workflow.nodes.map(n => resolveNodeAgents(n).map(a => a.name))`
		//   in TaskAgentManager.buildNodeAgentMcpServerForSession, so it covers the full
		//   static workflow surface. Without source 2, never-activated peers fall through
		//   to "Unknown target" — the bug Task #133 closes.
		const allDeclaredAgentNames = new Set(
			allExecutions.filter((e) => e.agentSessionId !== fromSessionId).map((e) => e.agentName)
		);
		if (nodeGroups) {
			for (const slots of Object.values(nodeGroups)) {
				for (const slot of slots) {
					if (slot === fromAgentName) continue;
					allDeclaredAgentNames.add(slot);
				}
			}
		}

		// --- Resolve target agent names ---
		let targetAgentNames: string[];

		if (target === '*') {
			// Broadcast: expand to all topology-permitted targets
			const permittedNodes = resolver.getPermittedTargets(fromNodeName);
			if (permittedNodes.length === 0) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: `No permitted targets for agent '${fromAgentName}' in the declared channel topology.`,
				};
			}
			targetAgentNames = permittedNodes;
		} else if (Array.isArray(target)) {
			// Multicast: explicit list of agent names
			targetAgentNames = target;
		} else if (target === 'task-agent' && taskAgentRouter) {
			targetAgentNames = ['task-agent'];
		} else {
			// Single target: try to resolve by agent name or node name.
			// Resolution order:
			//   1. Agent name matches a live session peer
			//   2. Node name maps to agents via nodeGroups
			//   3. Agent name is declared in any node_execution for this run (pending activation)
			//   4. Channel topology declares a channel to this node name (not yet activated)
			// If none match → unknown target error.
			const agentMatches = peers.filter((m) => m.agentName === target).map((m) => m.agentName);

			if (agentMatches.length > 0) {
				// Agent name → DM to its live session(s)
				targetAgentNames = [target];
			} else if (nodeGroups && nodeGroups[target]) {
				// Node name match → fan-out to all agents in that node
				targetAgentNames = nodeGroups[target];
			} else if (allDeclaredAgentNames.has(target)) {
				// Agent is declared in a node_execution but hasn't spawned a session yet.
				// Route through activation/queue path below.
				targetAgentNames = [target];
			} else {
				// Check if the target is a topology-declared node that hasn't been activated yet.
				// This handles the case where the caller uses a node name that hasn't been seen yet.
				const permittedNodes = resolver.getPermittedTargets(fromNodeName);
				const isTopologyDeclared =
					permittedNodes.includes(target) ||
					permittedNodes.some((n) => resolveNodeName(n) === target);
				if (isTopologyDeclared) {
					// Target is declared in channel topology but not yet activated.
					// Route through activation/queue path below as a single target.
					targetAgentNames = [target];
				} else {
					// No match — unknown target
					const knownAgentNames = [...new Set(peers.map((m) => m.agentName))].sort();
					const nodeNames = nodeGroups ? Object.keys(nodeGroups) : [];
					const allTargets = [
						...new Set([...knownAgentNames, ...nodeNames, ...allDeclaredAgentNames]),
					].sort();
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

		// --- Ensure target sessions are live before content delivery ---
		// ChannelRouter activation above may only create pending node_execution rows.
		// The runtime callback is responsible for spawning/resuming the actual session;
		// send_message must not report success until that session can receive content.
		if (activateTargetSession) {
			const refreshed = new Map(peers.map((peer) => [`${peer.agentName}:${peer.sessionId}`, peer]));
			for (const agentName of targetAgentNames) {
				if (agentName === 'task-agent') continue;
				if (peers.some((peer) => peer.agentName === agentName)) continue;
				try {
					const activatedSessions = await activateTargetSession(agentName);
					for (const session of activatedSessions) {
						refreshed.set(`${session.agentName}:${session.sessionId}`, session);
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.warn(
						`[AgentMessageRouter] failed to activate target session for agent "${agentName}": ${errMsg}`
					);
				}
			}
			peers = [...refreshed.values()].filter((peer) => peer.sessionId !== fromSessionId);
		}

		// --- Build the message content (with optional structured-data appendix) ---
		const dataAppendix =
			data && Object.keys(data).length > 0
				? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
				: '';

		// --- Deliver to all resolved sessions (best-effort) ---
		const delivered: Array<{ agentName: string; sessionId: string }> = [];
		const queued: Array<{ agentName: string; messageId: string }> = [];
		const notFound: string[] = [];
		const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];

		for (const agentName of targetAgentNames) {
			if (agentName === 'task-agent') {
				if (!taskAgentRouter) {
					notFound.push(agentName);
					continue;
				}
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
				// No live session for this target. This is not a successful delivery:
				// `delivered: true` requires a live session that received the message.
				// Keep the legacy queue as a recovery backstop only.
				// Queue when:
				//   (a) channelRouter just activated the target node (activatedTargets), OR
				//   (b) the target is already declared in node_executions (pending spawn), OR
				//   (c) the target was resolved from topology (may not have an execution yet)
				// — and a pendingMessageRepo is available for persistent queuing.
				const isDeclaredOrActivated =
					activatedTargets.has(agentName) ||
					// Target appears in a node_execution (pending activation by the tick loop).
					allDeclaredAgentNames.has(agentName) ||
					// Target appears in the channel topology even without an execution record.
					// Three sub-conditions cover the slot/node name mapping in both directions:
					//   n === agentName             — channel target IS the slot name directly (slot-name addressed channel)
					//   resolveNodeName(n) === agentName — channel target is a node name that maps to this agent via slotToNode
					//   n === resolveNodeName(agentName) — agent's slot maps to a node name that is the channel target
					//                                      (node-name addressed channels when nodeGroups is configured)
					resolver
						.getPermittedTargets(fromNodeName)
						.some(
							(n) =>
								n === agentName ||
								resolveNodeName(n) === agentName ||
								n === resolveNodeName(agentName)
						);

				if (isDeclaredOrActivated && pendingMessageRepo && spaceId) {
					// Audited (Task #139): onMessageQueued below covers all
					// queuing paths. No independent activation gap exists —
					// every branch that enqueues also fires the callback.
					// Queue the message (without the "[Message from X]:" prefix — flushPendingMessages
					// adds it at delivery time so the source name is always accurate).
					const rawMessage = `${message}${dataAppendix}`;
					try {
						const { record, deduped } = pendingMessageRepo.enqueue({
							workflowRunId,
							spaceId,
							taskId: taskId ?? null,
							sourceAgentName: fromAgentName,
							targetKind: 'node_agent',
							targetAgentName: agentName,
							message: rawMessage,
							idempotencyKey: JSON.stringify([fromSessionId, agentName, rawMessage]),
							ttlMs: 60_000,
							maxAttempts: 3,
						});
						queued.push({ agentName, messageId: record.id });
						notFound.push(agentName);
						log.info(
							`[AgentMessageRouter] queued message ${record.id} for agent "${agentName}" ` +
								`(run=${workflowRunId}, from=${fromAgentName})`
						);
						// Best-effort auto-resume: if the target already has a known session
						// (e.g. a previous execution that is now idle/completed), trigger an
						// immediate resume so the queue is drained without waiting for the
						// next activation cycle.
						if (!deduped) onMessageQueued?.(agentName);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.warn(
							`[AgentMessageRouter] failed to queue message for agent "${agentName}": ${errMsg}`
						);
						notFound.push(agentName);
					}
				} else if (activatedTargets.has(agentName)) {
					// channelRouter activated the node but no pending queue is configured.
					// The node will be spawned by the tick loop; message delivery is best-effort.
					// Don't count as notFound since the activation handoff was accepted.
					log.warn(
						`[AgentMessageRouter] target "${agentName}" was activated but no pendingMessageRepo is configured — ` +
							`message may not be delivered to the new session. Configure pendingMessageRepo to enable reliable delivery.`
					);
				} else {
					notFound.push(agentName);
				}
				continue;
			}

			for (const member of agentSessions) {
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

		// All outcomes failed (nothing delivered to a live session). A queued row is
		// a recovery artifact, not delivery, so success must stay false when the only
		// outcome was queueing.
		if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`Could not deliver message to target agent(s): ${notFound.join(', ')}. ` +
					`The target is declared but no live session received the message.`,
				queued: queued.length > 0 ? queued : undefined,
				notFoundAgentNames: notFound,
			};
		}

		if (delivered.length === 0 && queued.length === 0 && failed.length > 0) {
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
				queued: queued.length > 0 ? queued : undefined,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
			};
		}
		return {
			success: true,
			delivered,
			failed,
			queued: queued.length > 0 ? queued : undefined,
			notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
		};
	}
}
