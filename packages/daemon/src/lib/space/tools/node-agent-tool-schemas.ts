/**
 * Node Agent MCP Tool Schemas — Zod schemas and TypeScript types for the 3
 * peer communication tools available to node agent sub-sessions.
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
 * No arguments — the group and self are inferred from the node agent context.
 */
export const ListPeersSchema = z.object({});

export type ListPeersInput = z.infer<typeof ListPeersSchema>;

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

/**
 * Schema for `send_message` input.
 *
 * Primary direct messaging tool for node agents. Validates against declared channel
 * topology before routing. Supports four target forms:
 *   - Agent name (role): `target: 'coder'` — DM to the named agent
 *   - Node name: `target: 'node-name'` — fan-out to all agents in the named node
 *   - Multicast array: `target: ['coder', 'reviewer']` — deliver to multiple roles
 *   - Broadcast to all permitted: `target: '*'`
 */
export const SendMessageSchema = z.object({
	/**
	 * Delivery target: an agent role name for DM, a node name for fan-out,
	 * an array of role names for multicast, or '*' for broadcast to all topology-permitted targets.
	 * - Agent name: delivers to the specific agent (or all agents sharing the role)
	 * - Node name: fan-out to all agents in the named node
	 * - Array of role names: multicast to each specified role (all must be permitted)
	 * - '*': broadcast to all permitted targets
	 */
	target: z
		.union([z.string(), z.array(z.string())])
		.describe(
			"Delivery target: agent role name (DM), node name (fan-out), array of role names (multicast), or '*' (broadcast to all permitted targets)"
		),
	/** The message to send to the target(s). */
	message: z.string().min(1).describe('The message content to send to the target peer(s)'),
	/**
	 * Optional structured data payload attached to the message.
	 * Used for machine-readable data (gate writes, task results, structured feedback)
	 * alongside the human-readable `message` text.
	 */
	data: z
		.record(z.string(), z.unknown())
		.describe(
			'Optional structured data payload (key-value pairs) attached to the message. Used for gate writes, task results, and structured feedback.'
		)
		.optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// ---------------------------------------------------------------------------
// report_done
// ---------------------------------------------------------------------------

/**
 * Schema for `report_done` input.
 *
 * Signals that this node agent has completed its work. Marks the step's SpaceTask
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
// list_channels
// ---------------------------------------------------------------------------

/**
 * Schema for `list_channels` input.
 * Lists all channels declared in the current workflow.
 * No arguments — channels are derived from the workflow run context.
 */
export const ListChannelsSchema = z.object({});

export type ListChannelsInput = z.infer<typeof ListChannelsSchema>;

// ---------------------------------------------------------------------------
// list_gates
// ---------------------------------------------------------------------------

/**
 * Schema for `list_gates` input.
 * Lists all gates declared in the current workflow with their current data.
 * No arguments — gates are derived from the workflow run context.
 */
export const ListGatesSchema = z.object({});

export type ListGatesInput = z.infer<typeof ListGatesSchema>;

// ---------------------------------------------------------------------------
// read_gate
// ---------------------------------------------------------------------------

/**
 * Schema for `read_gate` input.
 * Reads the current runtime data for a specific gate from the gate_data table.
 */
export const ReadGateSchema = z.object({
	/** The ID of the gate to read data for. */
	gateId: z.string().min(1).describe('The gate ID to read current data for'),
});

export type ReadGateInput = z.infer<typeof ReadGateSchema>;

// ---------------------------------------------------------------------------
// write_gate
// ---------------------------------------------------------------------------

/**
 * Schema for `write_gate` input.
 *
 * Merges key-value data into a gate's runtime data store. The caller's role must
 * be listed in the gate's `allowedWriterRoles` (or the list contains `'*'`).
 *
 * For vote-counting gates (count conditions): use your `nodeId` (returned in the
 * tool response) as the key in the vote map so each node's vote counts only once
 * even if multiple agents in the node send votes.
 */
export const WriteGateSchema = z.object({
	/** The ID of the gate to write data to. */
	gateId: z.string().min(1).describe('The gate ID to write data to'),
	/**
	 * Key-value data to merge (shallow) into the gate's data store.
	 * For vote-counting (count conditions), use your nodeId (provided in the response)
	 * as the map key: e.g. { votes: { [nodeId]: "approved" } }
	 */
	data: z
		.record(z.string(), z.unknown())
		.describe(
			'Key-value data to merge into the gate data store. Shallow merge: top-level keys overwrite existing entries.'
		),
});

export type WriteGateInput = z.infer<typeof WriteGateSchema>;

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * All node agent tool schemas keyed by tool name.
 */
export const NODE_AGENT_TOOL_SCHEMAS = {
	list_peers: ListPeersSchema,
	send_message: SendMessageSchema,
	report_done: ReportDoneSchema,
	list_reachable_agents: ListReachableAgentsSchema,
	list_channels: ListChannelsSchema,
	list_gates: ListGatesSchema,
	read_gate: ReadGateSchema,
	write_gate: WriteGateSchema,
} as const;

export type NodeAgentToolName = keyof typeof NODE_AGENT_TOOL_SCHEMAS;
