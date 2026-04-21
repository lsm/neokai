# PR Merging & Completion Actions — Cross-Workflow Analysis

**Date:** 2026-04-21
**Scope:** All four built-in workflows (Coding, Coding-with-QA, Research, Plan & Decompose), plus the Review-Only template.
**Question:** Where are PR merge decisions made, and can a PR be auto-merged when the space is at autonomy **Level 1** (the lowest / most conservative level)?
**Bottom line:** Yes — there are two concrete code paths that can merge a PR at Level 1 without any human approval step, and one design gap where the documented "merge-pr" completion action for the *Coding* workflow is effectively **dead code at Level 1** (it is never reached through the human-approval path).

---

## 1. Background — The Three Dials That Govern Merging

Three independent settings determine whether the runtime will execute a terminal side effect (like merging a PR) without asking a human:

| Dial | Where defined | What it controls | Default |
|---|---|---|---|
| `space.autonomyLevel` | Per-space (1-5) | How much unsupervised capability the space has | `1` |
| `workflow.completionAutonomyLevel` | Per-workflow | Minimum `autonomyLevel` at which the **end-node agent's** `approve_task` tool is allowed to self-close the task | `5` if omitted |
| `CompletionAction.requiredLevel` | Per-action | Minimum `autonomyLevel` at which a specific completion action (script / instruction / mcp_call) auto-executes; otherwise the task pauses for human approval of that action | required field |

Related state on each `SpaceTask`:

- `pendingCheckpointType`: `'gate' | 'task_completion' | 'completion_action' | null` — why the task is paused
- `pendingActionIndex`: when `pendingCheckpointType === 'completion_action'`, points at the `CompletionAction` awaiting approval
- `reportedStatus`: what the end-node agent claimed; **NOT** the authoritative terminal status

The "sole arbiter of terminal status" comment at `packages/daemon/src/lib/space/runtime/space-runtime.ts:611` is important:

> The completion-action pipeline is the sole arbiter of terminal status — we no longer read `reportedStatus` from the agent.

That is, once the end-node agent calls `approve_task`, the daemon runs `resolveCompletionWithActions` (see §5) which decides the final `status` based on `completionActions` + space level, not on what the agent said.

---

## 2. End-Node Tool Contract (Design v2)

The end-node agent has three MCP tools. They are registered in
`packages/daemon/src/lib/space/tools/node-agent-tools.ts:1012-1052`, and their
handlers live in `packages/daemon/src/lib/space/tools/end-node-handlers.ts`.

| Tool | Effect | Autonomy gate |
|---|---|---|
| `report_result({summary, evidence?})` | Append-only audit row in `task_report_result`. **Never** sets `reportedStatus`. | None |
| `approve_task({})` | Sets `reportedStatus='done'` → triggers `resolveCompletionWithActions` on next tick | Rejected when `space.autonomyLevel < workflow.completionAutonomyLevel` (`end-node-handlers.ts:onApproveTask`) |
| `submit_for_approval({reason?})` | Sets `status='review'`, `pendingCheckpointType='task_completion'`. Human reviews via UI. | None (this is the escape hatch when `approve_task` is blocked) |

The task-agent's system prompt is dynamically built in
`packages/daemon/src/lib/space/runtime/task-agent-manager.ts:~1805` and includes a
line telling the agent whether `approve_task` is unlocked:

> `approve_task({}) — NOT AVAILABLE: space autonomy {level} < workflow completionAutonomyLevel {level}`

So at Level 1 in the Coding workflow (whose `completionAutonomyLevel=3`), the
Reviewer is told *at prompt time* that `approve_task` is unavailable — it must
use `submit_for_approval` instead.

---

## 3. Workflow-by-Workflow Breakdown

Key files:
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` — all built-in graphs & prompts
- `MERGE_PR_COMPLETION_ACTION` (`built-in-workflows.ts:186`): `requiredLevel: 4`, runs `gh pr merge --squash` with a MERGED idempotency guard
- `VERIFY_PR_MERGED_COMPLETION_ACTION` (`built-in-workflows.ts:228`): `requiredLevel: 2`, exits non-zero if GitHub PR state is not MERGED
- `VERIFY_REVIEW_POSTED_COMPLETION_ACTION` (`built-in-workflows.ts:271`): `requiredLevel: 2`, exits non-zero if the PR has no reviews/comments
- `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION` (`built-in-workflows.ts:821`): `requiredLevel: 1`, counts DB rows to prove tasks were created

### 3.1 Coding workflow (`CODING_WORKFLOW`, `built-in-workflows.ts:417`)

```
   Coder ──(code-pr-gate: pr_url)──▶ Reviewer ──[end]
   ▲                                    │
   └─(feedback channel, maxCycles=6)────┘

