# Space System Gap Analysis — MiniMax-M2-7-HighSpeed

> Generated: 2026-04-20
> Branch: session/space-workflow-system-gap-analysis-aed6ade7

## System Overview

The space system has three orthogonal control layers:

| Layer | Purpose | Key Files |
|---|---|---|
| **Gates** (per-channel) | Field checks + scripts block message delivery until approved | `gate-evaluator.ts`, `channel-router.ts` |
| **Autonomy Level** (per-space, 1–5) | Controls whether completion actions auto-execute or pause for human | `workflow-autonomy.ts`, `space-runtime.ts` |
| **Task Status Machine** | `open → in_progress → review → done/blocked/cancelled/archived` | `space-task-manager.ts`, `space-runtime.ts` |

```
┌──────────────────────────────────────────────────────────────┐
│                          SPACE                                │
│  SpaceWorkflow (nodes, channels, gates, completionActions)     │
│       │              │              │                         │
│  GateEvaluator  WorkflowExecutor  TaskAgentManager            │
│       │                                                    │
│  SPACE RUNTIME (tick loop)                                  │
│    resolveCompletionWithActions → executeCompletionAction     │
│      ├── script (bash, 2min timeout)                        │
│      ├── instruction (ephemeral agent + report_verification)│
│      └── mcp_call (MCP tool + optional assert)              │
└──────────────────────────────────────────────────────────────┘

UI Banners (SpaceTaskPane):
  PendingGateBanner         → workflow-level gates
  PendingCompletionActionBanner → node completion actions
  PendingTaskCompletionBanner   → submit_for_approval
  TaskBlockedBanner            → blocked status
```

---

## Autonomy Levels

| Level | Label | Behavior |
|---|---|---|
| 1 | Supervised | All actions need approval |
| 2 | Mostly supervised | Routine actions auto-approved |
| 3 | Balanced | Judgment calls need approval |
| 4 | Mostly autonomous | Only high-risk needs approval |
| 5 | Fully autonomous | All actions auto-approved |

**Key invariant**: Gate *validation* (script + field checks) always runs regardless of autonomy level. Only *approval* is autonomy-gated.

---

## Previously Tracked Gaps (from `docs/space-autonomy-hitl-gaps-claude-opus-4-6.md`)

The gap doc at `docs/space-autonomy-hitl-gaps-claude-opus-4-6.md` tracks 19 gaps, 9 of which are closed. The remaining open items are briefly noted here with new findings.

### Gap #3 — Audit Trail
**Status**: Partially implemented. Gate approval/rejection stamps `approvalSource`, `approvalReason`, `approvedAt`. But completion action *approval* does not record a comment/reason — only rejection does. See **Gap D** below.

### Gap #6 — Tiered Retry by Autonomy
**Status**: Not implemented. `MAX_TASK_AGENT_CRASH_RETRIES = 2` applies uniformly at all autonomy levels. Level 5 (fully autonomous) still gets only 2 retries before blocking, with no backoff or indefinite retry option.

### Gap #9 — Human Review SLA/Timeout
**Status**: Not implemented. Tasks can sit in `review` indefinitely. No configurable SLA, no auto-escalation, no auto-approve after timeout.

### Gap #10 — Conditional Branching by Autonomy Level
**Status**: Not implemented. Workflow topologies are static. No `IF autonomy >= 4 THEN skip-review-node` semantics. Low-autonomy users cannot get a simplified flow for a complex template.

### Gap #16 — Multi-Gate `blockingGateId`
**Status**: Not implemented. When a task is blocked with `gate_rejected`, `blockReason` is set but `blockingGateId` is not. `TaskBlockedBanner` uses a heuristic to find the blocking gate which can be wrong. See `TaskBlockedBanner.tsx:111` TODO.

### Gap #17 — Consecutive Failure Escalation
**Status**: Not implemented. `taskCrashCounts` and `blockedRetryCounts` are tracked per-execution but not persisted across daemon restarts, not accumulated across runs of the same workflow, and no auto-escalation threshold exists per space.

### Gap #18 — Task Retry RPC
**Status**: Not implemented. No RPC to retry a blocked Space task. The only options are cancel+new-run (loses all state) or archive. `resumeCompletionActions` only handles `pendingCheckpointType === 'completion_action'` resumes, not blocked node retries.

---

## New Gaps Found in Code

### Gap A — `human_input_requested` Has No Unblock Path **[CRITICAL]**

**Files**: `packages/daemon/src/lib/space/tools/task-agent-tools.ts:587-628`, `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`

