/**
 * Step Agent Tools — MCP tool handlers for step agent sub-sessions.
 *
 * These handlers implement peer communication tools for step agents within
 * the same workflow step group:
 *
 *   list_peers   — discover other group members with roles and permitted channels
 *   send_message — primary channel-validated direct messaging tool
 *   report_done  — signal that this agent has completed its step task
 *
 * Communication model:
 * - Step agents communicate via declared channel topology (`send_message`).
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
 * - Dependencies are injected via `StepAgentToolsConfig`.
 * - `messageInjector` is backed by `injectSubSessionMessage` → `injectMessageIntoSession`
 *   → `session.messageQueue.enqueueWithId()`, which provides per-session write ordering.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonHub } from '../../daemon-hub';
import { Logger } from '../../logger';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceSessionGroupRepository } from '../../../storage/repositories/space-session-group-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { ChannelResolver } from '../runtime/channel-resolver';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	ListPeersSchema,
	SendMessageSchema,
	ReportDoneSchema,
	ListReachableAgentsSchema,
} from './step-agent-tool-schemas';
import type {
	ListPeersInput,
	SendMessageInput,
	ReportDoneInput,
	ListReachableAgentsInput,
} from './step-agent-tool-schemas';

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('step-agent-tools');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createStepAgentToolHandlers().
 * All fields are required unless noted — the caller (TaskAgentManager) wires them up.
 */
export interface StepAgentToolsConfig {
	/** Session ID of this step agent (used to exclude self from list_peers). */
	mySessionId: string;
	/** Role of this step agent (e.g., 'coder', 'reviewer'). */
	myRole: string;
	/** ID of the parent task (used for error messages). */
	taskId: string;
	/** ID of the step-level SpaceTask this agent is executing. Used by report_done. */
	stepTaskId: string;
	/** Space ID — used for event emission in report_done. */
	spaceId: string;
	/** Workflow run ID — used to load channel topology from run config. */
	workflowRunId: string;
	/** Session group repository for looking up group members. */
	sessionGroupRepo: SpaceSessionGroupRepository;
	/** Returns the group ID for this task from the in-memory map. */
	getGroupId: () => string | undefined;
	/** Workflow run repository for reading run config (channel topology). */
	workflowRunRepo: SpaceWorkflowRunRepository;
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
		stepTaskId,
		spaceId,
		workflowRunId,
		sessionGroupRepo,
		getGroupId,
		workflowRunRepo,
		spaceTaskRepo,
		workflowNodeId,
		messageInjector,
		taskManager,
		daemonHub,
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
			const loaded = loadGroupAndResolver();
			if (!loaded.ok) return loaded.error;
			const { group, resolver } = loaded;

			// Build completion state map from tasks on the current workflow node
			const nodeTasks =
				workflowRunId && workflowNodeId
					? spaceTaskRepo
							.listByWorkflowRun(workflowRunId)
							.filter((t) => t.workflowNodeId === workflowNodeId)
					: [];
			const completionByAgentName = new Map(
				nodeTasks.filter((t) => t.agentName != null).map((t) => [t.agentName as string, t])
			);

			// Filter out self and task-agent (coordinator)
			const peers = group.members
				.filter((m) => m.sessionId !== mySessionId && m.role !== 'task-agent')
				.map((m) => {
					const nodeTask = completionByAgentName.get(m.role) ?? null;
					return {
						sessionId: m.sessionId,
						role: m.role,
						agentId: m.agentId ?? null,
						status: m.status,
						completionState: nodeTask
							? {
									agentName: nodeTask.agentName ?? null,
									taskStatus: nodeTask.status,
									completionSummary: nodeTask.completionSummary ?? null,
									completedAt: nodeTask.completedAt ?? null,
								}
							: null,
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
		 * Send a message directly to one or more peer agents.
		 *
		 * Validates the requested direction(s) against the declared channel topology
		 * before routing.
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
		async send_message(args: SendMessageInput): Promise<ToolResult> {
			const { target, message } = args;

			const loaded = loadGroupAndResolver();
			if (!loaded.ok) return loaded.error;
			const { group, resolver } = loaded;

			// When no channel topology is declared for this step, all send_message calls fail.
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
				});
			}

			// Find peer sessions for each target role (exclude self and task-agent)
			const peers = group.members.filter(
				(m) => m.sessionId !== mySessionId && m.role !== 'task-agent'
			);
			const delivered: Array<{ role: string; sessionId: string }> = [];
			const notFound: string[] = [];
			const failed: Array<{ role: string; sessionId: string; error: string }> = [];

			// Best-effort delivery: attempt all targets, aggregate errors.
			// This avoids the partial-delivery / stop-on-first-error problem where
			// some peers receive the message while others don't, and the caller gets
			// success: false despite partial delivery having already occurred.
			for (const targetRole of targetRoles) {
				const targetSessions = peers.filter((m) => m.role === targetRole);
				if (targetSessions.length === 0) {
					notFound.push(targetRole);
					continue;
				}
				for (const targetMember of targetSessions) {
					const prefixedMessage = `[Message from ${myRole}]: ${message}`;
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
				// Partial or total delivery failure — report what was and was not delivered.
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
			const loaded = loadGroupAndResolver();
			if (!loaded.ok) return loaded.error;
			const { group, resolver } = loaded;

			// Within-node peers: group members excluding self and the task-agent coordinator
			const withinNodePeers = group.members
				.filter((m) => m.sessionId !== mySessionId && m.role !== 'task-agent')
				.map((m) => ({
					agentName: m.role,
					status: m.status,
				}));

			const reachabilityDeclared = !resolver.isEmpty();

			// Cross-node targets: outgoing channel entries where the target role is NOT
			// already in the current session group (i.e., it lives on a different node).
			const withinNodeRoles = new Set(group.members.map((m) => m.role));

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
		 * Signal that this step agent has completed its work.
		 *
		 * Marks the step's SpaceTask as 'completed', persists the optional summary
		 * as the task result, and emits a `space.task.updated` event for real-time UI.
		 *
		 * After calling this tool, the step agent should stop and not perform
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
 * Create an MCP server exposing all step agent peer communication tools.
 * Pass the returned server to the AgentSessionInit.mcpServers for step agent sessions.
 */
export function createStepAgentMcpServer(config: StepAgentToolsConfig) {
	const handlers = createStepAgentToolHandlers(config);

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
			'send_message',
			'Send a message directly to one or more peer agents via declared channel topology. ' +
				"Supports point-to-point ('coder'), broadcast ('*'), and multicast (['coder','reviewer']). " +
				'Validates against declared channels — returns an error with available channels if unauthorized.',
			SendMessageSchema.shape,
			(args) => handlers.send_message(args)
		),
		tool(
			'report_done',
			'Signal that this step agent has completed its work. ' +
				'Marks the step task as completed and persists an optional summary as the result. ' +
				'Call this when you have finished all assigned work. ' +
				'After calling this tool, stop — do not continue with further actions.',
			ReportDoneSchema.shape,
			(args) => handlers.report_done(args)
		),
	];

	return createSdkMcpServer({ name: 'step-agent', tools });
}

export type StepAgentMcpServer = ReturnType<typeof createStepAgentMcpServer>;
