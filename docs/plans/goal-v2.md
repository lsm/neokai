# Goal V2: Mission System -- Autonomous Agent Workflows

## Overview

Evolve NeoKai's current "Goal" feature into a fully autonomous agent workflow system called **"Mission"**. The current system supports basic goal-to-task decomposition with human approval gates. The v2 system adds support for measurable outcome-based missions, recurring/scheduled missions, continuous monitoring, adaptive replanning, and progress tracking -- enabling agents to work continuously on long-term objectives with minimal human intervention.

### Naming Decision: "Goal" -> "Mission"

Based on deep research across major AI agent frameworks (CrewAI, LangGraph, AutoGPT, OpenAI Agents SDK) and enterprise literature (HBR's "Designing a Successful Agentic AI System"), **"Mission"** is the strongest replacement for "Goal":

- **Outcome-oriented**: Implies sustained effort toward a measurable outcome, not just task execution
- **Ownership**: Naturally implies a "mission owner" (the human) and "mission agents" (the AI)
- **Scope**: Works across all types -- one-shot missions, recurring missions, monitoring missions
- **Distinction**: Clearly differentiates from "task" (the sub-unit) and "goal" (overloaded term)
- **Industry precedent**: Used in HBR's enterprise AI framework; distinct from "workflow" (too technical) or "project" (too generic)

### Mission Types

| Type | Description | Example | Completion |
|------|-------------|---------|------------|
| **One-Shot** | Discrete objective with clear done criteria | "Add dark mode to the app" | Completes when criteria met |
| **Measurable** | Outcome with quantifiable KPI target | "Get 10,000 Twitter followers" | Completes when KPI target reached |
| **Recurring** | Executes on a schedule, never truly "completes" | "Check email daily, clean spam" | Runs indefinitely on schedule |
| **Monitoring** | Always-on, event-driven, acts on triggers | "Watch CI for failures, auto-fix" | Runs indefinitely, acts on events |

### Current State

The existing system provides:
- `RoomGoal` with status (`active | needs_human | completed | archived`), priority, progress aggregation
- `NeoTask` with full lifecycle (`draft -> pending -> in_progress -> review -> completed/failed/cancelled`)
- Two-phase planning (plan PR -> approval -> task creation)
- Leader-reviewed execution with feedback loops
- Replanning on failure
- Basic progress aggregation (average of linked task progress)

### What V2 Adds

1. **Mission type system** -- Different behaviors for one-shot, measurable, recurring, and monitoring missions
2. **Metrics and KPI tracking** -- Structured metrics with targets, current values, and history
3. **Scheduling engine** -- Cron-based scheduling for recurring missions
4. **Adaptive replanning** -- Smarter replanning that learns from completed/failed tasks
5. **Autonomous loop improvements** -- Reduced human gates for low-risk operations, escalation policies
6. **Mission lifecycle hooks** -- Event-driven triggers for monitoring missions
7. **Progress intelligence** -- Better progress tracking beyond simple task averages

---

## Task Breakdown

### Task 1: Research Document -- Mission System Design Specification

**Agent**: `general`
**Priority**: `high`
**Dependencies**: None

**Description**:
Produce a detailed technical design document (`docs/design/mission-system.md`) that covers:

1. **Data model changes**: Define the `Mission` type (replacing `RoomGoal`) with:
   - `missionType: 'one_shot' | 'measurable' | 'recurring' | 'monitoring'`
   - `metrics: MissionMetric[]` for measurable missions (name, target, current, unit, history)
   - `schedule: CronSchedule` for recurring missions (cron expression, timezone, next_run_at)
   - `triggers: MissionTrigger[]` for monitoring missions (event type, condition, action)
   - `autonomyLevel: 'supervised' | 'semi_autonomous' | 'autonomous'` to control human gate frequency
   - `maxConsecutiveFailures: number` before escalating to `needs_human`
   - Backward compatibility: migration path from `RoomGoal` to `Mission`

2. **Database schema changes**: New columns/tables needed, migration strategy

3. **Runtime behavior changes**: How `RoomRuntime` handles each mission type differently:
   - One-shot: Current behavior (plan -> execute -> complete)
   - Measurable: Plan -> execute -> measure -> replan if not met -> repeat
   - Recurring: Schedule -> execute -> sleep -> repeat
   - Monitoring: Listen for events -> execute -> return to listening

4. **Autonomy level design**: Define what each level means:
   - `supervised`: Current behavior (all tasks reviewed by human)
   - `semi_autonomous`: Leader can complete low-risk tasks; human reviews high-risk
   - `autonomous`: Leader completes all tasks; human notified asynchronously

5. **API surface**: New/changed RPC handlers, MCP tool changes

6. **Migration strategy**: How to rename `goal` -> `mission` across the codebase without breaking existing data

**Acceptance Criteria**:
- Design document committed to `docs/design/mission-system.md`
- Covers all four mission types with concrete data model definitions
- Includes database migration SQL
- Includes API surface changes (RPC handlers + MCP tools)
- Reviewed and approved by Leader
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Database Schema Migration -- Goal to Mission Rename + New Fields

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: Task 1

**Description**:
Implement the database schema changes to support the Mission system:

1. **Rename `goals` table to `missions`** with backward-compatible migration:
   - Add new columns: `mission_type` (default `'one_shot'`), `schedule` (JSON, nullable), `triggers` (JSON, nullable), `autonomy_level` (default `'supervised'`), `max_consecutive_failures` (default 3)
   - Add `metrics_history` table for time-series KPI tracking
   - Migrate existing `goals` data to new schema
   - Update all indexes

2. **Update `GoalManager` -> `MissionManager`**:
   - Rename class and all methods
   - Add mission-type-specific validation
   - Add metrics CRUD operations
   - Add schedule management methods
   - Preserve all existing functionality

3. **Update shared types** (`packages/shared/src/types/neo.ts`):
   - Rename `RoomGoal` -> `Mission` with new fields
   - Add `MissionType`, `MissionMetric`, `CronSchedule`, `MissionTrigger`, `AutonomyLevel` types
   - Keep `RoomGoal` as deprecated type alias for backward compatibility during transition

4. **Update RPC handlers** (`goal-handlers.ts` -> `mission-handlers.ts`):
   - Rename all `goal.*` handlers to `mission.*`
   - Add backward-compatible aliases for `goal.*` that forward to `mission.*`
   - Add new handlers: `mission.updateMetrics`, `mission.setSchedule`, `mission.setTriggers`

5. **Update all imports and references** across the codebase

**Acceptance Criteria**:
- Database migration runs cleanly on fresh DB and on DB with existing goals
- All existing goal tests pass with renamed entities
- New types are properly exported from `@neokai/shared`
- RPC handlers work with both `goal.*` (deprecated) and `mission.*` namespaces
- Unit tests cover migration, new field validation, and backward compatibility
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: Measurable Mission Support -- Metrics Tracking and Adaptive Replanning

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 2

**Description**:
Implement the measurable mission type with KPI tracking and adaptive replanning:

1. **Metrics tracking in MissionManager**:
   - `recordMetric(missionId, metricName, value, timestamp)`: Record a KPI measurement
   - `getMetricHistory(missionId, metricName, timeRange)`: Query historical values
   - `checkMetricTargets(missionId)`: Compare current values against targets, return pass/fail per metric
   - Progress calculation for measurable missions: `progress = (currentValue / targetValue) * 100`

2. **Runtime behavior for measurable missions** in `RoomRuntime`:
   - After all tasks complete, call `checkMetricTargets()`
   - If all targets met -> complete mission
   - If targets not met -> trigger replanning with metric context
   - Replanning context includes: current metric values, historical trend, completed tasks summary, what was tried
   - Cap replanning attempts (`planning_attempts` already exists, add `max_planning_attempts` to mission config)

3. **Planner agent context for measurable missions**:
   - Include metric targets and current values in planning prompt
   - Include history of previous planning attempts and their outcomes
   - Guide planner to adjust strategy based on what worked/didn't work

4. **MCP tool updates** for room agent:
   - `record_metric(mission_id, metric_name, value)`: Agents can report metric progress
   - `get_metrics(mission_id)`: View current metric state

**Acceptance Criteria**:
- Metrics can be recorded, queried, and compared against targets
- Measurable missions auto-replan when tasks complete but targets aren't met
- Replanning includes full context of previous attempts
- Progress shows metric-based calculation for measurable missions
- Unit tests for metric CRUD, target checking, and replan triggering
- Online tests for the full measure -> replan -> re-execute loop
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Recurring Mission Support -- Scheduling Engine

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 2

**Description**:
Implement recurring mission support with cron-based scheduling:

1. **Schedule types and parsing**:
   - Support cron expressions (e.g., `0 9 * * *` for daily at 9 AM)
   - Support simple presets: `@daily`, `@weekly`, `@hourly`
   - Store timezone with schedule
   - Calculate and store `next_run_at` timestamp

2. **Scheduler in RoomRuntime**:
   - On tick, check for recurring missions where `next_run_at <= now`
   - When triggered: create a new execution cycle (plan -> tasks -> execute)
   - After execution completes: calculate next `next_run_at` from cron expression
   - Each execution cycle is independent (stateless execution with external state)
   - Pass previous execution results as context for the next cycle

3. **Execution history for recurring missions**:
   - New `mission_executions` table: `id, mission_id, started_at, completed_at, status, result_summary, tasks_created`
   - Each schedule trigger creates a new execution record
   - Mission progress shows latest execution status, not aggregate

4. **Lifecycle management**:
   - Recurring missions never auto-complete; only manual archive/pause
   - Add `paused` status for temporarily stopping recurring missions
   - Resume from pause recalculates `next_run_at`

5. **MCP tools**:
   - `set_schedule(mission_id, cron, timezone)`: Set/update schedule
   - `pause_mission(mission_id)` / `resume_mission(mission_id)`: Control recurring execution

**Acceptance Criteria**:
- Cron expressions parsed correctly with timezone support
- Scheduler triggers execution at the right times
- Each execution cycle is independent with proper context passing
- Execution history is recorded and queryable
- Pausing/resuming works correctly with schedule recalculation
- Unit tests for cron parsing, schedule calculation, and execution lifecycle
- Online tests for a triggered recurring execution cycle
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Autonomy Levels -- Reducing Human Gates for Low-Risk Operations

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 2

**Description**:
Implement tiered autonomy levels that control how much human oversight is required:

1. **Autonomy level enforcement in RoomRuntime**:
   - `supervised` (default, current behavior):
     - All task completions require human approval
     - Plan approval required before task creation
     - Leader cannot auto-complete tasks
   - `semi_autonomous`:
     - Leader can complete tasks without human approval
     - Plan still requires human approval
     - Failed tasks escalate to human after `maxConsecutiveFailures`
     - Human notified asynchronously of completions
   - `autonomous`:
     - Leader can complete tasks and approve plans
     - Human notified asynchronously of all decisions
     - Escalation to human only on: repeated failures, budget exceeded, or explicit uncertainty

2. **Update Leader agent behavior**:
   - `complete_task` tool: Check mission autonomy level before requiring human approval
   - In `semi_autonomous` / `autonomous`: Leader's approval is sufficient
   - In `supervised`: Current behavior (human gate)

3. **Update plan approval flow**:
   - In `autonomous` mode: Leader can approve plans directly
   - Skip `submit_for_review` human gate
   - Still create PR for auditability, but auto-merge after Leader approval

4. **Notification system** (foundation):
   - Emit events when tasks complete without human review: `mission.task.auto_completed`
   - Emit events for autonomous plan approvals: `mission.plan.auto_approved`
   - These events are broadcast via MessageHub for UI consumption

5. **Escalation policy**:
   - Track consecutive failures per mission
   - When `consecutiveFailures >= maxConsecutiveFailures`: set mission status to `needs_human`
   - Reset counter on successful task completion

**Acceptance Criteria**:
- Three autonomy levels work as described
- `supervised` mode behavior is unchanged from current system
- `semi_autonomous` allows Leader to complete tasks but requires human plan approval
- `autonomous` allows full agent autonomy with async notifications
- Escalation triggers correctly after consecutive failures
- Unit tests for each autonomy level's gate behavior
- Online tests for semi-autonomous task completion flow
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6: Frontend -- Mission UI Updates

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 2, Task 3, Task 4, Task 5

**Description**:
Update the frontend to support the new Mission system:

1. **Rename Goal -> Mission in UI**:
   - Update all component names, labels, and text
   - Update RoomStore signals and methods
   - Update event subscriptions (`goal.*` -> `mission.*`, support both during transition)

2. **Mission creation form**:
   - Mission type selector (one-shot, measurable, recurring, monitoring)
   - Conditional fields based on type:
     - Measurable: metric name, target value, unit
     - Recurring: schedule preset or custom cron, timezone
     - Monitoring: event type, condition description
   - Autonomy level selector with descriptions

3. **Mission detail view**:
   - Type-specific progress display:
     - One-shot: task progress bar (current behavior)
     - Measurable: metric value vs target with trend chart
     - Recurring: next execution time, execution history list
     - Monitoring: event log, trigger count
   - Autonomy level indicator
   - Execution history for recurring missions

4. **Mission dashboard updates**:
   - Group missions by type
   - Show schedule/next-run for recurring missions
   - Show metric progress for measurable missions
   - Notification feed for autonomous completions

**Acceptance Criteria**:
- All "Goal" references renamed to "Mission" in UI
- Mission creation supports all four types with appropriate fields
- Detail view shows type-specific information
- Dashboard groups and displays missions by type
- E2E tests for mission creation flow (at least one-shot and recurring types)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 7: Monitoring Mission Support -- Event-Driven Triggers

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 4 (shares execution infrastructure), Task 5

**Description**:
Implement monitoring missions that react to events:

1. **Trigger system**:
   - Define trigger types: `cron` (time-based, reuse from Task 4), `webhook` (HTTP endpoint), `file_watch` (filesystem changes), `manual` (on-demand)
   - Trigger condition: simple expression evaluated against event payload
   - Trigger action: spawn execution cycle with event context

2. **Webhook endpoint** (new RPC handler):
   - `POST /api/missions/:id/trigger` -- External systems can trigger a monitoring mission
   - Payload passed as context to the execution cycle
   - Authentication via mission-specific token

3. **File watch integration** (if applicable to workspace):
   - Watch specified paths for changes
   - Debounce rapid changes
   - Pass changed files as context

4. **Runtime integration**:
   - RoomRuntime manages active monitors
   - Each trigger type has a listener that spawns execution cycles
   - Execution cycles follow same plan -> execute -> complete flow
   - Monitor state persists across daemon restarts

**Acceptance Criteria**:
- Webhook triggers create execution cycles with correct context
- Cron-based monitoring reuses recurring infrastructure
- File watch triggers work for workspace paths
- Monitor state survives daemon restart
- Unit tests for trigger evaluation and execution spawning
- Online tests for webhook-triggered execution
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 8: Integration Testing and Documentation

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 3, Task 4, Task 5, Task 6, Task 7

**Description**:
Comprehensive integration testing and documentation:

1. **Online integration tests**:
   - Full lifecycle test for each mission type:
     - One-shot: create -> plan -> execute -> complete
     - Measurable: create -> plan -> execute -> measure -> replan -> complete
     - Recurring: create -> schedule -> trigger -> execute -> next trigger
     - Monitoring: create -> configure trigger -> receive event -> execute
   - Autonomy level tests:
     - Supervised: human gates enforced
     - Semi-autonomous: Leader completes, human notified
     - Autonomous: full auto with escalation on failure
   - Migration test: existing goals work as one-shot missions

2. **E2E tests**:
   - Create each mission type through UI
   - View mission progress for measurable missions
   - View execution history for recurring missions
   - Change autonomy level through settings

3. **Documentation**:
   - Update `CLAUDE.md` with mission system terminology
   - Update agent prompts to use "mission" instead of "goal"
   - Add inline code comments for complex scheduling/trigger logic

**Acceptance Criteria**:
- All online integration tests pass
- E2E tests cover the four mission types
- CLAUDE.md updated with mission terminology
- No regressions in existing test suite
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependency Graph

```
Task 1 (Design Spec)
  └─> Task 2 (DB Schema + Rename)
        ├─> Task 3 (Measurable Missions) ──────────┐
        ├─> Task 4 (Recurring Missions) ───────┐   │
        └─> Task 5 (Autonomy Levels) ─────┐   │   │
              │                            │   │   │
              v                            v   v   v
        Task 7 (Monitoring Missions) ──> Task 6 (Frontend)
              │                            │
              v                            v
        Task 8 (Integration Tests + Docs) <┘
```

- Tasks 3, 4, 5 can run in parallel after Task 2
- Task 6 depends on Tasks 2, 3, 4, 5 (needs all backend features)
- Task 7 depends on Tasks 4 and 5 (reuses scheduling + autonomy)
- Task 8 depends on Tasks 3, 4, 5, 6, 7 (tests everything)
