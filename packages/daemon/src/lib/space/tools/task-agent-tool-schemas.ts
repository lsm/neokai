/**
 * Task Agent MCP Tool Schemas — Zod schemas and TypeScript types for the 5
 * tools available to the Task Agent session.
 *
 * Tools:
 *   spawn_step_agent      — spawn a sub-session for a specific workflow step
 *   check_step_status     — check the status of the current or a specific step's sub-session
 *   advance_workflow      — advance the workflow to the next step after the current step completes
 *   report_result         — report the final task result (terminal tool)
 *   request_human_input   — pause execution and surface a question to the human user
 *
 * This file is consumed by the MCP server factory (Milestone 3). It intentionally
 * contains only schema definitions — no runtime logic or side effects.
 *
 * Style conventions (matching space-agent-tools.ts):
 *   - z.string().describe() on every field — .describe() before .optional()
 *   - optional fields use .optional() after .describe()
 *   - enum fields use z.enum([...])
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// spawn_step_agent
// ---------------------------------------------------------------------------

/**
 * Schema for `spawn_step_agent` input.
 * Spawns a sub-session for the given workflow step.
 */
export const SpawnStepAgentSchema = z.object({
	/** ID of the workflow step to execute. */
	step_id: z.string().describe('ID of the workflow step to spawn a sub-session for'),
	/** Optional override instructions to pass to the step agent. */
	instructions: z
		.string()
		.describe('Optional instructions to pass to the step agent, overriding the default step prompt')
		.optional(),
});

export type SpawnStepAgentInput = z.infer<typeof SpawnStepAgentSchema>;

// ---------------------------------------------------------------------------
// check_step_status
// ---------------------------------------------------------------------------

/**
 * Schema for `check_step_status` input.
 * Checks the processing state, completion, and any errors for the current or
 * a specific step's sub-session.
 */
export const CheckStepStatusSchema = z.object({
	/** Optional step ID to check. Omit to check the current active step. */
	step_id: z
		.string()
		.describe('ID of the workflow step to check. Omit to check the currently active step.')
		.optional(),
});

export type CheckStepStatusInput = z.infer<typeof CheckStepStatusSchema>;

// ---------------------------------------------------------------------------
// advance_workflow
// ---------------------------------------------------------------------------

/**
 * Schema for `advance_workflow` input.
 * Advances the workflow to the next step after the current step completes.
 * When a `task_result` transition condition is present on the outgoing transitions,
 * supply `step_result` to evaluate it — e.g. `'passed'` or `'failed: <reason>'`.
 */
export const AdvanceWorkflowSchema = z.object({
	/**
	 * Result from the completed step, used for `task_result` transition condition evaluation.
	 * Example values: `'passed'`, `'failed: tests failed'`, `'approved'`.
	 * When evaluating a `task_result` condition, the executor matches this value
	 * (prefix match) against the condition's `expression` field.
	 */
	step_result: z
		.string()
		.describe(
			"Result of the completed step — used for 'task_result' condition evaluation. " +
				"Example: 'passed' or 'failed: <reason>'. Prefix-match against the condition's expression."
		)
		.optional(),
});

export type AdvanceWorkflowInput = z.infer<typeof AdvanceWorkflowSchema>;

// ---------------------------------------------------------------------------
// report_result
// ---------------------------------------------------------------------------

/**
 * Possible final statuses for a task result.
 */
export const TaskResultStatusSchema = z.enum(['completed', 'needs_attention', 'cancelled']);

export type TaskResultStatus = z.infer<typeof TaskResultStatusSchema>;

/**
 * Schema for `report_result` input.
 * Reports the final outcome of the task and closes the task lifecycle.
 */
export const ReportResultSchema = z.object({
	/** Final task status. */
	status: TaskResultStatusSchema.describe(
		"Final task status: 'completed' (success), 'needs_attention' (human intervention required), or 'cancelled'"
	),
	/** Human-readable summary of what was accomplished or why it stopped. */
	summary: z.string().describe('Human-readable summary of the task outcome'),
	/** Optional error message when status is needs_attention or cancelled. */
	error: z
		.string()
		.describe('Error details when the task ended in needs_attention or was cancelled')
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
// relay_message
// ---------------------------------------------------------------------------

/**
 * Schema for `relay_message` input.
 * Injects a user-turn message into a target sub-session in the same group.
 * The Task Agent is not constrained by channel topology — it can relay to any member.
 */
export const RelayMessageSchema = z.object({
	/** Session ID of the target sub-session to relay the message to. */
	target_session_id: z
		.string()
		.describe('Session ID of the target sub-session to send the message to'),
	/** The message to inject as a user turn in the target session. */
	message: z.string().describe('The message content to inject into the target session'),
});

export type RelayMessageInput = z.infer<typeof RelayMessageSchema>;

// ---------------------------------------------------------------------------
// Aggregate export for MCP server factory (Milestone 3)
// ---------------------------------------------------------------------------

/**
 * All Task Agent tool schemas keyed by tool name.
 * The MCP server factory can iterate this map to register tools.
 */
export const TASK_AGENT_TOOL_SCHEMAS = {
	spawn_step_agent: SpawnStepAgentSchema,
	check_step_status: CheckStepStatusSchema,
	advance_workflow: AdvanceWorkflowSchema,
	report_result: ReportResultSchema,
	request_human_input: RequestHumanInputSchema,
	list_group_members: ListGroupMembersSchema,
	relay_message: RelayMessageSchema,
} as const;

export type TaskAgentToolName = keyof typeof TASK_AGENT_TOOL_SCHEMAS;
