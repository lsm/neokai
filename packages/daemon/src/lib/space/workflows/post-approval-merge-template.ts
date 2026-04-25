/**
 * Shared "merge the PR" post-approval instructions template.
 *
 * Referenced verbatim from
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §5 — "Merge-template `instructions` string (shared across Coding, Research,
 * QA)."
 *
 * Delivered to the reviewer post-approval session by `PostApprovalRouter` when
 * a workflow declares `postApproval.targetAgent = 'reviewer'`. Template tokens
 * follow the §1.6 grammar evaluated by
 * `post-approval-template.ts:interpolatePostApprovalTemplate`. Recognised
 * tokens used below:
 *
 *   - `{{pr_url}}`          — signalled by the end node via
 *                             `send_message(task-agent, …, data:{ pr_url })`.
 *   - `{{autonomy_level}}`  — space autonomy level at routing time.
 *   - `{{approval_source}}` — `'end_node' | 'human_review'` (distinguishes
 *                             reviewer self-close from human-approved review).
 *
 * NOTE: The `{{reviewer_name}}` token was intentionally replaced with the
 * static string `[end-node reviewer]` in PR 3/5 because nothing in
 * `dispatchPostApproval` currently resolves the approving agent's slot name
 * into `routeContext.reviewer_name`. Threading the name through from
 * `onApproveTask` is tracked as a follow-up (PR 4/5 / PR 5/5). Leaving the
 * token as a literal `{{reviewer_name}}` would degrade the reviewer
 * sub-session's kickoff, so it is rendered as a stable human-readable label
 * for now.
 *
 * Workflow authors referencing this template MUST ensure their end node signals
 * `{ pr_url }` (inside the `data` payload of `send_message(target:
 * 'task-agent', …)` and/or `save_artifact({ type: 'result', data: { prUrl } })`)
 * before `approve_task()` / `submit_for_approval()`. The earlier §2.1
 * `post_approval_action` discriminator was removed — post-approval routing is
 * declarative on the workflow's `postApproval` field, not signalled at runtime.
 *
 * Step 6 MUST instruct the post-approval session to call `mark_complete` (not
 * `approve_task`); this is the hard distinction between the
 * `in_progress → approved` and `approved → done` transitions — see §3.2 of the
 * plan and the `mark_complete` tool docstring in
 * `packages/daemon/src/lib/space/tools/task-agent-tools.ts`.
 */
export const PR_MERGE_POST_APPROVAL_INSTRUCTIONS: string = [
	'The task has been approved. Your job is to merge PR {{pr_url}}.',
	'',
	'Space autonomy level: {{autonomy_level}} (threshold for auto-merge: 4).',
	// TODO(PR 4/5 or 5/5): resolve the approving agent's slot name and replace
	// this static label with `{{reviewer_name}}`. See file-level NOTE.
	'Reviewer: [end-node reviewer].',
	'Approval source: {{approval_source}}.',
	'',
	'Steps:',
	'1. Verify the PR is still open and passes CI:',
	'     gh pr view {{pr_url}} --json state,mergeStateStatus,statusCheckRollup',
	'   If state is MERGED, record an audit artifact and exit — the work is done.',
	'2. If autonomy_level < 4:',
	'     Call request_human_input with',
	'       question: "Approve merging PR {{pr_url}}?"',
	'       context: "Reviewer: [end-node reviewer]. CI: <from step 1>."',
	'     Wait for the response before proceeding.',
	'3. Merge:',
	'     gh pr merge {{pr_url}} --squash --delete-branch',
	'   On a merge conflict, do NOT force — exit, call request_human_input with',
	'   a clear summary of the conflict, and let the human resolve.',
	'4. Sync your worktree with main/dev:',
	'     git fetch origin && git checkout dev && git pull --ff-only',
	'5. Save an audit artifact:',
	'     save_artifact({ type: "result", append: true,',
	'                     data: { merged_pr_url, mergedAt, approval: "auto"|"human" } })',
	'6. Call mark_complete() to signal post-approval finished',
	'   (transitions the task from `approved` to `done`).',
	'   DO NOT call approve_task — that\'s for the initial "work is good"',
	'   transition (in_progress → approved), which already happened upstream.',
].join('\n');
