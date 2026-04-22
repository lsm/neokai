# Plan: Remove `completionActions` — Task Agent as Post-Approval Executor

**Task:** Space Task #75
**Source research:** [`docs/research/pr-merging-completion-actions.md`](../research/pr-merging-completion-actions.md)
**Status:** Planning — no code changes yet
**Author:** Research node

---

## 0. Executive summary

The research doc argues (and this plan accepts) that the `completionActions`
system should be **removed entirely** and replaced by a single, uniform
post-approval executor: the **Task Agent**. Concretely:

1. End nodes signal post-approval intent via a structured `send_message` to
   `task-agent` (with `data: { pr_url, post_approval_action: 'merge_pr' }`) and
   **then** call `approve_task()` / `submit_for_approval()` exactly as today.
2. The Task Agent receives the structured intent, checks space autonomy level:
   - Level ≥ 4 → auto-executes a narrowly-scoped new MCP tool `merge_pr(pr_url)`.
   - Level 1–3 → first calls `request_human_input(question, context)` to surface
     the merge decision to the user; after the human responds, calls
     `merge_pr(pr_url)` with the human approval recorded on the call.
3. The entire `CompletionAction` type, its runtime pipeline, its RPC intercepts,
   its MCP tool (`approve_completion_action`), its DB columns, and its UI
   surface are deleted. The per-workflow knob `completionAutonomyLevel`
   **stays** (it controls `approve_task` vs `submit_for_approval` at the
   *work-is-good* level, orthogonal to the merge-PR level).

This resolves Gaps #1, #2, #3 from the research doc in one move, eliminates the
failure modes catalogued in §10 of that doc, and produces a single unified
approval UX.

### Prioritized implementation order

| Stage | PR | Scope | Dependency |
|------|----|-------|------------|
| 1 | `merge_pr` tool + wiring | Add the Task Agent `merge_pr` MCP tool (disabled for now via feature flag), unit-tested. No prompt/workflow changes. | — |
| 2 | End-node handoff | Update built-in workflow prompts to `send_message` to `task-agent` with `{ pr_url, post_approval_action }` before `approve_task`. Update Task Agent system prompt + kickoff to handle the signal. Flip the feature flag. | Stage 1 deployed |
| 3 | Remove runtime pipeline | Delete `resolveCompletionWithActions` / `resumeCompletionActions` / `executeCompletionAction`; delete the `spaceTask.update` intercept for `completion_action`; delete `approve_completion_action` MCP tool; delete `PendingCompletionActionBanner`. Task/run completion now flows through a simplified path. | Stage 2 deployed |
| 4 | Schema cleanup | Drop `pending_action_index`, `pending_checkpoint_type='completion_action'` value, `completion_actions_fired_at`, `MERGE_PR_COMPLETION_ACTION` etc. from DB & shared types. | Stage 3 merged |
| 5 | Docs + tests sweep | Remove stale test coverage, update design docs, add changelog entry. | Stage 4 merged |

Stages 3 + 4 can reasonably ship as one PR if the diff is still reviewable;
separating them keeps the migration safer.

---

## 1. Task Agent merge capability

### 1.1 New MCP tool: `merge_pr`

Add a single new tool on the Task Agent's MCP server, defined alongside the
existing tools in
[`packages/daemon/src/lib/space/tools/task-agent-tools.ts`](../../packages/daemon/src/lib/space/tools/task-agent-tools.ts).

```ts
merge_pr(args: {
    pr_url: string;             // fully-qualified GitHub PR URL
    human_approval_reason?: string; // required when autonomy < MERGE_AUTONOMY_THRESHOLD
}): Promise<ToolResult>;
```

**Handler contract** (new file
`packages/daemon/src/lib/space/tools/task-agent-merge-handler.ts`, wired from
`createTaskAgentMcpServer`):

1. Validate `pr_url` against `^https://github.com/[^/]+/[^/]+/pull/\d+$`.
2. Look up `space = spaceManager.getSpace(spaceId)`, `level = space.autonomyLevel ?? 1`.
3. `const MERGE_AUTONOMY_THRESHOLD = 4` (constant — matches the current
   `MERGE_PR_COMPLETION_ACTION.requiredLevel`, so no behavioural change at the
   autonomy boundary).
4. If `level < MERGE_AUTONOMY_THRESHOLD` **and** `args.human_approval_reason`
   is missing or empty → return
   `{ success: false, error: 'Human approval required: call request_human_input first, then retry with human_approval_reason set to the human\'s response.' }`.
   This is belt-and-braces: the Task Agent's system prompt also tells it this
   rule, but an agent that ignores the prompt is caught by the handler.
5. Idempotency: query artifact store for any existing
   `{ type: 'result', data.merged_pr_url == pr_url }` — if found, return
   `{ success: true, alreadyMerged: true }`. (Artifact-based idempotency keeps
   state local to the workflow run; no new DB column needed.)
6. Actually invoke the merge. Reuse the existing
   [`PR_MERGE_BASH_SCRIPT`](../../packages/daemon/src/lib/space/workflows/built-in-workflows.ts)
   body — move it out of `built-in-workflows.ts` into a new helper
   `packages/daemon/src/lib/space/tools/pr-merge-script.ts` that exports
   `PR_MERGE_BASH_SCRIPT` as a string. Execute via the existing gate-script
   runner pattern (`Bun.spawn` / `child_process.spawn`) with:
    - `cwd = space.workspacePath`
    - env: `NEOKAI_ARTIFACT_DATA_JSON = JSON.stringify({ pr_url })`,
            `NEOKAI_WORKSPACE_PATH = space.workspacePath`
    - timeout: 120_000 ms (matches current completion-action timeout at
      `space-runtime.ts:2209`)
