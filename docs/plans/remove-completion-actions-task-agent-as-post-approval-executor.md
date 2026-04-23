# Plan: Remove `completionActions` — Workflow-Defined Post-Approval Agent Routing

**Task:** Space Task #75
**Source research:** [`docs/research/pr-merging-completion-actions.md`](../research/pr-merging-completion-actions.md)
**Status:** Planning — no code changes yet
**Author:** Research node
**Revision:** 2026-04-23 — approach changed from "Task Agent MCP `merge_pr` tool" to "workflow-declared post-approval agent". See §8 "Revision history" for the full context.

---

## 0. Executive summary

The research doc argues (and this plan accepts) that the `completionActions`
system should be **removed entirely**. The original revision of this plan
proposed replacing it with a narrow `merge_pr` MCP tool on the Task Agent.
That approach was reconsidered after initial review:

- Real-world post-approval work (merge a PR, deploy, publish a package, …) is
  rarely a one-shot shell command. It involves waiting on CI, handling
  conflicts, retrying on transient failures, and deciding when to escalate to
  a human. A rigid handler cannot do this well; it needs **LLM dynamic
  processing**.
- Post-approval actions are **per-workflow**, not per-daemon. The workflow
  template knows its own domain (coding-with-PRs vs. research-with-docs vs.
  plan-and-decompose). Hardcoding "merge_pr" as a daemon-level primitive
  leaks workflow-specific knowledge into the runtime.
- The Task Agent's "orchestrator, never executor" contract should stay
  intact. Adding any executor tool to it (narrow or otherwise) erodes the
  contract and makes future requests ("can Task Agent also deploy?") harder
  to refuse.

**The revised approach is workflow-declared post-approval agent routing.** In
one sentence: a workflow template declares `postApproval.targetAgent` (an
agent role that is part of the same workflow, or `task-agent`) and
`postApproval.instructions` (a templated prompt). After the end node signals
completion, the Task Agent transitions the task to a new `approved` status,
spawns a fresh session for the target agent with the interpolated
instructions, and moves the task to `done` once that session completes. The
target agent is a normal workflow-agent session with its normal toolkit
(Bash, file ops, MCP servers, everything), so it can handle merge complexity
the same way any other node handles its work — with LLM judgement, retries,
and escalation.

Concretely:

1. New workflow schema field `postApproval: { targetAgent, instructions }` —
   `targetAgent` must be either a declared agent role in the same workflow or
   the literal string `task-agent`. `instructions` is a templated string
   (`{{pr_url}}`, `{{autonomy_level}}`, `{{reviewer_name}}`, …) evaluated at
   routing time.
2. End nodes still signal post-approval intent via a structured `send_message`
   to `task-agent` (with `data: { pr_url, post_approval_action: 'merge_pr' }`
   or any other domain-specific key) and **then** call `approve_task()` /
   `submit_for_approval()` exactly as today. This payload survives as the
   template's data source — `{{pr_url}}` comes from there.
3. New task status value **`approved`**. Lifecycle becomes
   `open → in_progress → review? → approved → done` (the `review` branch is
   unchanged from today). The Task Agent transitions the task to `approved`
   when an end node closes it; it transitions to `done` once post-approval
   completes.
4. Task Agent, on seeing `approved`, looks up `workflow.postApproval`:
   - If the workflow has no `postApproval` → immediately transition to `done`
     (single-step workflows, documentation missions).
   - Otherwise → spawn a new session for `targetAgent` with the interpolated
     `instructions` as the kickoff user message. Wait for the session to
     complete.
5. The spawned post-approval session is a normal workflow-agent session: it
   has the agent's full system prompt, tool surface, and MCP servers. For a
   PR merge, the instructions direct it to run the appropriate shell
   commands (`gh pr view`, `gh pr merge`, worktree sync). For a different
   workflow's post-approval it could be publishing a release, notifying
   slack, etc. — all determined by the workflow author's instruction string.
6. The entire `CompletionAction` type, its runtime pipeline, its RPC
   intercepts, its MCP tool (`approve_completion_action`), its DB columns,
   and its UI surface are deleted. The per-workflow knob
   `completionAutonomyLevel` **stays** (it controls `approve_task` vs
   `submit_for_approval` at the *work-is-good* level, orthogonal to the
   post-approval step).

This resolves Gaps #1, #2, #3 from the research doc in one move, eliminates
the failure modes catalogued in §10 of that doc, and produces a single
unified approval UX — without introducing new executor primitives into the
Task Agent or daemon.

### Prioritized implementation order

| Stage | PR | Scope | Dependency |
|------|----|-------|------------|
| 1 | Task state `approved` + workflow schema | Add `TaskStatus='approved'` (shared types + DB migration), add `WorkflowDefinition.postApproval` shape + validator, no behaviour change yet (nothing reads `approved` or `postApproval` beyond load/save). Unit-tested. | — |
| 2 | Task Agent post-approval routing | Task Agent reads `workflow.postApproval` on task-closed event; transitions task to `approved`; spawns target-agent session with templated instructions; waits for that session to complete; transitions task to `done`. Behind a feature flag so callers continue seeing completion-actions behaviour until workflow templates migrate. | Stage 1 deployed |
| 3 | End-node handoff + built-in workflow `postApproval` entries | Update built-in workflow prompts to `send_message` to `task-agent` with `{ pr_url, post_approval_action }` before `approve_task`. Populate `postApproval` on all 5 built-in workflows. Update Task Agent system prompt + kickoff. Flip the feature flag. | Stage 2 deployed |
| 4 | Remove completion-action runtime pipeline | Delete `resolveCompletionWithActions` / `resumeCompletionActions` / `executeCompletionAction`; delete the `spaceTask.update` intercept for `completion_action`; delete `approve_completion_action` MCP tool; delete `PendingCompletionActionBanner`. Task/run completion now flows through the new `approved → done` path. | Stage 3 deployed |
| 5 | Schema cleanup + docs | Drop `pending_action_index`, `pending_checkpoint_type='completion_action'` value, `completion_actions_fired_at`, `MERGE_PR_COMPLETION_ACTION` etc. from DB & shared types. Docs refresh. Changelog. | Stage 4 merged |

Stages 4 + 5 can reasonably ship as one PR if the diff is still reviewable;
separating them keeps the migration safer.

---

## 1. Post-approval agent routing

### 1.1 Workflow schema: `postApproval`

New optional field on `WorkflowDefinition` (shared type):

```ts
interface PostApprovalRoute {
    /**
     * Agent role that runs post-approval work. Must be one of:
     *   - An agent name declared on a node in THIS workflow (e.g. "reviewer",
     *     "coder", "qa"). Post-approval spawns a fresh session for that role
     *     with the same config as a workflow-node session (same tool surface,
     *     same MCP servers, same worktree), independent of any previous
     *     execution.
     *   - The literal string "task-agent". Post-approval runs in the Task
     *     Agent's own session — used only when no workflow agent is
     *     appropriate and the Task Agent's orchestrator-tool surface is
     *     sufficient.
     * Validation runs at workflow save + load time; see §1.5.
     */
    targetAgent: string;

    /**
     * Templated user-message prompt delivered to the target agent's new
     * session as its kickoff input. Template variables are interpolated from
     * the signalled data and space state at routing time; see §1.6 for the
     * template grammar.
     *
     * Example:
     *   "The task has been approved. Merge the PR at {{pr_url}}.
     *    Space autonomy level: {{autonomy_level}}.
     *    - If autonomy >= 4, merge directly. Sync your worktree after.
     *    - Otherwise, call request_human_input to confirm, then merge.
     *    Verify CI status first (gh pr checks). On conflicts, rebase and
     *    retry. Escalate to the user via request_human_input if you get
     *    stuck."
     */
    instructions: string;
}

interface WorkflowDefinition {
    // ... existing fields
    postApproval?: PostApprovalRoute;
}
```

