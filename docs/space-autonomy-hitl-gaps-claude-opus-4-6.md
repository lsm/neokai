# Space Autonomy & Human-in-the-Loop Gap Analysis

Date: 2026-04-12

## Architecture Summary

The space/task/workflow system has three orthogonal control layers:

| Layer | Scope | Mechanism | Key File |
|-------|-------|-----------|----------|
| **Gates** | Per-channel in workflow | Field checks + scripts block message delivery | `runtime/gate-evaluator.ts` |
| **Autonomy Level** | Per-space | Controls task terminal status (`review` vs `done`) | `runtime/space-runtime.ts:1177` |
| **Task Status Machine** | Per-task | `open -> in_progress -> review -> done` | `managers/space-task-manager.ts` |

### How Autonomy Works Today

Autonomy has exactly **one decision point** — at `space-runtime.ts:1177`:

```
supervised:       workflow completes -> task status = 'review' (human must approve)
semi_autonomous:  workflow completes -> task status = 'done' (auto-completed)
```

During execution, both modes behave identically.

---

## Room vs Space: Architectural Guidelines for Gap Fixes

Room and Space both orchestrate agent work, but their architectures differ in a way
that must guide every implementation decision in this gap list.

| | Room | Space |
|---|------|-------|
| **Workflow model** | Static, hardcoded in code — the code *is* the workflow (leader/worker/planner roles wired directly in `room-runtime.ts`) | Framework — users define workflow topology (nodes, channels, gates) as data; the runtime executes it generically |
| **Boundary** | No clear boundary between execution logic and workflow definition | Clean separation: workflow definition (data) vs. workflow executor (runtime) |
| **Extension point** | Add a new role → modify runtime code | Add a new node/channel → modify workflow data, runtime unchanged |

### Implications for gap fixes

1. **Keep execution details out of the workflow executor.** The workflow executor
   (`workflow-executor.ts`, `channel-router.ts`, `gate-evaluator.ts`) is generic
   infrastructure. Gap fixes that add scheduling logic, retry policies, or
   autonomy-aware behavior belong at the **task scheduling layer**
   (`space-runtime.ts` tick loop, `space-task-manager.ts`), not inside the executor.

2. **Prefer passive re-evaluation over explicit cascading.** Space already has a
   5-second tick loop that re-evaluates all open tasks. When possible, let the tick
   naturally discover state changes (e.g., dependencies met) rather than building
   explicit unblock/notify cascades. This keeps the system simpler and idempotent.

3. **Don't copy Room patterns verbatim.** Room's tight coupling (e.g., role-specific
   logic in `submit_for_review()`, hardcoded `leader_semi_auto` approval source)
   works *because* Room's workflow is static. Space must express the same intent
   through its existing extensibility primitives (gates, channels, task metadata)
   rather than hardcoding role-specific behavior.

4. **Cross-pollinate concepts, not code.** Room's richer autonomy model (planner
   always needs human, coder auto-approves) is a useful *design reference* for
   Gap #4 and #7. But the implementation should use Space's gate/channel system
   to express these policies declaratively, not replicate Room's imperative checks.

---

## Gap List

### 1. PR Auto-Merge for Semi-Autonomous

**Status:** Documented but unimplemented

CLAUDE.md states: *"Semi-autonomous: Worker can merge approved PRs without human confirmation"*

Tasks track `prUrl`, `prNumber`, `prCreatedAt` but:
- No merge logic exists
- No gate script template for "wait for N approvals + CI green"
- No differentiation between supervised (human must merge) and semi-autonomous (agent can merge approved PRs)

**Impact:** High — core promised feature  
**Effort:** Medium

---

### 2. Approval Notification/Queue UI ✅ PR #TBD

Gates support `writers: ['human']` and `spaceWorkflowRun.approveGate` RPC exists. However:
- ~~No notification to tell humans a gate is waiting~~
- ~~No inbox/queue of pending approvals in the UI~~
- No webhook/Slack/email integration for approval requests
- ~~Human must manually check the workflow run state to discover pending gates~~

**Implemented:**
- LiveQuery `spaceTasks.needingAttention` — real-time attention task tracking (review + human-blocked)
- "Action" tab in SpaceTasks — groups tasks by reason: Needs Input, Gate Pending, Awaiting Review, Blocked
- Amber attention badge on Tasks sidebar button and SpacesPage cards
- LiveQuery-backed counts survive reconnect (no missed notifications)

**Impact:** Medium — humans don't know when approval is needed  
**Effort:** Medium