Reviewer.completionActions = [MERGE_PR_COMPLETION_ACTION]  // requiredLevel=4
workflow.completionAutonomyLevel = 3
```

**Flow at space.autonomyLevel = 1:**

1. Coder opens PR, writes `code-pr-gate.pr_url` → channel unlocks
2. Reviewer agent runs, posts review comments on PR
3. Reviewer attempts `approve_task()` → **rejected** (1 < 3). Prompt already told the agent to use `submit_for_approval` instead.
4. Reviewer calls `submit_for_approval({reason})` → task goes to `status='review'`, `pendingCheckpointType='task_completion'`
5. UI surfaces a banner (via `PendingGateBanner` / `SpaceTaskPane` — see `packages/web/src/components/space/PendingGateBanner.tsx`). Human clicks **Approve**.
6. Frontend calls `spaceTask.approvePendingCompletion(approved=true)` RPC → `setTaskStatus('done')` directly (`packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:328-333`)

**Key observation:** Step 6 **skips** `resolveCompletionWithActions` entirely. The
`merge-pr` completion action is never reached. The PR stays open. This is
actually safe from an "auto-merge at level 1" perspective — **but** it means
the `merge-pr` action is effectively dead code in the Coding workflow at
Levels 1-2, and partially-dead at Level 3 (where it would pause for human
approval of the action, but the agent is forced into `submit_for_approval`
anyway). See §6, Gap #3.

**Flow at space.autonomyLevel = 3:**
1-4. Agent now calls `approve_task()` (3 ≥ 3) → succeeds → `reportedStatus='done'`
5. Runtime tick hits `resolveCompletionWithActions` (`space-runtime.ts:1881`)
6. Iterates `[MERGE_PR_COMPLETION_ACTION]`: `3 < 4` → **pause**: `status='review'`, `pendingCheckpointType='completion_action'`, `pendingActionIndex=0`
7. UI surfaces `PendingCompletionActionBanner` (`packages/web/src/components/space/PendingCompletionActionBanner.tsx`). Human clicks **Approve**.
8. Frontend calls `spaceTask.update(status='done')`; daemon intercepts and routes through `resumeCompletionActions` (`packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:117-277`)
9. Script runs → `gh pr merge --squash`. ✅

**Flow at space.autonomyLevel ≥ 4:** `merge-pr` auto-executes. ✅

### 3.2 Coding with QA workflow (`FULLSTACK_QA_LOOP_WORKFLOW`, `built-in-workflows.ts:~1060`)

```
   Coder ──(code-pr-gate: pr_url)──▶ Reviewer ──(review-approval-gate: approved)──▶ QA ──[end]
   ▲                                    │                                          │
   └─(feedback, maxCycles=6)────────────┘                                          │
   └─(QA → Coding feedback, maxCycles=6)──────────────────────────────────────────┘

QA.completionActions = [VERIFY_PR_MERGED_COMPLETION_ACTION]  // requiredLevel=2
workflow.completionAutonomyLevel = 4
```

**Here is the bug.** The QA agent's *system prompt* (`built-in-workflows.ts:1127`, step 5) explicitly instructs:

> 5. If all green: merge the PR with `gh pr merge <URL> --squash`

The QA agent has access to the Bash tool by default. It will run this command
**directly, before any autonomy check**. The `VERIFY_PR_MERGED_COMPLETION_ACTION`
runs **after** (as a completion action at `requiredLevel=2`), and only
*verifies post-facto* that the PR is MERGED on GitHub — so if the agent did
merge, that check passes; if the agent lied, it fails.

**Flow at space.autonomyLevel = 1:**

1. QA agent reads the prompt, runs all tests, all green.
2. QA agent runs `gh pr merge <URL> --squash` **(the PR is now merged on GitHub)**
3. Agent calls `report_result(...)` → append-only audit
4. Agent calls `approve_task()` → rejected (1 < 4). Falls back to `submit_for_approval`.
5. Task pauses at `task_completion`. Human approves via UI. `setTaskStatus('done')`.
6. Completion actions never fire (same dead-code path as §3.1). But **the PR is already merged** from step 2.

**Verdict:** At *every* autonomy level, this workflow merges the PR via the
agent's Bash tool, not via the gated completion action. The
`VERIFY_PR_MERGED_COMPLETION_ACTION` is a post-hoc audit, not a gate.

The code comment at `built-in-workflows.ts:197-199` even acknowledges this:

> Used by QA workflows where the agent is expected to run `gh pr merge` itself
> — this action double-checks that the merge actually happened so the agent
> cannot "lie" about completion.

That is a **deliberate design choice** for high-autonomy operation, but it is
applied unconditionally regardless of `space.autonomyLevel`. This is the most
likely source of the user's observation "PR got merged at level 1."

### 3.3 Research workflow (`RESEARCH_WORKFLOW`, `built-in-workflows.ts:602`)

```
   Research ──(research-ready-gate: pr_url)──▶ Review ──[end]
   ▲                                              │
   └─(feedback)──────────────────────────────────┘

