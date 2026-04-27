/**
 * Task Agent MCP Tool Schemas — Zod schemas and TypeScript types for the
 * tools available to the Task Agent session (send_message schema is shared
 * from node-agent-tool-schemas.ts).
 *
 * Tools (defined in this file):
 *   approve_task          — self-close the task (gated by autonomy level)
 *   submit_for_approval   — request human sign-off
 *   mark_complete         — finish post-approval work (`approved → done`)
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
 *
 * Note: For append-only audit records, use `save_artifact` (from
 * node-agent-tool-schemas.ts) with `append: true`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// approve_task
// ---------------------------------------------------------------------------

/**
 * Schema for `approve_task` input.
 *
 * Agent-self-close tool for end-node agents and the Task Agent. Conditionally
 * registered on the MCP server only when `space.autonomyLevel >= workflow.completionAutonomyLevel`.
 * Calling this tool sets `space_tasks.reportedStatus = 'done'`, triggering the
 * completion-action pipeline on the next runtime tick.
 *
 * Takes no arguments — the task, workflow, and node are implicit from the
 * calling session's context. Strict schema so future fields fail fast until
 * explicitly added.
 */
export const ApproveTaskSchema = z.object({}).strict();

export type ApproveTaskInput = z.infer<typeof ApproveTaskSchema>;

// ---------------------------------------------------------------------------
// submit_for_approval
// ---------------------------------------------------------------------------

/**
 * Schema for `submit_for_approval` input.
 *
 * Always available to end-node agents and the Task Agent (independent of
 * autonomy level). Marks the task as awaiting human sign-off: sets
 * `task.status = 'review'` and populates the pending-completion fields so the
 * UI can route a human to approve or reject. Even at high autonomy levels this
 * remains available — agents may want to escalate a risky result for attention.
 */
export const SubmitForApprovalSchema = z
	.object({
		/**
		 * Optional human-readable reason for requesting review. Surfaces in the
		 * approval UI so the human reviewer knows why the agent escalated.
		 */
		reason: z
			.string()
			.describe(
				'Optional note explaining why you are requesting human review (visible in the approval UI)'
			)
			.optional(),
	})
	.strict();

export type SubmitForApprovalInput = z.infer<typeof SubmitForApprovalSchema>;

// ---------------------------------------------------------------------------
// mark_complete
// ---------------------------------------------------------------------------

/**
 * Schema for `mark_complete` input.
 *
 * Post-approval completion tool. Added in PR 2/5 of the
 * task-agent-as-post-approval-executor refactor. Transitions the task from
 * `approved → done` once the post-approval agent (the Task Agent itself when
 * the workflow's `postApproval.targetAgent === 'task-agent'`, or a spawned
 * space-task-node-agent sub-session otherwise) has finished its work.
 *
 * Distinct from `approve_task`:
 *   - `approve_task`  covers `in_progress → approved` (work is good).
 *   - `mark_complete` covers `approved → done`       (post-approval finished).
 *
 * Takes no arguments — the task is implicit from the calling session's
 * context. Strict schema so future fields fail fast until explicitly added.
 */
export const MarkCompleteSchema = z.object({}).strict();

export type MarkCompleteInput = z.infer<typeof MarkCompleteSchema>;

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
	approve_task: ApproveTaskSchema,
	submit_for_approval: SubmitForApprovalSchema,
	mark_complete: MarkCompleteSchema,
	request_human_input: RequestHumanInputSchema,
	list_group_members: ListGroupMembersSchema,
} as const;

export type TaskAgentToolName = keyof typeof TASK_AGENT_TOOL_SCHEMAS;
