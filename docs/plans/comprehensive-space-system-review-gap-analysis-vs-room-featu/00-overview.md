# Comprehensive Space System Review: Gap Analysis vs Room Feature Parity

## Executive Summary

The Space system is a workflow-graph-based multi-agent orchestration engine that surpasses the Room system in visual workflow authoring, multi-agent parallelism, and channel topology flexibility. However, the Space system has significant gaps in goal/mission integration, runtime reliability (rate limit detection, dead loop detection, lifecycle hooks), tick persistence (JobQueue), UI task management views, and cron scheduling. This document provides a concrete, prioritized list of missing pieces organized into milestones with detailed implementation specs.

This analysis is based on a thorough code-level review of both systems as of 2026-03-24, cross-referencing `packages/daemon/src/lib/room/` (Room) against `packages/daemon/src/lib/space/` (Space), their shared types, RPC handlers, storage repositories, and frontend components.

> **⚠️ Design Revalidation Notice:** This codebase is under active development. File paths, interfaces, and implementation patterns referenced in this plan may have changed since the analysis date. **Agents working on tasks must revalidate the design against the current code before implementing.** This includes verifying that referenced files still exist, interfaces still match, and integration points are still correct. If you encounter discrepancies, update the task specification accordingly and flag the change in the PR description.

---

## Architecture Comparison

### Room System (Leader/Worker Paired Sessions)

| Component | File | Description |
|-----------|------|-------------|
| `RoomRuntime` | `room/runtime/room-runtime.ts` | Central orchestrator per room. Detects goals needing planning, spawns (Worker, Leader) session groups, routes worker output to leader for review, enforces review round limits, handles lifecycle hooks. |
| `RoomRuntimeService` | `room/runtime/room-runtime-service.ts` | Wires RoomRuntime instances into the daemon. One runtime per room, with session factory, worktree manager, MCP server attachment, and daemon recovery. |
| `TaskGroupManager` | `room/runtime/task-group-manager.ts` | Manages (Worker, Leader) session group lifecycle: spawn, route worker-to-leader, route leader-to-worker, complete, fail, cancel, submit for review, escalate. |
| `SessionObserver` | `room/state/session-observer.ts` | Subscribes to `session.updated` DaemonHub events, fires callbacks on terminal states. |
| `SessionGroupRepository` | `room/state/session-group-repository.ts` | SQLite persistence for session groups with feedback iteration tracking, gate failure history, leader bootstrap config, mirroring. |
| `GoalManager` | `room/managers/goal-manager.ts` | Full mission system: CRUD, metric recording, execution management, cron scheduling, progress tracking. |
| `TaskManager` | `room/managers/task-manager.ts` | Task lifecycle with status transitions, priority, task types (planning/coding). |
| `LifecycleHooks` | `room/runtime/lifecycle-hooks.ts` | Deterministic runtime gates: WorkerExitGate (branch/PR checks), LeaderSubmitGate (PR mergeability), LeaderCompleteGate (PR merged, root repo sync). |
| `ErrorClassifier` | `room/runtime/error-classifier.ts` | 4-class error taxonomy: terminal, rate_limit, usage_limit, recoverable. Used for auto-transition and model fallback. |
| `DeadLoopDetector` | `room/runtime/dead-loop-detector.ts` | Detects infinite bounce cycles in gates via count-based and similarity-based analysis. |
| `HumanMessageRouting` | `room/runtime/human-message-routing.ts` | Routes human messages to worker or leader of active groups. |
| `RuntimeRecovery` | `room/runtime/runtime-recovery.ts` | Restores active groups, sessions, and observers after daemon restart. |
| `RateLimitUtils` | `room/runtime/rate-limit-utils.ts` | Parses rate limit reset times, creates backoff strategies. |
| `MessageRouting` | `room/runtime/message-routing.ts` | Formats worker-to-leader and leader-to-worker envelopes. |
| `CronUtils` | `room/runtime/cron-utils.ts` | Cron expression parsing, next-run computation, catch-up detection for recurring missions. |

