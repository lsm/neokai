/**
 * Step Agent Tools — MCP tool handlers for step agent sub-sessions.
 *
 * These handlers implement peer communication tools for step agents within
 * the same workflow step group:
 *
 *   list_peers          — discover other group members with roles and permitted channels
 *   send_feedback       — primary channel-validated direct messaging tool
 *   request_peer_input  — fallback Task Agent mediated messaging (async)
 *
 * Communication model:
 * - Step agents communicate via declared channel topology (`send_feedback`).
 * - When no channel is declared, or as a fallback, use `request_peer_input`
 *   which routes through the Task Agent.
 * - `list_peers` reveals who is in the group and what channels are available.
 *
 * Channel topology patterns supported:
 *   - Bidirectional point-to-point: A↔B (both directions permitted)
 *   - One-way: A→B (only A can send to B)
 *   - Fan-out one-way: hub→[spoke1, spoke2, ...]
 *   - Hub-spoke: hub↔spokes (hub sends to all, spokes only reply to hub)
 *
 * When no channels are declared for a step, all `send_feedback` calls fail with
 * a suggestion to use `request_peer_input` instead.
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `StepAgentToolsConfig`.
 * - `messageInjector` is backed by `injectSubSessionMessage` → `injectMessageIntoSession`
 *   → `session.messageQueue.enqueueWithId()`, which provides per-session write ordering.
 * - The `injectToTaskAgent` callback is used by `request_peer_input` for routing.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SpaceSessionGroupRepository } from '../../../storage/repositories/space-session-group-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { ChannelResolver } from '../runtime/channel-resolver';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	ListPeersSchema,
	SendFeedbackSchema,
	RequestPeerInputSchema,
} from './step-agent-tool-schemas';
import type {
	ListPeersInput,
	SendFeedbackInput,
	RequestPeerInputInput,
} from './step-agent-tool-schemas';

// Re-export for consumers that want the shared type
export type { ToolResult };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createStepAgentToolHandlers().
 * All fields are required — the caller (TaskAgentManager) wires them up.
 */
