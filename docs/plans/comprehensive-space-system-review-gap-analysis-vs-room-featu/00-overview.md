# Space Workflow System: End-to-End Execution Build-Out

## Executive Summary

The Space system is a workflow-graph-based multi-agent orchestration engine. It already has a solid foundation: a visual workflow editor, a directed-graph executor with four condition types (always, human, condition, task_result), a Task Agent architecture that drives workflow advancement via MCP tools, channel-based messaging topology, and notification infrastructure. The core question this plan answers is:

**What does it take for a human to define a multi-agent workflow in Space and have it execute flawlessly on a real task?**

The answer requires hardening the runtime so it never silently loses work, adding error detection so failures are caught and recovered automatically, providing real-time observability so humans can monitor execution, and building lifecycle quality gates so coding tasks produce verifiable outputs.

This plan is organized into milestones that deliver minimum viable workflow execution first, then progressively expand capability. Room system feature parity is covered in a brief appendix; the main body focuses exclusively on what Space needs to work end-to-end.

> **Design Revalidation Notice:** This codebase is under active development. File paths, interfaces, and implementation patterns referenced in this plan may have changed since the analysis date (2026-03-24). **Agents working on tasks must revalidate the design against the current code before implementing.** This includes verifying that referenced files still exist, interfaces still match, and integration points are still correct. If you encounter discrepancies, update the task specification accordingly and flag the change in the PR description.

---

## What Already Works

The Space system has substantial working infrastructure. Here is what is in place today:

| Primitive | Status | Implementation |
|-----------|--------|----------------|
| Workflow definition (graph model) | Working | `SpaceWorkflow` with `WorkflowNode[]`, `WorkflowTransition[]`, `WorkflowRule[]` |
| Visual workflow editor | Working | `VisualWorkflowEditor` with drag-drop canvas, node config, edge conditions |
| Workflow execution (advance) | Working | `WorkflowExecutor` with condition evaluation, cyclic iteration cap |
| Task Agent orchestration | Working | `TaskAgentManager` spawns Task Agent + sub-sessions per step |
| Condition types | Working | `always`, `human`, `condition` (shell), `task_result` (prefix match) |
| Multi-agent parallel steps | Working | `agents[]` on nodes, `resolveNodeAgents()` normalization |
| Channel topology | Working | `ChannelResolver` validates `canSend(fromRole, toRole)` |
| Notification sink | Working | `NotificationSink` interface, `SessionNotificationSink` with defer delivery |
| Built-in templates | Working | Coding (4-node cycle), Research (2-node), Review-Only (1-node) |
| Export/Import | Working | Full agent + workflow export/import system |
| Agent management | Working | Custom agents with roles, prompts, models; seed agents on creation |
| Session groups | Working | `SpaceSessionGroup` with member tracking and DaemonHub events |

## What Needs to Be Built

The gaps below are ordered by impact on end-to-end workflow execution. Each gap maps to a task in the milestones.

| Gap | Impact | Milestone |
|-----|--------|-----------|
| `in_progress` cannot transition to `rate_limited`/`usage_limited` | Cannot detect or handle API rate limits | M1 |
| Pending workflow runs lost on daemon crash | Data loss for mid-creation runs | M1 |
| No dead loop detection on condition gates | Infinite bounce loops burn API credits | M2 |
| Tick loop uses `setInterval` (lost on restart) | Workflow runs stall after daemon restart | M2 |
| No error classification pipeline | All API errors treated equally, no auto-recovery | M2 |
| No task conversation view | Humans cannot see what agents are doing | M3 |
| No review/approval UI for `review` status tasks | No structured human feedback on work product | M3 |
| No real-time DaemonHub events for task/run state changes | Frontend polls, stale UI | M3 |
| No exit hooks (PR checks on step completion) | Agents can complete without creating verifiable work | M4 |
| No advance hooks (gate enforcement) | Workflows can advance past quality checkpoints | M4 |
| No human message routing to step agents | Cannot provide guidance mid-execution | M5 |
| No goal/mission integration | Workflow runs disconnected from progress tracking | M6 |
| No cron scheduling | Cannot run recurring workflows | M6 |
| No workflow run history / activity feed | No post-hoc review of what happened | M6 |

---

## Dependency Graph

