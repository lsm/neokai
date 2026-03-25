# Space (V2 Room) System Gap Analysis vs Room Feature Parity

## Executive Summary

The Space system is a workflow-graph-based multi-agent orchestration engine, fundamentally different in architecture from Room's Leader/Worker paired-session model. Space has a **visual workflow editor**, **multi-agent parallel steps**, and **MCP-tool-driven execution**, but lacks significant features present in the mature Room system.

## Summary Gap Scores by Dimension

| # | Dimension | Score | Priority |
|---|-----------|-------|----------|
| 1 | Workflow execution runtime | 60% | HIGH |
| 2 | Agent spawning/session management | 80% | MEDIUM |
| 3 | Inter-agent messaging/channel topology | 90% | LOW |
| 4 | UI visual editor parity | 60% | HIGH |
| 5 | Task/group lifecycle | 70% | HIGH |
| 6 | Event handling/notifications | 80% | MEDIUM |
| 7 | Persistence and recovery | 70% | HIGH |
| 8 | Error handling | 60% | HIGH |
| 9 | Goal management parity | 30% | CRITICAL |
| 10 | Tick loop and scheduling | 40% | HIGH |

## Detailed Findings

### 1. Workflow Execution Runtime (60%)

**Gaps:**
- No JobQueue integration (uses `setInterval` instead)
- No dead loop detection (only `maxIterations` cap)
- No lifecycle hooks (WorkerExitGate, LeaderCompleteGate, etc.)
- No automatic rate limit handling or model fallback

### 2. Agent Spawning/Session Management (80%)

**Gaps:**
- Space lacks worktree isolation per task
- Sub-session streaming not restarted after daemon restart
- `answerQuestion` tool not implemented via MCP

### 3. Inter-Agent Messaging (90%)

**Parity achieved.** Space's channel topology actually exceeds Room's capability.

### 4. UI Visual Editor (60%)

**Gaps:**
- No Space task list view
- No Space task detail view
- No goal/mission editor for Space
- No human approval UI for Space tasks

**Space leads:** Visual workflow editor with drag-drop canvas, pan/zoom, multi-agent nodes.

### 5. Task/Group Lifecycle (70%)

**Gaps:**
- Missing `draft` and `review` task statuses
- No human review workflow (submitForReview → approve/reject)
- Missing task promotion flow (draft→pending)

### 6. Event Handling/Notifications (80%)

**Gaps:**
- Notification deduplication set not persisted (duplicates after restart)
- No webhook/external notification sink implementation

### 7. Persistence and Recovery (70%)

**Gaps:**
- `pending` workflow runs silently excluded from rehydration
- Sub-session streaming not restarted after daemon restart
- `setInterval` lost on restart (vs JobQueue surviving)

### 8. Error Handling (60%)

**Gaps:**
- No error classification taxonomy
- No rate limit handling
- No dead loop detection

### 9. Goal Management Parity (30%) — CRITICAL

**Major gaps:**
- Space cannot create goals
- Space tasks do not contribute to goal progress
- No autonomy levels (supervised/semi_autonomous)
- No metric tracking
- No cron scheduling for recurring workflows
- `goalId` field is passive metadata only

### 10. Tick Loop and Scheduling (40%)

**Gaps:**
- Uses `setInterval` instead of JobQueue
- No event-driven scheduling (no `scheduleTick()` equivalent)
- No cron/recurring workflow scheduling
- No per-space tick isolation

## Prioritized Implementation Phases

### Phase 1: Critical
1. Goal Management Integration — wire Space tasks to `GoalManager`
2. Dead Loop Detection — track gate failures, detect repeated bounces
3. Notification Sink Improvements — persist dedup set
4. Sub-session Streaming Restart — restart streaming on rehydrate

### Phase 2: High Priority
5. JobQueue Tick Integration
6. Cron/Recurring Workflow Scheduling
7. Space Task List UI
8. Rate Limit Handling

### Phase 3: Medium Priority
9. Human Review Workflow UI
10. Lifecycle Hooks
11. Worktree Isolation for Space

### Phase 4: Future
12. Full Error Classification Taxonomy
13. Goal Creation UI for Space