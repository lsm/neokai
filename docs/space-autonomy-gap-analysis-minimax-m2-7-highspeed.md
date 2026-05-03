# Space System Gap Analysis — MiniMax-M2-7-HighSpeed

> Generated: 2026-04-20
> Updated: 2026-05-03
> Branch: session/space-workflow-system-gap-analysis-aed6ade7

## System Overview

The space system has three orthogonal control layers:

| Layer | Purpose | Key Files |
|---|---|---|
| **Gates** (per-channel) | Field checks + scripts block message delivery until approved | `gate-evaluator.ts`, `channel-router.ts` |
| **Autonomy Level** (per-space, 1–5) | Controls whether end-node agents can self-close via `approve_task` | `workflow-autonomy.ts`, `space-runtime.ts` |
| **Task Status Machine** | `draft → open → in_progress → review → approved → done/blocked/cancelled/archived` | `space-task-manager.ts`, `space-runtime.ts` |

**Task status transitions** (`VALID_SPACE_TASK_TRANSITIONS`, `space-task-manager.ts:26-48`):
```
draft → open → in_progress → review → approved → done
                   ↓           ↓
                 blocked    cancelled
                   ↓           ↓
               archived    archived
blocked → open, in_progress, archived  (retry resets to open)
```

**Post-approval path**: After `approved`, `PostApprovalRouter` handles dispatch:
- No route → `approved → done` directly
- `targetAgent: 'task-agent'` → inject into Task Agent session
- Any other `targetAgent` → spawn fresh node-agent sub-session

**Note**: The old `completion-action-executors.ts` pipeline (script/instruction/mcp_call) was deleted. `PostApprovalRouter` is the sole post-approval mechanism.

---

## Autonomy Levels

| Level | Label | Behavior |
|---|---|---|
| 1 | Supervised | All actions need approval |
| 2 | Mostly supervised | Routine actions auto-approved |
| 3 | Balanced | Judgment calls need approval |
| 4 | Mostly autonomous | Only high-risk needs approval |
| 5 | Fully autonomous | All actions auto-approved |

**Key enforcement**: Gate *validation* always runs. Gate *approval* is autonomy-gated when `gate.requiredLevel` is set. `approve_task` is gated by `space.autonomyLevel >= workflow.completionAutonomyLevel`. `PostApprovalRouter` has **no autonomy check** — it routes deterministically.

---

## Key Files Reference

| Component | File |
|---|---|
| Space/Task/Workflow types | `packages/shared/src/types/space.ts` |
| Autonomy helpers | `packages/shared/src/space/workflow-autonomy.ts` |
| Built-in workflows | `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` |
| Post-approval router | `packages/daemon/src/lib/space/runtime/post-approval-router.ts` |
| Workflow executor | `packages/daemon/src/lib/space/runtime/workflow-executor.ts` |
| Channel router | `packages/daemon/src/lib/space/runtime/channel-router.ts` |
| Gate evaluator | `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` |
| Space runtime | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| Task agent tools | `packages/daemon/src/lib/space/tools/task-agent-tools.ts` |
| Task manager | `packages/daemon/src/lib/space/managers/space-task-manager.ts` |
| Space task handlers | `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` |
| Space task message handlers | `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts` |
| Workflow run handlers | `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` |
| Room task handlers (ref) | `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` |
| TaskBlockedBanner | `packages/web/src/components/space/TaskBlockedBanner.tsx` |
| PendingGateBanner | `packages/web/src/components/space/PendingGateBanner.tsx` |
| PendingTaskCompletionBanner | `packages/web/src/components/space/PendingTaskCompletionBanner.tsx` |
| PendingPostApprovalBanner | `packages/web/src/components/space/PendingPostApprovalBanner.tsx` |
| VisualWorkflowEditor | `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` |
| Prior gap doc | `docs/space-autonomy-hitl-gaps-claude-opus-4-6.md` |

---

## Gaps

### Gap 1 — `dispatchPostApproval` Silently Fails Without Setting Error State **[HIGH]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:455-590`

**What actually happens**: When `dispatchPostApproval` encounters a failure (router not wired, task not found, or `route()` returns `mode: 'skipped'`), it returns `{ mode: 'skipped', reason }` and the task **stays in whatever status it was** — silently, with no error indicator:

```typescript
// space-runtime.ts:460-471
const router = this.getPostApprovalRouter();
if (!router) {
    const reason = `PostApprovalRouter not wired yet...`;
    log.warn(`dispatchPostApproval: ${reason}`);
    return { mode: 'skipped', reason };  // task stays in 'approved'
}
const current = this.config.taskRepo.getTask(taskId);
if (!current) {
    const reason = `task ${taskId} not found`;
    log.warn(`dispatchPostApproval: ${reason}`);
    return { mode: 'skipped', reason };  // task stays in whatever status
}
```

When `router.route()` returns `mode: 'skipped'`, same issue — task is in `approved` with no indication anything went wrong.

