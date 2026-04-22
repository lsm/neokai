# Plan: Remove `completionActions` — Task Agent as Post-Approval Executor

**Source plan (authoritative):** [`docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`](docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md) (committed to `dev`)

**Space Task:** #75 (plan) → #79 (this decomposition)

---

## Goal summary

Replace the entire `completionActions` pipeline with a single, uniform post-approval executor: the **Task Agent**. End-node agents signal post-approval intent via a structured `send_message` to `task-agent` carrying `{ pr_url, post_approval_action: 'merge_pr' }`, then call `approve_task()` / `submit_for_approval()` as today. The Task Agent receives the signal, waits for a new `[TASK_APPROVED]` runtime injection, and — gated by space autonomy level via a new `merge_pr(pr_url)` MCP tool — either auto-merges (level ≥ 4) or first asks a human via `request_human_input` (level < 4). On completion this deletes the `CompletionAction` union, its runtime pipeline (`resolveCompletionWithActions` / `resumeCompletionActions` / executors), its RPC intercept, its MCP tool (`approve_completion_action`), the `PendingCompletionActionBanner` UI, and the associated DB columns — while keeping `completionAutonomyLevel` (which controls `approve_task` vs `submit_for_approval` and is orthogonal to merge autonomy). Rollout is staged across 5 stacked PRs targeting `dev`, each dependent on the previous being merged and (for Stages 2–3) deployed long enough to validate the new path.

---

## Work items

### 1. Task Agent `merge_pr` MCP tool + handler + script module (behind feature flag)

**Priority:** high

**Description:** Add a new single-purpose `merge_pr({ pr_url, human_approval_reason? })` MCP tool on the Task Agent's MCP server in `packages/daemon/src/lib/space/tools/task-agent-tools.ts`, with a new handler file `packages/daemon/src/lib/space/tools/task-agent-merge-handler.ts`. The handler validates the GitHub PR URL, re-reads live autonomy via the injected `getSpaceAutonomyLevel` resolver (threshold constant `MERGE_AUTONOMY_THRESHOLD = 4`), refuses calls below the threshold that lack `human_approval_reason`, performs artifact-store idempotency (matching `merged_pr_url`), and executes the merge by reusing the existing `PR_MERGE_BASH_SCRIPT` — hoisted into a new helper module `packages/daemon/src/lib/space/tools/pr-merge-script.ts` and invoked with `cwd = space.workspacePath`, env `NEOKAI_ARTIFACT_DATA_JSON` / `NEOKAI_WORKSPACE_PATH`, and a 120s timeout. On success write a `task-agent` artifact recording `merged_pr_url`, `status: 'merged'`, `approval` (`auto_policy` | `human`), and `approvalReason`. Gate registration behind `NEOKAI_TASK_AGENT_MERGE_EXECUTOR` (env var or `Space.experimentalFeatures` bit) so the tool is defined and tested but not yet visible to agents. Ship with the unit tests listed in §4.6 of the source plan (level ≥ 4 happy path, level < 4 refusal, level < 4 with reason, invalid URL, idempotent re-entry, script failure/stderr, timeout). No workflow prompt or user-facing changes.

### 2. End-node handoff protocol: prompt changes, Task Agent prompt addition, `[TASK_APPROVED]` injection, feature-flag flip

**Priority:** high

**Description:** Update all five built-in workflows in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` so every end-node issues `send_message({ target: 'task-agent', message, data: { pr_url, post_approval_action: 'merge_pr' } })` before calling `approve_task()` / `submit_for_approval()`. Concretely: CODING_WORKFLOW Reviewer step 5, RESEARCH_WORKFLOW Review step 6, FULLSTACK_QA_LOOP_WORKFLOW QA steps 5–6 (remove the inline `gh pr merge --squash` and worktree sync entirely — QA no longer merges), REVIEW_ONLY_WORKFLOW step 6 (no merge signal; trim verify-review-posted boilerplate), and PLAN_AND_DECOMPOSE_WORKFLOW (no prompt change required — Dispatcher artifact is evidence). Also update the duplicate `FULLSTACK_QA_PROMPT` constant. Append a new `## Post-Approval Actions` section to the Task Agent system prompt (`packages/daemon/src/lib/space/agents/task-agent.ts`, `buildTaskAgentSystemPrompt`) that teaches the autonomy-gated merge flow (≥4 → `merge_pr` directly; <4 → `request_human_input` first, then `merge_pr` with `human_approval_reason`). Add a new runtime injection `[TASK_APPROVED]` in `packages/daemon/src/lib/space/runtime/space-runtime.ts` at both the auto-approve and `approvePendingCompletion` transition sites, delivered into the task's Task Agent session. Flip `NEOKAI_TASK_AGENT_MERGE_EXECUTOR` to on. Snapshot-test end-node prompts to lock in the new instruction and assert the legacy `gh pr merge` / completion-action references are gone. Depends on Work Item 1 being deployed.

### 3. Delete completion-action runtime pipeline, RPC intercept, MCP tool, and UI banner

**Priority:** high

