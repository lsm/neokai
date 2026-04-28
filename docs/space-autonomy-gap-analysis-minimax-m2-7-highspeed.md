# Space System Gap Analysis — MiniMax-M2-7-HighSpeed

> Generated: 2026-04-20
> Updated: 2026-04-27
> Branch: session/space-workflow-system-gap-analysis-aed6ade7

## System Overview (Updated)

The space system has three orthogonal control layers:

| Layer | Purpose | Key Files |
|---|---|---|
| **Gates** (per-channel) | Field checks + scripts block message delivery until approved | `gate-evaluator.ts`, `channel-router.ts` |
| **Autonomy Level** (per-space, 1–5) | Controls post-approval routing and whether end-node agents can self-close | `workflow-autonomy.ts`, `space-runtime.ts` |
| **Task Status Machine** | `open → in_progress → review → approved → done/blocked/cancelled/archived` | `space-task-manager.ts`, `space-runtime.ts` |

**Architectural note (April 2026)**: The `completion-action-executors.ts` pipeline (script/instruction/mcp_call) was **deleted**. The sole post-approval path is now `PostApprovalRouter` (`packages/daemon/src/lib/space/runtime/post-approval-router.ts`), introduced in PR #4/5 of the autonomy refactor.

```
┌──────────────────────────────────────────────────────────────┐
│                          SPACE                                │
│  SpaceWorkflow (nodes, channels, gates, postApproval route)  │
│       │              │              │                         │
│  GateEvaluator  WorkflowExecutor  TaskAgentManager            │
│       │                                                    │
│  SPACE RUNTIME (tick loop)                                  │
│    dispatchPostApproval → PostApprovalRouter                 │
│      ├── no route → approved → done (direct)                │
│      ├── targetAgent: 'task-agent' → inject into session    │
│      └── targetAgent: other → spawn sub-session             │
└──────────────────────────────────────────────────────────────┘

UI Banners (SpaceTaskPane):
  PendingGateBanner         → workflow-level gates (waiting_human)
  PendingTaskCompletionBanner → submit_for_approval agent calls
  PendingPostApprovalBanner  → approved + postApproval blocked
  TaskBlockedBanner          → blocked status (any reason)
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

**Autonomy enforcement points**:
- `gate.requiredLevel` — if `spaceLevel >= requiredLevel`, gate auto-approved after validation
- `workflow.completionAutonomyLevel` — if `spaceLevel >= completionAutonomyLevel`, end-node agents can use `approve_task`; otherwise only `submit_for_approval`
- `PostApprovalRouter` — no autonomy check; always routes deterministically

---

## Task Status Lifecycle

```
open → in_progress → review → approved → done
                 ↘         ↗ ↘
                  blocked  cancelled archived
```

**Block reasons** (`SpaceBlockReason`): `agent_crashed`, `workflow_invalid`, `execution_failed`, `human_input_requested`, `gate_rejected`, `dependency_failed`

---

## Previously Tracked Gaps (from `docs/space-autonomy-hitl-gaps-claude-opus-4-6.md`)

The prior gap doc tracks 19 gaps, 9 closed. Open items updated below with new findings.

### Gap #3 — Audit Trail
**Status**: Partially implemented. Gate approval/rejection stamps `approvalSource`, `approvalReason`, `approvedAt`. But post-approval routing (the new architecture) leaves no structured audit entry for *why* a human approved.

### Gap #6 — Tiered Retry by Autonomy
**Status**: Not implemented. `MAX_TASK_AGENT_CRASH_RETRIES = 2` applies uniformly at all autonomy levels. Level 5 (fully autonomous) still gets only 2 retries before blocking, with no backoff or indefinite retry option.

### Gap #9 — Human Review SLA/Timeout
**Status**: Not implemented. Tasks in `review` status have no timeout. Timeout detection at `space-runtime.ts:1530-1535` only checks `in_progress` tasks.

### Gap #10 — Conditional Branching by Autonomy Level
**Status**: Not implemented. Workflow topologies are static. `completionAutonomyLevel` only controls auto-close, not conditional branching.

### Gap #16 — Multi-Gate `blockingGateId`
**Status**: Not implemented. `space-workflow-run-handlers.ts:525-529` sets `blockReason: 'gate_rejected'` but does not pass `blockingGateId`. `TaskBlockedBanner` uses a heuristic (first rejected/waiting gate) which is wrong for multi-gate workflows.

### Gap #17 — Consecutive Failure Escalation
**Status**: Not implemented. `taskCrashCounts` and `blockedRetryCounts` are in-memory only (`space-runtime.ts:253-265`), not persisted across daemon restarts, not accumulated across runs.

### Gap #18 — Task Retry RPC
**Status**: Partially addressed — `SpaceTaskManager.retryTask()` exists as a daemon-internal method at `space-task-manager.ts:452` but is **not exposed via any RPC**. Humans still cannot retry a blocked task without cancel+new-run.

---

## New Gaps Found in Code

### Gap 1 — `request_human_input` Has No Unblock Path **[CRITICAL]**

**File**: `packages/daemon/src/lib/space/tools/task-agent-tools.ts:893-935`

The `request_human_input` tool transitions the task to `blocked` with `blockReason: 'human_input_requested`:

```typescript
// task-agent-tools.ts:915-918
await taskManager.setTaskStatus(taskId, 'blocked', {
  result: questionContext ? `${question}\n\nContext: ${questionContext}` : question,
  blockReason: 'human_input_requested',
});
```

The comment at line 889 says:
> "When the human responds (via space.task.sendMessage), the message is injected into this Task Agent session"

But **`space.task.sendMessage` does not exist**. The `TaskBlockedBanner` shows "reply via composer" hint but there is no RPC endpoint to deliver the response, transition the task back to `in_progress`, and inject the message into the agent session.

**Break scenario**:
```
1. Task Agent calls request_human_input("Refactor auth module or write tests first?")
2. Task transitions to blocked[human_input_requested]
3. TaskBlockedBanner shows "reply via composer" hint
4. Human types a response — NO RPC exists to deliver it
5. Agent waits forever. Work stalls indefinitely.
```

**Contrast with Room**: Room `task.sendHumanMessage` at `task-handlers.ts:967` handles `needs_attention → review → in_progress` reactivation with message injection. Space has no equivalent.

---

### Gap 2 — No `spaceTask.sendHumanMessage` RPC **[CRITICAL]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` (missing), `packages/daemon/src/lib/rpc-handlers/task-handlers.ts:967` (Room)

Room's `task.sendHumanMessage`:
1. Validates task is not `archived`
2. Auto-reactivates `needs_attention`/`completed`/`cancelled` tasks via `reviveTaskForMessage`
3. Prepends review reminder when task was in `review`
4. Injects the message into the agent session

Space has no equivalent. The SpaceComposer exists (for Space Chat) but has no integration with blocked task sessions. Gap 1 and Gap 2 are the same underlying issue.

---

### Gap 3 — `retryTask` Is Internal-Only, Not RPC-Exposed **[HIGH]**

**File**: `packages/daemon/src/lib/space/managers/space-task-manager.ts:452-477`

`SpaceTaskManager.retryTask()` exists as a daemon-internal method with a comment explicitly stating:

> "This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers)."

Not exposed via any `spaceTask.retry` handler in `space-task-handlers.ts`.

**Break scenario**:
```
1. Fullstack QA Loop workflow blocked at QA node after 4 cycles due to transient CI failure
2. Human wants to retry without losing prior review cycles
3. Only options: cancel+new-run (loses ALL state), or archive (terminal)
4. No spaceTask.retry equivalent exists
```

---

### Gap 4 — Post-Approval Human Decision Has No Structured Audit Comment **[MEDIUM]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts:322-406` (`approvePendingCompletion`)

`spaceTask.approvePendingCompletion` stamps `approvalReason` but only on rejection. Approvals (the `approved: true` path) do not record a structured comment explaining *why* the human approved.

```typescript
// space-task-handlers.ts:376-378
await spaceRuntimeService.dispatchPostApproval(params.spaceId, params.taskId, 'human', {
  approvalReason: params.reason ?? null,  // only passed for reject path
});
```

**Break scenario**:
```
1. Human approves a merge_pr post-approval action
2. PR turns out to have issues
3. Audit trail has only "approvedAt: timestamp" — no reason
4. Cannot reconstruct why the approval was granted
```

---

### Gap 5 — No Autonomy-Differentiated Retry Policy **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:1602-1630`, `packages/daemon/src/lib/space/runtime/constants.ts`

Crash retry logic is identical regardless of autonomy level:

```typescript
// space-runtime.ts:1602-1603
if (crashCount <= MAX_TASK_AGENT_CRASH_RETRIES) {
  // reset to pending — same for all levels
}
```

`MAX_TASK_AGENT_CRASH_RETRIES = 2` applies uniformly. Level 5 (fully autonomous) should retry indefinitely with backoff; Level 1 should escalate immediately to human.

---

### Gap 6 — No Review SLA / Human Timeout **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:1530-1535`

Timeout detection only checks `in_progress` tasks:

```typescript
// space-runtime.ts:1531
if (taskTimeoutMs !== undefined) {
  const timedOutExecutions = nodeExecutions.filter((execution) => {
    if (execution.status !== 'in_progress' || !execution.startedAt) return false;
    return now - execution.startedAt > taskTimeoutMs;
  });
```