**What should happen**: On failure, transition task to `blocked` with `blockReason: 'execution_failed'` (or new `post_approval_failed`) so `PendingPostApprovalBanner` renders and the operator is notified.

**Break scenario**:
```
1. Post-approval tries to spawn a node-agent sub-session
2. Target agent name doesn't resolve (template not stamped properly)
3. Router returns { mode: 'skipped', reason }
4. Task stays in 'approved' with all null post-approval fields
5. Operator sees no banner — assumes task completed
6. Task is dead in the water
```

---

### Gap 2 — `postApprovalBlockedReason` Never Set to Non-Null Error Value **[HIGH]**

**File**: `packages/daemon/src/lib/space/runtime/post-approval-router.ts:289-410`

**What actually happens**: The router only ever sets `postApprovalBlockedReason` to `null`:

```typescript
// Line 294 — no-route branch
postApprovalBlockedReason: null

// Line 398 — spawn branch
postApprovalBlockedReason: null
```

There is **zero code path** in the router that sets it to a descriptive error string.

`PendingPostApprovalBanner` renders only when `!!postApprovalBlockedReason` (`PendingPostApprovalBanner.tsx:86-87`). Since it can never be non-null, **the banner never renders**.

**What should happen**: When the router cannot complete (skipped, spawn failure, exception), it should set `postApprovalBlockedReason` to a descriptive error so the banner appears and the operator can take action.

**Break scenario**:
```
1. Post-approval spawn throws an exception (OOM, bad agent config)
2. Exception is caught somewhere but postApprovalBlockedReason is never set
3. Task is in 'approved' with all null post-approval fields
4. PendingPostApprovalBanner never shows (condition is always false)
5. Task silently dead
```

Gap 1 and Gap 2 compound each other.

---

### Gap 3 — `retryTask` Is Internal-Only, Not RPC-Exposed **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/managers/space-task-manager.ts:480-505`

**What actually happens**: `SpaceTaskManager.retryTask()` exists as a daemon-internal method with explicit documentation:

> "This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers)."

No `spaceTask.retry` or `spaceWorkflowRun.retryTask` RPC exists anywhere in `space-task-handlers.ts`.

**Additionally**: `TaskBlockedBanner` has a "Resume" button that calls `onStatusTransition?.('in_progress')` — but `blocked → in_progress` is a valid transition that does **not** reset gate state or node executions. The task resumes but immediately re-blocks on the same gate.

**What should happen**: Either expose `retryTask` as an RPC, or have the "Resume" button call a proper retry handler that resets blocked executions and gate state.

**Break scenario**:
```
1. Task blocked on gate_rejected after human rejects a plan approval
2. Operator clicks "Resume" in TaskBlockedBanner
3. Task transitions to in_progress
4. Agent tries to re-enter the rejected gate channel
5. Gate blocks again immediately
6. Task re-blocked, operator confused
```

---

### Gap 4 — No Review Status Timeout **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts` (absent)

**What actually happens**: The tick loop has timeout detection for `in_progress` node executions (lines checking `execution.status === 'in_progress'` and comparing against `taskTimeoutMs`), but **no timeout mechanism for tasks in `review` status**. A task submitted for human review sits indefinitely.

**What should happen**: Tasks in `review` should have a configurable timeout (per autonomy level or space config). After timeout: auto-reject and return to `in_progress`, or escalate to `blocked`.

**Break scenario**:
```
1. Operator submits a task for review and closes laptop
2. Task sits in review indefinitely
3. No notification, no auto-reject, no escalation
4. Workflow deadlocked
```

---

### Gap 5 — Crash Retry Is Flat, Not Autonomy-Aware **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:1961`

**What actually happens**: `MAX_TASK_AGENT_CRASH_RETRIES` is a flat constant. The crash retry logic uses the same limit unconditionally regardless of `autonomyLevel`:

```typescript
// space-runtime.ts:1961
const exhausted = crashCount > MAX_TASK_AGENT_CRASH_RETRIES;
```

**What should happen**: Level 5 (fully autonomous) should retry indefinitely with backoff. Level 1-2 should escalate to human quickly. Retry policy should be autonomy-differentiated.

**Break scenario**:
```
1. Level 1 (supervised) space, agent crashes twice due to transient infra issue
2. Same retry behavior as level 5 — exhausts retries before human notification
3. Unnecessary delay for a space where human should be notified immediately
```

---

### Gap 6 — `TaskBlockedBanner` Uses Ambiguous Heuristic for `blockingGateId` **[MEDIUM]**

**File**: `packages/web/src/components/space/TaskBlockedBanner.tsx:71-100`

**What actually happens**: For `gate_rejected` tasks, the banner fetches all gate data and picks the **first** rejected/waiting gate:

```typescript
// TaskBlockedBanner.tsx:80-88
// Note: in multi-gate workflows this may not be the gate that actually
// blocked the task. A future improvement would store `blockingGateId` on
// SpaceTask to remove ambiguity.
const rejected = records.find(
    (r) => r.data?.approved === false || r.data?.waiting === true
);
```