Review.completionActions = [MERGE_PR_COMPLETION_ACTION]  // requiredLevel=4
workflow.completionAutonomyLevel = 2
```

Identical dead-code pattern to Coding:
- At Level 1: Reviewer is blocked from `approve_task` (1 < 2), goes through `submit_for_approval` → human approves → `setTaskStatus('done')` → completion actions skipped → PR stays open. Safe.
- At Level 2-3: `approve_task` allowed, completion-action pipeline pauses on merge-pr (2-3 < 4). Human approves via banner → merge. ✅
- At Level 4+: auto-merges. ✅

### 3.4 Review-Only workflow (`REVIEW_ONLY_WORKFLOW`, `built-in-workflows.ts:722`)

```
   Reviewer ──[end]

Reviewer.completionActions = [VERIFY_REVIEW_POSTED_COMPLETION_ACTION]  // requiredLevel=2
workflow.completionAutonomyLevel = 2
```

No PR merge action. `verify-review-posted` only checks that the Reviewer
posted at least one review/comment. At Level 1 the agent is blocked from
`approve_task`, falls into `submit_for_approval` → human approves → task done.
No merge.

### 3.5 Plan & Decompose (`PLAN_AND_DECOMPOSE_WORKFLOW`, `built-in-workflows.ts:851`)

```
   Planner ──(plan-pr-gate)──▶ Plan Review (4 reviewers) ──(plan-approval-gate 4-of-4)──▶ Task Dispatcher ──[end]

Task Dispatcher.completionActions = [PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION]  // requiredLevel=1
workflow.completionAutonomyLevel = 3
```

No PR merge action. The verification script (`built-in-workflows.ts:793`)
counts rows in `space_tasks` created during this run. At Level 1 the agent is
blocked from `approve_task` (1 < 3) and goes through `submit_for_approval`;
the plan PR stays open and is never merged by the workflow itself.

**Caveat:** downstream tasks created by the Dispatcher may use the Coding
workflow. Each such child task is evaluated independently against the rules
above.

---

## 4. The "Merge Happens" Code-Path Table

For each workflow, where can a `gh pr merge` actually be issued, by whom, and under what autonomy check?

| Workflow | Location of merge | Who runs it | Guarded by |
|---|---|---|---|
| Coding | `MERGE_PR_COMPLETION_ACTION` script (`built-in-workflows.ts:148-180`) | Daemon (`SpaceRuntime.executeCompletionAction`) | `autonomyLevel ≥ 4` (action requiredLevel) **AND** the pipeline is actually reached (only happens when `autonomyLevel ≥ workflow.completionAutonomyLevel = 3`) |
| Coding with QA | Agent's Bash tool, per prompt step 5 (`built-in-workflows.ts:1127`) | QA agent | **Nothing.** Runs at every level. |
| Research | Same as Coding | Daemon | Same as Coding (gated by `requiredLevel=4` and `completionAutonomyLevel=2`) |
| Review-Only | N/A | — | — |
| Plan & Decompose | N/A | — | — |

Two additional back doors that can execute any completion action:

| Back door | Location | Autonomy check? |
|---|---|---|
| `approve_completion_action` MCP tool (space-agent-tools) | `packages/daemon/src/lib/space/tools/space-agent-tools.ts:931-993` | **NO.** Only checks task state (`status==='review'` and `pendingCheckpointType==='completion_action'`). |
| `spaceTask.update` RPC with `status: 'done'` when pendingCheckpointType is `completion_action` | `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:117-277` | None at the RPC layer — this is the *intended* path for human approvals from the UI banner |

---

## 5. `resolveCompletionWithActions` — the Pipeline in Detail

`packages/daemon/src/lib/space/runtime/space-runtime.ts:1881-2015`

```
Input: (spaceId, runId, workflow, taskResult, spaceLevel, taskId)

1. Resolve endNode.completionActions.
   If none → fall back to isAutonomousWithoutActions(spaceLevel) i.e. level ≥ 2.
   (Threshold defined in packages/shared/src/space/workflow-autonomy.ts:35.)

2. Idempotency: if run.completionActionsFiredAt != null → skip, mark done.

3. For each action in order:
     if (spaceLevel >= action.requiredLevel) {
         // Auto-run via executeCompletionAction
         // On failure → return status='blocked' with the failure reason
         // On success → emit completion_action_executed thread + notification events
     } else {
         // Pause here.
         return {
             status: 'review',
             result: buildAwaitingApprovalReason(...),
             pendingActionIndex: i,
             pendingCheckpointType: 'completion_action',
         };
     }

