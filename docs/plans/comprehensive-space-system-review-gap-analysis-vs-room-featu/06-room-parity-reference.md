# Appendix: Room Feature Parity Reference + Deferred Tasks

> **Design revalidation notice:** This appendix references Room system internals for cross-reference only. It is NOT a task list. See `00-overview.md` for the actual plan.

---

## Purpose

This document serves two purposes:
1. Maps Room features to their Space equivalents (or lack thereof) for developers familiar with Room.
2. Preserves the full specifications of tasks that were deferred from the main plan because they are not prerequisites for workflow execution.

---

## Part 1: Feature-by-Feature Mapping

### Workflow Execution

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| Leader/Worker paired sessions | Task Agent + sub-sessions | Architecturally different; Space uses MCP tools for orchestration |
| `advance()` direct call | `advance_workflow` MCP tool | Space's Task Agent proxies the advance call |
| Fixed linear pipeline (Plan -> Code -> Review) | User-defined directed graph | Space is more flexible |
| Condition evaluation (gate checks) | 4 types: always, human, condition, task_result | Space has more condition types |
| Cyclic iteration (maxIterations on task_result) | Same + explicit `isCyclic` flag | Space has richer cycle detection |
| `WorkerExitGate` (exit condition on worker output) | `task_result` condition on transitions | Space checks agent output prefix |
| `LeaderCompleteGate` (exit condition on leader plan) | N/A (no explicit leader role) | Space has no fixed leader/worker roles |
| `LeaderSubmitGate` (PR submission requirement) | N/A | Not implemented in Space |

### Agent Spawning & Session Management

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| Session worktree isolation | No worktree isolation (deliberate) | Space uses workflow-defined agent roles instead |
| Fixed agent roles (leader, worker) | Configurable agent roles (planner, coder, general, custom) | Space is more flexible |
| `answerQuestion()` direct injection | `request_human_input` MCP tool + deferred message delivery | Space uses tool-based approach |
| `retryFailedTask()` auto-retry | Manual via Space Agent notification | Space relies on agent intelligence for retry decisions |
| `reassignFailedTask()` | `SpaceTaskManager.setTaskStatus()` + Space Agent coordination | No direct auto-reassign |

### Task Management

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| NeoTask (Room tasks) | SpaceTask (Space tasks) | Separate tables, similar structure |
| Task status: pending/in_progress/completed/failed | Same statuses + needs_attention/review/archived/rate_limited/usage_limited | Space has more statuses |
| Task types: planning/coding/research | Same types | Space has identical task types |
| PR URL on task | Same (prUrl, prNumber) | Both support PR association |
| Task dependencies (dependsOn) | Same | Both support dependencies |
| Task result field | Same | Both support result strings |

### Inter-Agent Communication

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| `routeWorkerToLeader()` | `send_message` MCP tool | Space uses channel topology |
| `routeLeaderToWorker()` | `send_message` MCP tool with ChannelResolver | Space validates against declared channels |
| Fixed Worker -> Leader routing | Configurable channel topology (one-way, bidirectional, hub-spoke) | Space is more flexible |
| No peer-to-peer messaging | Full peer-to-peer via `send_message` | Space leads here |

### Goal / Mission System

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| Goal CRUD (create, update, delete) | `goalId` on workflow runs only | Space has passive goal reference only |
| Measurable missions (structuredMetrics) | N/A | Not implemented in Space |
| Recurring missions (cron schedule) | N/A | Not implemented in Space |
| Semi-autonomous mode | autonomyLevel on Space | Same concept, different implementation |
| Mission execution history | N/A | Not implemented in Space |
| Metric tracking (metric_history table) | N/A | Not implemented in Space |

### Runtime Infrastructure

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| RoomRuntimeService (per-room runtime) | SpaceRuntimeService (per-space runtime) | Same pattern |
| Tick loop (JobQueue-based, 30s) | Tick loop (setInterval, 5s) | Space is faster but less persistent |
| Tick persistence across restarts | Rehydration on first tick | Space rebuilds state from DB |
| Agent session rehydration | TaskAgentManager.rehydrate() | Space has full rehydration |
| Session state change events (DaemonHub) | Same + spaceSessionGroup events | Space has more event types |