```
M1 Tasks (Foundation)
  Task 1: Transition map fix ──────────────────────────────────────┐
  Task 2: Pending run rehydration ─────────────────────────────────┤
  Task 3: Notification dedup validation ──────────────────────────┤
                                                                  │
M2 Tasks (Runtime Reliability)                                    │
  Task 4: Dead loop detection ─────────────────────────────────────┤
  Task 5: JobQueue tick persistence ──────────────────────────────┤
  Task 6: Error classification pipeline ─────────┬─── depends on Task 1
                                                  │
M3 Tasks (Monitoring & Debugging)                 │
  Task 7: Task conversation view ─────────────────┤
  Task 8: Review/approval UI ─────────────────────┤
  Task 9: DaemonHub real-time events ─────────────┤
                                                  │
M4 Tasks (Lifecycle & Quality Gates)              │
  Task 10: Lifecycle hook design ──────── depends on Task 4
  Task 11: Exit hooks ────────────────── depends on Task 10
  Task 12: Advance hooks + bypass ────── depends on Task 10, 11
                                                  │
M5 Tasks (Human-in-the-Loop)                     │
  Task 13: Human message routing ────── depends on Task 8
                                                  │
M6 Tasks (Advanced Features)                      │
  Task 14: Goal/mission bridge design ────────────┤
  Task 15: Goal progress wiring ─────── depends on Task 14
  Task 16: Cron scheduling ──────────── depends on Task 5
  Task 17: Dashboard + activity feed ─ depends on Task 15
```

**Parallelization opportunities:**
- Tasks 1, 2, 3, 4, 5, 7, 8, 9, 14 can all start immediately (no dependencies).
- Task 6 depends on Task 1.
- Task 10 depends on Task 4.
- Task 11 depends on Task 10.
- Task 12 depends on Tasks 10, 11.
- Task 13 depends on Task 8.
- Task 15 depends on Task 14.
- Task 16 depends on Task 5.
- Task 17 depends on Task 15.

---

## Milestones

| # | Milestone | Tasks | Theme |
|---|-----------|-------|-------|
| 1 | Workflow Execution Foundation | 1, 2, 3 | Fix data model holes so workflows never silently lose state |
| 2 | Runtime Reliability | 4, 5, 6 | Detect failures automatically, persist ticks, recover from errors |
| 3 | Workflow Monitoring & Debugging | 7, 8, 9 | Let humans see what is happening and intervene when needed |
| 4 | Lifecycle & Quality Gates | 10, 11, 12 | Enforce that coding work meets quality standards before advancing |
| 5 | Human-in-the-Loop | 13 | Enable real-time guidance to step agents during execution |
| 6 | Advanced Features | 14, 15, 16, 17 | Goal integration, recurring workflows, dashboard polish |

---

## Total Task Count

**17 tasks** across 6 milestones. Estimated **8 coder sessions + 1 general session** (Task 10 is design-only).

---

## Milestone Files

Each milestone has its own detailed task specification file. Agents working on tasks must **revalidate the design against the current codebase** before implementing -- file paths, interfaces, and integration points may have changed since the analysis date.

- [`01-workflow-execution-foundation.md`](01-workflow-execution-foundation.md) -- M1: Fix data model holes (Tasks 1, 2, 3)
- [`02-runtime-reliability.md`](02-runtime-reliability.md) -- M2: Error detection + persistent ticks (Tasks 4, 5, 6)
- [`03-monitoring-debugging.md`](03-monitoring-debugging.md) -- M3: Task views + review UI + real-time events (Tasks 7, 8, 9)
- [`04-lifecycle-quality-gates.md`](04-lifecycle-quality-gates.md) -- M4: Exit hooks + advance hooks (Tasks 10, 11, 12)
- [`05-human-in-the-loop.md`](05-human-in-the-loop.md) -- M5: Human message routing (Task 13)
- [`06-advanced-features.md`](06-advanced-features.md) -- M6: Goals + cron + dashboard (Tasks 14, 15, 16, 17)
- [`07-room-parity-reference.md`](07-room-parity-reference.md) -- Appendix: Room parity analysis for reference

---

## Architecture Overview

```
Human (browser)
  |
  v
Space UI (Preact + Signals)
  |-- VisualWorkflowEditor  (define workflows)
  |-- SpaceDashboard        (monitor execution)
  |-- SpaceTaskPane         (inspect tasks)
  |-- SpaceTaskReviewBar    (approve/reject work)
  |
  v  (MessageHub RPC + pub/sub)
Daemon
  |
  |-- SpaceRuntimeService  (lifecycle: start/stop shared runtime)
  |     |
  |     |-- SpaceRuntime   (tick loop, executor management)
  |     |     |-- WorkflowExecutor   (graph navigation, condition eval)
  |     |     |-- NotificationSink   (event delivery to Space Agent)
  |     |
  |     |-- TaskAgentManager  (spawn Task Agent + sub-sessions)
  |     |     |-- Task Agent session  (orchestrates via MCP tools)
  |     |     |     |-- Sub-session (step agent: planner/coder/general/custom)
  |     |     |-- ChannelResolver  (messaging permissions)
  |     |
  |     |-- SpaceTaskManager   (task CRUD, status transitions)
  |     |-- SpaceWorkflowManager (workflow definition CRUD)
  |     |-- SpaceAgentManager  (agent definition CRUD)
  |
  |-- DaemonHub  (event bus: session.updated, spaceSessionGroup.*, etc.)
  |-- MessageHub  (WebSocket RPC + pub/sub to web client)
```