export interface StepAgentToolsConfig {
	/** Session ID of this step agent (used to exclude self from list_peers). */
	mySessionId: string;
	/** Role of this step agent (e.g., 'coder', 'reviewer'). */
	myRole: string;
	/** ID of the parent task (used for error messages). */
	taskId: string;
	/** Workflow run ID — used to load channel topology from run config. */
	workflowRunId: string;
	/** Session group repository for looking up group members. */
	sessionGroupRepo: SpaceSessionGroupRepository;
	/** Returns the group ID for this task from the in-memory map. */
	getGroupId: () => string | undefined;
	/** Workflow run repository for reading run config (channel topology). */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/**
	 * Injects a message into a peer sub-session as a user turn.
	 * Used by `send_feedback` to deliver messages to target sessions.
	 */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Injects a message into the Task Agent session.
	 * Used by `request_peer_input` to route questions through the Task Agent.
	 */
	injectToTaskAgent: (message: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions for the step agent peer communication tools.
 * Returns a map of tool name → async handler function.
 */
export function createStepAgentToolHandlers(config: StepAgentToolsConfig) {
	const {
		mySessionId,
		myRole,
		taskId,
		workflowRunId,
		sessionGroupRepo,
		getGroupId,
		workflowRunRepo,
		messageInjector,
		injectToTaskAgent,
	} = config;

	type GroupLoaded = {
		ok: true;
		group: NonNullable<ReturnType<typeof sessionGroupRepo.getGroup>>;
		resolver: ChannelResolver;
		groupId: string;
	};
	type GroupError = { ok: false; error: ToolResult };

	/**
	 * Helper: load the group and build a ChannelResolver from the current run config.
	 * Returns a discriminated union — callers check `result.ok` before accessing `group`.
	 */
	function loadGroupAndResolver(): GroupLoaded | GroupError {
		const groupId = getGroupId();
		if (!groupId) {
			return {
				ok: false,
				error: jsonResult({
					success: false,
					error:
						`No session group found for task ${taskId}. ` +
						`The group may not have been created yet.`,
				}),
			};
		}

		const group = sessionGroupRepo.getGroup(groupId);
		if (!group) {
			return {
				ok: false,
				error: jsonResult({
					success: false,
					error: `Session group ${groupId} not found in the database.`,
				}),
			};
		}

		// Build ChannelResolver from the active workflow run's config
		const run = workflowRunRepo.getRun(workflowRunId);
		const resolver = ChannelResolver.fromRunConfig(
			run?.config as Record<string, unknown> | undefined
		);

		return { ok: true, group, resolver, groupId };
	}

	return {
		/**
		 * List all peers (other group members) with their roles, statuses, session IDs,
		 * and permitted channel connections.
		 *
		 * Does NOT include self (filtered by `mySessionId`).
		 * Does NOT include the Task Agent (filtered by role 'task-agent').
		 *
		 * Returns permittedTargets: roles this agent can directly send to via send_feedback.
		 */
		async list_peers(_args: ListPeersInput): Promise<ToolResult> {
			const loaded = loadGroupAndResolver();
			if (!loaded.ok) return loaded.error;
			const { group, resolver } = loaded;

			// Filter out self and task-agent (coordinator)
			const peers = group.members
				.filter((m) => m.sessionId !== mySessionId && m.role !== 'task-agent')
				.map((m) => ({
					sessionId: m.sessionId,
					role: m.role,
					agentId: m.agentId ?? null,
					status: m.status,
				}));

			const permittedTargets = resolver.getPermittedTargets(myRole);
			const channelTopologyDeclared = !resolver.isEmpty();

			return jsonResult({
				success: true,
				myRole,
				peers,
				permittedTargets,
				channelTopologyDeclared,
				message:
					`Found ${peers.length} peer(s). ` +
					(channelTopologyDeclared
						? `Permitted direct targets via send_feedback: ${permittedTargets.length > 0 ? permittedTargets.join(', ') : 'none'}.`
						: 'No channel topology declared — use request_peer_input to communicate with peers.'),
			});
		},

		/**
		 * Send a message directly to one or more peer agents.
		 *
		 * Validates the requested direction(s) against the declared channel topology
		 * before routing. On validation failure, returns an error with available channels
		 * and suggests `request_peer_input` as a fallback.
		 *
		 * Target forms:
		 *   - `target: 'coder'` — point-to-point to a single role
		 *   - `target: '*'` — broadcast to all permitted targets
		 *   - `target: ['coder', 'reviewer']` — multicast to multiple roles
		 *
		 * Fan-out one-way and hub-spoke enforcement:
		 *   - Spokes can only send to roles where canSend(myRole, targetRole) is true
		 *   - Hub-spoke isolation is enforced by channel topology (spoke→spoke channels
		 *     are not declared; spokes can only reply to hub)
		 */
		async send_feedback(args: SendFeedbackInput): Promise<ToolResult> {
			const { target, message } = args;

			const loaded = loadGroupAndResolver();
			if (!loaded.ok) return loaded.error;
			const { group, resolver } = loaded;

			// When no channel topology is declared for this step, all send_feedback calls
			// fail. Agents in a step with no declared channels must use request_peer_input
			// so that all inter-agent communication is mediated by the Task Agent.
			if (resolver.isEmpty()) {
				return jsonResult({
					success: false,
					error:
						`No channel topology declared for this step. ` +
						`Direct messaging via send_feedback is not available. ` +
						`Use request_peer_input to communicate with peers through the Task Agent.`,
					suggestion: 'request_peer_input',
				});
			}

			// Resolve target roles from the target argument
			let targetRoles: string[];

			if (target === '*') {
				// Broadcast: expand to all permitted targets
				const permitted = resolver.getPermittedTargets(myRole);
				if (permitted.length === 0) {
					return jsonResult({
						success: false,
						error:
							`No permitted targets for role '${myRole}' in the declared channel topology. ` +
							`Broadcast ('*') requires at least one permitted outgoing channel.`,
						availableTargets: [],
						suggestion: 'request_peer_input',
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
					suggestion:
						'Use request_peer_input to route through the Task Agent for undeclared channels.',
				});
			}

			// Resolve target roles to session IDs from group members
			// Multiple members can share the same role (parallel instances)
			const targetMembers = group.members.filter(
				(m) =>
					targetRoles.includes(m.role) && m.sessionId !== mySessionId && m.role !== 'task-agent'
			);

			if (targetMembers.length === 0) {
				return jsonResult({
					success: false,
					error:
						`No active sessions found for target role(s): ${targetRoles.join(', ')}. ` +
						`Use list_peers to check which peers are currently active.`,
					targetRoles,
				});
			}

			// Prefix message with sender identity so the receiver can attribute it.
			// Without this, agents in multi-peer groups cannot tell who sent the message.
			const attributedMessage = `[Feedback from ${myRole}]: ${message}`;

			// Inject message into each target session
			const injected: Array<{ sessionId: string; role: string }> = [];
			const failed: Array<{ sessionId: string; role: string; error: string }> = [];

			for (const member of targetMembers) {
				try {
					await messageInjector(member.sessionId, attributedMessage);
					injected.push({ sessionId: member.sessionId, role: member.role });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					failed.push({ sessionId: member.sessionId, role: member.role, error: msg });
				}
			}

			if (injected.length === 0) {
				return jsonResult({
					success: false,
					error: `Failed to deliver message to any target. All injections failed.`,
					failed,
				});
			}

			return jsonResult({
				success: true,
				delivered: injected,
				...(failed.length > 0 ? { partialFailures: failed } : {}),
				message:
					`Message delivered to ${injected.length} peer(s): ` +
					injected.map((t) => `${t.role} (${t.sessionId})`).join(', ') +
					'.',
			});
		},

		/**
		 * Route a question or request through the Task Agent to a peer.
		 *
		 * This is the FALLBACK tool for when no direct channel is declared, or when
		 * `send_feedback` fails validation. It routes through the Task Agent, which
		 * has unrestricted relay access to all group members.
		 *
		 * ASYNC and NON-BLOCKING — returns immediately with an acknowledgment.
		 * The peer's answer will arrive as a separate user turn in this session,
		 * prefixed with: `[Peer response from {role}]: ...`
		 *
		 * Do NOT wait for an immediate reply. Continue working and process the peer's
		 * response when it arrives.
		 */
		async request_peer_input(args: RequestPeerInputInput): Promise<ToolResult> {
			const { target_role, question } = args;

			// Format the routing request for the Task Agent
			const routingMessage =
				`[Peer input request from '${myRole}' (session ${mySessionId}) to '${target_role}']: ` +
				`${question}\n\n` +
				`Please relay this question to the '${target_role}' peer and forward their response back to '${myRole}' ` +
				`(session ${mySessionId}) prefixed with: [Peer response from ${target_role}]: ...`;

			try {
				await injectToTaskAgent(routingMessage);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return jsonResult({
					success: false,
					error: `Failed to route request through Task Agent: ${msg}`,
				});
			}

			return jsonResult({
				success: true,
				targetRole: target_role,
				message:
					`Request routed to Task Agent for delivery to '${target_role}'. ` +
					`This is async — continue your work. ` +
					`The peer's response will arrive as a user turn prefixed with: [Peer response from ${target_role}]: ...`,
				async: true,
			});
		},
	};
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server exposing all step agent peer communication tools.
 * Pass the returned server to the AgentSessionInit.mcpServers for step agent sessions.
 */
export function createStepAgentMcpServer(config: StepAgentToolsConfig) {
	const handlers = createStepAgentToolHandlers(config);

	const tools = [
		tool(
			'list_peers',
			'List all other agents in this workflow step group with their roles, statuses, session IDs, ' +
				'and permitted channel connections. ' +
				'Use this to discover which peers are active and what direct messaging channels are available.',
			ListPeersSchema.shape,
			(args) => handlers.list_peers(args)
		),
		tool(
			'send_feedback',
			'Send a message directly to one or more peer agents via declared channel topology. ' +
				"Supports point-to-point ('coder'), broadcast ('*'), and multicast (['coder','reviewer']). " +
				'Validates against declared channels — returns an error with available channels if unauthorized. ' +
				'Use request_peer_input as a fallback when no channel is declared.',
			SendFeedbackSchema.shape,
			(args) => handlers.send_feedback(args)
		),
		tool(
			'request_peer_input',
			'Route a question or request to a peer through the Task Agent. ' +
				'Use this when no direct channel is declared or as a fallback when send_feedback fails. ' +
				'Call list_peers first to verify the target_role exists in the group. ' +
				'ASYNC: returns immediately. The peer response arrives later as a user turn prefixed with [Peer response from {role}]: ...',
			RequestPeerInputSchema.shape,
			(args) => handlers.request_peer_input(args)
		),
	];

	return createSdkMcpServer({ name: 'step-agent', tools });
}

export type StepAgentMcpServer = ReturnType<typeof createStepAgentMcpServer>;