### Space System (Workflow-Graph + Task Agent Orchestration)

| Component | File | Description |
|-----------|------|-------------|
| `SpaceRuntime` | `space/runtime/space-runtime.ts` | Shared runtime for all spaces. Manages WorkflowExecutor map, processes completed tasks, advances workflows, timeout detection. |
| `SpaceRuntimeService` | `space/runtime/space-runtime-service.ts` | Lifecycle management. One shared SpaceRuntime for all spaces. |
| `WorkflowExecutor` | `space/runtime/workflow-executor.ts` | Directed graph navigation: getCurrentStep, advance, condition evaluation (always/human/condition/task_result), cyclic iteration cap. |
| `TaskAgentManager` | `space/runtime/task-agent-manager.ts` | Manages Task Agent sessions + sub-sessions. Hierarchical model: Task Agent per task, sub-session per step. Handles spawn, completion detection, rehydration. |
| `ChannelResolver` | `space/runtime/channel-resolver.ts` | Validates messaging permissions based on declared channel topology. |
| `NotificationSink` | `space/runtime/notification-sink.ts` | Interface for structured events (task_needs_attention, workflow_run_needs_attention, task_timeout, workflow_run_completed). |
| `SessionNotificationSink` | `space/runtime/session-notification-sink.ts` | Production implementation: injects deferred messages into Space Agent session. |
| `SpaceManager` | `space/managers/space-manager.ts` | Space CRUD and listing. |
| `SpaceAgentManager` | `space/managers/space-agent-manager.ts` | Agent definition CRUD with roles, model overrides, system prompts. |
| `SpaceTaskManager` | `space/managers/space-task-manager.ts` | SpaceTask CRUD with status transitions, goal filtering, archive. |
| `SpaceWorkflowManager` | `space/managers/space-workflow-manager.ts` | Workflow definition CRUD. |

---

## Dependency Graph

```
Task 0 (Goal Bridge Design) ──→ Task 1 (Goal Progress Wiring) ──→ Task 11 (DaemonHub Events)
                                 │                                  │
                                 │                                  ↓
                                 │                              Task 13 (Goal UI)
                                 │                                  │
                                 │                                  ↓
                                 │                              Task 14 (Dashboard)
                                 │
Task 2 (Transition Map Fix) ───→ Task 2-Full (Rate Limit Pipeline)
                                 │
Task 3 (Dead Loop Detection) ───→ Task 6a (Hook Design) ──→ Task 6b (Exit Hooks) ──→ Task 6c (Advance Hooks)
                                 │
Task 4 (Review UI) ─────────────→ Task 10 (Message Routing)
                                 │
Task 5 (Task Detail View)
                                 │
Task 7 (JobQueue Integration) ──→ Task 12 (Cron Scheduling)
                                 │
Task 8 (Pending Run Fix)
                                 │
Task 9 (Dedup Validation)
```

**Parallelization opportunities:**
- Tasks 0, 2, 3, 4, 5, 7, 8, 9 can all start immediately (no dependencies).
- Task 6a can start after Task 3.
- Task 6b can start after Tasks 6a and 3.
- Task 10 can start after Task 4.
- Task 1 can start after Task 0.
- Task 11 can start after Task 1.
- Task 12 can start after Task 7.
- Task 2-Full can start after Task 2 (Milestone 1).

---

## Milestones

| # | Milestone | Tasks | Depends On | Description |
|---|-----------|-------|------------|-------------|
| 1 | Foundation | 0, 2, 8, 9 | None | Data model fixes + goal bridge design |
| 2 | Runtime Reliability | 3, 7 | None | Dead loop detection + persistent ticks |
| 3 | Goal Integration + HITL UI | 1, 4, 5, 11 | M1 (Task 0→1) | Goal progress wiring + review UI + task detail |
| 4 | Lifecycle Hooks | 6a, 6b, 6c | M2 (Task 3→6a) | Hook design + exit hooks + advance hooks |
| 5 | Rate Limit Pipeline + Messaging | 2-Full, 10 | M1 (Task 2→2-Full), M3 (Task 4→10) | Full error pipeline + human message routing |
| 6 | Cron + Goal UI + Dashboard | 12, 13, 14 | M2 (Task 7→12), M3 (Task 1→13) | Recurring workflows + UI polish |