**Description:** Net-negative removal PR (~1500 LOC). Delete `resolveCompletionWithActions`, `resumeCompletionActions`, `executeCompletionAction`, `resolveArtifactData`, `buildAwaitingApprovalReason`, `emitTaskAwaitingApproval` from `packages/daemon/src/lib/space/runtime/space-runtime.ts`; collapse the two call sites (~lines 613 and 1561) to a new small helper `resolveTaskCompletion(workflow, spaceLevel)` that handles only the now-universal "no actions" case. Delete `packages/daemon/src/lib/space/runtime/completion-action-executors.ts` and `packages/daemon/src/lib/space/runtime/pending-action.ts` in their entirety. Remove the `resumeCompletionActions` public API from `space-runtime-service.ts`. Delete the `approve_completion_action` handler + tool registration in `packages/daemon/src/lib/space/tools/space-agent-tools.ts`. Delete the `pendingCheckpointType === 'completion_action'` intercept inside `spaceTask.update` in `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`. Update the `approve_task` tool description string in `task-agent-tools.ts` to stop referencing the removed pipeline. Delete `packages/web/src/components/space/PendingCompletionActionBanner.tsx` and remove all mount / routing references in `TaskStatusActions.tsx`, `SpaceTaskPane.tsx`, and `packages/web/src/lib/space-store.ts`. Remove all `completionActions: [...]` node entries and the `MERGE_PR_*`, `VERIFY_PR_MERGED_*`, `VERIFY_REVIEW_POSTED_*`, `PLAN_AND_DECOMPOSE_VERIFY_*` constants + scripts from `built-in-workflows.ts` (preserving the hoisted `PR_MERGE_BASH_SCRIPT` in `pr-merge-script.ts` from Work Item 1). Drop the tests enumerated in §4.5 of the source plan and update the surviving tests (`space-agent-tools.test.ts`, `end-node-handlers.test.ts`, `built-in-workflows.test.ts`, `space-task-handlers.test.ts`, `space-store.test.ts`, plus prompt-text assertions). Depends on Work Item 2 being deployed long enough to confirm the new path works in practice.

### 4. Schema cleanup + shared types + DB migration

**Priority:** high

**Description:** Remove the `CompletionAction` union, `ScriptCompletionAction`, `InstructionCompletionAction`, `McpCallCompletionAction`, `CompletionActionBase`, `McpCallExpectation`, and `WorkflowNode.completionActions` from `packages/shared/src/types/space.ts`. Drop `SpaceTask.pendingActionIndex` / `pendingAction`, the `'completion_action'` variant of `SpaceTask.pendingCheckpointType`, and `SpaceWorkflowRun.completionActionsFiredAt`. Simplify `packages/shared/src/space/workflow-autonomy.ts`: delete `EMPTY_ACTIONS_AUTONOMY_THRESHOLD`, `isAutonomousWithoutActions`, `BlockingAction`, `BlockingWorkflow`, `AutonomousWorkflowCount`, `isWorkflowAutonomousAtLevel`, `countAutonomousWorkflows`, `collectCompletionActions`, and replace with a single `isWorkflowAutoClosingAtLevel(wf, level)` that checks only `level >= (wf.completionAutonomyLevel ?? 5)`. Update the UI summary copy to "N of M auto-close at level X". Add a new SQLite migration in `packages/daemon/src/storage/schema/migrations.ts` that: (1) rewrites any live `pending_checkpoint_type = 'completion_action'` rows to `'task_completion'` with `pending_action_index = NULL` (defensive — Work Item 3 stopped producing them), (2) drops the `pending_action_index` column via the table-rebuild pattern used by migration 99, (3) tightens the `CHECK` constraint to `IN ('gate', 'task_completion')`, (4) drops `completion_actions_fired_at` from `space_workflow_runs`. Strip unknown `completionActions` fields from any user-authored workflow JSON on load (soft-migration) and emit a `workflow.migrated` notification. Update `space-task-repository.ts` and `space-workflow-run-repository.ts` mappers. Also lower `FULLSTACK_QA_LOOP_WORKFLOW.completionAutonomyLevel` from 4 → 3 (QA no longer merges; auto-merge autonomy is now enforced by the `merge_pr` tool handler) with an inline comment explaining the rationale. Rewrite `packages/shared/tests/workflow-autonomy.test.ts`. Can be squashed into Work Item 3 if the combined diff remains reviewable. Depends on Work Item 3.

### 5. Docs refresh, E2E coverage, changelog, and rollout closeout

**Priority:** normal

