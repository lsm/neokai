/**
 * Task Agent MCP Tool Schemas — Zod schemas and TypeScript types for the 5
 * tools available to the Task Agent session (send_message schema is shared
 * from node-agent-tool-schemas.ts, making 6 tools total in the MCP server).
 *
 * Tools (defined in this file):
 *   spawn_node_agent      — spawn a sub-session for a specific workflow node (node_id)
 *   check_node_status     — check the status of the current or a specific node's sub-session (node_id)
 *   report_result         — report the final task result (terminal tool)
 *   request_human_input   — pause execution and surface a question to the human user
 *   list_group_members    — list all members of the current task's session group
 *
 * This file is consumed by the MCP server factory. It intentionally
 * contains only schema definitions — no runtime logic or side effects.
 *
 * Style conventions (matching space-agent-tools.ts):
 *   - z.string().describe() on every field — .describe() before .optional()
 *   - optional fields use .optional() after .describe()
 *   - enum fields use z.enum([...])
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// spawn_node_agent
// ---------------------------------------------------------------------------

/**
 * Schema for `spawn_node_agent` input.
 * Spawns a sub-session for the given workflow node (identified by node_id).
 */
export const SpawnNodeAgentSchema = z.object({
	/** ID of the workflow node to execute. */
	node_id: z.string().describe('ID of the workflow node to spawn a sub-session for'),
	/** Optional override instructions to pass to the node agent. */
	instructions: z
		.string()
		.describe('Optional instructions to pass to the node agent, overriding the default node prompt')
		.optional(),
});

export type SpawnNodeAgentInput = z.infer<typeof SpawnNodeAgentSchema>;

// ---------------------------------------------------------------------------
// check_node_status
// ---------------------------------------------------------------------------

/**
 * Schema for `check_node_status` input.
 * Checks the processing state, completion, and any errors for the current or
 * a specific node's sub-session.
 */
export const CheckNodeStatusSchema = z.object({
	/** Optional node ID to check. Omit to check the current active node. */
	node_id: z
		.string()
		.describe('ID of the workflow node to check. Omit to check the currently active node.')
		.optional(),
});

export type CheckNodeStatusInput = z.infer<typeof CheckNodeStatusSchema>;

// ---------------------------------------------------------------------------
// report_result
// ---------------------------------------------------------------------------

/**
 * Possible final statuses for a task result.
 */
export const TaskResultStatusSchema = z.enum(['done', 'blocked', 'cancelled']);

export type TaskResultStatus = z.infer<typeof TaskResultStatusSchema>;

/**
 * Schema for `report_result` input.
 * Reports the final outcome of the task and closes the task lifecycle.
 */
export const ReportResultSchema = z.object({
	/** Final task status. */
	status: TaskResultStatusSchema.describe(
		"Final task status: 'done' (success), 'blocked' (human intervention required), or 'cancelled'"
	),
	/** Human-readable summary of what was accomplished or why it stopped. */
	summary: z.string().describe('Human-readable summary of the task outcome'),
	/** Optional error message when status is blocked or cancelled. */
	error: z
		.string()
		.describe('Error details when the task ended in blocked state or was cancelled')
		.optional(),
});

export type ReportResultInput = z.infer<typeof ReportResultSchema>;

// ---------------------------------------------------------------------------
// request_human_input
// ---------------------------------------------------------------------------

/**
 * Schema for `request_human_input` input.
 * Pauses workflow execution and surfaces a question to the human user.
 */
export const RequestHumanInputSchema = z.object({
	/** The question to ask the human. */
	question: z.string().describe('The question to surface to the human user'),
	/** Optional context to help the human understand why the question is being asked. */
	context: z
		.string()
		.describe('Optional context explaining why this question is being asked')
		.optional(),
});

export type RequestHumanInputInput = z.infer<typeof RequestHumanInputSchema>;

// ---------------------------------------------------------------------------
// list_group_members
// ---------------------------------------------------------------------------

/**
 * Schema for `list_group_members` input.
 * Lists all members of the current task's session group with their permitted channels.
 * No arguments — the group is inferred from the task context.
 */
export const ListGroupMembersSchema = z.object({});

export type ListGroupMembersInput = z.infer<typeof ListGroupMembersSchema>;

// ---------------------------------------------------------------------------
// Aggregate export for MCP server factory
// ---------------------------------------------------------------------------

/**
 * All Task Agent tool schemas keyed by tool name.
 * The MCP server factory can iterate this map to register tools.
 */
export const TASK_AGENT_TOOL_SCHEMAS = {
	spawn_node_agent: SpawnNodeAgentSchema,
	check_node_status: CheckNodeStatusSchema,
	report_result: ReportResultSchema,
	request_human_input: RequestHumanInputSchema,
	list_group_members: ListGroupMembersSchema,
} as const;

export type TaskAgentToolName = keyof typeof TASK_AGENT_TOOL_SCHEMAS;