7. On success: `artifactRepo.upsert({ type: 'result', append: true, nodeId: 'task-agent', data: { merged_pr_url: pr_url, status: 'merged', mergedAt: Date.now(), approval: level >= MERGE_AUTONOMY_THRESHOLD ? 'auto_policy' : 'human', approvalReason: args.human_approval_reason ?? null } })`
   so the audit trail mirrors the pre-removal shape.
8. On failure: return `{ success: false, error, stderr }` — Task Agent can
   surface this via its normal human-coordination path (`save_artifact` +
   `submit_for_approval` if it decides the task cannot close).

### 1.2 Why a dedicated tool, not generic Bash

The Task Agent's system prompt at
[`packages/daemon/src/lib/space/agents/task-agent.ts:281-283`](../../packages/daemon/src/lib/space/agents/task-agent.ts)
declares:

> "Do not execute code directly. You are an orchestrator, not an executor.
> All code execution, file editing, and git operations happen in workflow
> node sessions. You have no direct access to the filesystem."

A generic Bash carve-out would force us to unpick this rule (the LLM might
decide to run arbitrary commands). A single-purpose `merge_pr` tool:

- Is a **narrow, well-defined class of action** (merge a specific, validated PR URL)
- Keeps the "orchestrator only" contract intact for everything else
- Is unit-testable without spinning up an LLM
- Has its own autonomy check at the handler level — cannot be bypassed by a
  hallucinated model call

This is a **deliberate, documented policy exception**, not a silent broadening.
Add a §"Post-Approval Actions" subsection to the Task Agent system prompt
(see §3.2) explaining when this tool is available and how to use it.

### 1.3 Wiring

`createTaskAgentMcpServer` in
[`packages/daemon/src/lib/space/tools/task-agent-tools.ts:965-1061`](../../packages/daemon/src/lib/space/tools/task-agent-tools.ts)
already takes a `TaskAgentToolsConfig` with
`spaceManager`, `artifactRepo`, `taskRepo`, `getSpaceAutonomyLevel` — all the
dependencies the new handler needs. Add:

- `tool definition` in the MCP `tools` list (around line 1044)
- `handler` registration (around line 975)

No new manager plumbing is required; `TaskAgentManager.spawnTaskAgent` in
[`packages/daemon/src/lib/space/runtime/task-agent-manager.ts:429-683`](../../packages/daemon/src/lib/space/runtime/task-agent-manager.ts)
already composes the MCP server with all these dependencies.

### 1.4 Feature flag for staged rollout

Gate the tool registration behind a `Space.experimentalFeatures` bit (or a
`NEOKAI_TASK_AGENT_MERGE_EXECUTOR` env var) during Stage 1 so the tool is
defined, tested, and wired but not yet visible to agents. Flip the flag in
Stage 2 after the workflow prompt changes land.

---

## 2. End-node handoff protocol

### 2.1 Signalling mechanism — `send_message` to `task-agent` with structured `data`

The Task Agent already accepts `send_message({ target: 'task-agent', message, data })`
from node agents via the `taskAgentRouter` plumbed through
[`task-agent-manager.ts:2878-2882`](../../packages/daemon/src/lib/space/runtime/task-agent-manager.ts)
and
[`agent-message-router.ts:237-238, 367-381`](../../packages/daemon/src/lib/space/runtime/agent-message-router.ts).

When `data` is non-empty the router formats the delivered message as:

```
[Message from <fromAgentName>]: <message>

<structured-data>
{
  "pr_url": "...",
  "post_approval_action": "merge_pr"
}
</structured-data>
```

So the Task Agent can parse `pr_url` out of its conversation context with zero
new infrastructure.

**New convention:** end-node agents send, as a required step before calling
`approve_task()` / `submit_for_approval()`:

```ts
send_message({
    target: 'task-agent',
    message: 'Work complete. PR ready for post-approval action: merge_pr.',
    data: { pr_url: '<url>', post_approval_action: 'merge_pr' }
});
```

This gives the Task Agent the `pr_url` and a typed intent (`post_approval_action: 'merge_pr'`) in its context, so when the task completes it can act.

### 2.2 Why not a gate write?

A gate on the `End → TaskAgent` channel could enforce that `pr_url` is
supplied. But:

- The Task Agent has **default bidirectional channels to all node agents**
  (task-agent-manager.ts and agent-message-router.ts) and those are not
  gate-enforced — gates live on workflow channels, not the implicit task-agent
  channel.
- Adding a gate solely for this would force every workflow author to learn a
  new gate pattern.
- The `data` payload delivered inline inside `<structured-data>…</structured-data>`
  is already the idiomatic way node agents pass typed info to the Task Agent
  (example: the Research node's research-ready-gate data is surfaced exactly
  this way).