---

## Summary Gap Scores

| # | Dimension | Parity | Priority | Key Gap |
|---|-----------|--------|----------|---------|
| 1 | Goal/Mission integration | 15% | CRITICAL | No active integration |
| 2 | Error detection and recovery | 50% | HIGH | No inbound transitions, no runtime detection |
| 3 | Dead loop detection | 0% | HIGH | No detection mechanism |
| 4 | Lifecycle hooks | 0% | HIGH | No structured gate framework |
| 5 | Human-in-the-loop | 55% | HIGH | No review UI, no direct routing |
| 6 | Tick persistence | 30% | HIGH | No persistent scheduling |
| 7 | UI task management | 50% | HIGH | Missing detail view, review UI, goals |
| 8 | Persistence/recovery | 70% | MEDIUM | Pending runs, no mirroring |
| 9 | Event handling | 65% | MEDIUM | No real-time task updates |
| 10 | Inter-agent messaging | 95% | LOW | Minor: no answerQuestion |
| 11 | Worktree isolation | N/A | DESIGN | Intentional design difference |

**Methodology note:** Parity percentages are qualitative assessments. "15%" means only metadata fields exist with no runtime integration; "50%" means types are present but no runtime logic; "95%" means near-complete with minor gaps. Read as rough ordinal indicators.

---

## Space-Exclusive Advantages (Room Does NOT Have)

| Feature | Space | Room |
|---------|-------|------|
| Visual workflow editor | Full drag-drop canvas with pan/zoom, node cards, edge editing | None |
| Multi-agent parallel steps | Multiple agents per workflow step, all concurrent | Single worker per task |
| Channel topology | Flexible directed/bidirectional edges via ChannelResolver | Fixed Worker-to-Leader routing |
| Condition-based transitions | always, human, condition (shell), task_result | Implicit via Leader tool calls |
| Task Agent architecture | MCP-tool-driven orchestration (agent drives workflow advancement) | Direct advance() calls (runtime drives workflow) |
| NotificationSink pattern | Structured event interface with deferred delivery, testable via NullNotificationSink | Ad-hoc `daemonHub.emit()` calls, harder to test in isolation |
| Per-agent overrides | Model and system prompt per agent slot | Agent model override only |
| Workflow templates | Coding, Research, Review-Only built-in workflows | No workflow templates |
| Export/Import | Full agent + workflow export/import system | No export/import |
| Custom agents | User-defined agents with roles, prompts, models | Preset roles only (planner/coder/general) |

---

## Milestone Files

Each milestone has its own detailed task specification file. Agents working on tasks must **revalidate the design against the current codebase** before implementing — file paths, interfaces, and integration points may have changed since the analysis date.

- [`01-foundation.md`](01-foundation.md) -- M1: Data Model Fixes + Goal Bridge Design (Tasks 0, 2, 8, 9)
- [`02-runtime-reliability.md`](02-runtime-reliability.md) -- M2: Dead Loop Detection + Tick Persistence (Tasks 3, 7)
- [`03-goal-integration-hitl-ui.md`](03-goal-integration-hitl-ui.md) -- M3: Goal Integration + Human-in-the-Loop UI (Tasks 1, 4, 5, 11)
- [`04-lifecycle-hooks.md`](04-lifecycle-hooks.md) -- M4: Lifecycle Hooks + Advanced Runtime (Tasks 6a, 6b, 6c)
- [`05-rate-limit-pipeline-messaging.md`](05-rate-limit-pipeline-messaging.md) -- M5: Rate Limit Pipeline + Human Message Routing (Tasks 2-Full, 10)
- [`06-cron-goal-ui-dashboard.md`](06-cron-goal-ui-dashboard.md) -- M6: Cron Scheduling + Goal UI + Dashboard (Tasks 12, 13, 14)