4. All actions done → stamp run.completionActionsFiredAt
   → return { status: 'done', approvalSource: 'auto_policy', ... }
```

**Entry points (where it is called):**

- `processRunTick` (`space-runtime.ts:1561`): when the run is complete and the task hasn't been resolved yet. This is the post-`approve_task` path.
- `reconcileTerminalRunTasks` (`space-runtime.ts:613`): guarded by `canonicalTask.status !== 'done' && !== 'review' && !== 'cancelled'` — i.e. skipped if a human-approved `setTaskStatus('done')` already landed.

**Resume path:** `resumeCompletionActions` (`space-runtime.ts:933-1100`) picks up from `pendingActionIndex`, runs that action, and continues or re-pauses. Called from:
- `spaceTask.update` RPC when the UI banner approves a completion action
- `approve_completion_action` MCP tool (no autonomy check — see §6 Gap #2)

---

## 6. Identified Problems

### Gap #1 — Coding-with-QA auto-merges at Level 1 (HIGH severity)

**Summary.** The QA agent's system prompt (`built-in-workflows.ts:1127`) unconditionally instructs `gh pr merge <URL> --squash` before any autonomy check. At Level 1 the PR is merged by the agent's Bash tool regardless of workflow completionAutonomyLevel. The `VERIFY_PR_MERGED_COMPLETION_ACTION` is post-hoc verification, not a gate.

**Evidence.** Prompt text:
```
5. If all green: merge the PR with `gh pr merge <URL> --squash`
```

Comment at `built-in-workflows.ts:197` explicitly says this is expected:

> Used by QA workflows where the agent is expected to run `gh pr merge` itself

**This is almost certainly the source of the observed behavior.** The user sees
the PR merged at Level 1 in a QA-loop workflow because the QA agent merged
it with its own Bash tool, independent of any approval pipeline.

### Gap #2 — `approve_completion_action` has no autonomy check (MEDIUM severity)

**Summary.** `space-agent-tools.ts:931-993` delegates straight into
`runtime.resumeCompletionActions` without checking space autonomy level
against the action's `requiredLevel`. Contrast with `approve_gate` (same
file, line 713-737) which has a writers-or-autonomy two-path check.

Per `CLAUDE.md` §"Space tool surface", **every session in a Space attaches
to `space-agent-tools` MCP**, including worker sessions and ad-hoc
sessions. Any agent in the space could call this tool and trigger
`merge-pr` at Level 1.

The handler does require `task.status === 'review'` and
`pendingCheckpointType === 'completion_action'`, so this is only exploitable
while a task is already paused. But at Levels 2-3 the Coding/Research
workflows do pause Tasks at `merge-pr` in state `completion_action` — any
space-agent-tools-attached session can approve the merge at that point
without the human click.

**Recommendation:** Mirror the `approve_gate` autonomy path — reject when
`spaceLevel < action.requiredLevel` unless the calling agent has an explicit
writer grant.

### Gap #3 — `merge-pr` completion action is dead code at Levels 1-2 for Coding/Research (MEDIUM severity)

**Summary.** In the Coding workflow (`completionAutonomyLevel=3`) at Level
1, the Reviewer is prevented from calling `approve_task`. It takes
`submit_for_approval` → human approves → `setTaskStatus('done')` via
`spaceTask.approvePendingCompletion`
(`space-task-handlers.ts:328-333`). This path **bypasses
`resolveCompletionWithActions`** entirely, so the `merge-pr` completion
action never fires. The PR is never merged by the workflow.

Same shape for Research (`completionAutonomyLevel=2`) at Level 1.

This is arguably safe (no auto-merge), but it is confusing: the workflow
declares a `merge-pr` action, yet a Level-1 user who "Approves" the task
via the UI is not actually approving the merge — and the PR silently
stays open. There's no UI signal that a completion action was skipped.

**Recommendation (one of):**

1. **Chain the pipelines.** After a successful `approvePendingCompletion`
   for a `task_completion` checkpoint, route the task into
   `resolveCompletionWithActions` the same way `report_result` does. The
   human's approval would then surface the completion-action banner(s) so
   they can individually approve merge-pr. This makes the action reachable
   at Level 1.

2. **Document the gap.** Add a comment to `approvePendingCompletion` noting
   that completion actions are *not* run, and add a UI hint on the
   `task_completion` banner when the end-node has any remaining completion
   actions.

3. **Remove the dead action.** If the design intent is that Level-1 Coding
   never auto-merges, drop `MERGE_PR_COMPLETION_ACTION` from the Coding
   workflow entirely and document that the human is responsible for
   clicking merge on GitHub. (Simplest, but conflicts with the stated
   intent of the action.)

### Gap #4 — No single-source truth for "this action merges code" (LOW severity)

The `artifactType: 'pr'` flag on merge-pr exists but isn't used as a
reviewer-surface cue. A future refactor could use `artifactType` to force
human approval when `spaceLevel < someThreshold`, independent of the
`requiredLevel` knob, for actions that mutate external state
(GitHub PRs).

---

## 7. Code Path Reference (File: Line)

### Daemon runtime
- `packages/daemon/src/lib/space/runtime/space-runtime.ts`
  - `:613` — `reconcileTerminalRunTasks` call into `resolveCompletionWithActions` (skipped when task already done/review/cancelled)
  - `:933-1100` — `resumeCompletionActions` (resume path)
  - `:1561` — `processRunTick` call into `resolveCompletionWithActions` (primary path)
  - `:1881-2015` — `resolveCompletionWithActions` implementation (pause-or-execute loop)
  - `:1945` — the autonomy check: `spaceLevel >= action.requiredLevel`
  - `:2005` — `completionActionsFiredAt` stamp for idempotency

### End-node agent tools
- `packages/daemon/src/lib/space/tools/end-node-handlers.ts`
  - `onApproveTask` — autonomy-gated on `workflow.completionAutonomyLevel`; sets `reportedStatus='done'`
  - `onReportResult` — append-only audit row
  - `onSubmitForApproval` — sets `status='review'`, `pendingCheckpointType='task_completion'`
- `packages/daemon/src/lib/space/tools/node-agent-tools.ts:1012-1052` — tool registration (end-node tools only exposed when callbacks provided)

### Space-wide agent tools
- `packages/daemon/src/lib/space/tools/space-agent-tools.ts`
  - `:687-793` — `approve_gate` with writers-or-autonomy two-path authorization
  - `:878-890` — `approve_task` guard rejecting when `pendingCheckpointType === 'completion_action'`
  - `:931-993` — `approve_completion_action` (Gap #2: **no autonomy check**)
  - `:1211-1244` — MCP tool registrations

### RPC handlers (UI entry points)
- `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`
  - `:117-277` — `spaceTask.update`: intercepts `status='done'` when pending is `completion_action` and routes to `resumeCompletionActions`
  - `:291-367` — `spaceTask.approvePendingCompletion`: **for `task_completion` only**; calls `setTaskStatus('done')` directly; does NOT run completion actions

### Workflow definitions
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`
  - `:148-180` — `PR_MERGE_BASH_SCRIPT` (idempotent, skips if already MERGED)
  - `:186-193` — `MERGE_PR_COMPLETION_ACTION` (`requiredLevel: 4`)
  - `:203-220` — `VERIFY_PR_MERGED_BASH_SCRIPT`
  - `:228-238` — `VERIFY_PR_MERGED_COMPLETION_ACTION` (`requiredLevel: 2`)
  - `:271-281` — `VERIFY_REVIEW_POSTED_COMPLETION_ACTION` (`requiredLevel: 2`)
  - `:417-540` — `CODING_WORKFLOW` (`completionAutonomyLevel=3`, merge-pr)
  - `:602-678` — `RESEARCH_WORKFLOW` (`completionAutonomyLevel=2`, merge-pr)
  - `:722-780` — `REVIEW_ONLY_WORKFLOW` (`completionAutonomyLevel=2`)
  - `:821-831` — `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION` (`requiredLevel=1`)
  - `:851-984` — `PLAN_AND_DECOMPOSE_WORKFLOW` (`completionAutonomyLevel=3`)
  - `:1060-1201` — `FULLSTACK_QA_LOOP_WORKFLOW` (`completionAutonomyLevel=4`)
  - `:1127` — **Gap #1** — QA agent's merge instruction