---

### 2b. Action UI (Approve/Reject/Resolve)

Gap #2 surfaces *that* tasks need human attention, but there is no UI for *taking* that action.

Missing:
- Approve/reject buttons for gate-pending tasks (`spaceWorkflowRun.approveGate` RPC exists but has no UI)
- Input form for `human_input_requested` tasks (agent asked a question, human has no way to answer)
- "Mark done" / "Re-open" actions for tasks in `review` status
- Contextual display of *why* the task is blocked (gate message, agent's question, dependency chain)

**Depends on:** Gap #2 (notification/queue), Gap #8 (block reasons)  
**Impact:** High — without action UI, the notification queue is informational only  
**Effort:** Medium

---

### 3. Approval Audit Trail

When a human approves a gate or transitions a task from `review` -> `done`:
- No record of **who** approved or **when**
- No approval comment/reason field
- Room system tracks `approvalSource` (`"human"` vs `"leader_semi_auto"`) but space system doesn't
- No audit log for gate state changes

**Impact:** Medium — no accountability  
**Effort:** Low

---

### 4. Execution-Time Autonomy Differentiation

Semi-autonomous is identical to supervised during execution. Missing:
- Autonomy-aware retry behavior (semi-autonomous retries more aggressively)
- Auto-skipping of lower-priority gates
- Autonomous decision-making at workflow branch points
- The "semi" in semi-autonomous implies graduated control but none exists during execution

**Impact:** High — defeats purpose of autonomy levels  
**Effort:** High

---

### 5. Task Dependency Enforcement

`SpaceTask.dependsOn` stores dependency IDs but is **not enforced at runtime**:
- Tasks with unmet deps can be started
- No auto-blocking when dependencies incomplete
- No auto-unblocking when dependencies complete
- `cancelTaskCascade()` exists for cancellation propagation but no `completionCascade()` for unblocking

**Impact:** Medium  
**Effort:** Medium

---

### 6. Tiered Retry by Autonomy Level

Current behavior when a node agent crashes (same for both modes):
- Runtime detects via liveness check
- Resets node to `pending` for retry
- After max retries, escalates to `blocked`

Missing autonomy-aware retry policies:
- **Semi-autonomous:** Auto-retry more aggressively (higher retry count, auto-restart)
- **Supervised:** Block immediately and notify human on first failure

**Impact:** Medium  
**Effort:** Medium

---

### 7. Room/Space Autonomy Unification

Two parallel autonomy systems exist with different capabilities:

| System | Table | Check Point | Behavior |
|--------|-------|-------------|----------|
| Space | `spaces.autonomy_level` | Workflow task completion | Binary: review vs done |
| Room/Goal | `goals.autonomy_level` | `submit_for_review()` | Richer: planner always needs human, coder auto-approves with `leader_semi_auto` |

No cross-pollination of patterns between the two systems.

**Impact:** High — confusing dual systems  
**Effort:** High

---

### 8. Block Reason Tagging for Space Tasks

Space tasks use a single `blocked` status for all failure modes. Once a task is blocked,
nothing in the system knows *why* — the UI, notifications, retry logic, and Space Agent
all see the same opaque state.

**Approach:** Keep `blocked` as the only status. Add a `blockReason` field that records
the specific cause. Downstream systems (notifications, retry, autonomy) branch on the
reason, not the status.

**Block reasons (by code path):**

| Reason | Trigger | Who resolves | Auto-recoverable? |
|--------|---------|-------------|-------------------|
| `agent_crashed` | Agent session died after 2 retries | Space Agent `retry_task()` → human | No (retries exhausted) |
| `workflow_invalid` | Missing endNodeId or broken topology | Human (fix workflow definition) | No |
| `execution_failed` | Node hit unrecoverable error | Space Agent → human | No |
| `human_input_requested` | Task Agent called `request_human_input` | Human (answer the question) | No (by design) |
| `gate_rejected` | Human or agent rejected a gate | Human (re-approve or revise) | No |
| `dependency_failed` | Upstream task failed (future, Gap 5) | Depends on upstream fix | No |

**Why not a separate `needs_attention` status?**
- No status machine changes, no migration of existing tasks
- Block reasons are more informative than a binary status split
- The runtime auto-retry (2 agent crashes, 1 run retry) happens *before* `blocked` — by the
  time a task is blocked, auto-recovery already failed regardless of reason
- UI/notifications can filter on reason directly (e.g. show badge only for `human_input_requested` + `gate_rejected`)

**Impact:** Low-Medium  
**Effort:** Low

---

### 9. Human Review SLA/Timeout

Tasks can sit in `review` indefinitely:
- No configurable SLA per space
- No auto-escalation after timeout
- No auto-approve option for semi-autonomous after timeout period

**Impact:** Low  
**Effort:** Low

---

### 10. Conditional Branching by Autonomy

Workflow topology is fixed regardless of autonomy level:
- Can't express "if supervised, route to human-review node; if semi-autonomous, skip to merge node"
- Would need conditional node type or autonomy-aware channel routing

**Impact:** Medium  
**Effort:** High

---

## Priority Matrix

| # | Gap | Impact | Effort | Priority |
|---|-----|--------|--------|----------|
| 1 | PR auto-merge for semi-autonomous | High | Medium | **P0** |
| 2 | Approval notification/queue UI | Medium | Medium | **P1** |
| 2b | Action UI (approve/reject/resolve) | High | Medium | **P1** |
| 3 | Approval audit trail | Medium | Low | **P1** |
| 4 | Execution-time autonomy differentiation | High | High | **P2** |
| 5 | Task dependency enforcement | Medium | Medium | **P2** |
| 6 | Tiered retry by autonomy level | Medium | Medium | **P2** |
| 7 | Room/Space autonomy unification | High | High | **P3** |
| 8 | Block reason tagging for space tasks | Low-Medium | Low | **P2** |
| 9 | Human review SLA/timeout | Low | Low | **P3** |
| 10 | Conditional branching by autonomy | Medium | High | **P3** |

## Dependency Graph & Implementation Order

```
Gap 3 (Audit Trail) ──────┐
                           ├──► Gap 2 (Notification UI) ──► Gap 2b (Action UI) ──► Gap 1 (PR Auto-Merge)
Gap 8 (block reasons) ────┘                                       │
                                                                  ▼
Gap 5 (Dependency Enforcement)                              Gap 9 (Review SLA)
                                                                  │
Gap 6 (Tiered Retry) ────────────────────────────────────────────┤
                                                                  ▼
                                                          Gap 4 (Execution-Time Autonomy)
                                                                  │
                                                                  ▼
                                                          Gap 10 (Conditional Branching)
                                                                  │
                                                                  ▼
                                                          Gap 7 (Room/Space Unification)
```

### Recommended Implementation Sequence

| Step | Gap | Why this order | Effort | Status |
|------|-----|----------------|--------|--------|
| 1 | **#3 Audit trail** | Foundation — everything else needs to record who/when/why | Low | **Done** (PR #1481) |
| 2 | **#8 Block reason tagging** | Foundation — distinguishes block types for notifications & retry | Low | **Done** (PR #1486) |
| 3 | **#5 Dependency enforcement** | Standalone, no deps, fixes correctness issue | Medium | **Done** (PR #1488) |
| 4 | **#2 Notification UI** | Builds on 3+8, unlocks human-in-the-loop usability | Medium | |
| 5 | **#2b Action UI** | Builds on #2, makes notification queue actionable | Medium | |
| 6 | **#9 Review SLA** | Small, builds on audit trail | Low | |
| 7 | **#6 Tiered retry** | Standalone, but informed by needs_attention distinction | Medium | |
| 8 | **#1 PR auto-merge** | Needs audit trail + notification + action UI in place | Medium | |
| 9 | **#4 Execution-time autonomy** | Builds on retry + needs_attention + audit | High | |
| 10 | **#10 Conditional branching** | Extends execution-time autonomy into workflow topology | High | |
| 11 | **#7 Room/Space unification** | Last — needs both systems mature before merging patterns | High | |

## Key Files Reference

| Component | Path |
|-----------|------|
| Space types | `packages/shared/src/types/space.ts` |
| Space runtime | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| Gate evaluator | `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` |
| Channel router | `packages/daemon/src/lib/space/runtime/channel-router.ts` |
| Task manager | `packages/daemon/src/lib/space/managers/space-task-manager.ts` |
| Node agent tools | `packages/daemon/src/lib/space/tools/node-agent-tools.ts` |
| Workflow executor | `packages/daemon/src/lib/space/runtime/workflow-executor.ts` |
| Space RPC handlers | `packages/daemon/src/lib/rpc-handlers/space-*.ts` |
| Room runtime (comparison) | `packages/daemon/src/lib/room/runtime/room-runtime.ts` |
| Room agent tools (comparison) | `packages/daemon/src/lib/room/tools/room-agent-tools.ts` |
