# Comprehensive Space System Review: Gap Analysis vs Room Feature Parity

## Executive Summary

The Space system is a workflow-graph-based multi-agent orchestration engine that surpasses the Room system in visual workflow authoring, multi-agent parallelism, and channel topology flexibility. However, the Space system has significant gaps in goal/mission integration, runtime reliability (rate limit detection, dead loop detection, lifecycle hooks), tick persistence (JobQueue), UI task management views, and cron scheduling. This document provides a concrete, prioritized list of missing pieces organized into milestones with detailed implementation specs.

This analysis is based on a thorough code-level review of both systems as of 2026-03-24, cross-referencing `packages/daemon/src/lib/room/` (Room) against `packages/daemon/src/lib/space/` (Space), their shared types, RPC handlers, storage repositories, and frontend components.

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

## Detailed Gap Analysis

### 1. Goal/Mission Management Integration (Parity: 15%) -- CRITICAL

**What Room has:**
- Full `GoalManager` with CRUD, metric recording (`structuredMetrics`), execution management (`mission_executions` table), cron scheduling (`schedule.expression` + `nextRunAt`), catch-up detection, progress tracking.
- Mission types: `one_shot`, `measurable`, `recurring`.
- Autonomy levels: `supervised`, `semi_autonomous`.
- `ConsecutiveFailures` tracking and auto-retry with `maxPlanningRetries`.
- Goal progress auto-recalculation on task status changes (`goalManager.updateGoalsForTask()`).
- `mission_executions` table for recurring mission run history.
- `mission_metric_history` table for time-series metric snapshots.

**What Space has:**
- `goalId` field on `SpaceWorkflowRun` (nullable `goal_id` column in `space_workflow_runs` table).
- No import or reference to `GoalManager` anywhere in the Space module.

**Missing:**
1. Space task completion does NOT trigger goal progress recalculation.
2. No mission type support for Space workflows (no `one_shot`/`measurable`/`recurring` distinction).
3. No `structuredMetrics` on Space tasks.
4. No `mission_executions` tracking for Space workflow runs.
5. No cron scheduling for recurring Space workflows.
6. No `consecutiveFailures` or auto-retry logic in Space.
7. No autonomy level enforcement (Space has `autonomyLevel` on the Space entity but no runtime enforcement).

**Impact:** Without goal integration, Space workflows operate in a vacuum. There is no way to track whether workflow runs contribute to overarching objectives, and recurring workflows cannot be scheduled automatically.

### 2. Runtime Error Detection and Recovery (Parity: 50%) -- HIGH

**What Room has:**
- `classifyError()` -- 4-class taxonomy (terminal/rate_limit/usage_limit/recoverable) parsing SDK "API Error: NNN" messages. Regex: `/^API Error:\s*(\d{3})/m`. Terminal codes: 400, 401, 403, 404, 422.
- `detectTerminalError()` -- immediate task failure on 4xx errors.
- `trySwitchToFallbackModel()` -- automatic model fallback on rate_limit/usage_limit using `GlobalSettings.fallbackModels` chain.
- `createRateLimitBackoff()` -- exponential backoff with parsed `retry-after` timestamps.
- Inline rate limit handling in `onWorkerTerminalState` / `onLeaderTerminalState`.

**What Space has:**
- `rate_limited` and `usage_limited` statuses in `SpaceTaskStatus` type.
- **Outbound** transitions from `rate_limited`/`usage_limited` to `in_progress` exist in `VALID_SPACE_TASK_TRANSITIONS` (lines 32-33).
- `WorkflowTransitionError` and `WorkflowGateError` for workflow-level errors.
- `error` field on `SpaceTask` persisted to DB.

**Missing:**
1. **No inbound transitions** -- `VALID_SPACE_TASK_TRANSITIONS` at `space-task-manager.ts:26` defines `in_progress → ['review', 'completed', 'needs_attention', 'cancelled']` but does NOT include `rate_limited` or `usage_limited`. This is a data-model-level prerequisite that blocks all rate limit detection.
2. No `classifyError()` equivalent -- no runtime pipeline that watches for "API Error: NNN" in agent output and classifies it.
3. No `trySwitchToFallbackModel()` -- no automatic model fallback when rate limits are hit.
4. No `createRateLimitBackoff()` -- no exponential backoff with parsed retry-after timestamps.
5. No automatic transition to `rate_limited`/`usage_limited` status when API errors are detected.
6. No deferred resume after backoff expires -- tasks that hit rate limits will stay stuck.

**Impact:** Space agents hit rate limits and freeze. The status types exist but the transition map blocks them and no runtime code populates them.

### 3. Dead Loop Detection (Parity: 0%) -- HIGH

**What Room has:**
- `DeadLoopDetector` with configurable `maxFailures` (default 5), `rapidFailureWindow` (default 5 min), `reasonSimilarityThreshold` (default 0.75).
- Count-based detection: same gate fails N times within the time window.
- Similarity-based detection: uses Levenshtein distance to avoid counting distinct issues as a loop.
- `recordAndCheckDeadLoop()` in RoomRuntime: records gate failure, checks for loop, fails task with diagnostic message.

**What Space has:**
- `maxIterations` cap on cyclic edges in `WorkflowExecutor` -- prevents infinite cycling but only for cyclic transitions.
- No gate failure tracking or similarity analysis.

**Missing:**
1. No dead loop detection for condition gates.
2. No gate failure history or similarity-based analysis.
3. No diagnostic message generation for dead loops.

### 4. Lifecycle Hooks (Parity: 0%) -- HIGH

**What Room has:**
- `WorkerExitGate` with 7+ hook functions, `LeaderSubmitGate`, `LeaderCompleteGate`. Each returns `HookResult { pass, bypassed?, reason?, bounceMessage? }`.
- Bypass markers: `RESEARCH_ONLY:`, `VERIFICATION_COMPLETE:`, `INVESTIGATION_RESULT:`, `ANALYSIS_COMPLETE:`.
- `closeStalePr()` for superseded PR cleanup.

**What Space has:**
- Workflow `condition`-type transitions with shell command evaluation.
- `human`-type transitions for human gates.
- No lifecycle hook framework.

**Missing:**
1. No deterministic gate framework equivalent.
2. No bypass marker detection.
3. No PR lifecycle validation.
4. No root repo sync after merge.
5. No stale PR cleanup.

### 5. Human-in-the-Loop Workflow (Parity: 55%) -- HIGH

**What Room has:**
- `HeaderReviewBar.tsx` -- approve/reject buttons with PR link display.
- `routeHumanMessageToGroup()` -- routes human messages to worker or leader.
- `answerQuestion()` for SDK AskUserQuestion.
- `request('task.approve', { roomId, taskId })` / `request('task.reject', { roomId, taskId, feedback })` RPC calls.

