# Space (V2 Room) System Gap Analysis vs Room Feature Parity

## Executive Summary

The Space system is a workflow-graph-based multi-agent orchestration engine, fundamentally different in architecture from Room's Leader/Worker paired-session model. Space has a **visual workflow editor**, **multi-agent parallel steps**, and **MCP-tool-driven execution**, but has gaps in several areas relative to the mature Room system.

This document provides a corrected gap analysis with more precise descriptions of what exists vs what is truly missing.

## Summary Gap Scores by Dimension

| # | Dimension | Score | Priority | Notes |
|---|-----------|-------|----------|-------|
| 1 | Workflow execution runtime | 65% | HIGH | Task Agent architecture is a key differentiator |
| 2 | Agent spawning/session management | 85% | MEDIUM | Worktree is deliberate design choice |
| 3 | Inter-agent messaging/channel topology | 90% | LOW | Space leads with ChannelResolver |
| 4 | UI visual editor parity | 60% | HIGH | Missing task list/detail/goal editor |
| 5 | Task/group lifecycle | 85% | HIGH | Statuses exist; UI approval workflow is gap |
| 6 | Event handling/notifications | 80% | MEDIUM | NotificationSink pattern differs from Room |
| 7 | Persistence and recovery | 70% | HIGH | Sub-session streaming gap is real |
| 8 | Error handling | 70% | HIGH | Data model exists; runtime detection is gap |
| 9 | Goal management parity | 30% | CRITICAL | Passive goalId only; no active integration |
| 10 | Tick loop and scheduling | 40% | HIGH | No JobQueue, no cron scheduling |

## Detailed Findings

### 1. Workflow Execution Runtime (65%)