### Frontend

| Room Feature | Space Equivalent | Notes |
|------------|-----------------|-------|
| RoomContextPanel (task list + goal editor) | SpaceTaskPane + SpaceNavPanel | Different layout, similar purpose |
| RoomTasks component | SpaceTaskPane | Both show task lists |
| GoalsEditor component | N/A | Not implemented in Space |
| Visual workflow editor | VisualWorkflowEditor (canvas, nodes, edges) | Space leads here |
| Export/import workflows | Full export/import system | Space leads here |

---

## Part 2: Deferred Task Specifications

The following tasks were removed from the main plan because they are not prerequisites for workflow execution. They are preserved here in full specification for future implementation.

### Deferred Task 3.2: Task Agent Conversation Inspector

**Original milestone:** M3 (Monitoring and Debugging)
**Reason for deferral:** Nice-to-have debugging feature. Users can inspect tasks via the basic TaskDetailView (Task 1.3). Full conversation inspection with tool calls, sub-sessions, and auto-refresh is a monitoring enhancement, not an execution blocker.

**Summary:** Enhance `TaskDetailView` to show full conversation history including tool calls, tool results, and agent reasoning. Add Conversation, Logs, and Sub-sessions tabs with auto-refresh via DaemonHub events.

**Key files:** `packages/web/src/components/space/TaskDetailView.tsx`, `packages/web/src/lib/space-store.ts`

### Deferred Task 3.3: Workflow Run History View

**Original milestone:** M3 (Monitoring and Debugging)
**Reason for deferral:** Nice-to-have monitoring feature. Past run data exists in DB and can be queried via RPC. A dedicated history UI with pagination, filtering, and step timelines is valuable but not needed for a workflow to execute.

**Summary:** Create a history view showing all past workflow runs for a space with chronological list, step execution timeline, and filtering by workflow/status/date.

**Key files:** `packages/web/src/components/space/WorkflowRunHistory.tsx`, `packages/web/src/lib/space-store.ts`

### Deferred Task 4.4: Space Agent Orchestration of Human Interactions

**Original milestone:** M4 (Human-in-the-Loop)
**Reason for deferral:** This is a Room-like leader coordination pattern. The Space Agent's behavior when receiving notifications is an optimization, not a prerequisite. The human interaction primitives (gate approval UI, question response UI, pause/resume) work independently of the Space Agent's orchestration behavior.

**Summary:** Enhance the Space Agent's system prompt and notification handling to properly orchestrate human interactions. Add `spaceWorkflowRun.updateConfig` RPC and workflow interaction tools for the Space Agent.

**Key files:** `packages/daemon/src/lib/space/agents/space-chat-agent.ts`, `packages/daemon/src/lib/space/tools/global-spaces-tools.ts`

### Deferred Task 5.2: Cron Scheduling for Recurring Workflows

**Original milestone:** M5 (Advanced Features)
**Reason for deferral:** This ports Room's `cron-utils.ts` infrastructure. While useful, cron scheduling is not part of the core "define, run, complete a workflow" vision. Workflows can be started manually.

**Summary:** Add cron-based scheduling for recurring workflow runs using the same infrastructure as Room's goal cron system. Includes catch-up on missed schedules and minimum interval cap.

**Key files:** `packages/daemon/src/lib/space/runtime/workflow-scheduler.ts` (new), `packages/daemon/src/lib/room/runtime/cron-utils.ts` (reference)

### Deferred Task 5.3: Goal/Mission Integration for Workflows

**Original milestone:** M5 (Advanced Features)
**Reason for deferral:** This bridges to Room's GoalManager. The `goalId` field exists on `SpaceWorkflowRun` but wiring it to the Room goal system requires cross-system architectural decisions (GoalManager is constructed with a `roomId`, Space has no `roomId`). This is a separate design effort.

**Summary:** Wire up the existing `goalId` field so workflow completion updates mission metrics and recurring mission execution can trigger workflow runs. Includes cross-system reference handling.

**Key files:** `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`, `packages/daemon/src/lib/room/managers/goal-manager.ts` (reference)