**Description:** Add a closing section to `docs/research/pr-merging-completion-actions.md` pointing at this plan and its PR chain. Update `docs/design/autonomy-levels-and-completion-actions.md` to reflect the removal. Add a changelog entry describing the breaking change (shared types, built-in workflow schema, DB columns) and the new `NEOKAI_TASK_AGENT_MERGE_EXECUTOR` flag default. Sweep the repo for other stale references (grep for `completionActions`, `CompletionAction`, `approve_completion_action`, `pendingActionIndex`, `PendingCompletionActionBanner`, `completionActionsFiredAt`, `MERGE_PR_COMPLETION_ACTION`, `VERIFY_PR_MERGED_COMPLETION_ACTION`, `VERIFY_REVIEW_POSTED_COMPLETION_ACTION`, `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION`, `resolveCompletionWithActions`, `resumeCompletionActions`, `executeCompletionAction`, `EMPTY_ACTIONS_AUTONOMY_THRESHOLD`). Add the three E2E tests from §4.6 of the source plan: `task-agent-merge-autonomy-high.e2e.ts` (level 4 auto-merge), `task-agent-merge-autonomy-low.e2e.ts` (level 1 human-approves-through-`request_human_input` path), and `task-agent-merge-human-rejects.e2e.ts` (level 1 human rejection — merge skipped, task stays `done`, audit artifact written). Provide a `tests/e2e/helpers/mock-gh.sh` PATH shim for the mock GitHub CLI if the existing E2E fixture infrastructure doesn't already cover it. Add online-test runs under `packages/daemon/tests/online/space/` simulating full Coding / Research / QA runs with dev-proxy at representative autonomy levels. Add the structured daemon log line `task-agent.merge_pr: spaceId=... taskId=... prUrl=... level=... autoApproved=bool outcome=... reason=...` described in §6.4. Manually trigger E2E in CI for UI changes (`PendingCompletionActionBanner` removal) per the workflow_dispatch pattern. Depends on Work Item 4.

---

## Dependencies

- Work Item 2 depends on Work Item 1 being **deployed** (not just merged) so the `merge_pr` tool is live when prompts start emitting the signal.
- Work Item 3 depends on Work Item 2 being **deployed long enough to validate** the new path in practice (catches any prompt regressions before the old pipeline is deleted).
- Work Item 4 depends on Work Item 3 being merged. May be squashed into Work Item 3 at the author's discretion if the combined diff remains reviewable, but keeping them separate keeps the migration safer.
- Work Item 5 depends on Work Item 4.

All PRs stack linearly: 1 → 2 → 3 → 4 → 5. Each targets `dev` and uses squash merge.

---

## Out of scope

- **Renaming `completionAutonomyLevel`.** It stays — it independently controls `approve_task` vs `submit_for_approval`, orthogonal to merge autonomy. A rename (e.g. to `workApprovalAutonomyLevel`) would cost a schema migration without user-visible benefit; defer indefinitely.
- **Reintroducing verification hooks as post-approval actions.** `verify-review-posted` (Review-Only) and `verify-tasks-created` (Plan-and-Decompose) are deleted as part of Work Item 3; regressions are accepted per §4.3 of the source plan. A follow-up `verify_tasks_created` Task Agent tool can be added later if operator feedback says the check was load-bearing.
- **Dropping `space_task_report_results` table.** Confirmed orphaned but kept in place; a later cleanup migration can drop it once a full-repo audit confirms no writers remain.
- **Exposing `merge_pr` to node-agent or space-agent sessions.** Intentional: the tool is registered solely via `createTaskAgentMcpServer`. Do not add it to `createNodeAgentMcpServer` / `createSpaceAgentMcpServer`.
- **Arbitrary shell access for the Task Agent.** `merge_pr` is a deliberate, documented, single-purpose policy exception. The "orchestrator only" contract in the Task Agent prompt is preserved for every other action.
- **Migrating user workflows that declare `completionActions[…]`.** Handled by a soft-migration (strip unknown fields, emit `workflow.migrated` notification). A one-shot data migration is only added in Stage 4 if the soft-migration assumption proves wrong.
- **Documentation for user-authored post-approval actions beyond `merge_pr`.** The MCP tool only supports `merge_pr` at launch; other `post_approval_action` values are treated as unsupported and escalated via `request_human_input` per the Task Agent prompt.

---

## Open questions

Carried forward verbatim from §7 of the source plan — each has a recommended decision; flagged here in case Plan Review wants to override before dispatch.

1. **Artifact-based idempotency vs. a new `space_task_merges` table.** Source plan recommends the artifact store (`type: 'result', data.merged_pr_url`). Low risk, zero schema cost. Accept the recommendation unless a reviewer calls it out.
2. **`merge_pr` artifact namespace.** Recommended: `nodeId: 'task-agent'` (provenance-clear, matches `task-agent-tools.ts:294`). No expected pushback.
3. **FULLSTACK_QA_LOOP_WORKFLOW `completionAutonomyLevel` drop 4 → 3.** Recommended in Work Item 4 and Appendix B of the source plan. Call out in the Work Item 4 PR description as a behavioural intent change so Plan Review can sign off.
4. **Verification regressions for Review-Only and Plan-and-Decompose.** Recommended: accept the regression in Stage 3; revisit as a follow-up if operator feedback demands it.
5. **Runtime enrichment of `request_human_input` context.** Recommended: no — let the Task Agent use the `pr_url` the end-node supplied plus the artifact trail. Re-evaluate if the human-facing question text is too thin in practice.
6. **Should `merge_pr` ever be exposed to non-Task-Agent sessions?** No — keep it registered solely on `createTaskAgentMcpServer`.

If any of these need to be flipped, adjust the affected work item's description before dispatch.