Tasks in `review` status awaiting human approval can sit indefinitely. No `reviewTimeoutMs` in `SpaceConfig`.

---

### Gap 7 — In-Memory Crash/Block Counters Not Persistent **[MEDIUM]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts:253-265`

```typescript
private taskCrashCounts = new Map<string, number>();
private blockedRetryCounts = new Map<string, number>();
```

Both are in-memory only. Daemon restart clears them. Also not accumulated across runs of the same workflow. No per-space configurable escalation threshold.

---

### Gap 8 — `blockingGateId` Not Set on Gate Rejection **[LOW]**

**File**: `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts:525-529`

```typescript
await taskMgr.setTaskStatus(canonicalTask.id, 'blocked', {
  result: params.reason ?? 'Gate rejected',
  blockReason: 'gate_rejected',
});
// blockingGateId is NOT passed — remains null
```

`TaskBlockedBanner` uses a heuristic to find the blocking gate (has a TODO noting this). Plan & Decompose workflow has two gates — wrong gate can be shown.

---

### Gap 9 — Static Workflow Topology, No Conditional Branching by Autonomy **[LOW]**

**File**: `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`, `packages/daemon/src/lib/space/runtime/workflow-executor.ts`

Built-in workflows have fixed topologies. `completionAutonomyLevel` only controls auto-close, not which nodes execute.

Cannot express:
- `IF autonomy >= 4 THEN skip-review-node`
- `IF autonomy < 3 THEN add extra-validation-node`

Low-autonomy users running Fullstack QA Loop get the same 6-cycle flow as high-autonomy users.

---

### Gap 10 — Post-Approval Failure Doesn't Set `blockReason` **[LOW]**

**File**: `packages/daemon/src/lib/space/runtime/space-runtime.ts` (in `dispatchPostApproval` error path)

When post-approval routing fails (e.g., sub-session crash), the task is blocked but `blockReason` is not set. The Attention tab cannot distinguish post-approval failures from agent crashes.

---

## Summary Table

| Gap | Severity | Category | File | Status |
|---|---|---|---|---|
| 1. `request_human_input` no unblock path | **Critical** | HITL | `task-agent-tools.ts:893-935` | Open |
| 2. No `spaceTask.sendHumanMessage` | **Critical** | HITL | `space-task-handlers.ts` (missing) | Open |
| 3. `retryTask` internal-only, not RPC | **High** | Lifecycle | `space-task-manager.ts:452` | Open |
| 4. Approval has no audit comment | Medium | Audit | `space-task-handlers.ts:376-378` | Open |
| 5. No autonomy-differentiated retry | Medium | Retry | `space-runtime.ts:1602-1630` | Open |
| 6. No review SLA/timeout | Medium | Operations | `space-runtime.ts:1530-1535` | Open |
| 7. In-memory crash counters not persistent | Medium | Operations | `space-runtime.ts:253-265` | Open |
| 8. `blockingGateId` not set | Low | Workflow | `space-workflow-run-handlers.ts:525-529` | Open |
| 9. Static workflow topology | Low | Autonomy | `built-in-workflows.ts` | Open |
| 10. Post-approval failure no `blockReason` | Low | Audit | `space-runtime.ts` | Open |
| #3 — Audit trail | Medium | Audit | (partial: gate done, approval not) | Partial |
| #6 — Tiered retry by autonomy | Medium | Retry | (uniform retry count) | Open |
| #9 — Review SLA | Low | Operations | (not implemented) | Open |
| #10 — Conditional branching | Low | Autonomy | (static topology) | Open |
| #16 — Multi-gate ambiguity | Low | UX | `TaskBlockedBanner.tsx:111` | Open |
| #17 — Consecutive failure escalation | Medium | Operations | (in-memory, not cross-run) | Open |
| #18 — Task retry RPC | **High** | Lifecycle | (internal method exists, not RPC-exposed) | Open |

**Total: 18 distinct gap items** (10 new + 8 from prior doc)

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
| Workflow run handlers | `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` |
| Room task handlers (ref) | `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` |
| TaskBlockedBanner | `packages/web/src/components/space/TaskBlockedBanner.tsx` |
| PendingGateBanner | `packages/web/src/components/space/PendingGateBanner.tsx` |
| PendingTaskCompletionBanner | `packages/web/src/components/space/PendingTaskCompletionBanner.tsx` |
| PendingPostApprovalBanner | `packages/web/src/components/space/PendingPostApprovalBanner.tsx` |
| VisualWorkflowEditor | `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` |
| Prior gap doc | `docs/space-autonomy-hitl-gaps-claude-opus-4-6.md` |
