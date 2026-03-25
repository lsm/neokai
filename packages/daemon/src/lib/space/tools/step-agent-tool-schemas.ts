/**
 * Step Agent MCP Tool Schemas — Zod schemas and TypeScript types for the 3
 * peer communication tools available to step agent sub-sessions.
 *
 * Tools:
 *   list_peers   — list other group members with their roles, statuses, and permitted channels
 *   send_message — channel-validated direct messaging tool
 *   report_done  — signal that this agent has completed its work
 *
 * This file contains only schema definitions — no runtime logic or side effects.
 *
 * Style conventions (matching task-agent-tool-schemas.ts):
 *   - z.string().describe() on every field — .describe() before .optional()
 *   - optional fields use .optional() after .describe()
 *   - union types use z.union([...]) for discriminated inputs
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
 *   - Point-to-point: `target: 'coder'`
 *   - Broadcast to all permitted: `target: '*'`
 *   - Multicast: `target: ['coder', 'reviewer']`
 */
export const SendMessageSchema = z.object({
	/**
	 * Target role(s) to send the message to.
	 * - String: point-to-point to a single role (e.g., 'coder')
	 * - '*': broadcast to all roles permitted by channel topology
	 * - Array of strings: multicast to multiple specific roles
	 */
	target: z
		.union([
			z.string().describe('Role name or * for broadcast'),
			z.array(z.string()).describe('Array of role names for multicast'),
		])
		.describe(
			"Target role(s): a role name (e.g., 'coder'), '*' for broadcast to all permitted targets, or an array of role names for multicast"
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
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * All step agent tool schemas keyed by tool name.
 */
export const STEP_AGENT_TOOL_SCHEMAS = {
	list_peers: ListPeersSchema,
	send_message: SendMessageSchema,
	report_done: ReportDoneSchema,
} as const;

export type StepAgentToolName = keyof typeof STEP_AGENT_TOOL_SCHEMAS;