Rules:

- **Optional.** Workflows without a `postApproval` field transition directly
  from `approved → done` with no routing. Applies to workflows whose
  real-world lifecycle has no after-approval step (documentation, research,
  plan-and-decompose).
- **Single target per workflow.** No fan-out, no fallback chain. If a
  workflow needs both "merge PR" and "notify slack" the authors compose them
  inside `instructions`: the single target agent runs the combined flow
  step-by-step.
- **No dedicated tool surface.** The target agent's session is started with
  the same tool surface as if it were running a workflow node. No
  post-approval-specific MCP tools or Bash carve-outs.

### 1.2 Why a post-approval agent, not a dedicated MCP tool

(This section replaces the original revision's §1.2 "Why a dedicated tool,
not generic Bash". The argument flipped after the initial review: the
deterministic handler was too rigid for real-world merges.)

The Task Agent's system prompt declares it an orchestrator, not an executor.
Holding that line is valuable for three reasons, all of which push against
adding even a narrow executor tool like `merge_pr`:

1. **Merging a PR is not a one-shot shell command.** It requires waiting on
   CI, resolving conflicts, retrying on transient GitHub 500s, and deciding
   when to escalate to a human. A `Bun.spawn` handler with a fixed bash
   script has no decision surface for any of this; it either succeeds in one
   attempt or returns a stderr blob. LLM-dynamic handling is the natural fit.

2. **Post-approval work is workflow-specific.** A coding workflow merges a
   PR. A release workflow cuts a tag and publishes. A docs workflow might
   open a downstream docs-site PR. Encoding any one of these as a daemon
   primitive leaks the workflow's domain into the runtime and invites
   `deploy_service`, `publish_package`, `notify_oncall` as follow-up
   primitives. Workflow authors already write the rest of their workflow in
   prompts — let them write post-approval the same way.

3. **The orchestrator contract is a narrow interface worth keeping.** The
   Task Agent's value is that it is predictable: it tracks tasks, routes
   messages, requests human input, spawns agents. Every executor tool added
   to its MCP server enlarges its surface area and makes its behaviour
   harder to reason about. Routing to a purpose-built agent session keeps
   the Task Agent thin.

**Tradeoff accepted:** the post-approval agent session has a full toolkit
(Bash, filesystem, MCP) — much broader than a dedicated `merge_pr` handler.
This is fine because: (a) workflow-node sessions already have it, so we are
not granting a new privilege — we are reusing an existing one; (b) the
session is short-lived and scoped to the task at hand; (c) the autonomy
level and instruction template bound what the agent does in practice
(§3).

### 1.3 New task status: `approved`

Add `'approved'` to the `TaskStatus` union (shared type) and to the DB
`space_tasks.status` CHECK constraint. The full set becomes:

```
open | in_progress | review | approved | done | blocked | cancelled | archived
```

Semantics:

| Status | Meaning |
|--------|---------|
| `in_progress` | A workflow node is actively working. |
| `review` | The end node returned `submit_for_approval`; a human must approve (or reject) before the task can close. Unchanged. |
| **`approved` (new)** | The work has been accepted (by the end node via `approve_task`, or by a human via `approvePendingCompletion`). **Post-approval is now pending.** The Task Agent reads `workflow.postApproval` and routes. |
| `done` | Terminal success. Reached from `approved` once the post-approval session completes (or immediately if the workflow has no `postApproval`). |
| `blocked` | Terminal failure or human intervention required. |
| `cancelled` | User cancelled. |
| `archived` | Moved out of active views. |

Transitions relevant to this plan:

```
in_progress --approve_task()--> approved
in_progress --submit_for_approval()--> review
review --approve (human)--> approved
approved --no postApproval--> done
approved --postApproval session completed--> done
approved --postApproval session failed after retries--> blocked
```

**DB migration:**

- Extend the `status` CHECK constraint on `space_tasks` to include
  `'approved'`. Uses the table-rebuild pattern (SQLite cannot alter a CHECK
  constraint in place).
- Add a new column `space_tasks.post_approval_session_id TEXT NULL` that
  records the sub-session spawned for post-approval. Nullable because many
  tasks won't have one.
- Add a new column `space_tasks.post_approval_started_at INTEGER NULL` for
  audit / observability.

No backfill required: existing tasks are all in terminal or in-flight
statuses that don't include `approved`.

### 1.4 Task Agent routing mechanics

Three event sites interact:

1. **End-node `approve_task` completes.** Today this flows through the
   completion-action pipeline. New behaviour:
   - `SpaceRuntime` transitions the task from `in_progress → approved`
     (instead of the current `in_progress → pending_completion_action → done`).
   - Emits a `[TASK_APPROVED]` runtime event to the Task Agent session
     carrying the end-node's structured-data payload verbatim (for template
     interpolation).

2. **`approvePendingCompletion` (the human-approves-the-work path).**
   Transitions the task `review → approved` instead of today's `review → done`
   (or the completion-action branch). Emits `[TASK_APPROVED]` the same way.

3. **Task Agent receives `[TASK_APPROVED]`.** It looks up
   `workflow.postApproval` for the current workflow:

   - **If no `postApproval`:** Task Agent calls a new internal RPC
     `spaceTask.completePostApproval({ taskId })` which transitions
     `approved → done`. Done.

   - **If `postApproval.targetAgent === 'task-agent'`:** Task Agent
     interpolates `instructions` and acts on them within its own session.
     This is the narrow case where the orchestrator itself is the target
     — used when the post-approval work is small enough to fit within
     the Task Agent's orchestrator tool surface (e.g. sending a notification
     via `send_message`, writing a final artifact, no-op workflows). On
     completion, calls `spaceTask.completePostApproval` to close.

   - **Otherwise (targetAgent is a workflow-agent role):** Task Agent
     spawns a new session for that role:
     - Session kind: `space_task_post_approval` (new session type) or reuse
       the existing `space_task_agent` sub-session model. Decision deferred
       to §7.1.
     - Same worktree, same MCP server config as the corresponding
       workflow-node session would have.
     - Kickoff user message = interpolated `instructions`.
     - Records `post_approval_session_id` on the task.
     - Awaits session completion.

4. **Post-approval session completes.** The spawned session terminates
   normally (its agent calls `approve_task`, or simply exits). Task Agent
   observes the `[NODE_COMPLETE]`-equivalent event and calls
   `spaceTask.completePostApproval({ taskId })` to move `approved → done`.

5. **Post-approval session fails.** If the session exits with an error, or
   the spawned agent calls `submit_for_approval` on its post-approval work
   (escalating to a human), the task stays in `approved` with a
   `postApprovalBlockedReason` recorded. The user sees a banner similar to
   today's `PendingCompletionActionBanner` but driven by the session
   outcome, not by a specific action. They can inspect the session
   transcript, fix the issue externally, and either retry or manually close.