### Shared / helpers
- `packages/shared/src/space/workflow-autonomy.ts`
  - `:35` — `EMPTY_ACTIONS_AUTONOMY_THRESHOLD = 2` (binary fallback)
  - `:44` — `isAutonomousWithoutActions(level)`
  - `:92` — `isWorkflowAutonomousAtLevel`

### Web UI
- `packages/web/src/components/space/PendingCompletionActionBanner.tsx:81-95` — Approve button calls `spaceStore.updateTask(task.id, { status: 'done' })` which round-trips through `spaceTask.update` → `resumeCompletionActions`

---

## 8. Recommendations (Prioritized)

1. **Fix Gap #1 — Remove direct `gh pr merge` from the QA prompt.**
   - Replace the instructive merge-step in `FULLSTACK_QA_PROMPT` (`built-in-workflows.ts:384-410`) and step 5 of the QA customPrompt (`:1127`) with: "Call `approve_task()` — the workflow will merge the PR for you if autonomy permits."
   - Add `MERGE_PR_COMPLETION_ACTION` to the QA node's `completionActions` (before or after `VERIFY_PR_MERGED_COMPLETION_ACTION`, depending on whether verification should happen pre- or post-merge).
   - Keep `completionAutonomyLevel=4` so the QA flow still self-closes at Level 4+, but now the merge itself is a gated completion action at `requiredLevel=4`.