**What Space has:**
- `WorkflowExecutor` with directed graph navigation and condition evaluation
- `TaskAgentManager` driving execution via MCP tools (`advance_workflow`, `spawn_step_agent`, etc.)
- Per-run executor isolation — each workflow run has its own executor
- 5-second tick interval (more responsive than Room's 30s)

**Gaps:**
- No JobQueue integration (uses `setInterval` instead) — tick loop not persistent across daemon restarts
- No dead loop detection (only `maxIterations` cap on cyclic edges) — repeated bounces on same gate won't be detected
- No lifecycle hooks (Room's `WorkerExitGate`, `LeaderCompleteGate`, `LeaderSubmitGate` equivalents)
- No automatic model fallback on rate/usage limits (gap is runtime detection + transition)

**Key Architectural Difference:** Room uses direct `advance()` calls; Space uses Task Agent + MCP tools to drive workflow progression. The Task Agent acts as a proxy orchestrator.

### 2. Agent Spawning/Session Management (85%)

**What Space has:**
- `TaskAgentManager` with hierarchical session model (Task Agent + per-step Sub-sessions)
- `spawnTaskAgent()` with idempotent spawn + concurrency guard
- `createSubSession()` for step agents
- `request_human_input` MCP tool (the Space equivalent of Room's `answerQuestion`)
- Sub-session streaming is restarted on rehydrate for Task Agents (but not for sub-sessions — see gap)

**Gaps:**
- **Sub-session streaming not restarted after daemon restart** — sub-sessions are restored but not actively streaming; Task Agent re-spawns them via MCP tools after re-orientation
- `worktree: false` is a **deliberate design choice** for custom agents, not a missing feature — Space uses a different isolation model (workflow-defined agents rather than worktree-isolated sessions)

**Note on `answerQuestion`:** Space's equivalent is `request_human_input` tool in Task Agent + `NotificationSink` with deferred delivery. This is architecturally different from Room's direct `answerQuestion()` injection but achieves similar human-in-the-loop functionality.

### 3. Inter-Agent Messaging (90%)

**Space leads Room here:**
- `ChannelResolver` with flexible topologies (one-way, bidirectional) vs Room's fixed Worker↔Leader routing
- Visual edge configuration in the workflow editor
- `send_message` MCP tool for peer step agent communication
- `NotificationSink` pattern for structured event delivery with deferred mode

**Room has:** Direct `routeWorkerToLeader()` / `routeLeaderToWorker()` envelope injection

**Space has:** Task Agent MCP tools + `SessionNotificationSink` with deferred message delivery

**Parity achieved** in terms of capability; different architectural approaches.

### 4. UI Visual Editor (60%)

**Space leads Room:**
- Visual drag-drop workflow editor with pan/zoom canvas
- `WorkflowNodeCard` with multi-agent support (multiple agents per step)
- Per-agent model and system prompt overrides
- Template system (Coding, Research, Quick Fix)

**Gaps:**
- No Space task list view (`RoomTasks` equivalent)
- No Space task detail view (`TaskViewV2` equivalent)
- No goal/mission editor for Space (Room has `GoalsEditor`)
- No human approval UI for Space tasks (approve/reject buttons, review bar)

### 5. Task/Group Lifecycle (85%) — Corrected

**Space DOES have:**
- `draft` and `review` statuses in `SpaceTaskStatus` type (`packages/shared/src/types/space.ts:119-129`)
- Full transition table including `draft → pending` and `review → completed/needs_attention` (`VALID_SPACE_TASK_TRANSITIONS`)
- `reviewTask()` method that sets PR metadata (`SpaceTaskManager:233-256`)
- `promoteDraftTasks()` method for draft→pending promotion (`SpaceTaskManager:261-263`)

**Real gaps:**
- **No human approval/rejection workflow UI** — Room has `TaskReviewBar` with approve/reject controls; Space's `review` status exists but has no corresponding UI for human decision
- No formal `submitForReview` equivalent with UI affordances

**Updated score: 85%** (was 70%). The statuses and transition logic exist; the human-facing approval workflow is the gap.

### 6. Event Handling/Notifications (80%)

**Architectural difference:**
- Room: `daemonHub.emit()` (TypedHub pattern)
- Space: `NotificationSink` interface with `notify(event)` method

**What Space has:**
- `NullNotificationSink` (default no-op)
- `SessionNotificationSink` (production implementation with deferred delivery)
- Event deduplication via `notifiedTaskSet` (in-memory, not persisted)

**Gaps:**
- `notifiedTaskSet` not persisted — duplicate notifications possible after restart for tasks already in `needs_attention`
- No webhook/external notification sink implementation

### 7. Persistence and Recovery (70%)

**What Space persists:**
- `SpaceTask`, `SpaceWorkflowRun`, `SpaceWorkflow`, `SpaceSessionGroup` — full structural data
- `currentNodeId` for executor rehydration
- `taskAgentSessionId` for Task Agent session restoration

**Gaps:**
- **`pending` runs excluded from rehydration** — if a run was `pending` when daemon crashed (between `createRun()` and `updateStatus('in_progress')`), it's silently skipped
- **Sub-session streaming not restarted** — restored to cache but not actively streaming; Task Agent re-spawns them
- `setInterval` not persisted — tick loop resumes on restart but spaces freeze until first tick

### 8. Error Handling (70%) — Corrected

**Space DOES have:**
- `rate_limited` and `usage_limited` statuses in `SpaceTaskStatus` (`packages/shared/src/types/space.ts:128-129`)
- Valid transitions from `rate_limited` and `usage_limited` back to `in_progress`, `needs_attention`, or `cancelled`
- `WorkflowTransitionError` and `WorkflowGateError` for workflow-level errors
- Task-level `error` field persisted to DB

**Real gaps:**
- **No runtime detection pipeline** — unlike Room's `classifyError()` + `onAgentRateLimited()` that auto-transitions tasks to `rate_limited`, Space has no equivalent that watches for rate limit responses and transitions automatically
- **No dead loop detection** — repeated bounces on same gate won't be caught (only `maxIterations` cap)
- **No error classification taxonomy** — Room's 4-class (`terminal`, `rate_limit`, `usage_limit`, `recoverable`) has no Space equivalent

**Updated score: 70%** (was 60%). Data model exists; runtime detection is the gap.

### 9. Goal Management Parity (30%) — CRITICAL

**Space has:**
- `goalId` field on `SpaceTask` and `SpaceWorkflowRun`
- `findByGoalId()` query method in `SpaceTaskRepository`

**Space does NOT have:**
- Any use of `GoalManager` — no import, no integration
- Task completion → goal progress update pipeline
- Mission types (`one_shot`, `measurable`, `recurring`) for Space
- Autonomy levels (`supervised`, `semi_autonomous`)
- Metric tracking (`structuredMetrics`)
- Cron scheduling (`schedule.expression`, `nextRunAt`)
- Execution tracking (`mission_executions`)

**`goalId` is passive metadata only.** Space can reference a Room goal ID, but Room's goal system has no awareness of Space tasks. Progress is never updated.

**This is the most critical gap.** No amount of progress in other dimensions helps if goal tracking requires manual correlation.

### 10. Tick Loop and Scheduling (40%)

**What Space has:**
- 5-second tick interval (more responsive than Room's 30s)
- `executeTick()` with executor processing, task cleanup, timeout detection
- Event-driven first tick (immediate on `start()`)

**Gaps:**
- No JobQueue — tick loop is in-memory `setInterval`, lost on restart
- No event-driven wake-up (`scheduleTick()` equivalent) — fastest reaction is next 5s poll
- No cron scheduling for recurring workflows
- No per-space tick isolation (single shared interval for all spaces)

---

## Space-Exclusive Advantages

Space exceeds Room in several dimensions:

| Feature | Space | Room |
|---------|-------|------|
| Visual workflow editor | Full drag-drop canvas with pan/zoom | None |
| Multi-agent parallel steps | Multiple agents per workflow step, all concurrent | Single worker per task |
| Channel topology | Flexible directed/bidirectional edges via ChannelResolver | Fixed Worker↔Leader routing |
| Condition-based transitions | `always`, `human`, `condition` (shell), `task_result` | Implicit via Leader tool calls |
| Task Agent architecture | MCP-tool-driven orchestration | Direct `advance()` calls |
| Per-agent overrides | Model and system prompt per agent slot | No |

---

## Prioritized Implementation Phases

### Phase 1: Critical (Goal Integration + Reliability Fixes)

1. **Goal Management Integration** — wire Space task completion → `GoalManager.recalculateProgress()`. This is the single highest-impact gap.
2. **Sub-session Streaming Restart** — fix `TaskAgentManager.rehydrate()` to restart sub-session streaming queries
3. **Pending Run Rehydration Fix** — handle `pending` runs that were mid-creation during crash

### Phase 2: High Priority (Runtime + UI)

4. **Human Review Workflow UI** — add approve/reject controls for Space tasks in `review` status
5. **Rate Limit Detection Pipeline** — auto-transition tasks to `rate_limited`/`usage_limited` when API returns 429/usage error
6. **JobQueue Tick Integration** — replace `setInterval` with per-space tick queue entries
7. **Cron/Recurring Workflow Scheduling** — add `schedule` field to `SpaceWorkflow`, implement `tickRecurringWorkflows()`

### Phase 3: Medium Priority (Robustness)

8. **Dead Loop Detection** — track gate failures per run, detect repeated bounces
9. **Notification Dedup Persistence** — persist `notifiedTaskSet` to survive restarts
10. **Space Task List UI** — `SpaceTasks.tsx` with filtering and status grouping
11. **Space Task Detail UI** — task conversation view for Space tasks

### Phase 4: Future / Nice to Have

12. **Lifecycle Hooks** — injectable `TaskCompleteGate` equivalent
13. **Goal Creation UI for Space** — wizard to create goals from Space context
14. **Full Error Classification Taxonomy** — 4-class error taxonomy matching Room's

---

## Methodology Note

Scores represent rough estimates of feature parity based on:
- Presence of data model/status types
- Completeness of runtime implementation vs Room's equivalent
- UI coverage relative to Room's components

A score of 100% does not mean identical functionality — Space and Room have fundamentally different architectures. The score reflects "how much of Room's capability is available in Space" rather than a feature count ratio.