**Problem**: When a Task Agent calls `request_human_input({ question, questionContext })`:
1. Task transitions to `blocked` with `blockReason: 'human_input_requested'`
2. `TaskBlockedBanner` shows "reply via composer" hint
3. **There is no RPC endpoint** that receives the human's answer, transitions the task back to `in_progress`, and delivers the answer to the agent session

The agent is told to "wait — do not call any other tools until the human responds" but has no mechanism to receive the response. The Room system has `task.sendHumanMessage` (task-handlers.ts:967) that handles `needs_attention → review → in_progress` reactivation — no equivalent exists for Space tasks.

**Scenario that breaks**:
```
Level 3 space, Coding workflow
→ Agent calls request_human_input("Refactor auth module or write tests first?")
→ Task becomes blocked, human sees it in Attention tab
→ Human has NO WAY to answer and unblock
→ Work stalls indefinitely
```

**Contrast with Room**: Room `task.sendHumanMessage` exists at task-handlers.ts:1030 and handles reactivation. Space has no equivalent.

---

### Gap B — No Task Retry RPC for Space Tasks **[HIGH]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` (missing), `packages/daemon/src/lib/space/runtime/space-runtime.ts` (no `retryTask`)

**Problem**: When a Space task is blocked (any reason), humans can only:
- `archive` it (terminal, loses all progress)
- `cancel` it (terminal, loses progress)
- Start a **new** workflow run from scratch (creates new `SpaceWorkflowRun`, discards all `node_execution` state, gate data, `send_message` history)

There is no `spaceTask.retry` RPC that resets blocked node executions to `pending` and resumes the existing workflow run.

**Scenario that breaks**:
```
Fullstack QA Loop workflow (6+ cycles)
→ Blocked at QA node after 4 cycles due to transient CI failure
→ Human must cancel and restart from scratch
→ All previous review/QA cycles are lost
```

---

### Gap C — Completion Action Failure Doesn't Set `blockReason` **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:1944-1948`

**Problem**: When a completion action script or MCP call fails:
```typescript
return { status: 'blocked' as const, result: result.reason ?? `Completion action "${action.name}" failed` };
// blockReason is NOT set — defaults to null
```

`setTaskStatus` is called with only `status` and `result` — no `blockReason`. This means:
- A task blocked because `merge_pr` script failed → `blockReason: null`
- A task blocked because an agent crashed → `blockReason: 'agent_crashed'`

The Attention tab cannot distinguish completion action failures from agent crashes. Should be `blockReason: 'execution_failed'`.

---

### Gap D — Completion Action Approval Has No Comment Field **[MEDIUM]**

**File**: `packages/web/src/components/space/PendingCompletionActionBanner.tsx:81-94`

**Problem**: The Approve button calls `spaceStore.updateTask(task.id, { status: 'done' })` with **no comment/reason field**. Only the Reject path (lines 97-121) records an optional `approvalReason`. The `resumeCompletionActions` handler at `space-runtime.ts:936` accepts `options.approvalReason` but the banner never passes it.

**Scenario**:
```
Human approves a "verify-pr-merged" action
→ No record of WHY human approved
→ Audit trail only captures rejections, not approvals
→ Reversionary analysis impossible
```

Gap #3 (Audit Trail) was partially implemented for gate approval/rejection, but not for completion action approval.

---

### Gap E — No `spaceTask.sendHumanMessage` Equivalent **[CRITICAL]**

**File**: `packages/daemon/src/lib/rpc-handlers/task-handlers.ts:967` (Room only), `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` (missing)

**Problem**: Room has `task.sendHumanMessage` which:
1. Validates target task is not `archived`
2. Auto-reactivates `needs_attention`/`completed`/`cancelled` tasks
3. Injects the message into the agent session via `reviveTaskForMessage`

Space has no equivalent. The SpaceComposer exists (for Space Chat) but has no integration with blocked task sessions. Even if a human somehow knew what to type, there is no RPC endpoint to deliver it to an agent waiting in a Space task session.

---

### Gap F — No Autonomy-Differentiated Retry Policy **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:1405-1451`, `packages/daemon/src/lib/job-queue-constants.ts`

**Problem**: Retry behavior for agent crashes is identical regardless of autonomy level:
```typescript
if (crashCount <= MAX_TASK_AGENT_CRASH_RETRIES) {
    // reset to pending — same for all levels
} else {
    // blocked with agent_crashed — same for all levels
}
```