### 1.5 Eligible target agents + validation

`targetAgent` must resolve at workflow save/load time. The validator:

```ts
function validatePostApproval(
    wf: WorkflowDefinition
): PostApprovalValidationResult {
    if (!wf.postApproval) return { ok: true };
    const { targetAgent } = wf.postApproval;
    if (targetAgent === 'task-agent') return { ok: true };
    const workflowAgents = new Set(
        wf.nodes.flatMap((n) => n.agents.map((a) => a.name))
    );
    if (workflowAgents.has(targetAgent)) return { ok: true };
    return {
        ok: false,
        error: `postApproval.targetAgent "${targetAgent}" is not a declared agent on this workflow and is not "task-agent". Eligible: ${[...workflowAgents, 'task-agent'].join(', ')}.`,
    };
}
```

Runs in `SpaceWorkflowManager.create` and `.update`, and on load from DB in
`SpaceWorkflowManager.get` (surfaces as a validator warning — workflow loads
but `postApproval` is disabled for that run until fixed, to protect against
stale configs after a node removal).

**Why restrict to workflow-declared agents + task-agent?** Any other target
would require inventing a new agent role with ad-hoc config. The constraint
keeps the surface narrow: a workflow author can only route to agents they
already understand (because they already declared them) or the
orchestrator. If a post-approval step needs a different agent, add it as a
node in the workflow first.

### 1.6 Template grammar for `instructions`

Minimal, deterministic interpolation — no conditional logic, no expressions,
no code execution. The template string is split on `{{…}}` tokens and each
token is looked up against the interpolation context:

```ts
interface PostApprovalTemplateContext {
    /** From end-node structured-data: { pr_url: "..." }. */
    [key: string]: string | number | boolean | undefined;

    // Standard variables always provided by the runtime:
    autonomy_level: number;      // space.autonomyLevel at routing time (1–5)
    task_id: string;             // the task being closed
    task_title: string;          // task title
    reviewer_name: string;       // agent name of the end node that approved
    approval_source:             // how the task reached 'approved'
        'end_node' | 'human_review';
    space_id: string;
    workspace_path: string;
}
```

- Undefined variables render as the literal token (e.g. `{{pr_url}}` stays
  as `{{pr_url}}`) and emit a runtime warning. The target agent sees the
  gap and can ask the user for clarification via `request_human_input`.
- No escaping for `{`/`}` is needed in practice; the grammar is scoped to
  `{{identifier}}` where identifier is `[a-zA-Z_][a-zA-Z0-9_]*`.
- Templating is performed in a single pass in the Task Agent's routing
  code before the kickoff message is sent.

**Explicitly out of scope for v1:** conditionals (`{{#if}}`), iteration,
nested variable lookups, helper functions. The goal is a dumb string
substitute — anything more is delegated to the LLM reading the prompt.

---

## 2. End-node handoff protocol

*(Largely unchanged from the previous revision — the signalling mechanism
still fits the new design. Only §2.3 is rewritten to reflect the new
routing semantics.)*

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

So the Task Agent can parse `pr_url` out of its conversation context with
zero new infrastructure.

**New convention:** end-node agents send, as a required step before calling
`approve_task()` / `submit_for_approval()`:

```ts
send_message({
    target: 'task-agent',
    message: 'Work complete. Post-approval data attached.',
    data: { pr_url: '<url>', post_approval_action: 'merge_pr' }
});
```

The `data` keys are **arbitrary** from the runtime's perspective — the Task
Agent uses them as the template interpolation context in §1.6. A workflow
whose `instructions` references `{{release_tag}}` would have its end node
signal `data: { release_tag: '...', post_approval_action: 'publish_release' }`
instead. The `post_approval_action` key is a **convention for the operator
reading the conversation**, not a runtime dispatch key — the runtime
dispatches on `workflow.postApproval.targetAgent`, not on the signalled
action.

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
have signalled data matching its workflow's expected template variables
before its `approve_task` is accepted"), add a runtime check in Stage 3: on
`approve_task`, if the workflow has a `postApproval` referencing template
variables not present in any signalled `data`, log a warning and optionally
refuse.

### 2.3 When does the Task Agent act?

Two signals converge in the Task Agent's existing event loop
(documented in the Task Agent system prompt at
[`task-agent.ts:233-260`](../../packages/daemon/src/lib/space/agents/task-agent.ts)):

1. The structured `[Message from reviewer]: ...\n<structured-data>{...}</structured-data>`
   arrives in the Task Agent's conversation. Task Agent remembers the
   payload in its context.
2. The task transitions to `approved` — either via `approve_task()` from the
   end-node or via the human `approvePendingCompletion` path. A new runtime
   event `[TASK_APPROVED]` is injected into the Task Agent's session at that
   moment.

**Runtime injection shape:**

```
[TASK_APPROVED] Task <taskId> ("<task-title>") was approved.

Post-approval routing:
  workflow: <workflow-name>
  target_agent: <target_agent or "none">
  interpolation_keys_expected: [pr_url, autonomy_level, ...]
  approval_source: <end_node | human_review>

If target_agent is declared, route now: spawn the session with the
interpolated instructions from workflow.postApproval.instructions. If
target_agent is "task-agent", act on those instructions in this
session and then call spaceTask.completePostApproval when done. If
target_agent is "none", call spaceTask.completePostApproval immediately.
```

The Task Agent has a new tool `spawn_post_approval_session` (internal to the
Task Agent MCP server; not exposed to node agents) that accepts
`{ taskId, targetAgent }` and performs the spawn. `completePostApproval` is
a no-args status transition (Task Agent already owns the task).

Alternative considered, rejected: have the runtime do the spawn automatically
on the `[TASK_APPROVED]` boundary, without the Task Agent's involvement.
Rejected because:

- The Task Agent owning the spawn keeps the control plane in one place.
- LLM judgement may still be useful pre-spawn (e.g. the Task Agent may
  decide the `instructions` need augmenting with context from artifacts it
  has seen).
- Symmetry with the `submit_for_approval` path, which the Task Agent already
  handles via its conversation loop.

### 2.4 Prompt changes by node

*(Unchanged from the previous revision — all five built-in workflows still
need to emit the `send_message(task-agent, …)` step before `approve_task`.
The full list is identical to the previous §2.4.)*

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
         message: "Reviewer approved. PR ready for post-approval.",
         data: { pr_url: "<url>", post_approval_action: "merge_pr" }
      )
   d. Call `save_artifact({ type: "result", append: true, summary, prUrl })` to record the audit entry.
   e. Call `approve_task()` to close the task. If autonomy blocks self-close,
      call `submit_for_approval({ reason: "…" })` instead — the Task Agent
      will still route post-approval once the human approves.