If we decide later that stronger enforcement is needed (e.g. "end-node must
have signalled an action before its `approve_task` is accepted"), we can add a
runtime check: refuse `approve_task` when `reportedStatus === 'done'` is set
but no `{ post_approval_action }` artifact / inbound task-agent message exists.

### 2.3 When does the Task Agent act?

Two signals converge in the Task Agent's existing event loop
(documented in the Task Agent system prompt at
[`task-agent.ts:233-260`](../../packages/daemon/src/lib/space/agents/task-agent.ts)):

1. The structured `[Message from reviewer]: ...\n<structured-data>{pr_url, post_approval_action}</structured-data>`
   arrives in the Task Agent's conversation.
2. A `[NODE_COMPLETE] Node "...-Review" sub-session (...) has completed`
   injection arrives once the end-node session ends
   ([`task-agent-manager.ts:1822-1834`](../../packages/daemon/src/lib/space/runtime/task-agent-manager.ts)).

**New runtime injection** — in addition to the existing `[NODE_COMPLETE]`,
when the canonical task transitions to `status = 'done'` AND
`reportedStatus = 'done'` AND an end-node message declared
`post_approval_action`, inject a `[TASK_APPROVED]` event:

```
[TASK_APPROVED] Task has been approved for completion. Pending post-approval action:
  action: merge_pr
  pr_url: <url>
  autonomy_level: <level>
  merge_autonomy_threshold: 4
Next step:
  - If autonomy_level >= merge_autonomy_threshold, call merge_pr({ pr_url }) directly.
  - Otherwise, call request_human_input({ question: "Approve merging PR <url>?", context: "..." })
    first, then call merge_pr({ pr_url, human_approval_reason: <human's response> }).
```

This injection happens from `SpaceRuntime` at the same site where the task
currently transitions to `done` ([`space-runtime.ts:611-621`](../../packages/daemon/src/lib/space/runtime/space-runtime.ts)
and [`space-runtime.ts:1561-1569`](../../packages/daemon/src/lib/space/runtime/space-runtime.ts)).

The equivalent injection also fires after the `submit_for_approval` path: when
`spaceTask.approvePendingCompletion` transitions the task from `review → done`
([`space-task-handlers.ts:328-333`](../../packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts)),
emit `[TASK_APPROVED]` into the task's Task Agent session before returning.

**How the Task Agent knows the pr_url / action:** from the structured message
it already received in its own conversation. The `[TASK_APPROVED]` injection
does not re-deliver the data — it just tells the agent to act.

Alternative design (considered, rejected): have the runtime look up the
artifact store for a `{ post_approval_action }` record and include it in the
`[TASK_APPROVED]` injection. Rejected because it duplicates state (agent
already has the data in context) and couples runtime to a specific artifact
schema.

### 2.4 Prompt changes by node

All four built-in workflows' end-node prompts live in
[`built-in-workflows.ts`](../../packages/daemon/src/lib/space/workflows/built-in-workflows.ts).
Exact edits:

#### 2.4.1 Coding Workflow — `CODING_WORKFLOW` Reviewer node
File: `built-in-workflows.ts:471-515`.
Replace the current step 5 ("If satisfied … `approve_task()` to close the task")
with:

```
5. If satisfied:
   a. Post an approval review: `gh pr review <pr-url> --approve --body-file <file>`
   b. Verify the PR is still open and mergeable.
   c. Signal the Task Agent that a merge is the post-approval action:
      send_message(
         target: "task-agent",
         message: "Reviewer approved. PR ready for merge.",
         data: { pr_url: "<url>", post_approval_action: "merge_pr" }
      )
   d. Call `save_artifact({ type: "result", append: true, summary, prUrl })` to record the audit entry.
   e. Call `approve_task()` to close the task. If autonomy blocks self-close,
      call `submit_for_approval({ reason: "…" })` instead — the Task Agent will
      still receive the post-approval signal.
```

The Coding node (`CODING_CODE_NODE`) prompt is unchanged — Coder never merges.

#### 2.4.2 Research Workflow — `RESEARCH_WORKFLOW` Review node
File: `built-in-workflows.ts:633-662`.
Replace step 6 identically:

```
6. If satisfied:
   a. Verify the PR is still open and mergeable.
   b. Signal the Task Agent that a merge is the post-approval action:
      send_message(target: "task-agent", message: "Research approved. PR ready for merge.",
                   data: { pr_url: "<url>", post_approval_action: "merge_pr" })
   c. Call `save_artifact({ type: "result", append: true, summary, prUrl })` to record the audit entry.
   d. Call `approve_task()` (or `submit_for_approval({ reason })` if autonomy blocks self-close).
```

#### 2.4.3 Coding with QA Workflow — `FULLSTACK_QA_LOOP_WORKFLOW` QA node
File: `built-in-workflows.ts:1107-1135`.
**Remove** steps 5–6 ("merge the PR with `gh pr merge … --squash`" and "sync
worktree") entirely. The QA agent no longer merges. Replace with:

```
5. If all green:
   a. Signal the Task Agent that a merge is the post-approval action:
      send_message(target: "task-agent", message: "QA passed. PR ready for merge.",
                   data: { pr_url: "<url>", post_approval_action: "merge_pr" })
   b. Call `save_artifact({ type: "result", append: true, summary, prUrl, testOutput })`
      to record the audit entry.
   c. Call `approve_task()` (or `submit_for_approval({ reason })` if autonomy blocks self-close).
      The Task Agent will perform the merge and sync under the autonomy check.
```

Also remove the trailing sentence "The runtime also verifies the PR is actually
merged before accepting completion." — that verification goes away with
`VERIFY_PR_MERGED_COMPLETION_ACTION`.

The `FULLSTACK_QA_PROMPT` constant at `built-in-workflows.ts:384-396` contains
the duplicate "merge the PR" instruction and must be updated the same way (the
QA custom prompt concatenates onto it).

#### 2.4.4 Review-Only Workflow — `REVIEW_ONLY_WORKFLOW`
File: `built-in-workflows.ts:721-777`.

No merge to perform. The post-approval step is a no-op. Prompt change:
remove the trailing paragraph about "the runtime verifies at least one
review/comment exists before accepting completion" (step 4) — that ran via
`VERIFY_REVIEW_POSTED_COMPLETION_ACTION` which is being deleted.

Known regression: at present, if the Reviewer lies about posting a review,
the runtime catches it via the completion action. After this change, the lie
goes through at Level 1 only when a human approves `submit_for_approval`.
(A human who approves completion without verifying the PR is the same failure
mode as today for every other workflow.) At Level ≥ 2 where `approve_task` is
unlocked, there is no gate. This is an acceptable regression for the
simplification; **mitigation** is documented in §4.3.

#### 2.4.5 Plan & Decompose Workflow — `PLAN_AND_DECOMPOSE_WORKFLOW`
File: `built-in-workflows.ts:952-972`.

No merge. `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION` (the "at least one
task was created" script) goes away. Prompt change: none required — the
Dispatcher already calls `save_artifact({ created_task_ids })` as its evidence.
Regression is identical to Review-Only — the verify script caught agents who
lied about dispatching; we trust the audit artifact instead.

**Mitigation option:** post-merge / Stage 5, add a `SpaceRuntime` sanity check
that refuses to mark a Plan-and-Decompose task `done` unless at least one
`created_task_ids` artifact is present on the run. This is a workflow-specific
post-approval check that can live in Task Agent as a follow-up tool call
(`verify_tasks_created`) if we decide it's worth the complexity.

---

## 3. Autonomy-level enforcement in Task Agent

### 3.1 Where the autonomy check lives

Two-layer enforcement:

1. **Handler-layer (authoritative):** `merge_pr` handler in
   `task-agent-merge-handler.ts` (new file) reads `space.autonomyLevel` via
   `config.getSpaceAutonomyLevel(spaceId)` at every call and rejects
   `level < 4` calls that lack `human_approval_reason`. This is the
   **single source of truth** and cannot be prompt-injected around.
2. **Prompt-layer (guidance):** the Task Agent system prompt and the
   `[TASK_APPROVED]` injection tell the LLM the rule (`level < 4 → call
   request_human_input first`) so the expected path succeeds without a tool
   bounce.

### 3.2 Task Agent system prompt addition

Amend [`task-agent.ts:buildTaskAgentSystemPrompt`](../../packages/daemon/src/lib/space/agents/task-agent.ts)
to add a new `## Post-Approval Actions` section after the existing
`## Human Gate Handling` section (~line 273):

```
## Post-Approval Actions

When a workflow end node signals a post-approval action via send_message —
e.g. { pr_url: "...", post_approval_action: "merge_pr" } — wait for the
`[TASK_APPROVED]` event. Then:

- If space.autonomyLevel >= 4 (MERGE autonomy threshold):
  - Call merge_pr({ pr_url }) directly.
- If space.autonomyLevel < 4:
  - First call request_human_input with a clear question
    (e.g. "Approve merging PR <pr_url>?") and the relevant context
    (diff summary, reviewer name, CI status if known).
  - Wait for the human's response. It arrives as a normal conversation
    message.
  - If the human approves, call merge_pr({ pr_url, human_approval_reason: "<exact human response>" }).
  - If the human rejects, save an artifact describing the rejection and
    call submit_for_approval if the task is not already closed.

The `merge_pr` tool is the ONLY direct-execution tool you may call. Do not
attempt to run other shell commands. If a post-approval action other than
`merge_pr` is signalled, treat it as an unsupported action and escalate via
request_human_input.
```

### 3.3 `request_human_input` question scaffolding

The existing `request_human_input` handler at
[`task-agent-tools.ts:759-801`](../../packages/daemon/src/lib/space/tools/task-agent-tools.ts)
sets `task.status = 'blocked'`, stores the question (+ optional context) in
`task.result`, and pauses the Task Agent's SDK session. The existing banner
[`TaskBlockedBanner.tsx`](../../packages/web/src/components/space/TaskBlockedBanner.tsx)
renders this. No code changes needed here — the Task Agent simply writes a
more specific question string.

Suggested question template (enforced by prompt, not schema):

```
question: "Approve merging PR <pr_url>?"
context:  "Reviewer: <agent name>
           PR title: <title>
           Commits: <n>
           CI status: <CLEAN | HAS_HOOKS | ...>
           Last review: <agent summary>"
```

The Task Agent can populate `context` by reading artifacts from the run
(`list_artifacts({ type: 'result' })` is already wired) and by running
`gh pr view <url> --json title,commits,mergeStateStatus` **— wait, Task Agent
has no Bash**. It does not. We'll rely on the data the end node already passed
through `send_message` + artifact, plus the PR URL itself.

### 3.4 Idempotency / retry

`merge_pr` is idempotent by two mechanisms:

- The underlying script `PR_MERGE_BASH_SCRIPT` already skips the merge when
  `gh pr view` reports `state == MERGED` (built-in-workflows.ts:163-170 today).
- The handler pre-checks the artifact store for a matching `merged_pr_url`.

This covers: daemon restart mid-merge, the Task Agent LLM re-calling the tool
after a conversation rewind, and the post-approval banner being clicked twice.

### 3.5 Human-rejection path

If the human rejects via `request_human_input` (responds "no" / "do not merge"):

1. Task Agent observes the response in its conversation.
2. Prompt tells it NOT to call `merge_pr`.
3. Task Agent calls `save_artifact({ type: 'result', append: true, summary: 'Human declined merge', data: { pr_url, rejectionReason: '...' } })`.
4. The task is already `done` at this point (merge was the post-approval step,
   not the completion step) — no further status transition needed.
5. Operator intervenes on GitHub manually or escalates.

This is a **minor design choice** — one could argue the task should revert to
`review` on human rejection, but: (a) the work was already approved as good,
(b) merging is an infrastructure step, not the work itself, (c) reverting
would require re-plumbing the `done → review` transition which doesn't exist
today. Keep it simple: task stays `done`, merge skipped, audit recorded.

---

## 4. Completion-action removal

### 4.1 Code to delete outright

File paths from the completion-action inventory:

| Path | What to delete |
|------|----------------|
| `packages/shared/src/types/space.ts` | `CompletionAction` union, `ScriptCompletionAction`, `InstructionCompletionAction`, `McpCallCompletionAction`, `CompletionActionBase`, `McpCallExpectation` (lines 1481-1556). `WorkflowNode.completionActions` field (line 1032). `SpaceTask.pendingActionIndex`, `SpaceTask.pendingAction` (lines 280, 315-326). `'completion_action'` variant of `SpaceTask.pendingCheckpointType` (line 287). `SpaceWorkflowRun.completionActionsFiredAt` (line 641). |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts` | `resolveCompletionWithActions` (lines 1881-2015). `resumeCompletionActions` (lines 932-1104). `executeCompletionAction` (lines 2067-2146). `resolveArtifactData` (lines 2153-2163). `buildAwaitingApprovalReason` (lines 71-76). `emitTaskAwaitingApproval` (lines 2028-2050). The two call sites at 613 and 1561 collapse to a direct call of a new small helper `resolveTaskCompletion(workflow, spaceLevel)` that only handles the "no actions" binary-autonomy case (which is now **all** cases). |
| `packages/daemon/src/lib/space/runtime/completion-action-executors.ts` | Entire file (285 lines). |
| `packages/daemon/src/lib/space/runtime/pending-action.ts` | Entire file (60 lines). |
| `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` | `resumeCompletionActions` public API (lines 795-807). |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts` | `approve_completion_action` handler (lines 944-1006) and its tool registration (line 1246). |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` | The `pendingCheckpointType === 'completion_action'` intercept in `spaceTask.update` (lines 154-203). |
| `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` | `PR_MERGE_BASH_SCRIPT` (move to new `pr-merge-script.ts` instead of deleting — see §1.1 step 6). `MERGE_PR_COMPLETION_ACTION` (lines 187-194). `VERIFY_PR_MERGED_BASH_SCRIPT` + `VERIFY_PR_MERGED_COMPLETION_ACTION` (lines 204-239). `VERIFY_REVIEW_POSTED_BASH_SCRIPT` + `VERIFY_REVIEW_POSTED_COMPLETION_ACTION` (lines 246-282). `PLAN_AND_DECOMPOSE_VERIFY_SCRIPT` + `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION` (lines 792-830). Every `completionActions: [...]` entry on a node (lines 518, 664, 766, 972, 1135). |
| `packages/web/src/components/space/PendingCompletionActionBanner.tsx` | Entire file (385 lines). |
| `packages/web/src/components/space/TaskStatusActions.tsx` | Remove import + render of `PendingCompletionActionBanner`. |
| `packages/web/src/components/space/SpaceTaskPane.tsx` | Remove routing of `'completion_action'` checkpoint to the removed banner. |
| `packages/shared/src/space/workflow-autonomy.ts` | `EMPTY_ACTIONS_AUTONOMY_THRESHOLD`, `isAutonomousWithoutActions`, `BlockingAction`, `BlockingWorkflow`, `AutonomousWorkflowCount`, `isWorkflowAutonomousAtLevel`, `countAutonomousWorkflows`, `collectCompletionActions` — replace with a single `isWorkflowAutoClosingAtLevel(wf, level)` that checks only `level >= (wf.completionAutonomyLevel ?? 5)`. The UI's "N of M workflows autonomous at level X" summary becomes "N of M auto-close at level X" — simpler and more accurate post-removal. |

### 4.2 Code to keep / repurpose

| Item | Decision |
|------|----------|
| `completionAutonomyLevel` on `SpaceWorkflow` | **Keep.** It still controls whether the end-node agent's `approve_task` is unlocked vs. forced onto `submit_for_approval` — orthogonal to the merge-PR level. The values (Coding=3, QA=4, Research=2, Review-Only=2, Plan-and-Decompose=3) remain valid. |
| `submit_for_approval` + `approvePendingCompletion` RPC + `PendingTaskCompletionBanner` | **Keep.** This is the human-approves-the-work path; it is NOT a completion-action path. No changes. |
| `pendingCheckpointType = 'task_completion'` variant | **Keep.** Still used by `submit_for_approval`. |
| `pendingCompletionSubmittedByNodeId`, `pendingCompletionSubmittedAt`, `pendingCompletionReason` | **Keep.** Still needed by the task-completion banner. |
| `space_task_report_results` table (migration 99) | **Keep.** The `report_result` handler has been removed, but the table itself persists audit rows. Check if any callers still write to it — if no, drop it in a later cleanup migration. Appears orphaned; verify with a full-repo grep before removing. |
| `PR_MERGE_BASH_SCRIPT` string body | **Move and keep.** Hoist to `packages/daemon/src/lib/space/tools/pr-merge-script.ts` so the new `merge_pr` tool handler imports it. |

### 4.3 Lost functionality & mitigations

| Lost check | Provided by | Mitigation |
|-----------|-------------|------------|
| `verify-pr-merged` (QA-loop) | double-check that QA agent actually merged | No longer needed — Task Agent is the merger, not the QA agent. |
| `verify-review-posted` (Review-Only) | catches reviewer lying about posting review | Rely on the agent's contract; the operator can inspect the PR. Optional future follow-up: a pre-`approve_task` runtime check that requires at least one `save_artifact` with `reviewUrl`. |
| `verify-tasks-created` (Plan-and-Decompose) | catches dispatcher lying about creating tasks | Same pattern — optional future `verify_tasks_created` Task Agent tool if the regression proves painful. |
| `'blocked'` status on post-hoc verification failure | escalated silently to a blocked task | Task Agent's `submit_for_approval` path produces the same end state via a different trigger. |
| `Awaiting Human Approval` banner (`PendingCompletionActionBanner`) | per-action modal UI | `request_human_input` → `TaskBlockedBanner` + plain conversation input now covers this. Operators answer the Task Agent's question in free text instead of clicking Approve/Reject on a specific action. Simpler, more uniform UX. |

### 4.4 DB migration

New migration (number = next after current tip):

```sql
-- Drop the completion_action checkpoint value and associated columns.
-- Step 1: transition any live tasks paused at 'completion_action'.
-- At Stage 4 time, Stage 3 will have already rewritten runtime paths to
-- never produce this value. Still, convert any in-flight rows defensively.
UPDATE space_tasks
SET pending_checkpoint_type = 'task_completion',
    pending_action_index = NULL
WHERE pending_checkpoint_type = 'completion_action';

-- Step 2: drop pending_action_index column.
-- SQLite requires the table-rebuild pattern used by migration 99.
-- (Full rebuild sql omitted here; see migration 99 for template.)

-- Step 3: tighten the CHECK constraint on pending_checkpoint_type:
--     from: CHECK (pending_checkpoint_type IN ('completion_action', 'gate', 'task_completion'))
--     to:   CHECK (pending_checkpoint_type IN ('gate', 'task_completion'))

-- Step 4: drop completion_actions_fired_at from space_workflow_runs.

-- Step 5: (optional) drop space_task_report_results if audit confirms no
-- writer remains. Defer to a later cleanup migration to keep this PR small.
```

No data migration is needed for `completionAutonomyLevel` since it stays.

### 4.5 Tests to delete / update

Files enumerated in the completion-action inventory (§9):

- Delete outright:
  - `packages/daemon/tests/unit/5-space/runtime/space-runtime-completion-actions.test.ts`
  - `packages/daemon/tests/unit/5-space/workflow/completion-actions-persistence.test.ts`
  - `packages/daemon/tests/unit/5-space/runtime/completion-action-executors.test.ts`
  - `packages/web/src/components/space/__tests__/PendingCompletionActionBanner.test.tsx`
  - `packages/e2e/tests/features/space-completion-action-approval.e2e.ts`
- Update (remove `approve_completion_action` / completion-action cases):
  - `packages/daemon/tests/unit/5-space/runtime/space-agent-tools.test.ts`
  - `packages/daemon/tests/unit/5-space/agent/end-node-handlers.test.ts`
  - `packages/daemon/tests/unit/5-space/workflow/built-in-workflows.test.ts`
  - `packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts`
  - `packages/shared/tests/workflow-autonomy.test.ts`
  - `packages/web/src/lib/__tests__/space-store.test.ts`
- Update (reflect new workflow prompts):
  - Any test that asserts specific prompt text from the five built-in workflows
    (e.g. asserting the QA prompt contains `gh pr merge` — it will not any more).

### 4.6 New tests to add

Under `packages/daemon/tests/unit/5-space/`:

- `tools/task-agent-merge-handler.test.ts`
  - Level ≥ 4, valid URL → script runs, artifact written, success.
  - Level < 4, no `human_approval_reason` → refused.
  - Level < 4, valid `human_approval_reason` → script runs.
  - Invalid URL → refused.
  - Already-merged idempotency → returns success without running script.
  - Script failure → returns failure with stderr.
  - Timeout → surfaces timeout error.

- `runtime/post-approval-signalling.test.ts`
  - Simulated end-node emits `send_message` to task-agent with
    `{pr_url, post_approval_action}`; verify the structured-data appendix is
    delivered to the Task Agent session in the expected format.
  - Verify `[TASK_APPROVED]` is injected into the Task Agent session on
    `done` transition.
  - Verify NOT injected when no `post_approval_action` was signalled.

- `workflows/end-node-handoff.test.ts`
  - For each of the 5 built-in workflows, snapshot-test the end-node's
    customPrompt to ensure the post-approval signalling instructions are
    present (and the old `gh pr merge` / completion-action references are
    absent).

E2E test additions (`packages/e2e/tests/features/`):

- `task-agent-merge-autonomy-high.e2e.ts` — Level 4 space, run the Coding
  workflow against a fake PR, assert the PR is merged without a human
  interaction.
- `task-agent-merge-autonomy-low.e2e.ts` — Level 1 space, run the Coding
  workflow, assert the Task Agent blocks at `human_input_requested`, then
  simulate the human approving via the conversation input, and assert the
  merge happens afterward.
- `task-agent-merge-human-rejects.e2e.ts` — Level 1 space, human rejects via
  request_human_input response, assert PR is not merged, task remains `done`,
  audit artifact is written.

These E2E tests need a mock `gh` CLI (or dev-proxy style shim) — reuse the
existing E2E PR-fixture infrastructure if present; otherwise add a tiny
`tests/e2e/helpers/mock-gh.sh` shim that `make run-e2e` injects onto the PATH.

---

## 5. Workflow definition changes — summary table

| Workflow | `completionActions` removed | `completionAutonomyLevel` | Prompt change |
|---------|-------|--------------------------|---------------|
| CODING_WORKFLOW | `[MERGE_PR_COMPLETION_ACTION]` | keep at 3 | Reviewer step 5 — add `send_message(task-agent)` before `approve_task` |
| RESEARCH_WORKFLOW | `[MERGE_PR_COMPLETION_ACTION]` | keep at 2 | Review step 6 — add `send_message(task-agent)` before `approve_task` |
| FULLSTACK_QA_LOOP_WORKFLOW | `[VERIFY_PR_MERGED_COMPLETION_ACTION]` | **lower from 4 to 3** — QA no longer merges, so the high-level threshold is no longer needed | QA steps 5–6 — remove `gh pr merge` + worktree sync; replace with `send_message(task-agent)` |
| REVIEW_ONLY_WORKFLOW | `[VERIFY_REVIEW_POSTED_COMPLETION_ACTION]` | keep at 2 | Review step 6 — trim verification boilerplate, no post-approval signalling (no merge) |
| PLAN_AND_DECOMPOSE_WORKFLOW | `[PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION]` | keep at 3 | Dispatcher — no change |

The QA-workflow `completionAutonomyLevel` drop from 4 → 3 is a **behavioural
intent change** worth calling out in the PR description: today, Coding-with-QA
requires Level 4 to self-close because the QA agent is the merger. After this
change, the QA agent no longer merges, so Level 3 is the natural threshold
(aligned with Coding). The operator still needs Level 4 to **auto-merge**,
because that check is now enforced by the `merge_pr` tool handler, not the
workflow.

---

## 6. Migration & rollout

### 6.1 Breaking change assessment

- **Workflow schema (shared types)**: removing `completionActions`,
  `CompletionAction`, `completionActionsFiredAt`, `pendingActionIndex`,
  `pendingCheckpointType: 'completion_action'` is a breaking change to
  `@neokai/shared`. NeoKai ships as a single repo; no external consumers.
- **Built-in workflows (DB rows)**: the existing `seedBuiltInWorkflows` code
  stamps template rows into SQLite. On startup after migration, the seeder
  re-runs with the new template (computed via `computeWorkflowHash`) and
  replaces the row. Existing user workflows that copied a built-in and still
  reference `completionActions[…]` in the JSON column will surface as dead
  fields that the schema validator rejects — a soft migration at load time
  strips unknown fields (validate this assumption against the `Gate` parser
  at `space-workflow-manager.ts`). Otherwise add a one-shot data migration in
  Stage 4.
- **In-flight runs at migration time**: a daemon upgrade mid-run where the
  task is paused at `pendingCheckpointType='completion_action'`. Migration
  step 1 above rewrites these to `task_completion` so the task appears in the
  "submit for approval" banner instead, where the operator can click through.
  Downside: the specific *action* context is lost. This is acceptable for the
  upgrade window.
- **User workflows that declare `completionActions`**: the workflow validator
  at `space-workflow-manager.ts` must learn to reject (or strip with warning)
  unknown fields so users don't hit a hard error on load. Emit a
  `workflow.migrated` notification in that case.

### 6.2 Suggested PR breakdown (5 PRs)

See §0 — restated with rough size estimates:

- **PR 1**: add `merge_pr` tool + handler + pr-merge-script module behind a feature flag, with unit tests. ~400 LOC; self-contained; safe to merge without downstream changes.
- **PR 2**: end-node prompt changes in all 5 workflows + Task Agent prompt addition (§3.2) + runtime injection of `[TASK_APPROVED]` + feature-flag flip. ~600 LOC; depends on PR 1.
- **PR 3**: delete runtime pipeline, RPC intercept, MCP tool, UI banner. ~1500 LOC net-negative; largest PR; depends on PR 2 being deployed long enough to confirm the new path works.
- **PR 4**: schema / shared-types / DB migration. ~500 LOC; depends on PR 3. Can be squashed into PR 3 if the diff is still reviewable.
- **PR 5**: docs refresh — update `docs/research/pr-merging-completion-actions.md` with a closing section pointing to this plan; update `docs/design/autonomy-levels-and-completion-actions.md`; changelog entry; remove any other stale references. ~200 LOC; trivial.

### 6.3 Test strategy summary

| Layer | Scope | Files |
|-------|-------|-------|
| Unit — daemon | `merge_pr` handler, post-approval signalling, runtime injection, built-in workflow snapshot | §4.6 list |
| Unit — shared | Workflow-autonomy helper simplification | `packages/shared/tests/workflow-autonomy.test.ts` (rewrite) |
| Integration — daemon online tests | Simulate full Coding/Research/QA runs with dev-proxy; assert task closes correctly at each autonomy level | `packages/daemon/tests/online/space/` (new files) |
| E2E | End-to-end from UI input through Task Agent merge decision, with mock `gh` | §4.6 list |
| Manual | Spin up a dev space at each autonomy level 1–5; kick a Coding workflow against a real GitHub PR; observe behaviour | Pre-merge of PR 2 + 3 |

### 6.4 Observability / rollback

- Add a structured daemon log entry for every `merge_pr` tool invocation:
  `task-agent.merge_pr: spaceId=... taskId=... prUrl=... level=... autoApproved=bool outcome=merged|already_merged|failed|refused-autonomy reason=...`
- Feature-flag (`NEOKAI_TASK_AGENT_MERGE_EXECUTOR`) allows a quick disable if
  the tool misbehaves in the wild. When disabled, the tool is not registered
  and the Task Agent's prompt gracefully reports to humans that the action is
  unsupported (humans merge manually on GitHub).
- PRs 3 and 4 are effectively one-way doors once merged (code + DB). If a
  regression is found after they ship, the fix is forward-only.

---

## 7. Open questions / decisions for review

1. **Artifact-based idempotency vs. a new `space_task_merges` table.**
   The plan uses the artifact store (`type: 'result', data.merged_pr_url`) for
   idempotency. Pro: no schema changes, matches existing audit pattern.
   Con: artifact store is not strictly type-safe; a malformed custom agent
   could write a similar shape. Decision: accept — the risk is low and the
   simplicity wins.

2. **Should `merge_pr` also write to the same artifact store as the end node,
   or its own namespace (`nodeId: 'task-agent'`)?**
   Using `nodeId: 'task-agent'` (already the convention in
   `task-agent-tools.ts:294`) keeps provenance clear and avoids colliding with
   reviewer-written artifacts. Decision: `nodeId: 'task-agent'`.

3. **Should the QA workflow `completionAutonomyLevel` drop to 3, or lower?**
   §5 suggests 3 (matches Coding). Argument for keeping it at 4: QA gates
   *all* of backend + frontend + browser tests, which is a higher-risk signal
   than Reviewer approval alone. Argument for 3: after the refactor the
   self-close is purely "is the work good"; merging is a separate question now
   handled by `merge_pr` autonomy. Decision: **3**, with a comment in the
   workflow definition explaining the rationale.

4. **Review-Only and Plan-and-Decompose verification regressions.**
   Do we accept losing the verify-review-posted / verify-tasks-created
   checks, or do we reintroduce them as optional post-approval actions
   (requiring a `post_approval_action: 'verify_review_posted'` variant)?
   **Recommendation:** accept the regression for Stage 3; revisit as a
   follow-up if operator feedback indicates the checks were load-bearing.

5. **Task Agent context for `request_human_input`.**
   Should the runtime enrich the structured-data payload with the PR title /
   CI status / commit count before delivery, so the Task Agent can produce a
   richer `context` string? Current design: no — let the Task Agent use the
   `pr_url` the end node supplied and the artifact trail. Re-evaluate if the
   human-facing question text is too thin in practice.

6. **Should `merge_pr` ever be exposed to non-Task-Agent sessions?**
   No. It is registered solely on the Task Agent's MCP server (via
   `createTaskAgentMcpServer`). Do not add it to `createNodeAgentMcpServer`
   or `createSpaceAgentMcpServer`.

---

## Appendix A — File path cheat sheet

Key files referenced in this plan, grouped by area:

**Task Agent wiring**
- `packages/daemon/src/lib/space/agents/task-agent.ts` — system prompt + session init
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` — session lifecycle, sub-session events, prompt building
- `packages/daemon/src/lib/space/tools/task-agent-tools.ts` — MCP server (add `merge_pr` here)
- `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts` — Zod schemas (add `MergePrInputSchema`)

**End-node wiring**
- `packages/daemon/src/lib/space/tools/end-node-handlers.ts` — `onApproveTask` / `onSubmitForApproval` (no change)
- `packages/daemon/src/lib/space/runtime/agent-message-router.ts` — `task-agent` routing (already works)

**Runtime completion-resolution (to delete / simplify)**
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` — `resolveCompletionWithActions`, `resumeCompletionActions`
- `packages/daemon/src/lib/space/runtime/completion-action-executors.ts` — full file
- `packages/daemon/src/lib/space/runtime/pending-action.ts` — full file
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` — `resumeCompletionActions`

**RPC layer**
- `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` — `spaceTask.update` intercept + `approvePendingCompletion`

**Workflow definitions**
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` — all 5 built-in workflows + action constants + scripts
- `packages/daemon/src/lib/space/workflows/template-hash.ts` — hash changes when templates change (auto)

**Shared types**
- `packages/shared/src/types/space.ts` — `CompletionAction`, `SpaceTask`, `SpaceWorkflowRun`, `WorkflowNode`
- `packages/shared/src/space/workflow-autonomy.ts` — autonomy helpers

**Storage**
- `packages/daemon/src/storage/schema/migrations.ts` — add new migration (§4.4)
- `packages/daemon/src/storage/repositories/space-task-repository.ts` — drop completion-action columns from mapper
- `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` — drop `completionActionsFiredAt`

**Web UI**
- `packages/web/src/components/space/PendingCompletionActionBanner.tsx` — delete
- `packages/web/src/components/space/TaskStatusActions.tsx` — remove banner mount
- `packages/web/src/components/space/SpaceTaskPane.tsx` — remove `'completion_action'` routing
- `packages/web/src/lib/space-store.ts` — drop completion-action state helpers

---

## Appendix B — Decision audit trail

| Decision | Options considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Merge executor: Task Agent LLM vs. deterministic daemon method | (A) TaskAgentManager method invoked from runtime completion hook; (B) New MCP tool the Task Agent LLM calls | **B** | Task description explicitly names `request_human_input` (an LLM-session tool) as the approval surface. Deterministic daemon method can't pause for human input the same way. Future post-approval actions reuse the same pattern. |
| Handoff signal: new gate vs. structured send_message | (A) New `merge-ready-gate` on an `End → TaskAgent` channel; (B) `send_message(task-agent, data)` with structured-data appendix; (C) Artifact written by end-node, runtime passes to Task Agent | **B** | `task-agent` is not a workflow node, so gate semantics don't fit. The structured-data appendix is already the idiomatic pattern for node→Task-Agent data transfer. Artifacts are used as the durable audit trail in addition. |
| `completionAutonomyLevel`: keep, repurpose, or remove | (A) Remove (merge-PR autonomy is the only thing that ever mattered); (B) Keep — separate from merge level; (C) Rename to `workApprovalAutonomyLevel` | **B** | It independently controls `approve_task` vs `submit_for_approval` — a distinct "is the work any good" decision. Removing would force every workflow into the same `approve_task` discipline. Rename is a nice-to-have but costs a schema migration; defer. |
| Verification completion actions (verify-pr-merged, verify-review-posted, verify-tasks-created): keep, convert, delete | (A) Keep as a separate "post-approval verification" hook (violates §11 of research doc); (B) Convert each to a Task Agent tool; (C) Delete (accept regression) | **C** | §11 of the research doc explicitly argues for wholesale removal. The lost verifications are soft guardrails; agents lying is a broader problem addressed by audit artifacts and human review, not completion actions. (B) remains available as a follow-up if the regression bites. |
| Feature-flag the new tool | (A) Ship registered from day 1; (B) Behind flag for Stages 1–2, flip in Stage 2 | **B** | Allows the tool to exist and be tested without any workflow prompt depending on it. De-risks the staged rollout. |
| QA workflow `completionAutonomyLevel` | Keep 4 vs. drop to 3 | **Drop to 3** | QA no longer merges. Self-close decision is now equivalent to Coding — same threshold. Auto-merge is a separate autonomy dimension enforced at the `merge_pr` tool layer. |

---

*End of plan.*