**What Space has:**
- `review` status with valid transitions.
- `reviewTask()` method with PR metadata.
- `request_human_input` MCP tool in Task Agent.
- `HumanInputArea` in `SpaceTaskPane.tsx` for `needs_attention` status.

**Missing:**
1. No approve/reject controls for tasks in `review` status.
2. No direct message routing to step agent sessions.
3. No `answerQuestion()` for Space sub-sessions.

### 6. Tick Loop and Scheduling (Parity: 30%) -- HIGH

**What Room has:**
- `JobQueue` integration -- `enqueueRoomTick(roomId, jobQueue, delayMs)` enqueues persistent `room.tick` jobs.
- `createRoomTickHandler(getRuntimeForRoom, jobQueue)` -- handler that calls `runtime.tick()` and re-enqueues.
- Registration via `jobProcessor.register(ROOM_TICK, handler)` in `RoomRuntimeService.start()`.
- Event-driven wake-up on room creation.
- `cancelPendingTickJobs()` on pause/stop.

**What Space has:**
- `setInterval`-based tick loop (5-second default, configurable via `tickIntervalMs`).
- Immediate first tick on `start()`.
- No event-driven wake-up.

**Missing:**
1. No JobQueue integration -- `setInterval` is lost on daemon restart.
2. No event-driven tick wake-up.
3. No cron scheduling for recurring workflows.
4. No per-space tick isolation.

### 7. UI Task Management (Parity: 50%) -- HIGH

**What Room has:**
- `TaskViewV2.tsx` with `useTaskViewData()` hook, `useGroupMessages()` LiveQuery, `useTurnBlocks()`.
- `GoalsEditor.tsx` with two-step create wizard, mission type tabs, metrics bars, execution history.
- `TaskReviewBar` from `task-shared/`.

**What Space has:**
- `SpaceTaskPane.tsx` -- basic right-column task detail with status, priority, agents, result/error, HumanInputArea.
- `SpaceContextPanel.tsx` -- space list with nested task rows.
- `WorkflowEditor.tsx` -- visual workflow editor.

**Missing:**
1. No task conversation history view.
2. No goals editor.
3. No review bar (approve/reject) for `review` status.
4. No space-level dashboard with goal progress.

### 8. Persistence and Recovery (Parity: 70%) -- MEDIUM

**What Room has:**
- `RuntimeRecovery` -- recovers active groups, restores sessions, re-attaches MCP servers.
- `recoverZombieGroups()` for orphan cleanup.

**What Space has:**
- `TaskAgentManager.rehydrate()` -- restores Task Agent sessions from DB.
- `pending` runs excluded from rehydration.

**Missing:**
1. `pending` runs excluded from rehydration.
2. No zombie cleanup for orphaned Space session groups.

### 9. Event Handling and DaemonHub Integration (Parity: 65%) -- MEDIUM

**What Room has:**
- `daemonHub.emit()` for real-time events: `room.task.update`, `goal.progressUpdated`, etc.
- Events scoped via `sessionId: 'room:${roomId}'`.

**What Space has:**
- `NotificationSink` pattern with deferred delivery.
- `space.task.created`, `space.task.updated`, `space.task.completed`, `space.task.failed` DaemonHub events (from `space-task-handlers.ts` and `task-agent-tools.ts`).
- `spaceSessionGroup.created/memberAdded/memberUpdated` events.

**Missing:**
1. No `goal.progressUpdated` event when Space task completion triggers goal update.

**Not a gap (intentional design):**
- `notifiedTaskSet` is intentionally in-memory only (documented restart contract at `space-runtime.ts:150-153`).

### 10. Inter-Agent Messaging (Parity: 95%) -- LOW

**Assessment:** Space leads Room here via `ChannelResolver` + `send_message` MCP tool. Only minor gap: no `answerQuestion()` for SDK AskUserQuestion in sub-sessions.

### 11. Worktree/Task Isolation (Parity: N/A) -- DESIGN CHOICE

**Assessment:** Not a gap. Space uses shared workspace by design.

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
Task 2 (Rate Limit Pipeline) ──→ Task 6b (Core Exit Hooks) ──→ Task 6c (Advance Hooks)
                                 │
Task 3 (Dead Loop Detection) ────┤
                                 │
Task 4 (Review UI) ─────────────→ Task 10 (Message Routing)
                                 │
Task 5 (Task Detail View)       │
                                 │
Task 6a (Hook Design) ──────────┘
                                 │
Task 7 (JobQueue Integration) ──→ Task 12 (Cron Scheduling)
                                 │
Task 8 (Pending Run Fix)        │
                                 │
Task 9 (Dedup Validation)       │
```

**Parallelization opportunities:**
- Tasks 0, 2, 3, 4, 5, 7, 8, 9 can all start immediately (no dependencies).
- Task 6a can start after Task 3.
- Task 6b can start after Tasks 6a and 3.
- Task 10 can start after Task 4.
- Task 1 can start after Task 0.
- Task 11 can start after Task 1.
- Task 12 can start after Task 7.

---

## Milestone 1: Foundation -- Data Model Fixes + Goal Bridge Design

**Goal:** Fix blocking data-model issues and produce the architectural design needed for goal integration.

**Milestone Acceptance Criteria:**
- [ ] `VALID_SPACE_TASK_TRANSITIONS` allows `in_progress → rate_limited` and `in_progress → usage_limited`.
- [ ] Unit tests cover the new transition map entries.
- [ ] Design document for GoalManager bridge architecture is approved.
- [ ] Notification dedup restart contract is validated with unit tests.
- [ ] Pending workflow run rehydration works correctly.

### Task 0: Design GoalManager Bridge Architecture for Space

- **Priority:** CRITICAL
- **Agent Type:** general
- **Dependencies:** None
- **Description:** `GoalManager` is constructed with `roomId` and operates on Room-scoped data. The `goals` table has a required `room_id` FK to `rooms(id)`. Space stores `goalId` on `SpaceWorkflowRun` (nullable `goal_id` column) but has no `roomId` concept. Before any goal integration code can be written, the bridge architecture must be designed.

- **Files to analyze:**
  - `packages/daemon/src/lib/room/managers/goal-manager.ts` -- `GoalManager` constructor: `(db, roomId, reactiveDb, shortIdAllocator?)`
  - `packages/daemon/src/storage/repositories/goal-repository.ts` -- all methods require `roomId` except `getGoalsForTask(taskId)` and `linkTaskToGoal(goalId, taskId)`
  - `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- `goalId` stored as nullable `goal_id` column
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- integration point at `handleSubSessionComplete()` line ~907
  - `packages/daemon/src/lib/room/managers/task-manager.ts` -- Room tasks are linked to goals via `GoalRepository.linkTaskToGoal()`, not via a `goalId` field on tasks