```

#### 2.4.2 Research Workflow — `RESEARCH_WORKFLOW` Review node
File: `built-in-workflows.ts:633-662`. Analogous change to step 6.

#### 2.4.3 Coding with QA Workflow — `FULLSTACK_QA_LOOP_WORKFLOW` QA node
File: `built-in-workflows.ts:1107-1135`.
**Remove** steps 5–6 ("merge the PR with `gh pr merge … --squash`" and "sync
worktree") entirely. QA no longer merges; a post-approval reviewer session
does. Replace with the same `send_message(task-agent, …)` + `approve_task`
sequence.

#### 2.4.4 Review-Only Workflow — `REVIEW_ONLY_WORKFLOW`
File: `built-in-workflows.ts:721-777`.
No merge to perform. No `postApproval` declared on the workflow. The
post-approval routing skips to `done` immediately. Prompt change:
remove the trailing paragraph about "the runtime verifies at least one
review/comment exists before accepting completion" — that ran via
`VERIFY_REVIEW_POSTED_COMPLETION_ACTION` which is being deleted.

Known regression (unchanged from previous revision): at Level 1 this is
still protected by human review; at Level ≥ 2 the lie slips through. See
§4.3 for mitigation options.

#### 2.4.5 Plan & Decompose Workflow — `PLAN_AND_DECOMPOSE_WORKFLOW`
File: `built-in-workflows.ts:952-972`.
No `postApproval` declared. Dispatcher prompt is unchanged.

---

## 3. Autonomy-level enforcement

### 3.1 Where the autonomy check lives (post-revision)

In the revised design, autonomy enforcement is **not a dedicated handler
check** (there is no dedicated handler). Instead, three layers hold the
line:

1. **Template-layer (guidance for the LLM):** the `postApproval.instructions`
   string for each workflow references `{{autonomy_level}}` and spells out
   the rule. A merge-PR instructions template, for example:
   > "Space autonomy level: {{autonomy_level}}. If autonomy >= 4, merge
   > directly. Otherwise, call `request_human_input` with a clear question
   > ('Approve merging PR {{pr_url}}?') before running any merge command.
   > Record the human's response as the merge justification."
2. **Tool-layer (authoritative — unchanged from today):** the
   post-approval session inherits the standard space autonomy enforcement
   applied to every tool call. Bash calls, file-write calls, and
   MCP-tool calls all run through the existing autonomy filter; a
   level-2 session cannot just `gh pr merge` if the space policy forbids
   destructive Bash at level 2. No new enforcement plumbing is needed.
3. **Session-kind-layer:** post-approval sessions can be given a narrower
   tool allowlist than the workflow-node session they correspond to, if
   we want to (e.g. `gh` + `git` + `cd` but no arbitrary `curl`). Scoping
   decision deferred to §7.2.

### 3.2 Task Agent system prompt addition

Amend [`task-agent.ts:buildTaskAgentSystemPrompt`](../../packages/daemon/src/lib/space/agents/task-agent.ts)
to add a new `## Post-Approval Routing` section after the existing
`## Human Gate Handling` section (~line 273):

```
## Post-Approval Routing

When a task reaches `approved` status (either via `approve_task()` from the
end node, or via human approval of a `submit_for_approval` request), a
`[TASK_APPROVED]` event is injected into your session. That event tells you:
- the workflow's `postApproval` routing (target agent + what interpolation
  keys the instructions template expects),
- whether the approval source was the end node or a human review.

Your job is to decide the next step:

1. If the workflow has no `postApproval` target, call
   `spaceTask.completePostApproval({ taskId })` to move the task to `done`.
2. If `target_agent` is a workflow-agent role (e.g. "reviewer", "coder"),
   call `spawn_post_approval_session({ taskId, targetAgent })`. The runtime
   interpolates the instructions using the structured-data payload from the
   end node's signal and delivers it as the new session's kickoff. Wait for
   the session to complete; then call `completePostApproval`.
3. If `target_agent` is "task-agent", the post-approval work runs in this
   conversation. Interpret the interpolated instructions directly. When
   complete, call `completePostApproval`.

You do not execute post-approval work yourself via shell or Bash — you
route. The only exception is `target_agent: "task-agent"`, in which case
use the tools already on this MCP server (send_message, request_human_input,
save_artifact, list_artifacts). Do not attempt to run shell commands.
```

### 3.3 `request_human_input` question scaffolding

When a target-agent session decides it needs human approval (the template
said `if autonomy < 4 → request_human_input first`), it calls the Task
Agent's existing `request_human_input` handler at
[`task-agent-tools.ts:759-801`](../../packages/daemon/src/lib/space/tools/task-agent-tools.ts).
This is the same path used by any workflow-node session that needs to pause
for a human — no changes here.

The template's guidance block steers the agent toward a consistent question
format (e.g. `"Approve merging PR {{pr_url}}?"`). Unlike the previous
revision, we do not snapshot-pin the exact string: the target agent's LLM
chooses the wording based on the instructions. If consistency is desired,
workflow authors can hardcode the question string inside the instructions
template:

```
If autonomy < 4, first call request_human_input with exactly
question="Approve merging PR {{pr_url}}?" and context="..." and wait for
the response before merging.
```

### 3.4 Idempotency / retry

Idempotency lives in two places:

1. **The target-agent session's own logic.** The session's LLM is told (via
   instructions) to check the current state before acting — e.g. "first run
   `gh pr view <url> --json state,mergedAt` — if the PR is already merged,
   record that and exit successfully."
2. **The underlying bash script used by merge templates.** The existing
   [`PR_MERGE_BASH_SCRIPT`](../../packages/daemon/src/lib/space/workflows/built-in-workflows.ts)
   has a merged-state short-circuit. We keep the script body available as a
   reusable helper that merge-style `postApproval.instructions` can
   reference (e.g. "`bash /path/to/merge-helper.sh`"). Hoisting it to a
   standalone module (`packages/daemon/src/lib/space/tools/pr-merge-script.ts`)
   remains useful purely as a reusable helper for the built-in Coding
   workflow's instructions string; not as a runtime-executed primitive.

**Daemon restart mid-session.** The post-approval session is a regular
sub-session; the same restart-restore plumbing that covers workflow-node
sessions covers post-approval sessions. When the session restarts it re-reads
the PR state and decides: already done → exit success; not done → retry
from the top. The Task Agent's tracking (`post_approval_session_id` on the
task row) makes it easy to re-attach.

**Task Agent re-routing.** If the Task Agent LLM decides to re-route (rare —
would require a conversation rewind), `spawn_post_approval_session` checks
`post_approval_session_id`; if one is already set and not in a terminal
state, it returns a no-op success with the existing session ID.

### 3.5 Human-rejection path