Level 1 (supervised) and Level 5 (fully autonomous) both get exactly `MAX_TASK_AGENT_CRASH_RETRIES = 2` retries. At Level 5, the expectation is the agent handles failures autonomously — it should retry indefinitely with backoff, not give up after 2 attempts.

---

### Gap G — No Review SLA / Timeout / Auto-Escalation **[LOW]**

**File**: No implementation found

**Problem**: Tasks can sit in `review` status indefinitely. No configurable SLA, no auto-escalation, no auto-approve after timeout.

**Scenario**:
```
Human approves a completion action at level 2
→ Action script fails (CI still red)
→ Task goes to blocked
→ Human fixes CI and wants to retry
→ Task is blocked with no timeout to auto-escalate
→ Human must manually notice and retry
```

---

### Gap H — Static Workflow Topology (No Conditional Branching by Autonomy) **[HIGH]**

**File**: `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`, `packages/daemon/src/lib/space/runtime/workflow-executor.ts`

**Problem**: Built-in workflow topologies are fixed. For example, `FULLSTACK_QA_LOOP_WORKFLOW`:
```
Coding → Review → QA → [merge done]
Review ↔ Coding (feedback cycle, maxCycles: 6)
QA ↔ Coding (feedback cycle, maxCycles: 6)
```

Cannot express:
- "If autonomy >= 4, skip to merge node"
- "If supervised, route to human-review node instead of QA"
- "If semi-autonomous, use simplified merge path"

Low-autonomy users who create a Fullstack QA Loop space cannot get a simplified flow.

---

### Gap I — Multi-Gate `blockingGateId` Still Missing **[LOW]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:421-554` (`approveGate` handler), `packages/daemon/src/lib/space/runtime/space-runtime.ts` (no `blockingGateId` on task)

**Problem**: When a task is blocked with `gate_rejected`, the runtime sets `blockReason: 'gate_rejected'` but does NOT record **which gate** caused it. `TaskBlockedBanner` uses a heuristic (first rejected/waiting gate from `listGateData()`) which is incorrect for multi-gate workflows.

**Scenario**:
```
Plan & Decompose workflow has TWO gates: plan-pr-gate AND plan-approval-gate
→ Human rejects plan-approval-gate
→ Task is blocked with gate_rejected but no blockingGateId
→ Human navigates to task, banner shows WRONG gate's details
```

---

### Gap J — No Consecutive Failure Escalation Across Runs **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts` (no cross-run tracking), `packages/daemon/src/lib/job-queue-constants.ts`

**Problem**: `taskCrashCounts` and `blockedRetryCounts` are tracked per-execution but:
- Not persisted across daemon restarts
- Not accumulated across multiple runs of the same workflow
- No configurable threshold per space

**Scenario**:
```
Space's coding workflow keeps failing at Review node (OOM on large diffs)
→ Each run gets 2 crash retries, then blocks
→ Human must manually notice pattern across runs
→ No auto-escalation after N consecutive failures
```

---

## Summary Table

| Gap | Severity | Category | Status |
|---|---|---|---|
| A — `human_input_requested` no unblock path | **Critical** | HITL | Open |
| B — No task retry RPC | **High** | Lifecycle | Open |
| C — Completion action failure no `blockReason` | Medium | Error handling | Open |
| D — Completion action approval no comment field | Medium | Audit trail | Open |
| E — No `spaceTask.sendHumanMessage` | **Critical** | HITL | Open |
| F — No autonomy-differentiated retry | Medium | Retry policy | Open |
| G — No review SLA/timeout | Low | Operations | Open |
| H — Static workflow topology | **High** | Autonomy | Open |
| I — Multi-gate `blockingGateId` missing | Low | UX | Open |
| J — No consecutive failure escalation | Medium | Operations | Open |
| #6 — Tiered retry by autonomy | Medium | Retry policy | Open |
| #9 — Human review SLA/timeout | Low | Operations | Open |
| #10 — Conditional branching by autonomy | **High** | Autonomy | Open |
| #16 — Multi-gate ambiguity | Low | UX | Open |
| #17 — Consecutive failure escalation | Medium | Operations | Open |
| #18 — Task retry RPC | **High** | Lifecycle | Open |
| #3 — Audit trail (completion action approval) | Medium | Audit trail | Partial |

---

## Previously Tracked Gap Doc Reference

`docs/space-autonomy-hitl-gaps-claude-opus-4-6.md` tracks 19 gaps total, 9 closed. This analysis covers the 10 open gaps plus 10 new gaps found in implementation, for a total of **20 open gaps** across HITL, autonomy, retry, audit, and operations categories.