- **Design options to evaluate:**
  1. **(a) Space queries GoalRepository directly** -- Use `GoalRepository.getGoalsForTask(taskId)` to look up goals without needing `roomId`. Problem: Space tasks are not Room tasks, so `linkTaskToGoal` has never been called. The linkage would need to be established at workflow run creation time.
  2. **(b) Space instantiates GoalManager with resolved roomId** -- When a Space workflow run starts with a `goalId`, resolve the `roomId` from the `goals` table, then create a `GoalManager(roomId)`. Problem: `GoalManager.recalculateProgress()` iterates `goal.linkedTaskIds` which are Room task UUIDs, not Space task IDs.
  3. **(c) Space tracks its own progress** -- Add a `SpaceTaskProgress` table or extend the goals table with Space-specific task links. Most flexible but most work.
  4. **(d) Space stores roomId alongside goalId** -- Schema change on `space_workflow_runs` to add `room_id`. Then Space can instantiate `GoalManager(roomId)` and use its full API.

- **Key question to resolve:** How does `updateGoalsForTask()` work when the tasks are Space tasks, not Room tasks? The Room method calls `getGoalsForTask(taskId)` then `calculateProgressFromTasks(goal)` which iterates `goal.linkedTaskIds` and calls `taskRepo.getTask(taskId)`. Space tasks live in a different table (`space_tasks` vs `tasks`) with a different repository (`SpaceTaskRepository` vs `TaskRepository`).

- **Deliverable:** `docs/plans/space-goal-bridge-design.md` with: (a) recommended option, (b) schema changes, (c) API surface changes, (d) integration points, (e) backward compatibility analysis.

- **Acceptance Criteria:** Design document is approved with a clear recommendation.

### Task 2: Rate Limit Detection Pipeline for Space (Data Model Prerequisite)

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Fix the `VALID_SPACE_TASK_TRANSITIONS` map to allow rate limit transitions. This is a prerequisite for the full pipeline (which will be in a later milestone).

- **Files to modify:**
  - `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- line 26: add `'rate_limited'`, `'usage_limited'` to `in_progress` transitions

- **Specific change:**
  ```ts
  // Before:
  in_progress: ['review', 'completed', 'needs_attention', 'cancelled'],
  // After:
  in_progress: ['review', 'completed', 'needs_attention', 'cancelled', 'rate_limited', 'usage_limited'],
  ```

- **Edge cases:**
  - Existing unit tests that enumerate valid transitions must be updated.
  - The `setTaskStatus()` method's `options` parameter should be extended to accept `{ rateLimitInfo?: { resetsAt: number; sessionRole: string } }` for persisting backoff metadata.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-task-manager.test.ts` (create if needed)
  - Test scenarios: (a) `in_progress → rate_limited` is valid, (b) `in_progress → usage_limited` is valid, (c) all existing transitions still work, (d) invalid transitions still throw

- **Acceptance Criteria:** Transition map updated and tested. PR created.

### Task 8: Pending Run Rehydration Fix

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Handle `pending` workflow runs that were mid-creation during a daemon crash. `rehydrateExecutors()` in `space-runtime.ts` only loads runs with status `in_progress` or `needs_attention`.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `rehydrateExecutors()` method
  - `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- add `getRehydratablePendingRuns()` or modify `getRehydratableRuns()`

- **Implementation approach:**
  1. Modify `SpaceWorkflowRunRepository.getRehydratableRuns()` to also include `pending` runs that have existed for less than a configurable threshold (default 5 minutes).
  2. In `rehydrateExecutors()`, for `pending` runs: attempt to resume task creation by checking if the workflow run already has tasks in the `space_tasks` table. If yes, transition to `in_progress` and load executor. If no tasks exist after the threshold, transition to `cancelled`.
  3. Add a configuration option `SpaceRuntimeConfig.pendingRunTimeoutMs` (default 300_000).

- **Edge cases:**
  - Run was `pending` but has tasks (partial creation) -- resume as `in_progress`.
  - Run was `pending` with no tasks and just created (< 1 minute) -- keep as `pending`, retry on next tick.
  - Run was `pending` with no tasks and stale (> 5 minutes) -- cancel.
  - Multiple `pending` runs for the same workflow -- cancel duplicates, keep newest.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-runtime-rehydrate.test.ts` (create if needed)
  - Test scenarios: (a) pending run with tasks resumes, (b) stale pending run without tasks cancels, (c) fresh pending run without tasks stays pending, (d) multiple pending runs deduplicated

- **Acceptance Criteria:** Pending runs from crashed daemon instances are either recovered or cleaned up on next startup. Unit tests pass.

### Task 9: Validate Notification Dedup Restart Contract

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** The `notifiedTaskSet` in `SpaceRuntime` is intentionally in-memory only (documented restart contract at `space-runtime.ts:150-153`). This task validates that contract with tests.

- **Files to modify:**
  - `packages/daemon/tests/unit/space/space-runtime-notification-dedup.test.ts` (create)

- **Test scenarios:**
  1. Construct a new `SpaceRuntime` instance -- verify `notifiedTaskSet` is empty (the field is private, so test via behavior: a `needs_attention` task should trigger a notification on the first tick after "restart").
  2. Simulate restart scenario: create a runtime, add a `needs_attention` task to the DB, call `executeTick()`, verify `safeNotify` was called exactly once for that task.
  3. On second tick, verify the same task does NOT re-notify (dedup works).
  4. Verify that calling `setNotificationSink()` clears the dedup set.

- **Implementation notes:**
  - Follow the same test pattern as `packages/daemon/tests/unit/room/` tests: use a mock `NotificationSink` that records calls.
  - The `SpaceRuntime` constructor takes `SpaceRuntimeConfig`. For tests, provide a mock `SpaceManager` and `SpaceTaskRepository` that return fixture data.

- **Acceptance Criteria:** Unit tests confirm: (a) dedup set starts empty, (b) `needs_attention` tasks re-notify on first tick after restart, (c) subsequent ticks are deduped.

---

## Milestone 2: Runtime Reliability -- Error Detection + Dead Loops + Tick Persistence

**Goal:** Build the core runtime reliability features that prevent Space workflows from silently hanging or looping.

**Milestone Acceptance Criteria:**
- [ ] Space tasks automatically transition to `rate_limited` when API returns 429.
- [ ] Fallback model switching works for Space sessions.
- [ ] Tasks resume after rate limit backoff expires.
- [ ] Dead loop detection catches condition gate bounce loops.
- [ ] Space ticks are persistent across daemon restarts via JobQueue.
- [ ] Event-driven tick wake-up reduces reaction latency.

### Task 3: Dead Loop Detection for Space Workflow Gates

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Port dead loop detection from Room to Space. Track condition gate failures per workflow run, detect repeated failures with similar reasons.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/dead-loop-detector.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `processRunTick()` where `WorkflowTransitionError` is caught