If the target-agent session escalates (calls `submit_for_approval` on
itself, or the template's `request_human_input` response is a rejection):

1. The session records the rejection in an artifact.
2. The session exits normally (completed, not failed).
3. Task Agent observes completion, calls `completePostApproval` —
   task moves to `done`.
4. An audit artifact on the task records "post-approval skipped:
   `human_rejected`".

If the session itself errors out irrecoverably (crashed, hit timeout, ran
out of retries):

1. Task stays in `approved`.
2. `postApprovalBlockedReason` is set.
3. A UI banner similar to today's PendingCompletionActionBanner shows
   "Post-approval failed: <reason>. [Retry | Mark done | View session]".
4. Operator can retry (re-spawn the same target agent with same
   instructions), manually advance, or inspect the session transcript.

This is a **minor design change from the previous revision.** Previously,
rejection always moved to `done`. In the revised design, *agent-initiated*
rejection (via the agent's own `submit_for_approval` or
`request_human_input(no)`) still moves to `done` (human decision), but
*session errors* stay in `approved` with a retry option (not a human
decision — a technical failure).

---

## 4. Completion-action removal

### 4.1 Code to delete outright

*(Unchanged from the previous revision; the old completion-action pipeline
is removed the same way regardless of what replaces it.)*

| Path | What to delete |
|------|----------------|
| `packages/shared/src/types/space.ts` | `CompletionAction` union, `ScriptCompletionAction`, `InstructionCompletionAction`, `McpCallCompletionAction`, `CompletionActionBase`, `McpCallExpectation` (lines 1481-1556). `WorkflowNode.completionActions` field (line 1032). `SpaceTask.pendingActionIndex`, `SpaceTask.pendingAction` (lines 280, 315-326). `'completion_action'` variant of `SpaceTask.pendingCheckpointType` (line 287). `SpaceWorkflowRun.completionActionsFiredAt` (line 641). |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts` | `resolveCompletionWithActions` (lines 1881-2015). `resumeCompletionActions` (lines 932-1104). `executeCompletionAction` (lines 2067-2146). `resolveArtifactData` (lines 2153-2163). `buildAwaitingApprovalReason` (lines 71-76). `emitTaskAwaitingApproval` (lines 2028-2050). The two call sites at 613 and 1561 now call a new small helper `resolveTaskApproval(task, workflow)` that transitions to `approved` and emits `[TASK_APPROVED]`. |
| `packages/daemon/src/lib/space/runtime/completion-action-executors.ts` | Entire file (285 lines). |
| `packages/daemon/src/lib/space/runtime/pending-action.ts` | Entire file (60 lines). |
| `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` | `resumeCompletionActions` public API (lines 795-807). |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts` | `approve_completion_action` handler (lines 944-1006) and its tool registration (line 1246). |
| `packages/daemon/src/lib/space/tools/task-agent-tools.ts` | Update `approve_task` tool description string to reference the new routing model. Add new tools: `spawn_post_approval_session`, `completePostApproval` (internal to Task Agent MCP server). |
| `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` | The `pendingCheckpointType === 'completion_action'` intercept in `spaceTask.update` (lines 154-203). `approvePendingCompletion` now transitions `review → approved` (not `review → done`). Add `completePostApproval` RPC. |
| `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` | `MERGE_PR_COMPLETION_ACTION` (lines 187-194). `VERIFY_PR_MERGED_BASH_SCRIPT` + `VERIFY_PR_MERGED_COMPLETION_ACTION` (lines 204-239). `VERIFY_REVIEW_POSTED_BASH_SCRIPT` + `VERIFY_REVIEW_POSTED_COMPLETION_ACTION` (lines 246-282). `PLAN_AND_DECOMPOSE_VERIFY_SCRIPT` + `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION` (lines 792-830). Every `completionActions: [...]` entry on a node (lines 518, 664, 766, 972, 1135). **Add** `postApproval` on the 2 workflows that need it (Coding, Research, QA). `PR_MERGE_BASH_SCRIPT` stays but moves to `pr-merge-script.ts` (see §3.4). |
| `packages/web/src/components/space/PendingCompletionActionBanner.tsx` | Entire file (385 lines). |
| `packages/web/src/components/space/TaskStatusActions.tsx` | Remove import + render of `PendingCompletionActionBanner`. Add a new, simpler `PendingPostApprovalBanner` that surfaces the post-approval session status when a task is stuck in `approved` (see §3.5). |
| `packages/web/src/components/space/SpaceTaskPane.tsx` | Remove routing of `'completion_action'` checkpoint to the removed banner. |
| `packages/shared/src/space/workflow-autonomy.ts` | `EMPTY_ACTIONS_AUTONOMY_THRESHOLD`, `isAutonomousWithoutActions`, `BlockingAction`, `BlockingWorkflow`, `AutonomousWorkflowCount`, `isWorkflowAutonomousAtLevel`, `countAutonomousWorkflows`, `collectCompletionActions` — replace with a single `isWorkflowAutoClosingAtLevel(wf, level)` that checks only `level >= (wf.completionAutonomyLevel ?? 5)`. |

### 4.2 Code to keep / repurpose

| Item | Decision |
|------|----------|
| `completionAutonomyLevel` on `SpaceWorkflow` | **Keep.** It still controls whether the end-node agent's `approve_task` is unlocked vs. forced onto `submit_for_approval` — orthogonal to the post-approval step. |
| `submit_for_approval` + `approvePendingCompletion` RPC + `PendingTaskCompletionBanner` | **Keep.** This is the human-approves-the-work path; the transition target changes from `review → done` to `review → approved` but the user-visible UX is unchanged. |
| `pendingCheckpointType = 'task_completion'` variant | **Keep.** Still used by `submit_for_approval`. |
| `pendingCompletionSubmittedByNodeId`, `pendingCompletionSubmittedAt`, `pendingCompletionReason` | **Keep.** |
| `space_task_report_results` table (migration 99) | **Keep.** Audit table; orphaned writers can be dropped in a later cleanup. |
| `PR_MERGE_BASH_SCRIPT` string body | **Move and keep.** Hoist to `packages/daemon/src/lib/space/tools/pr-merge-script.ts` as a reusable helper. The built-in Coding workflow's `postApproval.instructions` string can reference this path directly; user workflows can ignore it. |

### 4.3 Lost functionality & mitigations

*(Unchanged from the previous revision — removing the completion-action
pipeline has the same cost either way.)*

| Lost check | Provided by | Mitigation |
|-----------|-------------|------------|
| `verify-pr-merged` (QA-loop) | double-check that QA agent actually merged | No longer needed — post-approval reviewer session is the merger, not the QA agent. |
| `verify-review-posted` (Review-Only) | catches reviewer lying about posting review | Rely on the agent's contract; operator can inspect the PR. Optional follow-up: require a saved `reviewUrl` artifact before allowing `approve_task`. |
| `verify-tasks-created` (Plan-and-Decompose) | catches dispatcher lying about creating tasks | Same pattern — optional follow-up tool if the regression proves painful. |
| `'blocked'` status on post-hoc verification failure | escalated silently to a blocked task | Task Agent's `submit_for_approval` path produces the same end state via a different trigger. |
| `Awaiting Human Approval` banner (`PendingCompletionActionBanner`) | per-action modal UI | `request_human_input` → `TaskBlockedBanner` + plain conversation input now covers this. Operators answer the Task Agent's (or post-approval session's) question in free text. |

### 4.4 DB migration

New migration (number = next after current tip):

