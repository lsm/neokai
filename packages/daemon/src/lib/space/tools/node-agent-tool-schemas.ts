/**
 * Node Agent MCP Tool Schemas — Zod schemas and TypeScript types for the
 * tools available to node agent sub-sessions.
 *
 * Action tools:
 *   send_message — channel-validated direct messaging; writes gate data on gated channels
 *   save         — persist agent output (summary + structured data) to NodeExecution
 *
 * Discovery tools (read-only):
 *   list_peers           — list other group members with statuses and permitted channels
 *   list_reachable_agents — list all reachable agents/nodes grouped by proximity
 *   list_channels        — list all channels declared in the workflow
 *   list_gates           — list all gates with current runtime data
 *   read_gate            — read current data for a specific gate
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
 * Lists all other members of the current workflow node group.
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
 *   - Agent name: `target: 'coder'` — DM to the named agent
 *   - Node name: `target: 'node-name'` — fan-out to all agents in the named node
 *   - Multicast array: `target: ['coder', 'reviewer']` — deliver to multiple agents
 *   - Broadcast to all permitted: `target: '*'`
 *
 * When the target channel is gated, the optional `data` payload is automatically
 * merged into the gate's data store (merge semantics: top-level keys overwrite,
 * other keys survive). Gate re-evaluation fires after the merge — if the gate
 * opens, the message is delivered immediately; otherwise it is held until the
 * gate condition passes.
 */
export const SendMessageSchema = z.object({
	/**
	 * Delivery target: an agent name for DM, a node name for fan-out,
	 * an array of agent names for multicast, or '*' for broadcast to all topology-permitted targets.
	 * - Agent name: delivers to the specific agent (or all agents sharing the name)
	 * - Node name: fan-out to all agents in the named node
	 * - Array of agent names: multicast to each specified agent (all must be permitted)
	 * - '*': broadcast to all permitted targets
	 */
	target: z
		.union([z.string(), z.array(z.string())])
		.describe(
			"Delivery target: agent name (DM), node name (fan-out), array of agent names (multicast), or '*' (broadcast to all permitted targets)"
		),
	/** The message to send to the target(s). */
	message: z.string().min(1).describe('The message content to send to the target peer(s)'),
	/**
	 * Optional structured data payload attached to the message.
	 * When the target channel is gated, this data is automatically merged into the gate.
	 * Also passed through to the target as part of the delivery.
	 */
	data: z
		.record(z.string(), z.unknown())
		.describe(
			'Optional structured data payload. Automatically merged into the gate data store when the channel is gated (merge semantics). Also passed through to the target agent.'
		)
		.optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

/**
 * Schema for `save` input.
 *
 * Persists the agent's output to the NodeExecution record.
 * Call this whenever you have produced output worth recording — at any point
 * during your work, not just at the end. Multiple calls overwrite previous values.
 *
 * `summary` and `data` are independent — provide either or both.
 */
export const SaveSchema = z.object({
	/**
	 * Human-readable summary of work completed so far.
	 * Overwrites any previous summary on each call.
	 */
	summary: z
		.string()
		.describe('Human-readable summary of work completed. Overwrites previous summary.')
		.optional(),
	/**
	 * Structured output data (key-value pairs) produced by this agent.
	 * Use for machine-readable artifacts: pr_url, commit_sha, test_results, etc.
	 * Overwrites previous data on each call.
	 */
	data: z
		.record(z.string(), z.unknown())
		.describe(
			'Structured output data (key-value pairs). Use for artifacts like pr_url, commit_sha, test_results. Overwrites previous data.'
		)
		.optional(),
});

export type SaveInput = z.infer<typeof SaveSchema>;

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
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * All node agent tool schemas keyed by tool name.
 */
export const NODE_AGENT_TOOL_SCHEMAS = {
	list_peers: ListPeersSchema,
	send_message: SendMessageSchema,
	save: SaveSchema,
	list_reachable_agents: ListReachableAgentsSchema,
	list_channels: ListChannelsSchema,
	list_gates: ListGatesSchema,
	read_gate: ReadGateSchema,
} as const;

export type NodeAgentToolName = keyof typeof NODE_AGENT_TOOL_SCHEMAS;