2. **Fix Gap #2 — Add autonomy check to `approve_completion_action`.**
   - In `space-agent-tools.ts:931-993`, after resolving the pending action, do:
     ```ts
     if (getSpaceAutonomyLevel) {
       const level = await getSpaceAutonomyLevel(spaceId);
       if (level < pendingAction.requiredLevel) {
         return jsonResult({ success: false, error: `autonomy ${level} < requiredLevel ${pendingAction.requiredLevel}` });
       }
     }
     ```
   - Mirror the writers-path used by `approve_gate` if completion actions ever grow a `writers` field.

3. **Fix Gap #3 — Make the `task_completion` approval path trigger any remaining completion actions.**
   - In `spaceTask.approvePendingCompletion` (`space-task-handlers.ts:328-341`), after `setTaskStatus('done')`, call a new `SpaceRuntime.runPostTaskCompletionActions(taskId)` that invokes `resolveCompletionWithActions` for the task's run. This gives Level-1 Coding/Research users a single approval UX that *does* include the merge step.
   - Alternative: on `submit_for_approval`, record `pending_completion_actions: CompletionAction[]` on the task so the UI can surface all pending actions in one banner.

4. **Add a dev-mode assertion** in `seedBuiltInWorkflows` that any node with a `script`-type completion action does not *also* have a step in its `customPrompt` that duplicates the script's effect.
   - Catches the shape of Gap #1 statically for future workflows.

5. **Document the matrix** in `docs/design/autonomy-levels-and-completion-actions.md` — per-workflow, per-level: does merge happen, by what code path, and with what approval gate.

---

## 9. Quick-Check Verification Steps

- **Verify Gap #1:** create a Coding-with-QA space at Level 1, run a task to completion, inspect the `gh pr view <URL> --json state` output as soon as QA agent reports "all green". Expected: `MERGED` before any UI approval.
- **Verify Gap #2:** at Level 2 in a Coding space, pause a task at `merge-pr` (requires Level 3 to get there — so combined repro needs Level 3 space with the task paused by Level-4 action). Then have any session attached to `space-agent-tools` (e.g. the Space Chat Agent) call `approve_completion_action(task_id)`. Expected: merge fires without a human click.
- **Verify Gap #3:** at Level 1 in a Coding space, run a task; human approves the `task_completion` review. Expected: task = done, PR still open on GitHub.

---

## 10. Failure Modes of the Completion-Action Pipeline

The failure handling is the same in both entry paths:
- `resolveCompletionWithActions` (`space-runtime.ts:1945-1953`)
- `resumeCompletionActions` (`space-runtime.ts:1025-1030`)

Both do:

```ts
const result = await this.executeCompletionAction(action, spaceId, runId, workspacePath);
if (!result.success) {
    return {
        status: 'blocked' as const,
        result: result.reason ?? `Completion action "${action.name}" failed`,
    };
}
```

That is the entire failure surface. Everything below follows from it.

### 10.1 Observable outcome of a failed action

| Aspect | Behavior |
|---|---|
| Task status | `blocked` (not `review`, not `failed`) |
| UI banner | `TaskBlockedBanner` — exits the pending-approval UX |
| Error surface | Single string on `task.result`: either the executor's `reason` or `Completion action "X" failed` |
| Script stderr | Captured, capped at `MAX_BUFFER_BYTES`, silently truncated past limit |
| Script stdout | Discarded |
| Exit code | Not preserved |
| Retry affordance | None — no UI, no RPC, no tool |
| `completionActionsFiredAt` | **Not stamped** on failure. If the run is reopened, all earlier successful actions re-fire. |
| Pipeline halts at first failure | Remaining actions never run |
| Rollback | None — earlier successful side effects persist |
| Timeout | Only `script` actions have the 2-minute SIGKILL (`space-runtime.ts:2209`). `instruction` and `mcp_call` actions can hang indefinitely. |

### 10.2 Per-action-type failure modes