```sql
-- Stage 1 migration (adds 'approved' status + post_approval_session_id column).
-- Step 1: extend space_tasks.status CHECK constraint to include 'approved'.
-- SQLite requires table-rebuild pattern (see migration 99 for template).
-- New allowed values: open, in_progress, review, approved, done, blocked,
-- cancelled, archived.

-- Step 2: add post_approval_session_id TEXT NULL column.
-- Step 3: add post_approval_started_at INTEGER NULL column.
-- Step 4: add post_approval_blocked_reason TEXT NULL column.

-- Stage 5 migration (removes completion-action columns).
-- Step 5: rewrite any live tasks paused at 'completion_action'.
-- At Stage 5 time, Stages 3 + 4 will have rewritten runtime paths to never
-- produce this value. Defensively rewrite:
UPDATE space_tasks
SET pending_checkpoint_type = 'task_completion',
    pending_action_index = NULL
WHERE pending_checkpoint_type = 'completion_action';

-- Step 6: drop pending_action_index column.
-- Step 7: tighten CHECK constraint on pending_checkpoint_type:
--   from: CHECK (pending_checkpoint_type IN ('completion_action', 'gate', 'task_completion'))
--   to:   CHECK (pending_checkpoint_type IN ('gate', 'task_completion'))
-- Step 8: drop completion_actions_fired_at from space_workflow_runs.
-- Step 9: (optional) drop space_task_report_results if audit confirms no
-- writer remains. Defer to a later cleanup migration.
```

`completionAutonomyLevel` stays — no data migration needed for it.

### 4.5 Tests to delete / update

*(Updated from the previous revision to reflect the new test additions.)*

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
- Update (reflect new workflow prompts + `postApproval` entries):
  - Any test that asserts specific prompt text from the five built-in workflows.

### 4.6 New tests to add

Under `packages/daemon/tests/unit/5-space/`:

- `workflow/post-approval-validator.test.ts`
  - `targetAgent` = declared workflow agent → valid.
  - `targetAgent` = `task-agent` → valid.
  - `targetAgent` = unknown → invalid + error lists eligible targets.
  - Missing `postApproval` → valid (optional).
- `workflow/post-approval-template.test.ts`
  - Happy-path interpolation with all keys provided.
  - Missing key renders as `{{key}}` literal + warning.
  - Interpolation is a single pass (no recursive expansion).
  - Special characters in values are passed through unchanged (no HTML
    escaping, no shell escaping — the downstream agent handles that).
- `runtime/post-approval-routing.test.ts`
  - `approved` task with no `postApproval` → immediately transitions to
    `done` via `completePostApproval`.
  - `approved` task with workflow-agent target → Task Agent invokes
    `spawn_post_approval_session`; a session is created with the correct
    interpolated kickoff message.
  - `approved` task with `target_agent: task-agent` → no spawn; Task Agent
    executes instructions in its own session.
  - `post_approval_session_id` is persisted and observable via the
    repository.
  - `[TASK_APPROVED]` is emitted with the correct payload shape on both
    `approve_task` and `approvePendingCompletion` paths.
- `runtime/task-status-transitions.test.ts`
  - `in_progress → approved` via `approve_task`.
  - `review → approved` via `approvePendingCompletion`.
  - `approved → done` via `completePostApproval`.
  - `approved → blocked` disallowed in Stage 2 (deferred to §7).
- `agent/task-agent-post-approval-spawning.test.ts`
  - Given a mocked `spawn_post_approval_session` tool call, assert the
    resulting session receives the right system prompt, kickoff message,
    and tool surface.
- `workflows/end-node-handoff.test.ts`
  - For each of the 5 built-in workflows, snapshot-test the end-node's
    customPrompt to ensure the post-approval signalling instructions are
    present (and the old `gh pr merge` / completion-action references are
    absent).

E2E test additions (`packages/e2e/tests/features/`):

- `post-approval-merge-autonomy-high.e2e.ts` — Level 4 space, run the Coding
  workflow against a fake PR; assert the task reaches `approved`, the
  post-approval reviewer session spawns, merges, and the task reaches
  `done` without human interaction.
- `post-approval-merge-autonomy-low.e2e.ts` — Level 1 space, run the Coding
  workflow; assert the post-approval session pauses at
  `human_input_requested`; simulate the human approving via the
  conversation input; assert merge happens afterward.
- `post-approval-merge-human-rejects.e2e.ts` — Level 1 space, human rejects
  via `request_human_input`; assert PR is not merged, task reaches `done`,
  audit artifact records the rejection.
- `post-approval-no-route.e2e.ts` — Research workflow with no `postApproval`
  declared; assert task goes straight from `approved → done`.

These E2E tests need a mock `gh` CLI. Reuse existing E2E PR-fixture
infrastructure if present; otherwise add `tests/e2e/helpers/mock-gh.sh`
injected on the PATH.

---

## 5. Workflow definition changes — summary table

| Workflow | `completionActions` removed | `completionAutonomyLevel` | `postApproval` added | Prompt change |
|---------|-------|--------------------------|----------------------|---------------|
| CODING_WORKFLOW | `[MERGE_PR_COMPLETION_ACTION]` | keep at 3 | `{ targetAgent: 'reviewer', instructions: <merge template> }` | Reviewer step 5 — add `send_message(task-agent)` before `approve_task` |
| RESEARCH_WORKFLOW | `[MERGE_PR_COMPLETION_ACTION]` | keep at 2 | `{ targetAgent: 'reviewer', instructions: <merge template> }` | Review step 6 — add `send_message(task-agent)` before `approve_task` |
| FULLSTACK_QA_LOOP_WORKFLOW | `[VERIFY_PR_MERGED_COMPLETION_ACTION]` | **lower from 4 to 3** | `{ targetAgent: 'reviewer', instructions: <merge template> }` | QA steps 5–6 — remove `gh pr merge` + worktree sync; replace with `send_message(task-agent)` |
| REVIEW_ONLY_WORKFLOW | `[VERIFY_REVIEW_POSTED_COMPLETION_ACTION]` | keep at 2 | (none — no post-approval work) | Review step 6 — trim verification boilerplate |
| PLAN_AND_DECOMPOSE_WORKFLOW | `[PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION]` | keep at 3 | (none — no post-approval work) | Dispatcher — no change |

**Merge-template `instructions` string (shared across Coding, Research, QA):**

```
The task has been approved. Your job is to merge PR {{pr_url}}.

Space autonomy level: {{autonomy_level}} (threshold for auto-merge: 4).
Reviewer: {{reviewer_name}}.
Approval source: {{approval_source}}.

Steps:
1. Verify the PR is still open and passes CI:
     gh pr view {{pr_url}} --json state,mergeStateStatus,statusCheckRollup
   If state is MERGED, record an audit artifact and exit — the work is done.
2. If autonomy_level < 4:
     Call request_human_input with
       question: "Approve merging PR {{pr_url}}?"
       context: "Reviewer: {{reviewer_name}}. CI: <from step 1>."
     Wait for the response before proceeding.
3. Merge:
     gh pr merge {{pr_url}} --squash --delete-branch
   On a merge conflict, do NOT force — exit, call request_human_input with
   a clear summary of the conflict, and let the human resolve.
4. Sync your worktree with main/dev:
     git fetch origin && git checkout dev && git pull --ff-only
5. Save an audit artifact:
     save_artifact({ type: "result", append: true,
                     data: { merged_pr_url, mergedAt, approval: "auto"|"human" } })
6. Call approve_task() to signal post-approval complete.
```

The QA-workflow `completionAutonomyLevel` drop from 4 → 3 is a behavioural
intent change worth calling out in the PR description: today,
Coding-with-QA requires Level 4 to self-close because the QA agent is the
merger. After this change, the QA agent no longer merges, so Level 3 is the
natural threshold (aligned with Coding). Auto-merge remains a separate
autonomy dimension, now enforced by the template's conditional at the
post-approval session layer rather than at the `merge_pr` tool layer.

