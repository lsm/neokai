# Appendix: Room Feature Parity Reference

> **Design revalidation notice:** This appendix references Room system internals for cross-reference only. It is NOT a task list. See `00-overview.md` for the actual plan.

---

## Purpose

This document maps Room features to their Space equivalents (or lack thereof). It exists as a brief reference for developers familiar with Room who are working on Space. The main plan in `00-overview.md` focuses exclusively on what Space needs to work end-to-end; this appendix answers "what does Room have that Space doesn't?" without prescribing tasks.

---

## Feature-by-Feature Mapping

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
