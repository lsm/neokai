# Comprehensive Space System Review: Gap Analysis vs Room Feature Parity

## Executive Summary

The Space system is a workflow-graph-based multi-agent orchestration engine that surpasses the Room system in visual workflow authoring, multi-agent parallelism, and channel topology flexibility. However, the Space system has significant gaps in goal/mission integration, runtime reliability (rate limit detection, dead loop detection, lifecycle hooks), tick persistence (JobQueue), UI task management views, and cron scheduling. This document provides a concrete, prioritized list of missing pieces with implementation tasks.

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
- `goalId` field on `SpaceTask` and `SpaceWorkflowRun` -- passive metadata only.
- `findByGoalId()` query in `SpaceTaskRepository`.
- No import or reference to `GoalManager` anywhere in the Space module.

**Missing:**
1. Space task completion does NOT trigger goal progress recalculation.
2. No mission type support for Space workflows (no `one_shot`/`measurable`/`recurring` distinction).
3. No `structuredMetrics` on Space tasks.
4. No `mission_executions` tracking for Space workflow runs (Space has its own `space_workflow_runs` table but no linkage to Room's `mission_executions`).
5. No cron scheduling for recurring Space workflows.
6. No `consecutiveFailures` or auto-retry logic in Space.
7. No autonomy level enforcement (Space has `autonomyLevel` on the Space entity but no runtime enforcement).

**Impact:** Without goal integration, Space workflows operate in a vacuum. There is no way to track whether workflow runs contribute to overarching objectives, and recurring workflows cannot be scheduled automatically.

### 2. Runtime Error Detection and Recovery (Parity: 50%) -- HIGH

**What Room has:**
- `classifyError()` -- 4-class taxonomy (terminal/rate_limit/usage_limit/recoverable) parsing SDK "API Error: NNN" messages.
- `detectTerminalError()` -- immediate task failure on 4xx errors.
- `trySwitchToFallbackModel()` -- automatic model fallback on rate_limit/usage_limit using `GlobalSettings.fallbackModels` chain.
- `createRateLimitBackoff()` -- exponential backoff with parsed `retry-after` timestamps.
- `onAgentRateLimited()` -- runtime method that transitions task to `rate_limited`, creates backoff entry, attempts model fallback, schedules deferred resume.

**What Space has:**
- `rate_limited` and `usage_limited` statuses in `SpaceTaskStatus` type.
- Valid transitions back from `rate_limited`/`usage_limited` to `in_progress`.
- `WorkflowTransitionError` and `WorkflowGateError` for workflow-level errors.
- `error` field on `SpaceTask` persisted to DB.

**Missing:**
1. No `classifyError()` equivalent -- no runtime pipeline that watches for "API Error: NNN" in agent output and classifies it.
2. No `trySwitchToFallbackModel()` -- no automatic model fallback when rate limits are hit.
3. No `createRateLimitBackoff()` -- no exponential backoff with parsed retry-after timestamps.
4. No automatic transition to `rate_limited`/`usage_limited` status when API errors are detected. The statuses exist in the type but nothing writes them.
5. No deferred resume after backoff expires -- tasks that hit rate limits will stay stuck until manual intervention.

**Impact:** Space agents hit rate limits and freeze. The status types exist but no runtime code populates them. This is a critical reliability gap for any extended autonomous operation.

### 3. Dead Loop Detection (Parity: 0%) -- HIGH

**What Room has:**
- `DeadLoopDetector` with configurable `maxFailures`, `rapidFailureWindow`, `reasonSimilarityThreshold`.
- Count-based detection: same gate fails N times within the time window.
- Similarity-based detection: uses Levenshtein distance to avoid counting distinct issues as a loop.
- `recordAndCheckDeadLoop()` in RoomRuntime: records gate failure, checks for loop, fails task with diagnostic message.
- Gate failure history persisted in `SessionGroupRepository` (per-group metadata).

**What Space has:**
- `maxIterations` cap on cyclic edges in `WorkflowExecutor` -- prevents infinite cycling but only for cyclic transitions.
- No gate failure tracking or similarity analysis.

**Missing:**
1. No dead loop detection for condition gates. A `condition`-type transition that repeatedly fails with the same shell command output will bounce forever until `maxIterations` is hit (which is workflow-level, not gate-level).
2. No gate failure history or similarity-based analysis.
3. No diagnostic message generation for dead loops.

**Impact:** Space workflows can get stuck bouncing on a condition gate without the runtime detecting or reporting the loop. The `maxIterations` cap on cyclic edges is the only safeguard.

### 4. Lifecycle Hooks (Parity: 0%) -- HIGH

**What Room has:**
- `WorkerExitGate` with 7+ hook functions:
  - `checkNotOnBaseBranch` -- enforces feature branch creation.
  - `checkPrExists` -- requires GitHub PR.
  - `checkPrSynced` -- verifies local HEAD matches PR.
  - `checkWorkerPrMerged` -- verifies PR was merged (post-approval).
  - `checkDraftTasksCreated` -- planner must create tasks.
  - Bypass markers (RESEARCH_ONLY, VERIFICATION_COMPLETE, etc.) for read-only tasks.
- `LeaderSubmitGate`:
  - `checkLeaderPrExists` -- PR must exist before submitting for review.
  - `checkPrIsMergeable` -- no conflicts, CI passing.
  - `checkPrHasReviews` -- reviewer sub-agents must post reviews.
- `LeaderCompleteGate`:
  - `checkLeaderPrMerged` -- PR must be merged before completing.
  - `checkLeaderRootRepoSynced` -- syncs root repo after merge.
  - `checkLeaderDraftsExist` -- planner tasks must have drafts.
- `closeStalePr()` -- closes superseded PRs.

**What Space has:**
- Workflow `condition`-type transitions with shell command evaluation -- can check git/gh state programmatically.
- `human`-type transitions for human gates.
- `task_result`-type transitions for result-based branching.
- No lifecycle hook framework.

**Missing:**
1. No deterministic gate framework equivalent. Conditions are declarative (shell commands) but there is no structured hook system with pass/bail/bounce semantics.
2. No bypass marker detection for read-only tasks.
3. No PR lifecycle validation (PR exists, synced, mergeable, merged, has reviews).
4. No root repo sync after merge.
5. No stale PR cleanup.

**Impact:** Space agents can "complete" tasks without creating PRs, without merging PRs, and without verifying CI. The workflow condition system can approximate some of this via shell commands, but it lacks the structured gate framework, bounce messages, and bypass detection that makes Room's system robust.

### 5. Human-in-the-Loop Workflow (Parity: 55%) -- HIGH

**What Room has:**
- `submitForReview()` -- leader calls `submit_for_review(pr_url)`, moves task to `review` status with PR URL.
- `escalateToHumanReview()` -- runtime-enforced escalation when max feedback iterations are reached.
- `resumeWorkerFromHuman()` / `resumeLeaderFromHuman()` -- resumes after human rejection/approval.
- `HeaderReviewBar.tsx` -- UI component with approve/reject buttons, PR link display.
- `routeHumanMessageToGroup()` -- routes human messages to worker or leader of active groups.
- `reviveTaskForMessage()` -- allows sending messages to completed/failed tasks by recreating groups.
- `waitingForQuestion` state tracking -- supports AskUserQuestion from SDK.
- `answerQuestion()` in SessionFactory -- answers pending SDK questions programmatically.

**What Space has:**
- `review` status in `SpaceTaskStatus` with valid transitions.
- `reviewTask()` method with PR metadata.
- `request_human_input` MCP tool in Task Agent.
- `NotificationSink` with deferred message delivery to Space Agent session.
- Human gate transitions (`human` condition type in workflows).
- `WorkflowGateError` for human-gate-blocked advancement.

**Missing:**
1. No `HeaderReviewBar` equivalent in the Space UI -- no approve/reject buttons for Space tasks in `review` status.
2. No `routeHumanMessageToGroup()` equivalent -- no way to route a human message directly to a specific Space step agent session.
3. No `reviveTaskForMessage()` equivalent -- no way to send messages to completed/failed Space tasks.
4. No `escalateToHumanReview()` runtime-enforced escalation.
5. No `answerQuestion()` equivalent for Space sub-sessions (step agents cannot programmatically answer AskUserQuestion from SDK).
6. No `waitingForQuestion` state tracking for Space sessions.

**Impact:** Humans can interact with Space workflows via the Space Agent chat and the human gate transition, but there is no task-level review UI (approve/reject), no direct message routing to step agents, and no question-answer protocol for SDK AskUserQuestion calls.

### 6. Tick Loop and Scheduling (Parity: 30%) -- HIGH

**What Room has:**
- `JobQueue` integration -- ticks are enqueued via `enqueueRoomTick()` and processed by `JobQueueProcessor`.
- `scheduleTick()` -- event-driven tick wake-up (immediate response to state changes, not just polling).
- `cancelPendingTickJobs()` -- cancels queued ticks on pause/stop.
- Room tick handler registered via `jobProcessor.register(ROOM_TICK, handler)`.
- Cron scheduling for recurring missions via `GoalManager.scheduleTick()` + `getNextRunAt()`.
- 30-second default tick interval.

**What Space has:**
- `setInterval`-based tick loop (5-second interval).
- Immediate first tick on `start()`.
- No event-driven wake-up.

**Missing:**
1. No JobQueue integration -- `setInterval` is lost on daemon restart, and there is no persistent tick scheduling.
2. No event-driven tick wake-up -- fastest reaction to state changes is next 5s poll.
3. No cron scheduling for recurring workflows (no equivalent to Room's `GoalManager.scheduleTick()`).
4. No per-space tick isolation -- single shared interval for all spaces.

**Impact:** Space ticks are in-memory only. After a daemon restart, the tick loop restarts but any ticks that would have fired during downtime are missed. Recurring workflows cannot be scheduled.

### 7. Rate Limit Backoff and Model Fallback (Parity: 20%) -- HIGH

**What Room has:**
- `createRateLimitBackoff()` -- creates a `RateLimitBackoff` entry with `resumeAt` timestamp.
- `getGlobalSettings().fallbackModels` -- configurable chain of fallback models.
- `trySwitchToFallbackModel()` -- walks the fallback chain, switches session model.
- `onAgentRateLimited()` -- orchestrates the full rate-limit response: classify, transition status, create backoff, attempt fallback, schedule deferred resume.
- Model switch events appended to group timeline.

**What Space has:**
- `rate_limited` and `usage_limited` task statuses (data model only).
- No runtime code that populates these statuses.

**Missing:**
1. No rate limit backoff infrastructure.
2. No fallback model switching for Space sessions.
3. No deferred resume after rate limit expires.
4. No rate limit event logging.

### 8. UI Task Management (Parity: 50%) -- HIGH

**What Room has:**
- `RoomTasks.tsx` -- full task list with filtering by status, priority grouping, task counts.
- `TaskViewV2.tsx` -- task conversation view with turn-based rendering, slide-out panel.
- `TaskConversationRenderer.tsx` -- renders agent turn blocks.
- `TaskInfoPanel.tsx` -- task metadata sidebar.
- `HeaderReviewBar.tsx` -- review controls (approve/reject, PR link).
- `GoalsEditor.tsx` -- goal creation, editing, progress bars, execution history, metric tracking.
- `TaskViewModelSelector.tsx` -- model selector per task.
- `RoomContext.tsx` -- full room context provider with signals for tasks, goals, groups.
- `RoomDashboard.tsx` -- room overview with goal/task status.

**What Space has:**
- `SpaceTaskPane.tsx` -- basic task list for a space.
- `SpaceContextPanel.tsx` -- space overview with workflow run status.
- `SpaceDashboard.tsx` -- space listing and creation.
- `WorkflowEditor.tsx` -- visual workflow editor (drag-drop canvas, node cards, edge editing).
- `WorkflowNodeCard.tsx` -- multi-agent support per step.
- `WorkflowList.tsx` -- workflow listing.
- `WorkflowRulesEditor.tsx` -- rule configuration.

**Missing:**
1. No `SpaceTaskDetail` equivalent -- no way to view a Space task's conversation history in the UI.
2. No `SpaceGoalsEditor` equivalent -- no goal creation/editing UI for Space.
3. No `SpaceReviewBar` equivalent -- no approve/reject controls for tasks in `review` status.
4. No `SpaceTaskConversationRenderer` -- no turn-based conversation view for Space task sessions.
5. No task model selector for Space tasks.
6. No space-level dashboard equivalent to `RoomDashboard` (showing goal progress, active tasks, workflow status).

### 9. Persistence and Recovery (Parity: 70%) -- MEDIUM

**What Room has:**
- `RuntimeRecovery` -- recovers active groups, restores sessions from DB, re-attaches MCP servers, injects continuation messages.
- Session mirroring with `sdk.message` subscription for rate limit detection.
- `recoverZombieGroups()` -- cleans up orphaned active groups.
- Full session state recovery including `waitingForQuestion` handling.
- MCP server re-attachment on restart (runtime-only, non-serializable).
- Worktree tracking and cleanup.

**What Space has:**
- `TaskAgentManager.rehydrate()` -- restores Task Agent sessions from DB, re-attaches MCP servers, restarts streaming, injects re-orientation message.
- Sub-sessions restored to cache but not fully rehydrated (Task Agent re-spawns via MCP tools).
- Executor rehydration from DB (`rehydrateExecutors()`).
- `pending` runs excluded from rehydration.
- No mirroring or rate limit detection via `sdk.message`.

**Missing:**
1. **`pending` runs excluded from rehydration** -- if a run was mid-creation during crash (between `createRun()` and `updateStatus('in_progress')`), it is silently skipped and its executor is never loaded.
2. **Sub-session streaming not restarted** -- sub-sessions are restored to the in-memory cache but their SDK streaming queries are not restarted. The Task Agent must re-spawn them via MCP tools after receiving a re-orientation message.
3. **No mirroring** -- no `sdk.message` subscription for rate limit detection on Space sessions.
4. **No zombie cleanup** -- no equivalent to `cleanupZombieGroups()` for orphaned Space session groups.

### 10. Event Handling and DaemonHub Integration (Parity: 65%) -- MEDIUM

**What Room has:**
- `daemonHub.emit()` for real-time events: `room.task.update`, `goal.progressUpdated`, `goal.created`.
- Session mirroring via `sdk.message` subscription for rate limit detection.
- Event subscriptions: `room.created`, `room.updated`, `goal.created`, `room.task.update`.
- Real-time task update events so frontend UI updates in real time.

**What Space has:**
- `NotificationSink` pattern with structured events (task_needs_attention, workflow_run_needs_attention, task_timeout, workflow_run_completed).
- `SessionNotificationSink` -- production implementation using deferred message delivery.
- Event deduplication via `notifiedTaskSet` (in-memory, not persisted).
- DaemonHub events for session groups: `spaceSessionGroup.created`, `spaceSessionGroup.memberAdded`, `spaceSessionGroup.memberUpdated`.

**Missing:**
1. No `daemonHub.emit()` for real-time Space task status updates -- the frontend must poll or use live queries to detect status changes.
2. No event subscription for Space task status changes (no equivalent to Room's `room.task.update` subscription that triggers tick).
3. `notifiedTaskSet` not persisted -- duplicate notifications possible after restart.
4. No mirroring events for rate limit detection.

### 11. Inter-Agent Messaging (Parity: 95%) -- LOW

**What Room has:**
- Fixed Worker-to-Leader routing via `routeWorkerToLeader()`.
- Fixed Leader-to-Worker routing via `routeLeaderToWorker()`.
- Message envelope formatting via `formatWorkerToLeaderEnvelope()`, `formatLeaderToWorkerFeedback()`.
- `answerQuestion()` for SDK AskUserQuestion.

**What Space has:**
- `ChannelResolver` with flexible topologies (one-way, bidirectional, hub-spoke).
- `send_message` MCP tool for peer step agent communication with channel enforcement.
- `list_peers` MCP tool for discovering permitted communication targets.
- `request_human_input` MCP tool (human-in-the-loop).
- `TaskAgentManager.injectSubSessionMessage()` for programmatic message injection.
- `SessionNotificationSink` with deferred delivery.

**Assessment:** Space leads Room here. The ChannelResolver provides flexible, declarative topologies that Room's fixed Worker-Leader routing cannot match. The only minor gap is the lack of `answerQuestion()` for SDK AskUserQuestion responses in sub-sessions.

### 12. Worktree/Task Isolation (Parity: N/A) -- DESIGN CHOICE

**What Room has:**
- Git worktree creation for every task group via `WorktreeManager`.
- Isolated feature branches per task.
- Worktree cleanup on group completion/failure/archival.
- Root repo sync after PR merge.

**What Space has:**
- No worktree creation -- all Space agents share the same workspace path.
- This is a **deliberate design choice** for the Space system's multi-agent parallel model, where multiple agents may need to work on the same codebase simultaneously.

**Assessment:** Not a gap. Space uses a different isolation model (workflow-defined agents rather than worktree-isolated sessions). Worktree support could be added as an optional feature but is not required for parity.

---

## Prioritized Implementation Plan

### Phase 1: Critical -- Goal Integration + Reliability (3 tasks)

#### Task 1: Wire Space Task Completion to Goal Progress Tracking

- **Priority:** CRITICAL
- **Description:** Create a bridge between Space task status changes and Room's `GoalManager`. When a SpaceTask with a `goalId` completes (or fails), call `GoalManager.updateGoalsForTask()` to recalculate goal progress. This requires injecting `GoalManager` into the Space runtime pipeline (likely via `SpaceRuntimeService` or `TaskAgentManager`).
- **Subtasks:**
  1. Add `GoalManager` as an optional dependency to `SpaceRuntimeConfig`.
  2. In `SpaceRuntime.processRunTick()`, after a task transitions to `completed`, call `goalManager.updateGoalsForTask(taskId)`.
  3. In `TaskAgentManager.handleSubSessionComplete()`, emit goal progress events.
  4. Emit `goal.progressUpdated` DaemonHub events so the frontend updates.
- **Acceptance Criteria:** Space tasks with `goalId` update Room goal progress when completed. The `GoalsEditor` UI reflects Space task contributions.
- **Agent Type:** coder
- **Dependencies:** None

#### Task 2: Rate Limit Detection Pipeline for Space

- **Priority:** HIGH
- **Description:** Port the error classification and rate limit detection pipeline from Room to Space. When a Space Task Agent or step agent encounters an "API Error: 429" or usage limit message, the runtime should classify the error, transition the task to `rate_limited`/`usage_limited`, and attempt fallback model switching.
- **Subtasks:**
  1. Extract `classifyError()` and `parseRateLimitReset()` from Room into shared utilities (or import directly).
  2. Create `SpaceErrorClassifier` module in `space/runtime/`.
  3. In `TaskAgentManager`, subscribe to `session.error` events on Task Agent sessions. On error, classify and transition.
  4. Implement `trySwitchToFallbackModel()` for Space sessions (read `fallbackModels` from global settings).
  5. Create deferred resume mechanism for rate-limited Space tasks (schedule tick wake-up after backoff expires).
- **Acceptance Criteria:** Space tasks automatically transition to `rate_limited` when API returns 429. Fallback model switching works. Tasks resume after backoff expires.
- **Agent Type:** coder
- **Dependencies:** None

#### Task 3: Dead Loop Detection for Space Workflow Gates

- **Priority:** HIGH
- **Description:** Port the dead loop detection concept from Room to Space. Track condition gate failures per workflow run, detect repeated failures with similar reasons, and fail the run with a diagnostic message.
- **Subtasks:**
  1. Create `space/runtime/dead-loop-detector.ts` (can reuse/adapt Room's Levenshtein-based implementation).
  2. Add gate failure tracking to `SpaceWorkflowRunRepository` (store in `run.config` or a dedicated metadata column).
  3. In `SpaceRuntime.processRunTick()`, when a `WorkflowTransitionError` is caught, record the failure and check for dead loops.
  4. On dead loop detection, fail the workflow run and emit a `workflow_run_completed` event with diagnostic message.
- **Acceptance Criteria:** Space workflow runs that bounce repeatedly on the same condition gate are detected and failed with a diagnostic message.
- **Agent Type:** coder
- **Dependencies:** None

### Phase 2: High Priority -- UI + Runtime (4 tasks)

#### Task 4: Human Review UI for Space Tasks

- **Priority:** HIGH
- **Description:** Create approve/reject UI controls for Space tasks in `review` status. This is the most visible user-facing gap.
- **Subtasks:**
  1. Create `SpaceTaskReviewBar.tsx` component with approve/reject buttons, PR link display.
  2. Wire approve action to `space.task.update` RPC with status `completed`.
  3. Wire reject action to `space.task.update` RPC with status `needs_attention` and a feedback message.
  4. Integrate into `SpaceTaskPane.tsx` or `SpaceContextPanel.tsx`.
  5. Add E2E test for Space task review workflow.
- **Acceptance Criteria:** Space tasks in `review` status show approve/reject controls. Approving completes the task; rejecting sets it to `needs_attention`.
- **Agent Type:** coder
- **Dependencies:** None

#### Task 5: Space Task Detail/Conversation View

- **Priority:** HIGH
- **Description:** Create a conversation view for Space task sessions, equivalent to Room's `TaskViewV2.tsx`. Users should be able to see the full conversation history of a Space task's AgentSession.
- **Subtasks:**
  1. Create `SpaceTaskDetail.tsx` component that loads task session messages.
  2. Integrate `TaskConversationRenderer.tsx` (or create Space-specific version) for turn-based rendering.
  3. Add task info sidebar with metadata (status, type, agent, workflow run, PR link).
  4. Add navigation from `SpaceTaskPane.tsx` to detail view.
  5. Add E2E test for Space task detail navigation.
- **Acceptance Criteria:** Users can click a Space task and see its full conversation history with agent turns rendered properly.
- **Agent Type:** coder
- **Dependencies:** None

#### Task 6: Lifecycle Hook Framework for Space

- **Priority:** HIGH
- **Description:** Create a deterministic gate framework for Space that provides structured lifecycle hooks (equivalent to Room's WorkerExitGate/LeaderSubmitGate/LeaderCompleteGate) but adapted for the workflow-step model.
- **Subtasks:**
  1. Design hook interface for Space: `SpaceTaskExitGate`, `SpaceStepAdvanceGate`.
  2. Implement core hooks: `checkNotOnBaseBranch`, `checkPrExists`, `checkPrSynced`, `checkPrMerged`, `checkPrIsMergeable`.
  3. Integrate hooks into `TaskAgentManager.handleSubSessionComplete()` (task exit gate) and `WorkflowExecutor.advance()` (step advance gate).
  4. Add bypass marker detection for read-only tasks.
  5. Add hook configuration to workflow node data or space config.
- **Acceptance Criteria:** Space step agents are bounced when they exit without creating a PR. The bounce message is clear and actionable.
- **Agent Type:** coder
- **Dependencies:** Task 3 (dead loop detection prevents infinite bounce loops)

#### Task 7: JobQueue Integration for Space Tick Loop

- **Priority:** HIGH
- **Description:** Replace Space's `setInterval`-based tick loop with the persistent JobQueue system used by Room.
- **Subtasks:**
  1. Add `space.tick` job type to job queue constants.
  2. Create `space-tick.handler.ts` similar to `room-tick.handler.ts`.
  3. Register handler in `SpaceRuntimeService.start()`.
  4. Replace `setInterval` in `SpaceRuntime.start()` with `enqueueSpaceTick()`.
  5. Add event-driven tick wake-up: schedule tick on task status changes, workflow run creation, human gate resolution.
- **Acceptance Criteria:** Space ticks are persistent across daemon restarts via the JobQueue. Event-driven wake-up reduces reaction latency from 5s to near-immediate.
- **Agent Type:** coder
- **Dependencies:** None

### Phase 3: Medium Priority -- Robustness (4 tasks)

#### Task 8: Pending Run Rehydration Fix

- **Priority:** MEDIUM
- **Description:** Handle `pending` workflow runs that were mid-creation during a daemon crash. Currently excluded from rehydration, leaving orphaned `pending` runs in the DB.
- **Subtasks:**
  1. Update `rehydrateExecutors()` to include `pending` runs.
  2. Add a staleness check: if a `pending` run has existed for more than N minutes without tasks, cancel it.
  3. Attempt task creation for recently-pending runs (re-run the initial task creation logic).
- **Acceptance Criteria:** Pending runs from crashed daemon instances are either recovered or cleaned up on next startup.
- **Agent Type:** coder
- **Dependencies:** None

#### Task 9: Notification Dedup Persistence

- **Priority:** MEDIUM
- **Description:** Persist the `notifiedTaskSet` to survive daemon restarts, preventing duplicate notifications for tasks already in `needs_attention`.
- **Subtasks:**
  1. Create a lightweight DB table or use existing `space_task` metadata to track last notification status.
  2. Load dedup state on startup in `SpaceRuntime` constructor or `rehydrateExecutors()`.
  3. Clear dedup entries when tasks leave their flagged state.
- **Acceptance Criteria:** After daemon restart, tasks that were already in `needs_attention` do not trigger duplicate notifications on the first tick.
- **Agent Type:** coder
- **Dependencies:** None

#### Task 10: Human Message Routing to Space Step Agents

- **Priority:** MEDIUM
- **Description:** Add the ability to route human messages directly to a specific Space step agent session (equivalent to Room's `routeHumanMessageToGroup()`).
- **Subtasks:**
  1. Create `space.task-message.inject` RPC handler that routes a message to a specific Space session.
  2. Validate the session belongs to a Space task (not an arbitrary session).
  3. Inject the message via `TaskAgentManager.injectSubSessionMessage()`.
  4. Add `answerQuestion()` support for Space sub-sessions that have pending `AskUserQuestion` tool calls.
- **Acceptance Criteria:** Humans can send messages to Space step agent sessions via RPC. Pending SDK questions can be answered programmatically.
- **Agent Type:** coder
- **Dependencies:** Task 4 (review UI needs message routing)

#### Task 11: DaemonHub Event Emission for Space Task Updates

- **Priority:** MEDIUM
- **Description:** Emit `daemonHub` events for Space task status changes so the frontend can update in real time without polling.
- **Subtasks:**
  1. Add `space.task.update` DaemonHub event emission in `SpaceTaskManager` status transition methods.
  2. Subscribe to `space.task.update` events in the Space frontend (`space-store.ts`) for reactive updates.
  3. Add `goal.progressUpdated` event emission when Space task completion triggers goal update.
- **Acceptance Criteria:** Space task status changes are reflected in the frontend in real time without manual refresh.
- **Agent Type:** coder
- **Dependencies:** Task 1 (goal integration)

### Phase 4: Future/Nice-to-Have (3 tasks)

#### Task 12: Cron Scheduling for Recurring Space Workflows

- **Priority:** MEDIUM
- **Description:** Add cron-based scheduling for recurring Space workflows, equivalent to Room's `GoalManager.scheduleTick()`.
- **Subtasks:**
  1. Add `schedule` field to `SpaceWorkflow` (cron expression + timezone).
  2. Implement `getNextRunAt()` for Space workflows (can reuse Room's `cron-utils.ts`).
  3. Add tick handler that checks for due recurring workflows and starts new runs.
  4. Add catch-up detection for missed runs during downtime.
- **Acceptance Criteria:** Space workflows with a `schedule` field auto-start new runs at the configured cron interval.
- **Agent Type:** coder
- **Dependencies:** Task 7 (JobQueue integration)

#### Task 13: Goal Creation UI for Space

- **Priority:** LOW
- **Description:** Create a goal/mission creation wizard accessible from the Space context, equivalent to Room's `GoalsEditor.tsx`.
- **Subtasks:**
  1. Create `SpaceGoalsEditor.tsx` with goal creation, editing, progress bars.
  2. Support mission types (one_shot, measurable, recurring).
  3. Support structured metrics with progress tracking.
  4. Wire to `goal.*` RPC handlers.
- **Acceptance Criteria:** Users can create and manage goals from the Space UI. Goal progress reflects Space task contributions.
- **Agent Type:** coder
- **Dependencies:** Task 1 (goal integration)

#### Task 14: Space Dashboard with Goal/Task Overview

- **Priority:** LOW
- **Description:** Create a comprehensive Space dashboard equivalent to Room's `RoomDashboard.tsx`, showing goal progress, active workflow runs, task status summary, and recent activity.
- **Subtasks:**
  1. Create `SpaceOverviewDashboard.tsx` with goal progress bars, active workflow runs, task status counts.
  2. Add recent activity feed (task completions, workflow transitions, human approvals).
  3. Integrate into the Space navigation panel.
- **Acceptance Criteria:** Users can see at a glance the status of all goals, workflows, and tasks within a Space.
- **Agent Type:** coder
- **Dependencies:** Task 1 (goal integration), Task 13 (goal UI)

---

## Summary Gap Scores

| # | Dimension | Parity | Priority | Room Has | Space Has | Key Gap |
|---|-----------|--------|----------|----------|-----------|---------|
| 1 | Goal/Mission integration | 15% | CRITICAL | Full GoalManager with metrics, cron, executions | Passive goalId only | No active integration |
| 2 | Error detection and recovery | 50% | HIGH | classifyError + fallback + backoff | Status types exist only | No runtime detection |
| 3 | Dead loop detection | 0% | HIGH | Levenshtein-based gate analysis | None | No detection mechanism |
| 4 | Lifecycle hooks | 0% | HIGH | WorkerExit + LeaderSubmit + LeaderComplete gates | Declarative conditions only | No structured gate framework |
| 5 | Human-in-the-loop | 55% | HIGH | ReviewBar + message routing + question answering | request_human_input + human gates | No review UI, no direct routing |
| 6 | Tick persistence | 30% | HIGH | JobQueue + event-driven wake-up | setInterval only | No persistent scheduling |
| 7 | Rate limit handling | 20% | HIGH | Full pipeline: detect + backoff + fallback | None | No runtime code |
| 8 | UI task management | 50% | HIGH | Full task list + detail + review + goals | Basic task pane + workflow editor | Missing detail view, review UI, goals |
| 9 | Persistence/recovery | 70% | MEDIUM | Full recovery + mirroring + MCP reattach | Task Agent rehydrate only | Pending runs, no mirroring |
| 10 | Event handling | 65% | MEDIUM | DaemonHub emit + subscribe | NotificationSink pattern | No real-time task updates |
| 11 | Inter-agent messaging | 95% | LOW | Fixed Worker-Leader routing | ChannelResolver + send_message | Minor: no answerQuestion |
| 12 | Worktree isolation | N/A | DESIGN | Per-task worktrees | Shared workspace | Intentional design difference |

---

## Space-Exclusive Advantages (Room Does NOT Have)

| Feature | Space | Room |
|---------|-------|------|
| Visual workflow editor | Full drag-drop canvas with pan/zoom, node cards, edge editing | None |
| Multi-agent parallel steps | Multiple agents per workflow step, all concurrent | Single worker per task |
| Channel topology | Flexible directed/bidirectional edges via ChannelResolver | Fixed Worker-to-Leader routing |
| Condition-based transitions | always, human, condition (shell), task_result | Implicit via Leader tool calls |
| Task Agent architecture | MCP-tool-driven orchestration (agent drives workflow) | Direct advance() calls (runtime drives workflow) |
| Per-agent overrides | Model and system prompt per agent slot | Agent model override only |
| Workflow templates | Coding, Research, Review-Only built-in workflows | No workflow templates |
| Export/Import | Full agent + workflow export/import system | No export/import |
| Custom agents | User-defined agents with roles, prompts, models | Preset roles only (planner/coder/general) |