- **`script`:** non-zero exit OR bash spawner failure (e.g. `command not found`) both collapse to the same `blocked` result. Stderr is the error context; if the script wrote useful stdout, it's lost.
- **`instruction`:** if `instructionActionExecutor` is not wired up (`space-runtime.ts:2086-2091`), every instruction action fails with `instruction completion action is not supported: no instructionActionExecutor configured`. Silent configuration bug → every workflow that uses an instruction action is DOA.
- **`mcp_call`:** same missing-executor pattern (`:2117-2122`). Plus the underlying MCP tool's error shape (not captured structurally, just `reason: message`).

### 10.3 The false-negative block problem

The worst failure mode is **verification actions that fail transiently on external state**:

| Action | Realistic transient failure | Effect |
|---|---|---|
| `verify-pr-merged` | GitHub 5xx / rate-limit / `gh` auth glitch | Task blocked; PR was merged |
| `verify-review-posted` | GitHub eventual consistency right after posting | Task blocked; reviewer did their job |
| `verify-tasks-created` | SQLite lock contention | Task blocked; tasks were created |
| `merge-pr` | Merge conflict introduced between approval and execution | Task blocked; PR still open but recoverable |

The recovery path for a user hitting any of these is: read daemon logs, edit SQLite directly, or cancel and re-run the whole workflow. None of these are product-grade.

### 10.4 Partial-failure hazard

Because `completionActionsFiredAt` is only stamped on the *all-succeed* path (`:2005`, `:1093`), any failure mid-pipeline leaves the idempotency flag unset. If a code path ever reopens the run (daemon restart + stale executor record, a manual retry tool we might add later, a reconcile bug), **every previously-succeeded action re-runs**. For read-only verifications that's fine; for `merge-pr` the script's own "already MERGED" guard saves us, but that's per-action defensive code, not a runtime guarantee.

Any future completion action with non-idempotent side effects (create-release, post-to-slack, send-email, create-issue) inherits this hazard silently.

---

## 11. Proposal — Consolidate into Gates + Nodes

Taken together, §6 (three gaps) + §10 (failure modes) argue that completion actions should be **removed**, not fixed. The two mechanisms we already have — **gates** and **nodes** — cover every job a completion action does today, with better UX.

### 11.1 What each mechanism gives you

| Concern | Completion action | Gate | Node |
|---|---|---|---|
| Runtime-enforced assertion | ✅ script | ✅ script with same env shape | — |
| Waits-until-true retry UX | ❌ fails → `blocked` | ✅ closed → "not yet" | — |
| Autonomy gating | `requiredLevel` | `requiredLevel` | — (via gate on inbound channel) |
| Idempotency | `completionActionsFiredAt` (single flag) | Gate state in `gate_data` | Per-run state in agent session |
| Streaming logs | ❌ | ❌ (but short) | ✅ full transcript |
| Retry | ❌ | ✅ gate re-evaluates on write | ✅ re-activate node |
| Error context | Single string | Gate check result | Full session |
| Approval UI | Own banner | Existing gate banner | Task/thread UI |
| Tamper resistance | ✅ declarative | ✅ declarative | ⚠️ agent can subvert via prompt |

### 11.2 Migration table — one-for-one replacements

| Existing completion action | Replacement |
|---|---|
| `MERGE_PR_COMPLETION_ACTION` | **Merge node** after Reviewer. Inbound channel has `approval-gate: approved=true` with `requiredLevel: 4`. Agent runs `gh pr merge --squash`. Thread shows stdout/stderr. Failures are the agent's session errors — retry by re-activating the node. |
| `VERIFY_PR_MERGED_COMPLETION_ACTION` | **Delete.** The Merge node's agent is the evidence; no separate verification needed. (Also kills Gap #1 — no prompt can instruct a merge outside the Merge node.) |
| `VERIFY_REVIEW_POSTED_COMPLETION_ACTION` | **Move into `review-posted-gate`** on the Review → Coding feedback channel. Gate already exists; extend its bash check with the review-count query. Reviewer posts → gate re-evaluates → channel unlocks. No task-blocked state. |
| `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION` | **Move into a new `tasks-created-gate`** on the Task Dispatcher's outbound channel (or a post-dispatch self-gate). Same mechanics. |

### 11.3 What goes away

