/**
 * Step Agent MCP Tool Schemas — Zod schemas and TypeScript types for the 3
 * peer communication tools available to step agent sub-sessions.
 *
 * Tools:
 *   list_peers          — list other group members with their roles, statuses, and permitted channels
 *   send_feedback       — primary channel-validated direct messaging tool
 *   request_peer_input  — fallback Task Agent mediated messaging tool
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
// send_feedback
// ---------------------------------------------------------------------------

/**
 * Schema for `send_feedback` input.
 *
 * Primary direct messaging tool for step agents. Validates against declared channel
 * topology before routing. Supports three target forms:
 *   - Point-to-point: `target: 'coder'`
 *   - Broadcast to all permitted: `target: '*'`
 *   - Multicast: `target: ['coder', 'reviewer']`
 *
 * Returns an error with available channels and suggests `request_peer_input` when
 * the channel topology does not permit the requested direction.
 */
export const SendFeedbackSchema = z.object({
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

export type SendFeedbackInput = z.infer<typeof SendFeedbackSchema>;

// ---------------------------------------------------------------------------
// request_peer_input
// ---------------------------------------------------------------------------

/**
 * Schema for `request_peer_input` input.
 *
 * Fallback Task Agent mediated communication tool. Available when no direct channel
 * is declared for the target role, or when `send_feedback` fails validation.
 *
 * This is ASYNC and NON-BLOCKING — the tool returns an acknowledgment immediately.
 * The peer's answer will arrive as a separate user turn prefixed with:
 *   `[Peer response from {role}]: ...`
 *
 * Do NOT wait for an immediate reply. Continue working and handle the peer's
 * response when it arrives in the conversation.
 */
export const RequestPeerInputSchema = z.object({
	/** Role of the peer to ask (e.g., 'reviewer', 'coder'). */
	target_role: z
		.string()
		.describe("Role of the peer to request input from (e.g., 'reviewer', 'coder')"),
	/** The question or request to send to the peer via the Task Agent. */
	question: z
		.string()
		.min(1)
		.describe('The question or request to relay to the peer through the Task Agent'),
});

export type RequestPeerInputInput = z.infer<typeof RequestPeerInputSchema>;

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

/**
 * All step agent tool schemas keyed by tool name.
 */
export const STEP_AGENT_TOOL_SCHEMAS = {
	list_peers: ListPeersSchema,
	send_feedback: SendFeedbackSchema,
	request_peer_input: RequestPeerInputSchema,
} as const;

export type StepAgentToolName = keyof typeof STEP_AGENT_TOOL_SCHEMAS;