- **Interface design** (adapted from Room's `DeadLoopDetector`):
  ```ts
  interface SpaceGateFailureRecord {
    workflowRunId: string;
    stepNodeId: string;
    reason: string;
    timestamp: number;
  }

  interface SpaceDeadLoopConfig {
    maxFailures: number;          // default: 5
    rapidFailureWindow: number;   // default: 5 * 60 * 1000 (5 min)
    reasonSimilarityThreshold: number; // default: 0.75
  }

  function checkSpaceDeadLoop(
    failures: SpaceGateFailureRecord[],
    config?: SpaceDeadLoopConfig
  ): { isDeadLoop: boolean; reason: string; failureCount: number; gateName: string } | null;
  ```

- **Implementation approach:**
  1. Reuse Room's Levenshtein similarity algorithm from `room/runtime/dead-loop-detector.ts`. Extract to a shared utility or import directly (both are in the same monorepo package).
  2. Store gate failure history in `SpaceWorkflowRunRepository` via the `config` JSON column on `space_workflow_runs` (key: `gateFailures`). This avoids schema migrations.
  3. In `SpaceRuntime.processRunTick()`, when a `WorkflowTransitionError` is caught (the block that currently emits `workflow_run_needs_attention`), record the failure and check for dead loops before emitting the notification.
  4. On dead loop detection: fail the workflow run with status `needs_attention`, emit a diagnostic `workflow_run_completed` event with a clear message.

- **Integration point:** `space-runtime.ts`, in `processRunTick()` around the `WorkflowTransitionError` catch block (currently at approximately line 770). The error's `message` property contains the gate failure reason.

- **Edge cases:**
  - Failures across different gates should NOT be counted together (filter by `stepNodeId`).
  - Similarity threshold prevents counting genuinely different failures as a loop.
  - Race condition: two ticks processing the same run simultaneously. Mitigation: use the run's `updated_at` timestamp as an optimistic lock.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/dead-loop-detector.test.ts`
  - Test scenarios: (a) < threshold failures → no dead loop, (b) >= threshold failures with high similarity → dead loop detected, (c) >= threshold failures with low similarity → no dead loop (different issues), (d) diagnostic message format verification, (e) failures across different gates are independent

- **Acceptance Criteria:** Workflow runs that bounce ≥5 times on the same condition gate within 5 minutes (Levenshtein similarity ≥0.75) are detected and failed with a diagnostic message containing the gate name, bounce count, and last failure reason.

### Task 7: JobQueue Integration for Space Tick Loop

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Replace Space's `setInterval`-based tick loop with the persistent JobQueue system.

- **Files to create:**
  - `packages/daemon/src/lib/job-handlers/space-tick.handler.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/job-queue-constants.ts` -- add `SPACE_TICK = 'space.tick'`
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `start()` and `stop()` methods, add `scheduleImmediateTick()` method
  - `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` -- handler registration, config interface, `start()` method
  - `packages/daemon/src/lib/rpc-handlers/index.ts` -- bootstrap seeding

- **Implementation approach:**
  1. **Config interface change** -- Add `jobQueue` and `jobProcessor` to `SpaceRuntimeServiceConfig` (at `space-runtime-service.ts:25`). Currently the interface has `db`, `spaceManager`, `spaceAgentManager`, `spaceWorkflowManager`, `workflowRunRepo`, `taskRepo`, `taskAgentManager?`, `tickIntervalMs?`, `notificationSink?`. Add:
     ```ts
     export interface SpaceRuntimeServiceConfig {
       // ... existing fields ...
       jobQueue?: JobQueueRepository;       // NEW: for persistent tick scheduling
       jobProcessor?: JobQueueProcessor;     // NEW: for handler registration
     }
     ```
     Both fields are optional to maintain backward compatibility during migration. The `start()` method should only register the JobQueue handler when `jobQueue` and `jobProcessor` are provided.
  2. **Handler pattern** -- Follow `packages/daemon/src/lib/job-handlers/room-tick.handler.ts` exactly:
     ```ts
     // space-tick.handler.ts
     export const DEFAULT_SPACE_TICK_INTERVAL_MS = 10_000; // 10s (Space uses faster ticks than Room's 30s)

     export function enqueueSpaceTick(
       spaceId: string,
       jobQueue: JobQueueRepository,
       delayMs: number = DEFAULT_SPACE_TICK_INTERVAL_MS
     ): void;
     // Maintains at most one pending tick per space.

     export function cancelPendingSpaceTickJobs(
       spaceId: string,
       jobQueue: JobQueueRepository
     ): void;

     export function createSpaceTickHandler(
       getRuntime: () => SpaceRuntime | null,
       jobQueue: JobQueueRepository,
       tickIntervalMs: number = DEFAULT_SPACE_TICK_INTERVAL_MS
     ): JobHandler;
     ```
  2. **Registration** -- In `SpaceRuntimeService.start()`, register the handler:
     ```ts
     this.jobProcessor.register(SPACE_TICK, createSpaceTickHandler(
       () => this.spaceRuntime,
       this.jobQueue
     ));
     ```
  3. **Replace setInterval** -- In `SpaceRuntime.start()`, replace the `setInterval` with a single `enqueueSpaceTick()` call. The handler's re-enqueue loop replaces the polling loop.
  4. **Event-driven wake-up** -- Add a `scheduleImmediateTick()` method that enqueues a tick with `delayMs: 0`. Call this from:
     - `SpaceTaskManager.setTaskStatus()` (via a callback in `SpaceRuntimeConfig`)
     - `SpaceWorkflowRunRepository.updateStatus()` (via a callback)
     - Human gate resolution in `WorkflowExecutor`
  5. **Bootstrap seeding** -- In `rpc-handlers/index.ts`, seed ticks for all active spaces on startup, subscribe to `space.created` for new spaces.

- **Edge cases:**
  - SpaceRuntime is shared (one instance for all spaces). The tick handler calls `runtime.executeTick()` which processes ALL spaces. Per-space isolation comes from the JobQueue job key (each space gets its own pending job).
  - If SpaceRuntime is null (not yet initialized), the handler should re-enqueue with a retry delay.
  - On shutdown, call `cancelPendingSpaceTickJobs()` for all active spaces.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-tick-handler.test.ts`
  - Test scenarios: (a) handler enqueues next tick after execution, (b) at most one pending tick per space, (c) cancel removes pending ticks, (d) handler re-enqueues when runtime is null (retry), (e) tick fires across simulated restart (Job is persistent in DB)

- **Acceptance Criteria:** (a) Space ticks are persistent across daemon restarts. (b) Event-driven wake-up reduces reaction latency from 5s to near-immediate. (c) Per-space job isolation. (d) Unit tests pass.

---

## Milestone 3: Goal Integration + Human-in-the-Loop UI

**Goal:** Wire Space task completion to goal progress and build the human review UI.

**Milestone Acceptance Criteria:**
- [ ] Completing a Space task with a `goalId` updates Room goal progress.
- [ ] `GoalsEditor` UI reflects Space task contributions.
- [ ] Space tasks in `review` status show approve/reject controls.
- [ ] Approving completes the task; rejecting sets it to `needs_attention`.
- [ ] Users can view Space task conversation history.

### Task 1: Wire Space Task Completion to Goal Progress Tracking

- **Priority:** CRITICAL
- **Agent Type:** coder
- **Dependencies:** Task 0 (design approved)
- **Description:** Implement the bridge between Space task completion and Room's GoalManager, following the design from Task 0.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- `handleSubSessionComplete()` at line ~907
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `SpaceRuntimeConfig` interface
  - Possibly: `packages/daemon/src/storage/repositories/goal-repository.ts` -- if new cross-system query methods are needed

- **Implementation approach** (will be refined based on Task 0 design):
  1. Add a goal integration callback to `SpaceRuntimeConfig` or `TaskAgentManagerConfig`:
     ```ts
     onTaskGoalProgressUpdate?: (taskId: string, goalId: string) => Promise<void>;
     ```
  2. In `handleSubSessionComplete()`, after `taskManager.setTaskStatus(stepTask.id, 'completed')` succeeds:
     - Look up the workflow run to get `goalId`.
     - If `goalId` exists, call `onTaskGoalProgressUpdate(taskId, goalId)`.
  3. The callback implementation (in `SpaceRuntimeService` or `rpc-handlers/index.ts`) will:
     - Resolve the goal from the `goals` table using `GoalRepository`.
     - Recalculate progress using the design's chosen mechanism.
     - Emit `goal.progressUpdated` DaemonHub event.
  4. Also emit `goal.progressUpdated` in `space-task-handlers.ts` when `spaceTask.update` transitions a task to `completed`.

- **Edge cases:**
  - Task has no `goalId` -- skip silently.
  - Goal has been deleted since the workflow run started -- handle gracefully (goal lookup returns null, log warning, skip).
  - Goal belongs to a different room than expected -- depends on Task 0 design.
  - Multiple tasks completing simultaneously -- each should trigger independent progress updates.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/task-agent-goal-bridge.test.ts` (create)
  - Test scenarios: (a) completing a task with goalId triggers progress update, (b) completing a task without goalId skips, (c) deleted goal is handled gracefully, (d) goal.progressUpdated event is emitted

- **Acceptance Criteria:** Space tasks with `goalId` update Room goal progress when completed. `GoalsEditor` reflects Space task contributions.

### Task 4: Human Review UI for Space Tasks

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Create approve/reject UI controls for Space tasks in `review` status.

- **Files to create:**
  - `packages/web/src/components/space/SpaceTaskReviewBar.tsx`

- **Files to modify:**
  - `packages/web/src/components/space/SpaceTaskPane.tsx` -- integrate review bar when task status is `review`

- **Implementation approach:**
  1. **Follow the pattern of Room's `HeaderReviewBar.tsx`** but adapted for Space:
     ```tsx
     interface SpaceTaskReviewBarProps {
       spaceId: string;
       taskId: string;
       task?: SpaceTask | null;
       onApproved: () => void;
       onRejected: () => void;
     }
     ```
  2. **Approve action:** Call `spaceStore.updateTask(taskId, { status: 'completed' })`.
  3. **Reject action:** Open a `RejectModal` with textarea, then call `spaceStore.updateTask(taskId, { status: 'needs_attention', error: feedback })`.
  4. **PR link display:** Show `task.prUrl` if present (same as Room's pattern).
  5. **Integration:** In `SpaceTaskPane.tsx`, when `task.status === 'review'`, render `SpaceTaskReviewBar` above the task details.

- **Implementation notes:**
  - Use the existing `ActionBar` component from `packages/web/src/components/shared/` with `type="review"` (same as Room).
  - Use `useMessageHub()` hook for the request calls, or delegate to `spaceStore.updateTask()`.
  - Follow Room's error display pattern (red banner below the bar).

- **Edge cases:**
  - Task transitions away from `review` while user is viewing -- hide the bar, no action needed.
  - Network error on approve/reject -- show error banner, keep bar visible.

- **Testing:**
  - Unit test: Verify the component renders approve/reject buttons when status is `review`.
  - E2E test file: `packages/e2e/tests/features/space-task-review.e2e.ts` (create)
  - E2E scenario: create space → create task → transition to review via RPC → verify review bar is visible → click approve → verify task is completed.

- **Acceptance Criteria:** Space tasks in `review` status show approve/reject controls. Approve completes; reject sets to `needs_attention`.

### Task 5: Space Task Detail/Conversation View

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Create a conversation view for Space task sessions.

- **Files to create:**
  - `packages/web/src/components/space/SpaceTaskDetail.tsx`
  - `packages/web/src/hooks/useSpaceTaskMessages.ts`

- **Files to modify:**
  - `packages/web/src/components/space/SpaceTaskPane.tsx` -- add navigation to detail view
  - `packages/web/src/lib/space-store.ts` -- add `getTaskSessionGroups()` action

- **Implementation approach:**
  1. **Data loading hook** `useSpaceTaskMessages(spaceId, taskId)`:
     - Call `space.sessionGroup.list` RPC with filter by `taskId` (via `spaceStore`).
     - For each session group, get member sessions.
     - Use LiveQuery to stream messages for each session (follow `useGroupMessages()` pattern from Room).
     - Convert messages to turn blocks via `useTurnBlocks()` (from `packages/web/src/hooks/`).
  2. **SpaceTaskDetail component:**
     ```tsx
     interface SpaceTaskDetailProps {
       spaceId: string;
       taskId: string;
     }
     ```
     Render: task header (title, status, priority), agent list with status badges, conversation turns (reuse `AgentTurnBlock` from `packages/web/src/components/room/`), task info sidebar (metadata, error, result).
  3. **Navigation:** In `SpaceTaskPane.tsx`, add a "View Conversation" button that sets a route state to open `SpaceTaskDetail` in a slide-out panel or full view.

- **Implementation notes:**
  - Reuse existing components: `AgentTurnBlock`, `RuntimeMessageRenderer`, `SlideOutPanel` from `packages/web/src/components/room/`.
  - Follow Room's LiveQuery pattern: subscribe to `sessionGroupMessages.byGroup` named query with snapshot + delta handling.

- **Edge cases:**
  - Task has no session groups (not yet spawned) -- show empty state "Waiting for agent to start..."
  - Multiple session groups (sub-sessions for different steps) -- show tabs or merged view.

- **Testing:**
  - Unit test: `useSpaceTaskMessages` hook with mock data.
  - E2E test file: `packages/e2e/tests/features/space-task-detail.e2e.ts` (create)
  - E2E scenario: navigate to space task → verify conversation view loads → verify turn blocks render.

- **Acceptance Criteria:** Users can click a Space task and see its full conversation history with agent turns rendered.

### Task 11: DaemonHub Event Emission for Space Goal Progress

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 1
- **Description:** Emit `goal.progressUpdated` DaemonHub events when Space task completion triggers goal update, so the frontend updates in real time.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- emit event in goal callback
  - `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` -- emit event on status transition to completed
  - `packages/web/src/lib/room-store.ts` -- ensure `goal.progressUpdated` events are subscribed (may already be via Room channel)

- **Implementation approach:**
  1. In the goal progress callback (wired in Task 1), after recalculation, emit:
     ```ts
     daemonHub.emit('goal.progressUpdated', {
       sessionId: 'global',
       goalId,
       goal: updatedGoal,
     });
     ```
  2. In `space-task-handlers.ts`, in the `spaceTask.update` handler, when status transitions to `completed` and the task has a `goalId`, emit the same event.

- **Testing:**
  - Unit test: verify event emission with correct payload on task completion.
  - Test file: extend `packages/daemon/tests/unit/space/task-agent-goal-bridge.test.ts`

- **Acceptance Criteria:** Goal progress updates from Space task completions are emitted as DaemonHub events.

---

## Milestone 4: Lifecycle Hooks + Advanced Runtime

**Goal:** Implement the lifecycle hook framework for Space, enabling deterministic validation of agent outputs.

**Milestone Acceptance Criteria:**
- [ ] Design document for lifecycle hook architecture is approved.
- [ ] Space step agents are bounced when they exit without creating a PR.
- [ ] Workflow transitions are blocked when advance hooks fail.
- [ ] Bypass markers allow skipping hooks for research tasks.

### Task 6a: Design Space Lifecycle Hook Architecture

- **Priority:** HIGH
- **Agent Type:** general
- **Dependencies:** Task 3 (dead loop detection)
- **Description:** Room's lifecycle hooks are deeply coupled to the Worker/Leader session group model. Space uses a fundamentally different model. This task produces a design document.

- **Files to analyze:**
  - `packages/daemon/src/lib/room/runtime/lifecycle-hooks.ts` -- all hook functions, `HookResult`, `WorkerExitHookContext`, `LeaderCompleteHookContext`, bypass markers
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- `handleSubSessionComplete()` (exit hooks integration point)
  - `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- `advance()` (advance hooks integration point)
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `processRunTick()` (run-level hooks)

- **Key architectural questions:**
  1. **Exit hooks** fire in `TaskAgentManager.handleSubSessionComplete()` after `setTaskStatus(stepTask.id, 'completed')`. If a hook fails, should we: (a) revert the status back to `in_progress`, or (b) prevent the completion in the first place by running hooks BEFORE `setTaskStatus`? Room runs hooks AFTER worker completes but BEFORE routing to leader.
  2. **Advance hooks** fire in `WorkflowExecutor.advance()` before the transition is committed. This is straightforward -- throw `WorkflowGateError` to block.
  3. **Shared workspace concurrency**: Multiple step agents may be creating PRs on the same repo simultaneously. Room avoids this with per-task worktrees. Space needs: (a) branch name coordination (prefix with task ID), or (b) locking, or (c) accept that PR creation may conflict and let agents retry.
  4. **Configuration surface**: Hooks should be configurable per-workflow-node (different steps may have different requirements). Default hooks should apply to all coding tasks.

- **Deliverable:** `docs/plans/space-lifecycle-hooks-design.md`

- **Acceptance Criteria:** Design document with: (a) hook-to-Space mapping table, (b) concurrency strategy, (c) configuration surface, (d) integration points, (e) implementation plan.

### Task 6b: Implement Core Space Exit Hooks

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 6a, Task 3
- **Description:** Implement core exit hooks based on Task 6a's design.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/space-lifecycle-hooks.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- integrate hook runner

- **Interface design** (adapted from Room):
  ```ts
  interface SpaceHookResult {
    pass: boolean;
    bypassed?: boolean;
    reason?: string;
    bounceMessage?: string;
  }

  interface SpaceExitHookContext {
    workspacePath: string;
    taskId: string;
    stepNodeId: string;
    agentOutput?: string;
    workflowNodeId?: string;
  }

  // Core hooks to implement:
  async function checkSpaceNotOnBaseBranch(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;
  async function checkSpacePrExists(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;
  async function checkSpacePrSynced(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;

  // Gate runner:
  async function runSpaceExitGate(ctx: SpaceExitHookContext, opts?: HookOptions): Promise<SpaceHookResult>;
  ```

- **Integration in `handleSubSessionComplete()`:**
  ```ts
  // After setTaskStatus succeeds, BEFORE notifying Task Agent:
  const hookResult = await runSpaceExitGate({ workspacePath, taskId, stepId, agentOutput });
  if (!hookResult.pass && hookResult.bounceMessage) {
    await taskManager.setTaskStatus(stepTask.id, 'in_progress', { error: hookResult.bounceMessage });
    // Inject bounce message into sub-session
    return;
  }
  ```

- **Edge cases:**
  - Hook function throws an exception -- catch, log, and bounce with a generic message.
  - Git/gh CLI not available -- hooks should gracefully fail and bounce with installation instructions.
  - Shared workspace: another agent modified the branch between hook check and action.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-lifecycle-hooks.test.ts`
  - Test scenarios: (a) pass when on feature branch, (b) bounce when on base branch, (c) pass when PR exists, (d) bounce when no PR, (e) pass when PR synced, (f) bounce when PR behind, (g) bypass markers skip hooks

- **Acceptance Criteria:** Space step agents that complete without creating a PR are bounced with a clear diagnostic.

### Task 6c: Implement Space Advance Hooks and Bypass Markers

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 6a, Task 6b
- **Description:** Implement advance hooks and bypass markers based on Task 6a's design.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-lifecycle-hooks.ts` -- add advance hooks
  - `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- integrate into `advance()`

- **Hooks to implement:**
  ```ts
  async function checkSpacePrMerged(ctx, opts?): Promise<SpaceHookResult>;
  async function checkSpacePrIsMergeable(ctx, opts?): Promise<SpaceHookResult>;
  async function checkSpacePrHasReviews(ctx, opts?): Promise<SpaceHookResult>;
  async function runSpaceAdvanceGate(ctx, opts?): Promise<SpaceHookResult>;
  ```

- **Bypass markers:** Reuse Room's `BYPASS_GATES_MARKERS` constants (`RESEARCH_ONLY:`, `VERIFICATION_COMPLETE:`, etc.). Detect markers in the agent's output text (first/last N characters).

- **Integration in `WorkflowExecutor.advance()`:**
  ```ts
  // Before committing the transition:
  const hookResult = await this.runAdvanceHooks?.(context);
  if (hookResult && !hookResult.pass) {
    throw new WorkflowGateError(hookResult.reason ?? 'Advance blocked by hook');
  }
  ```

- **Stale PR cleanup:** Port `closeStalePr()` from Room. Call when a new PR is detected for a task that already had a PR (different PR URL).

- **Testing:**
  - Extend `packages/daemon/tests/unit/space/space-lifecycle-hooks.test.ts`
  - Test scenarios: (a) advance blocked when PR not merged, (b) advance allowed when PR merged, (c) advance blocked when PR has conflicts, (d) bypass markers skip hooks, (e) stale PR closed when new PR created

- **Acceptance Criteria:** Workflow transitions blocked by advance hooks. Bypass markers work.

---

## Milestone 5: Rate Limit Full Pipeline + Human Message Routing

**Goal:** Complete the rate limit error detection pipeline and enable human message routing to step agents.

**Milestone Acceptance Criteria:**
- [ ] Full error classification pipeline watches for API errors in Space sessions.
- [ ] Automatic rate limit detection with status transition and backoff.
- [ ] Fallback model switching works.
- [ ] Deferred resume after backoff.
- [ ] Humans can route messages to specific Space step agent sessions.

### Task 2-Full: Rate Limit Detection Full Pipeline

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 2 (Milestone 1 -- transition map fixed)
- **Description:** Build the full error classification, model fallback, and deferred resume pipeline for Space. The transition map prerequisite was fixed in Milestone 1.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/space-error-classifier.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- error subscription and handling
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- deferred resume scheduling

- **Implementation approach:**
  1. **Create `SpaceErrorClassifier`** -- Import and reuse Room's `classifyError()` and `parseRateLimitReset()` from `room/runtime/error-classifier.ts` and `room/runtime/rate-limit-utils.ts`. No extraction needed -- direct imports within the same package.
     ```ts
     // space-error-classifier.ts
     import { classifyError, ErrorClassification } from '../room/runtime/error-classifier';
     import { createRateLimitBackoff, parseRateLimitReset } from '../room/runtime/rate-limit-utils';

     export function classifySpaceError(message: string): ErrorClassification | null {
       return classifyError(message);
     }
     ```
  2. **Error detection in TaskAgentManager** -- Subscribe to session error events. Room does this inline in `onWorkerTerminalState`. For Space, the equivalent is detecting errors in step agent sessions. Options:
     - (a) Subscribe to `session.updated` events for terminal states, then classify the session's last output.
     - (b) Use SDK message mirroring (not currently implemented for Space).
     - Recommended: (a) -- use the existing `DaemonHub` event `session.updated` with a terminal status filter.
  3. **Rate limit handling** (follow Room's pattern from `room-runtime.ts` lines ~690-770):
     ```ts
     if (errorClass.class === 'rate_limit') {
       await taskManager.setTaskStatus(taskId, 'rate_limited', {
         error: `Rate limited. Resets at ${new Date(errorClass.resetsAt!).toISOString()}`
       });
       // Attempt model fallback
       await trySwitchToFallbackModel(sessionId);
       // Schedule deferred resume
       const delayMs = Math.max(0, (errorClass.resetsAt! - Date.now()) + 5000);
       scheduleImmediateTick(delayMs); // from Task 7
     }
     ```
  4. **Model fallback** -- Read `settings.fallbackModels` from `GlobalSettings`. Walk the fallback chain: get current model → find next in chain → call `messageHub.request('session.model.switch', { sessionId, model, provider })`. Follow Room's `trySwitchToFallbackModel()` pattern exactly.
  5. **Deferred resume** -- After the backoff expires, transition the task back to `in_progress`. This requires a timed callback. If Task 7 (JobQueue) is done, use `enqueueSpaceTick(spaceId, jobQueue, delayMs)`. If not, use a `setTimeout` with cleanup on shutdown.

- **Edge cases:**
  - Fallback chain exhausted -- set task to `needs_attention` with error "All fallback models exhausted".
  - Backoff time in the past (already expired) -- resume immediately.
  - Multiple sessions in the same task hitting rate limits -- debounce, only handle the first.
  - `usage_limit` (not 429) -- no backoff, attempt fallback immediately.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-error-classifier.test.ts`
  - Test scenarios: (a) classify 429 as rate_limit, (b) classify 400 as terminal, (c) classify 500 as recoverable, (d) parse rate limit reset time, (e) model fallback chain walks correctly, (f) exhausted fallback chain sets needs_attention
  - Online test file: `packages/daemon/tests/online/space/space-rate-limit.test.ts` (create)
  - Online scenario: Use dev proxy to mock a 429 response, verify task transitions to rate_limited and resumes after backoff.

- **Acceptance Criteria:** Space tasks auto-transition to `rate_limited` on 429. Fallback works. Tasks resume after backoff.

### Task 10: Human Message Routing to Space Step Agents

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 4
- **Description:** Add RPC handler for routing human messages to Space step agent sessions.

- **Files to modify:**
  - `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts` -- add inject handler (file already exists)
  - `packages/daemon/src/lib/rpc-handlers/index.ts` -- register new handler

- **New RPC methods:**
  ```ts
  // space.task-message.inject
  // Params: { spaceId: string, taskId: string, sessionId: string, message: string }
  // Action: Validates session belongs to Space task, injects message via TaskAgentManager
  ```

- **Implementation approach:**
  1. Add `spaceTaskMessage.inject` handler in `space-task-message-handlers.ts`.
  2. Validation: Look up the session via `SpaceSessionGroupRepository.getGroupsByTask(spaceId, taskId)`, verify the `sessionId` is a member of one of the task's groups.
  3. Injection: Call `taskAgentManager.injectSubSessionMessage(sessionId, message)`.
  4. Session discovery: Add `space.task.sessions` RPC that returns session groups for a task (or reuse existing `space.sessionGroup.list` with a task filter).

- **Edge cases:**
  - Session is not found or doesn't belong to the task -- return error.
  - Session is in a terminal state (completed/failed) -- return error.
  - Task Agent is not running -- return error.

- **Testing:**
  - Unit test: verify handler validation rejects invalid session IDs, accepts valid ones.
  - Test file: `packages/daemon/tests/unit/space/space-task-message-handler.test.ts`

- **Acceptance Criteria:** Humans can send messages to Space step agent sessions via RPC. Handler validates session ownership.

---

## Milestone 6: Cron Scheduling + Goal UI + Dashboard

**Goal:** Add recurring workflow scheduling and complete the Space UI with goal management and dashboard views.

**Milestone Acceptance Criteria:**
- [ ] Space workflows with a `schedule` field auto-start new runs at configured intervals.
- [ ] Users can create and manage goals from the Space UI.
- [ ] Space dashboard shows goal progress, active workflow runs, and task status.

### Task 12: Cron Scheduling for Recurring Space Workflows

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 7 (JobQueue)
- **Description:** Add cron-based scheduling for recurring Space workflows.

- **Files to modify:**
  - `packages/daemon/src/storage/repositories/space-workflow-repository.ts` -- add schedule fields
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- add schedule check in tick
  - Database migration: add `schedule TEXT` and `next_run_at INTEGER` columns to `space_workflows` table

- **Implementation approach:**
  1. **Schema migration:** Add `schedule` (JSON: `{ expression: string; timezone: string }`) and `next_run_at` (Unix seconds) to `space_workflows`.
  2. **Next-run computation:** Reuse `packages/daemon/src/lib/room/runtime/cron-utils.ts` directly:
     ```ts
     import { getNextRunAt, isValidCronExpression } from '../room/runtime/cron-utils';
     ```
  3. **Tick handler:** In `SpaceRuntime.executeTick()`, add a `processScheduledWorkflows()` step that:
     - Lists workflows with `next_run_at <= now` and `schedule != null`.
     - For each due workflow, starts a new run via `startWorkflowRun()`.
     - Computes and persists the next `next_run_at`.
  4. **Catch-up detection:** If `next_run_at` is in the past by more than one interval, only start ONE run (not backfill missed runs). This follows Room's approach.

- **Edge cases:**
  - Invalid cron expression -- validate on save, reject with clear error.
  - Timezone changes -- recompute `next_run_at` when timezone is updated.
  - Workflow deleted while scheduled -- cleanup in tick handler.
  - Space archived -- skip all scheduled workflows for archived spaces.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-cron-scheduling.test.ts`
  - Test scenarios: (a) valid cron creates run at correct time, (b) catch-up starts only one run, (c) archived space skips, (d) deleted workflow cleaned up

- **Acceptance Criteria:** Scheduled Space workflows auto-start new runs at configured intervals.

### Task 13: Goal Creation UI for Space

- **Priority:** LOW
- **Agent Type:** coder
- **Dependencies:** Task 1
- **Description:** Create a goal/mission creation wizard for Space.

- **Files to create:**
  - `packages/web/src/components/space/SpaceGoalsEditor.tsx`

- **Files to modify:**
  - `packages/web/src/lib/space-store.ts` -- add goal-related actions
  - `packages/web/src/components/space/SpaceTaskPane.tsx` or a parent layout -- integrate GoalsEditor

- **Implementation approach:**
  1. **Follow Room's `GoalsEditor.tsx` pattern** but simplify for Space context:
     ```tsx
     interface SpaceGoalsEditorProps {
       spaceId: string;
       goals: RoomGoal[];
       tasks?: SpaceTask[];
     }
     ```
  2. Reuse the same `goal.create`, `goal.list`, `goal.update`, `goal.delete` RPC handlers (they are Room-scoped but the Space context would need to know which `roomId` to use -- this depends on Task 0's design).
  3. If Task 0's design introduces Space-specific goal RPCs, use those instead.

- **Edge cases:**
  - No Room associated with the Space -- show message "Associate a Room to create goals" (depends on Task 0 design).
  - Goal created from Room but visible in Space -- show read-only or editable depending on design.

- **Testing:**
  - E2E test: goal creation wizard flow in Space context.
  - E2E test file: `packages/e2e/tests/features/space-goals-editor.e2e.ts`

- **Acceptance Criteria:** Users can create and manage goals from the Space UI.

### Task 14: Enhance Existing Space Dashboard with Goal/Task Overview

- **Priority:** LOW
- **Agent Type:** coder
- **Dependencies:** Task 1, Task 13
- **Description:** Enhance the existing `SpaceDashboard.tsx` (already shows space overview, active run progress, and quick-action cards) with goal progress, task status summary, and recent activity feed.

- **Files to modify:**
  - `packages/web/src/components/space/SpaceDashboard.tsx` -- add goal progress section, task status counts, activity feed
  - `packages/web/src/lib/space-store.ts` -- add goal-related computed signals if needed

- **Implementation approach:**
  1. **Goal progress section** -- Add a collapsible "Mission Progress" panel below the existing quick-action cards. Reuse the progress bar component from `GoalsEditor.tsx` (or extract to a shared component). Show each active goal with its title, progress percentage bar, and linked Space task count.
  2. **Task status summary** -- Add a task status breakdown row (in_progress: N, needs_attention: N, completed: N) using `spaceStore.activeTasks`, `spaceStore.standaloneTasks` computed signals.
  3. **Recent activity feed** -- Add a compact activity feed showing the last 10 task status changes (completed, failed, needs_attention). Source from `spaceStore.tasks` sorted by `updatedAt` descending.
  4. **Conditional rendering** -- Only show the goal section when `Task 1` integration is available (goals exist for the space's associated room). Show a placeholder "Associate a Room to track mission progress" if no goals.

- **Edge cases:**
  - Space has no associated room/goals -- show informative placeholder, not an empty section.
  - Large number of goals -- show top 3 with "Show all" link to GoalsEditor.
  - Dashboard already has substantial content -- new sections should be collapsible to avoid overwhelming the view.

- **Testing:**
  - Unit test: verify goal progress section renders when goals exist, hides when no goals.
  - Test file: `packages/web/tests/space/SpaceDashboard.test.ts` (create or extend)

- **Acceptance Criteria:** Users can see at a glance the status of all goals, workflows, and tasks within a Space. Goal progress, task counts, and recent activity are visible on the existing dashboard.

---

## Summary Gap Scores

| # | Dimension | Parity | Priority | Room Has | Space Has | Key Gap |
|---|-----------|--------|----------|----------|-----------|---------|
| 1 | Goal/Mission integration | 15% | CRITICAL | Full GoalManager with metrics, cron, executions | Passive goalId only | No active integration |
| 2 | Error detection and recovery | 50% | HIGH | classifyError + fallback + backoff + transition map | Status types + outbound transitions only | No inbound transitions, no runtime detection |
| 3 | Dead loop detection | 0% | HIGH | Levenshtein-based gate analysis | None | No detection mechanism |
| 4 | Lifecycle hooks | 0% | HIGH | WorkerExit + LeaderSubmit + LeaderComplete gates | Declarative conditions only | No structured gate framework |
| 5 | Human-in-the-loop | 55% | HIGH | ReviewBar + message routing + question answering | request_human_input + human gates | No review UI, no direct routing |
| 6 | Tick persistence | 30% | HIGH | JobQueue + event-driven wake-up | setInterval only | No persistent scheduling |
| 7 | UI task management | 50% | HIGH | Full task list + detail + review + goals | Basic task pane + workflow editor | Missing detail view, review UI, goals |
| 8 | Persistence/recovery | 70% | MEDIUM | Full recovery + mirroring + MCP reattach | Task Agent rehydrate only | Pending runs, no mirroring |
| 9 | Event handling | 65% | MEDIUM | DaemonHub emit + subscribe | NotificationSink pattern | No real-time task updates |
| 10 | Inter-agent messaging | 95% | LOW | Fixed Worker-Leader routing | ChannelResolver + send_message | Minor: no answerQuestion |
| 11 | Worktree isolation | N/A | DESIGN | Per-task worktrees | Shared workspace | Intentional design difference |

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
