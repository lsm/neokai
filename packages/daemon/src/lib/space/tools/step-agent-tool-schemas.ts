/**
 * Step Agent MCP Tool Schemas — Zod schemas and TypeScript types for the 3
 * peer communication tools available to step agent sub-sessions.
 *
 * Tools:
 *   list_peers   — list other group members with their roles, statuses, and permitted channels
 *   send_message — channel-validated direct messaging tool (string-based target)
 *   report_done  — signal that this agent has completed its work
 *
 * This file contains only schema definitions — no runtime logic or side effects.
 *
 * Style conventions (matching task-agent-tool-schemas.ts):
 *   - z.string().describe() on every field — .describe() before .optional()
 *   - optional fields use .optional() after .describe()
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// list_peers
// ---------------------------------------------------------------------------

/**
 * Schema for `list_peers` input.
 * Lists all other members of the current workflow step group.
 * No arguments — the group and self are inferred from the step agent context.
 */
export const ListPeersSchema = z.object({});

export type ListPeersInput = z.infer<typeof ListPeersSchema>;

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

/**
 * Schema for `send_message` input.
 *
 * Primary direct messaging tool for step agents. Validates against declared channel
 * topology before routing. Supports three target forms:
 *   - Agent name (role): `target: 'coder'` — DM to the named agent
 *   - Node name: `target: 'node-name'` — fan-out to all agents in the named node
 *   - Broadcast to all permitted: `target: '*'`
 */
export const SendMessageSchema = z.object({
	/**
	 * Delivery target: an agent role name for DM, a node name for fan-out,
	 * or '*' for broadcast to all topology-permitted targets.
	 * - Agent name: delivers to the specific agent (or all agents sharing the role)
	 * - Node name: fan-out to all agents in the named node
	 * - '*': broadcast to all permitted targets
	 */
	target: z
		.string()
		.describe(
			"Delivery target: agent role name (DM), node name (fan-out), or '*' (broadcast to all permitted targets)"
		),
	/** The message to send to the target(s). */
	message: z.string().min(1).describe('The message content to send to the target peer(s)'),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// ---------------------------------------------------------------------------
// report_done
// ---------------------------------------------------------------------------

/**
 * Schema for `report_done` input.
 *
 * Signals that this step agent has completed its work. Marks the step's SpaceTask
 * as 'completed' and persists an optional summary as the task result.
 */
export const ReportDoneSchema = z.object({
	/** Optional summary of what was accomplished. Persisted as the task result. */
	summary: z
		.string()
		.describe(
			'Optional summary of what was accomplished. Will be persisted as the task completion result.'
		)
		.optional(),
});

export type ReportDoneInput = z.infer<typeof ReportDoneSchema>;

// ---------------------------------------------------------------------------
// list_reachable_agents
// ---------------------------------------------------------------------------

/**
 * Schema for `list_reachable_agents` input.
 * Lists all agents and nodes this agent can reach, grouped by within-node peers
 * and cross-node targets. Includes gate status for cross-node targets.
 * No arguments — the reachability graph is inferred from the agent's context.
 */
export const ListReachableAgentsSchema = z.object({});

export type ListReachableAgentsInput = z.infer<typeof ListReachableAgentsSchema>;

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * All step agent tool schemas keyed by tool name.
 */
export const STEP_AGENT_TOOL_SCHEMAS = {
	list_peers: ListPeersSchema,
	send_message: SendMessageSchema,
	report_done: ReportDoneSchema,
	list_reachable_agents: ListReachableAgentsSchema,
} as const;

export type StepAgentToolName = keyof typeof STEP_AGENT_TOOL_SCHEMAS;