---

## 6. Migration & rollout

### 6.1 Breaking change assessment

- **Workflow schema (shared types):** removing `completionActions`,
  `CompletionAction`, `completionActionsFiredAt`, `pendingActionIndex`,
  `pendingCheckpointType: 'completion_action'` is a breaking change to
  `@neokai/shared`. NeoKai ships as a single repo; no external consumers.
  Adding `postApproval` is an additive, non-breaking change.
- **Task status `approved`:** additive; existing status values unchanged.
  No existing caller queries for `approved` tasks (it didn't exist). UI
  lists and filters need to be taught about it (Stage 1).
- **Built-in workflows (DB rows):** the `seedBuiltInWorkflows` seeder
  re-stamps template rows via `computeWorkflowHash`. Seeder must rebuild
  built-in rows in Stage 3 to pick up the new `postApproval` fields.
- **In-flight runs at migration time:** a daemon upgrade mid-run where the
  task is paused at `pendingCheckpointType='completion_action'`. Stage 5
  migration rewrites these to `task_completion` so the task surfaces in the
  submit-for-approval banner; the operator can click through.
- **User workflows that declare `completionActions`:** the workflow
  validator must learn to strip unknown fields with a warning so users
  don't hit a hard error on load. Emit a `workflow.migrated` notification
  in that case. (Same as the previous revision.)

### 6.2 Suggested PR breakdown (5 PRs)

- **PR 1** — **Task state `approved` + workflow schema.**
  Adds `TaskStatus='approved'`, `WorkflowDefinition.postApproval` type,
  validator, template interpolator, `post_approval_session_id` column +
  migration. No behaviour change (nothing reads `approved` in this PR).
  Unit-tested. ~600 LOC; self-contained.
- **PR 2** — **Task Agent post-approval routing.**
  Runtime emits `[TASK_APPROVED]`. Task Agent system prompt addition.
  New tools `spawn_post_approval_session` + `completePostApproval`. State
  transitions `in_progress/review → approved → done` plumbed through.
  Behind a feature flag (`NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING`).
  ~800 LOC; depends on PR 1.
- **PR 3** — **End-node handoff + built-in workflow `postApproval`
  entries.** Update all 5 built-in workflow prompts. Populate `postApproval`
  on Coding, Research, QA. Flip the feature flag. ~500 LOC; depends on PR 2.
- **PR 4** — **Delete completion-action runtime pipeline.** Remove
  `resolveCompletionWithActions`, `resumeCompletionActions`,
  `executeCompletionAction`, the RPC intercept, `approve_completion_action`
  MCP tool, `PendingCompletionActionBanner`. Task/run completion flows
  through the new `approved → done` path. ~1500 LOC net-negative. Depends
  on PR 3 being deployed long enough to confirm the new path works.
- **PR 5** — **Schema / shared-types / DB migration + docs.** Drop
  `pending_action_index`, `pending_checkpoint_type='completion_action'`,
  `completion_actions_fired_at`, `MERGE_PR_COMPLETION_ACTION` etc. Docs
  refresh, changelog entry. ~700 LOC. Depends on PR 4.

### 6.3 Test strategy summary

| Layer | Scope | Files |
|-------|-------|-------|
| Unit — daemon | Validator, template interpolator, routing, state transitions, spawning, end-node handoff, workflow snapshots | §4.6 list |
| Unit — shared | `TaskStatus` enum tests, workflow-autonomy helper simplification | `packages/shared/tests/workflow-autonomy.test.ts` (rewrite) |
| Integration — daemon online tests | Simulate full Coding/Research/QA runs with dev-proxy; assert `approved → done` works at each autonomy level | `packages/daemon/tests/online/space/` (new files) |
| E2E | End-to-end from UI input through post-approval session, with mock `gh` | §4.6 list |
| Manual | Spin up a dev space at each autonomy level 1–5; kick a Coding workflow against a real GitHub PR; observe behaviour | Pre-merge of PR 3 + 4 |

### 6.4 Observability / rollback

- Add structured daemon log entries:
  - `task-agent.post-approval.spawn: spaceId=... taskId=... targetAgent=... sessionId=... autonomyLevel=...`
  - `task-agent.post-approval.complete: spaceId=... taskId=... outcome=done|blocked reason=...`
  - `task.status-transition: taskId=... from=... to=... source=...`
- Feature flag (`NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING`) allows a quick
  disable. When disabled, tasks transition directly to `done` and no
  post-approval session spawns — identical to today's no-completion-actions
  behaviour for workflows without `postApproval`.
- PRs 4 and 5 are effectively one-way doors once merged. If a regression is
  found after they ship, the fix is forward-only.

---

## 7. Open questions / decisions for review

1. **Session kind for post-approval.** Options:
   - (A) Reuse the existing `space_task_agent` sub-session kind; add a field
     `isPostApproval: true` to distinguish from a regular node execution.
   - (B) Introduce a new `space_task_post_approval` sub-session kind with
     its own repository entries.
   - (C) Model post-approval as a new ad-hoc node grafted onto the run's
     node graph.
   **Recommendation:** **A** for Stage 2 — fewer moving parts, integrates
   with existing `[NODE_COMPLETE]` event plumbing. Revisit in Stage 5 if
   the flag becomes load-bearing for queries.

2. **Tool-allowlist scoping for post-approval sessions.**
   Can we narrow the tool surface (e.g. drop `curl`, drop file-write
   outside the worktree)? The target agent's default surface may be broader
   than the post-approval step needs.
   **Recommendation:** **No restriction in v1.** Keeping the surface
   identical to the node-session makes the template instructions
   transferable. Narrowing is a follow-up hardening pass if operators find
   a specific abuse pattern.

3. **Task stuck in `approved` with failed post-approval session — UX.**
   The `PendingPostApprovalBanner` surfaces a stuck task. What actions
   should it offer?
   - Retry (re-spawn same target agent with same instructions).
   - Mark done manually (record an audit artifact, advance to `done`).
   - View session transcript (routes to the session UI).
   - Escalate (convert to `blocked` with a reason).
   **Recommendation:** include all four in v1; escalation is the
   out-of-band option when retry doesn't work.

4. **Template interpolation: escape hatches.**
   Should `{{` be escapable? Should the grammar support literal `{{…}}`
   in output? Relevant when an `instructions` string wants to embed example
   template syntax for the LLM to learn from.
   **Recommendation:** no escaping in v1. If a template ever needs to
   output a literal `{{foo}}`, the author can use `{ {foo}}` as an escape
   hatch.

5. **Post-approval on multi-task missions.**
   Missions (workflow runs spanning several tasks) reach `done` when their
   last task reaches `done`. Does post-approval run per-task or once per
   mission? The current design is **per-task** (each task has its own
   `approved → done` with its own post-approval). A mission-level
   `postApproval` could be added later as a separate `MissionDefinition`
   field; not in scope here.

6. **Review-Only and Plan-and-Decompose verification regressions.**
   Do we accept losing the verify-review-posted / verify-tasks-created
   checks, or reintroduce them as optional post-approval templates (e.g.
   `targetAgent: 'task-agent'` + instructions "before closing, verify the
   reviewer posted an actual review")?
   **Recommendation:** accept the regression for Stage 4; revisit as a
   follow-up if operator feedback indicates the checks were load-bearing.

7. **Should `spawn_post_approval_session` be exposed to non-Task-Agent
   sessions?** No. Internal to the Task Agent MCP server.

---

## 8. Revision history

**2026-04-23 (this revision):** Approach changed from "narrow `merge_pr`
MCP tool on Task Agent" to "workflow-declared post-approval agent
routing", based on review feedback that the MCP-tool approach was too
rigid for real-world post-approval work. Key changes:

- §0, §1: rewritten around workflow schema `postApproval` field, new task
  status `approved`, agent-spawn routing model. §1.2 replaced ("Why a
  post-approval agent, not a dedicated MCP tool").
- §2.3: reframed `[TASK_APPROVED]` event as a routing signal (not a
  tool-call hint).
- §3.1: autonomy enforcement moves from handler-layer to template-layer +
  tool-layer.
- §5: workflows now declare `postApproval` instead of `completionActions`;
  added the shared merge-template `instructions` string.
- §6.2: five-PR breakdown reorganised around the new stages.
- §7: open questions rewritten for the new design.

Original revision (PR #1611) preserved in git history on branch
`space/task-agent-merge-pr-mcp-tool-handler-script-module-behind`.
Reusable carry-overs: `PR_MERGE_BASH_SCRIPT` hoist to
`pr-merge-script.ts`, end-node signalling via `send_message(task-agent,
data)`, unchanged sections §2 (signal protocol concepts), §4.1–4.3
(completion-action removal scope), §6.1 (breaking-change assessment).

---

## Appendix A — File path cheat sheet

Key files referenced in this plan, grouped by area:

**Task Agent wiring**
- `packages/daemon/src/lib/space/agents/task-agent.ts` — system prompt + session init (add §3.2 section)
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` — session lifecycle, sub-session events, post-approval spawn plumbing
- `packages/daemon/src/lib/space/tools/task-agent-tools.ts` — MCP server (add `spawn_post_approval_session`, `completePostApproval`)
- `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts` — Zod schemas for new tools

**Workflow schema**
- `packages/shared/src/types/space.ts` — add `PostApprovalRoute`, `WorkflowDefinition.postApproval`
- `packages/daemon/src/lib/space/workflows/post-approval-validator.ts` — NEW: `targetAgent` validator
- `packages/daemon/src/lib/space/workflows/post-approval-template.ts` — NEW: `instructions` interpolator
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` — populate `postApproval` on Coding, Research, QA

**Runtime completion-resolution (to delete / simplify)**
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` — replace `resolveCompletionWithActions` with `resolveTaskApproval`
- `packages/daemon/src/lib/space/runtime/completion-action-executors.ts` — full file
- `packages/daemon/src/lib/space/runtime/pending-action.ts` — full file
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` — `resumeCompletionActions`
- `packages/daemon/src/lib/space/runtime/post-approval-router.ts` — NEW: orchestrates target-agent spawn

**RPC layer**
- `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` — `spaceTask.update` intercept, `approvePendingCompletion` (new target = `approved`), `completePostApproval` (NEW RPC)

**Shared types**
- `packages/shared/src/types/space.ts` — `TaskStatus` (add `approved`), `CompletionAction` (remove), `SpaceTask`, `SpaceWorkflowRun`, `WorkflowDefinition`
- `packages/shared/src/space/workflow-autonomy.ts` — autonomy helpers

**Storage**
- `packages/daemon/src/storage/schema/migrations.ts` — add migrations (§4.4)
- `packages/daemon/src/storage/repositories/space-task-repository.ts` — `postApprovalSessionId`, `postApprovalStartedAt`, `postApprovalBlockedReason` columns
- `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` — drop `completionActionsFiredAt`

**Web UI**
- `packages/web/src/components/space/PendingCompletionActionBanner.tsx` — delete
- `packages/web/src/components/space/PendingPostApprovalBanner.tsx` — NEW: "post-approval in progress" / "post-approval failed" banner
- `packages/web/src/components/space/TaskStatusActions.tsx` — swap banners
- `packages/web/src/components/space/SpaceTaskPane.tsx` — remove `'completion_action'` routing
- `packages/web/src/lib/space-store.ts` — drop completion-action helpers; add `approved` status helpers

---

## Appendix B — Decision audit trail

| Decision | Options considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Post-approval executor: narrow MCP tool vs. workflow-declared target agent | (A) New `merge_pr` MCP tool on Task Agent; (B) Workflow declares `postApproval.targetAgent` + `instructions`, Task Agent spawns the target | **B** | Real-world post-approval (merge, deploy, publish) needs LLM-dynamic handling — CI waits, conflict resolution, retry logic. A narrow handler cannot do this. Agent-spawn model reuses workflow-agent session infrastructure for free. See §1.2 for full argument. |
| Eligible `targetAgent` values | (A) Any agent name; (B) Declared workflow agent + `task-agent`; (C) Declared workflow agent only | **B** | Constraining to agents the workflow already declared avoids ad-hoc config. `task-agent` as an explicit second option handles the "no workflow agent fits" escape hatch without needing new agent types. |
| Task lifecycle addition | (A) Reuse `review` → `done` with a post-approval sub-state; (B) Add new `approved` status; (C) Track post-approval progress on the workflow-run row, not the task | **B** | `approved` is semantically distinct from `review` (work is accepted, not pending) and from `done` (terminal). Making it a first-class status is simpler to reason about in UI and queries. See §1.3. |
| Template grammar | (A) Simple `{{var}}` substitute; (B) Full Handlebars; (C) JS expressions | **A** | Dumb substitute is sufficient because the LLM reading the prompt handles all the conditional logic. Handlebars + JS are overkill and create testing/security debt. |
| Merge executor: Task Agent LLM (direct) vs. Task Agent routes to reviewer | Original revision: Task Agent LLM calls `merge_pr` MCP tool directly. This revision: Task Agent routes to reviewer (workflow-declared agent). | **Route to reviewer** | Task Agent stays a pure orchestrator. The reviewer agent (or any target) already has the Bash/git/gh toolkit — reuse rather than duplicate. |
| Handoff signal: new gate vs. structured send_message | Unchanged from original revision. | **send_message(task-agent, data)** | Already idiomatic; gates don't fit the task-agent's implicit channels. |
| `completionAutonomyLevel`: keep, repurpose, or remove | Unchanged. | **Keep** | Independently controls `approve_task` vs `submit_for_approval` — a distinct "is the work any good" decision from post-approval. |
| Verification completion actions (verify-pr-merged, verify-review-posted, verify-tasks-created): keep, convert, delete | Unchanged. | **Delete** (accept regression) | Lost verifications are soft guardrails; audit artifacts + human review are the primary safety nets. |
| Feature-flag the new routing | (A) Ship enabled by default; (B) Behind flag during PR 2, flip in PR 3 | **B** | Allows the runtime code to exist and be tested without any workflow template depending on it. De-risks the staged rollout. |
| QA workflow `completionAutonomyLevel` | Keep 4 vs. drop to 3 | **Drop to 3** | QA no longer merges. Auto-merge autonomy is a separate dimension enforced via the post-approval session's own autonomy-aware template. |

---

*End of plan.*
