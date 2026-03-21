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
 * Follow the same style as space-agent-tools.ts:
 *   - z.string().describe() on every field
 *   - optional fields use .optional()
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
		.optional()
		.describe(
			'Optional instructions to pass to the step agent, overriding the default step prompt'
		),
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
		.optional()
		.describe('ID of the workflow step to check. Omit to check the currently active step.'),
});

export type CheckStepStatusInput = z.infer<typeof CheckStepStatusSchema>;

// ---------------------------------------------------------------------------
// advance_workflow
// ---------------------------------------------------------------------------

/**
 * Schema for `advance_workflow` input.
 * Advances the workflow to the next step after the current step completes.
 */
export const AdvanceWorkflowSchema = z.object({
	/** Optional result summary from the completed step, used for transition condition evaluation. */
	step_result: z
		.string()
		.optional()
		.describe(
			'Optional result or output summary from the completed step, used when evaluating transition conditions'
		),
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
		.optional()
		.describe('Error details when the task ended in needs_attention or was cancelled'),
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
		.optional()
		.describe('Optional context explaining why this question is being asked'),
});

export type RequestHumanInputInput = z.infer<typeof RequestHumanInputSchema>;

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
} as const;

export type TaskAgentToolName = keyof typeof TASK_AGENT_TOOL_SCHEMAS;