- `CompletionAction` type and its three variants (`script`, `instruction`, `mcp_call`)
- `node.completionActions[]` field
- `workflow.completionAutonomyLevel` (folded into gates' `requiredLevel`)
- `pendingCheckpointType = 'completion_action'` — only `'gate'` and `'task_completion'` remain
- `SpaceTask.pendingActionIndex`
- `resolveCompletionWithActions`, `resumeCompletionActions`, `executeCompletionAction` in `space-runtime.ts`
- `PendingCompletionActionBanner` in the web bundle
- `spaceTask.update` special-case for `pendingCheckpointType === 'completion_action'`
- `approve_completion_action` MCP tool (Gap #2 disappears)
- `run.completionActionsFiredAt` column and idempotency logic
- `buildAwaitingApprovalReason`, `emitTaskAwaitingApproval` helpers
- The dead-code branch in `approvePendingCompletion` (Gap #3 disappears)
- `isAutonomousWithoutActions` / `EMPTY_ACTIONS_AUTONOMY_THRESHOLD` — the zero-actions fallback is no longer needed because there are no completion actions
- The `task-agent-manager.ts` logic that conditionally hides `approve_task` based on `completionAutonomyLevel` (the gate on the outbound channel handles this)

### 11.4 What stays the same (and gets simpler)

- `approve_task` still closes the task. Gating moves to the outbound channel's gate.
- `submit_for_approval` still pauses at `task_completion` for human sign-off on the task itself (the "is this work any good" question).
- Autonomy levels (1-5) still determine which gates auto-approve.
- Workflow editor: the graph gains a node instead of a fiddly "Add completion action" form.

### 11.5 Shape of the new Coding workflow

```
Coder ──(code-ready-gate: pr_url + reviewable)──▶ Reviewer ──(approval-gate: approved + requiredLevel=4)──▶ Merge ──[end]
  ▲                                                  │
  └──(review-posted-gate: review_posted)─────────────┘

  Merge.endNode = true
  workflow.completionAutonomyLevel: REMOVED (gates handle it)
```

At Level 1: `approval-gate` is closed, awaits human. Human approves → channel unlocks → Merge node activates → agent merges PR → `approve_task` → done. **Single approval UX. Single banner. Single retry path.**

At Level 4+: `approval-gate` auto-opens (via `requiredLevel: 4`). Merge node activates and runs end-to-end. Same code path, no auto_policy special case.

### 11.6 Migration plan (sketch, not a ship plan)

1. **Ship a new "Merge" preset node** agent and a gated-merge channel primitive. Gate on channel already supports `requiredLevel`.
2. **Add a feature flag** `space.useLegacyCompletionActions` (default `true`). New spaces get `false`.
3. **Rewrite the four built-in workflows** under the flag: when `false`, use gates + Merge nodes; when `true`, current shape. Same workflow names.
4. **Migration job** per-space on `false` enablement: convert `node.completionActions[]` into an equivalent gate/node pair, preserving audit-trail data.
5. **Deprecate** the completion-action RPCs/tools behind warnings for one release.
6. **Remove** completion-action code once no active spaces are on the legacy flag.

### 11.7 Risks of the consolidation

- **Nodes are less tamper-resistant.** An agent can decide not to call the Merge tool. Mitigation: constrain the Merge node's agent to a single allowed tool (`gh pr merge`) and autoapprove — the session is effectively a "run this command" runner.
- **More rows in `spaces/workflows` tables.** Each former completion action becomes a node + gate. Acceptable.
- **Breaking change for user-authored workflows.** Mitigated by the migration flag + conversion job. Completion actions are not yet common outside the built-ins.
- **Agent context tokens.** A minimal Merge node agent has ~0 token overhead (single tool, one-shot). No meaningful cost.

### 11.8 Recommendation

Treat this consolidation as the **resolution of Gaps #1, #2, and #3 jointly**, not as three separate fixes. Fixing each gap in place either patches symptoms (Gap #2: add an autonomy check) or introduces a new mental-model wrinkle (Gap #3: "sometimes `approvePendingCompletion` triggers completion actions, sometimes not"). Removing the layer is the simpler move.

If shipping the removal is too invasive short-term, the **minimum viable fix** for the user-observed "approved but nothing happens" bug is Gap #3 option 1: chain `approvePendingCompletion` → `resolveCompletionWithActions` so the existing `MERGE_PR_COMPLETION_ACTION` at least fires. That unblocks users without prejudging the larger design direction.

---

## Appendix A — Glossary

- **`completionAction`** — declarative side effect attached to a workflow node (usually end node) that runs when a task would otherwise close. Three types: `script`, `instruction`, `mcp_call`.
- **`requiredLevel`** — minimum `autonomyLevel` at which a `completionAction` will auto-run. Otherwise the task pauses for human approval of that specific action.
- **`completionAutonomyLevel`** — minimum `autonomyLevel` at which the end-node agent's own `approve_task()` tool is unlocked. Below that, the agent must use `submit_for_approval` (human in the loop at the *task* level, before completion actions even get a chance to run).
- **`pendingCheckpointType`** — why a task is paused. `'gate'` = stuck on an unopened channel gate. `'task_completion'` = human approval requested by `submit_for_approval`. `'completion_action'` = paused because an action's `requiredLevel` exceeds space level.
- **`approvalSource`** — stamped on the task when it transitions to done/cancelled. `'human'`, `'auto_policy'`, or `'agent'`.