**What should happen**: `blockReason: 'gate_rejected'` should be accompanied by `blockingGateId` on the task record so the banner unambiguously identifies the blocking gate.

**Break scenario**:
```
1. Plan & Decompose workflow: plan-pr-gate rejected AND plan-approval-gate pending
2. plan-pr-gate is first in the list
3. Banner shows plan-pr-gate "Review & Approve"
4. Human approves plan-pr-gate
5. Task still blocked on plan-approval-gate
6. Human confused about why task is still blocked
```

---

### Gap 7 — `sendHumanMessage` Not in `space-task-handlers.ts` (Wrong File) **[LOW]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` (missing), `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts:358` (actual location)

**What actually happens**: `space-task-handlers.ts` registers only: `spaceTask.create`, `.list`, `.get`, `.update`, `.submitForReview`, `.approvePendingCompletion`, `.publish`, `.recoverWorkflow`. There is no `spaceTask.sendHumanMessage`.

The Space task message handler at `space-task-message-handlers.ts:358` handles `space.task.sendMessage` — but this is not the same as Room's `task.sendHumanMessage` which auto-reactivates tasks and injects messages into agent sessions.

**What should happen**: Document the correct handler location, or add auto-reactivation semantics to `space.task.sendMessage` to match Room's behavior.

---

### Gap 8 — `approvePendingCompletion` Error Message Conflates Concepts **[LOW]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:425-430`

**What actually happens**: The handler throws this if `pendingCheckpointType !== 'task_completion'`:

```
"Task X is not awaiting submit_for_approval review (pendingCheckpointType=null)"
```

This conflates `review` status (human-facing state) with `pendingCheckpointType === 'task_completion'` (technical checkpoint). A task can be in `review` via a different path (e.g., gate review) but the error message implies it isn't.

**What should happen**: Error message should distinguish "not in review status" from "in review but not via submit_for_approval".

---

### Gap 9 — `request_human_input` Unblock Path Unverified **[UNCLEAR]**

**File**: `packages/daemon/src/lib/space/tools/task-agent-tools.ts:897-939`

**Status**: The comment at line 889 says human responses go via `space.task.sendMessage`. The actual handler at `space-task-message-handlers.ts:358` handles `space.task.sendMessage`. Whether this handler auto-reactivates a `blocked[human_input_requested]` task back to `in_progress` and delivers the message to the agent session was **not verified** in this analysis pass. Further investigation needed.

The `TaskBlockedBanner` renders a "reply via composer" hint for `human_input_requested` but the actual unblock flow has not been confirmed to work.

---

## Summary Table

| Gap | Severity | Category | File | Status |
|---|---|---|---|---|
| 1. `dispatchPostApproval` silently fails, no `blockReason` | **High** | Post-approval | `space-runtime.ts:455-590` | Open |
| 2. `postApprovalBlockedReason` never set to non-null | **High** | Post-approval | `post-approval-router.ts:289-410` | Open |
| 3. `retryTask` internal-only; Resume button doesn't reset gate state | **Medium** | Lifecycle | `space-task-manager.ts:480`, `TaskBlockedBanner.tsx` | Open |
| 4. No review status timeout | **Medium** | Operations | `space-runtime.ts` (absent) | Open |
| 5. Crash retry flat, not autonomy-aware | **Medium** | Retry | `space-runtime.ts:1961` | Open |
| 6. `TaskBlockedBanner` ambiguous `blockingGateId` heuristic | **Medium** | UX | `TaskBlockedBanner.tsx:71-100` | Open |
| 7. `sendHumanMessage` in wrong file / unclear | Low | HITL | `space-task-handlers.ts` (missing) | Open |
| 8. `approvePendingCompletion` error message conflates concepts | Low | UX | `space-task-handlers.ts:425-430` | Open |
| 9. `request_human_input` unblock path unverified | Unclear | HITL | `task-agent-tools.ts:897-939` | Needs verification |

**Total: 9 gap items** (fewer than prior analysis because some prior items were confirmed not to be gaps, or were the same underlying issue)

---

## Previously Tracked Gaps — Updated Status

| Gap | Status This Pass |
|---|---|
| #3 Audit trail | Partially addressed — gate approval stamps `approvalSource`, `approvalReason`, `approvedAt`. Post-approval approval still has no structured comment (Gap 1/2 compound). |
| #6 Tiered retry | Open — confirmed flat `MAX_TASK_AGENT_CRASH_RETRIES` at `space-runtime.ts:1961` |
| #9 Review SLA | Open — confirmed no timeout for `review` status |
| #10 Conditional branching | Open — workflow topologies are static |
| #16 Multi-gate ambiguity | Open — confirmed ambiguous heuristic in `TaskBlockedBanner.tsx:80-88` |
| #17 Consecutive failure escalation | Partially addressed — `attemptBlockedRunRecovery` (tier 1: reset executions; tier 2: escalate to Space Agent) exists, but counters still in-memory only |
| #18 Task retry RPC | Open — `retryTask` exists internally but not RPC-exposed; "Resume" button doesn't reset gate state |
