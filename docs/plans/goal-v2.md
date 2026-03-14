# Goal V2: Mission System -- Autonomous Agent Workflows

## Overview

Evolve NeoKai's current "Goal" feature into a fully autonomous agent workflow system called **"Mission"**. The current system supports basic goal-to-task decomposition with human approval gates. The v2 system adds support for measurable outcome-based missions, recurring/scheduled missions, adaptive replanning, and tiered autonomy levels -- enabling agents to work continuously on long-term objectives with minimal human intervention.

### Naming Decision: "Goal" -> "Mission"

**"Mission"** is chosen for its semantic qualities, not because other AI agent frameworks use the term. Most frameworks use different terminology: CrewAI uses "Task/Crew," LangGraph uses "Graph/Node," AutoGPT uses "Task," OpenAI Agents SDK uses "Agent/Handoff." The HBR enterprise AI framework ("Designing a Successful Agentic AI System") is the primary source that uses "Mission" in the AI agent context.

Why "Mission" over alternatives:
- **vs "Objective"** (OKR-aligned, measurable): Good fit for measurable missions but feels clinical and narrow for recurring/monitoring use cases. "Objective" implies a finish line, which conflicts with recurring missions that run indefinitely.
- **vs "Workflow"**: Too technical, implies step-by-step process rather than outcome pursuit.
- **vs "Project"**: Overloaded, doesn't convey AI autonomy.
- **"Mission"** wins because it: implies sustained effort + clear ownership ("mission owner"), works across all types (one-shot, recurring, monitoring), and is distinct from "task" (the sub-unit).

### Mission Types (V2 Scope)

| Type | Description | Example | Completion |
|------|-------------|---------|------------|
| **One-Shot** | Discrete objective with clear done criteria | "Add dark mode to the app" | Completes when criteria met |
| **Measurable** | Outcome with quantifiable KPI target | "Reduce test suite runtime by 50%" | Completes when KPI target reached |
| **Recurring** | Executes on a schedule, never truly "completes" | "Check email daily, clean spam" | Runs indefinitely on schedule |

**Deferred to future iteration**: Monitoring missions (event-driven triggers via webhooks/file-watch). This requires significant new infrastructure (HTTP endpoints outside MessageHub, new auth mechanisms, filesystem event subscriptions) that conflicts with NeoKai's local-tool architecture. Cron-based monitoring is covered by the Recurring type.

### Current State

The existing system provides:
- `RoomGoal` with status (`active | needs_human | completed | archived`), priority, progress aggregation
- `RoomGoal.metrics?: Record<string, number>` -- existing metrics field for custom progress tracking (already stored as JSON in DB, supported by `GoalManager.updateGoalProgress()` and `GoalRepository`)
- `NeoTask` with full lifecycle (`draft -> pending -> in_progress -> review -> completed/failed/cancelled`)
- Two-phase planning (plan PR -> approval -> task creation)
- Leader-reviewed execution with feedback loops
- Replanning on failure
- Basic progress aggregation (average of linked task progress)

### What V2 Adds

1. **Mission type system** -- Different runtime behaviors for one-shot, measurable, and recurring missions
2. **Structured metrics with targets** -- Extends existing `metrics` field with target values, units, and time-series history
3. **Scheduling engine** -- Cron-based scheduling for recurring missions
4. **Adaptive replanning** -- Smarter replanning that learns from completed/failed tasks
5. **Tiered autonomy levels** -- Configurable human oversight with risk classification and escalation policies
6. **Progress intelligence** -- Type-specific progress tracking beyond simple task averages

---

## Task Breakdown

### Task 1: Shared Types -- Mission Type Definitions and Backward-Compatible Aliases

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: None

**Description**:
Define the new Mission types in `packages/shared/src/types/neo.ts` and update exports. This is a small, safe change that enables all downstream tasks.

1. **New types**:
   - `MissionType = 'one_shot' | 'measurable' | 'recurring'`
   - `AutonomyLevel = 'supervised' | 'semi_autonomous' | 'autonomous'`
   - `MissionMetric`: Extends existing `Record<string, number>` pattern with structured fields:
     ```ts
     interface MissionMetric {
       name: string;
       target: number;
       current: number;
       unit?: string;
     }
     ```
   - `MetricHistoryEntry`: `{ metricName: string; value: number; recordedAt: number }` -- unix timestamp, matches DB `recorded_at INTEGER`
   - `CronSchedule`: `{ expression: string; timezone: string; nextRunAt?: string }`
   - `MissionExecutionStatus = 'running' | 'completed' | 'failed'`

2. **Rename `RoomGoal` -> `Mission`**:
   - New `Mission` interface with all existing `RoomGoal` fields plus:
     - `missionType: MissionType` (default `'one_shot'`)
     - `autonomyLevel: AutonomyLevel` (default `'supervised'`)
     - `structuredMetrics?: MissionMetric[]` (coexists with existing `metrics` field during migration)
     - `schedule?: CronSchedule` (for recurring missions)
     - `schedulePaused?: boolean` (default false -- schedule-level pause flag, orthogonal to mission status)
     - `maxConsecutiveFailures?: number` (default 3)
     - `maxPlanningAttempts?: number` (default 5)
     - `consecutiveFailures?: number` (default 0)
   - Keep `RoomGoal` as `type RoomGoal = Mission` (deprecated alias)

   **Design decision: `maxPlanningAttempts` precedence**: The room-level `config.maxPlanningRetries` (used in `room-runtime.ts` planning gates, default from `RoomConfig`) and the new mission-level `maxPlanningAttempts` could conflict. **Rule: mission-level overrides room-level when set; otherwise fall back to room-level config.** Implementation: extract a shared helper `getEffectiveMaxPlanningAttempts(mission, roomConfig)` that returns `mission.maxPlanningAttempts ?? roomConfig.maxPlanningRetries ?? 5`. All planning/replanning gate checks (in `getNextGoalForPlanning()`, measurable replan logic, etc.) must use this helper — no direct reads of either config value.

   **Design decision: `schedulePaused` vs new GoalStatus value**: Recurring mission pause is a schedule-level boolean flag, NOT a new `GoalStatus` value. Current `GoalStatus` is `'active' | 'needs_human' | 'completed' | 'archived'` with a DB CHECK constraint. Adding `'paused'` would require updating the constraint and modifying `getNextGoalForPlanning()` which only selects `'active'` goals. Instead, `schedulePaused` keeps pause orthogonal to mission status — a recurring mission stays `active` (eligible for tick processing) but the scheduler skips it when `schedulePaused = true`. This mirrors how `RuntimeState.paused` is orthogonal to goal status at the room level.

3. **Update shared exports**: Ensure all new types are exported from `@neokai/shared`

**Acceptance Criteria**:
- New types compile and are exported from `@neokai/shared`
- `RoomGoal` alias exists for backward compatibility
- Existing code that imports `RoomGoal` continues to compile
- Unit tests verify type exports and alias compatibility
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Database Migration -- New Columns and Tables (Physical Table Stays `goals`)

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: Task 1

**Description**:
Add new columns to the existing `goals` table and create supporting tables. The physical table name remains `goals` to avoid breaking historical migrations, reactive DB mappings, SQL queries, and test helpers. The `Mission` name exists only at the type/API layer (Task 1). A physical table rename is deferred to a future coordinated cutover (or may never happen -- many codebases keep legacy table names).

1. **Add new columns to `goals` table** via migration:
   - `mission_type` (TEXT, default `'one_shot'`, CHECK constraint for valid values)
   - `autonomy_level` (TEXT, default `'supervised'`, CHECK constraint for valid values)
   - `schedule` (TEXT/JSON, nullable) -- stores `CronSchedule` for recurring missions
   - `schedule_paused` (INTEGER, default 0) -- boolean flag for pausing recurring schedules (see design note below)
   - `structured_metrics` (TEXT/JSON, nullable) -- stores `MissionMetric[]` with target/current/unit
   - `max_consecutive_failures` (INTEGER, default 3)
   - `max_planning_attempts` (INTEGER, default 5)
   - `consecutive_failures` (INTEGER, default 0)
   - Migrate existing rows: all get `mission_type = 'one_shot'`, `autonomy_level = 'supervised'`
   - **Do NOT rename the table** -- all SQL queries, indexes, reactive DB mappings, and test helpers continue to reference `goals`

2. **Preserve existing `metrics` column**:
   - The existing `metrics` JSON column (`Record<string, number>`) is preserved as-is
   - The new `structured_metrics` column coexists alongside it
   - Migration: existing `metrics` data untouched; `structured_metrics` starts as NULL

3. **New `mission_metric_history` table** for time-series KPI tracking:
   - `id` (TEXT PRIMARY KEY)
   - `goal_id` (TEXT, FK to `goals.id` ON DELETE CASCADE)
   - `metric_name` (TEXT NOT NULL)
   - `value` (REAL NOT NULL)
   - `recorded_at` (INTEGER NOT NULL) -- unix timestamp
   - Index on `(goal_id, metric_name, recorded_at)`
   - This table enables `recordMetric(..., timestamp)` and `getMetricHistory(..., timeRange)` in Task 5

4. **New `mission_executions` table** for recurring mission history:
   - `id, goal_id, started_at, completed_at, status, result_summary, tasks_created` (JSON array of task IDs)
   - Foreign key to `goals` (physical table name)

5. **Update `GoalRepository`** (keep class name for now -- renamed in Task 3):
   - Add CRUD for new columns (mission_type, autonomy_level, schedule, etc.)
   - Add `mission_metric_history` queries (insert, query by time range)
   - Add `mission_executions` queries (insert, list by goal_id, update status)
   - Preserve all existing query patterns and SQL unchanged

**Design note on `schedule_paused`**: Recurring mission pause is implemented as a schedule-level boolean flag (`schedule_paused`) rather than a new `GoalStatus` value. This avoids modifying the existing `CHECK(status IN ('active', 'needs_human', 'completed', 'archived'))` constraint and keeps pause orthogonal to mission status. A recurring mission can be `active` (eligible for tick-loop selection) but have `schedule_paused = 1` (scheduler skips it). This mirrors how `RuntimeState.paused` is orthogonal to goal status at the room level.

**Acceptance Criteria**:
- Migration runs cleanly on fresh DB and on DB with existing goals data
- Physical table name remains `goals` -- all existing SQL queries still work
- Existing `metrics` data is preserved after migration
- New columns have correct defaults and CHECK constraints
- `mission_metric_history` table supports insert and time-range queries
- `mission_executions` table is created and queryable
- `schedule_paused` flag defaults to 0 and is queryable
- Unit tests cover: fresh migration, migration with existing data, new column defaults, metric history CRUD, execution CRUD
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: Backend Rename -- Repository, Manager, RPC Handlers, and Agent References

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: Task 2

**Description**:
Rename all backend goal references to mission. This is a mechanical rename with backward-compatible RPC aliases. The physical DB table stays `goals` (decided in Task 2) -- only class names, method names, RPC endpoints, and event names change.

1. **Rename `GoalRepository` -> `MissionRepository`**:
   - Rename class and method names (e.g., `createGoal` -> `createMission`, `listGoals` -> `listMissions`)
   - All SQL queries continue to reference the physical `goals` table -- only the TypeScript API changes
   - Update reactive DB table mappings: method names change but table string stays `'goals'`
   - Update database facade methods and public getter

2. **Rename `GoalManager` -> `MissionManager`**:
   - Rename class, methods, and internal references
   - Update constructor and dependency injection in `RoomRuntime`
   - Preserve all existing functionality exactly

3. **Rename RPC handlers** (`goal-handlers.ts` -> `mission-handlers.ts`):
   - Rename all `goal.*` handlers to `mission.*`
   - Register backward-compatible aliases: `goal.create` -> `mission.create`, etc.
   - No new handlers in this task (new handlers added in feature tasks)

4. **Update agent references**:
   - Planner, Coder, General, Leader agent prompts: `goal` -> `mission` in system prompts
   - Room agent tools: `create_goal` -> `create_mission`, etc. (keep old names as aliases)
   - Update `room-runtime.ts` references

5. **Update event names**:
   - `goal.created` -> `mission.created`, `goal.updated` -> `mission.updated`, etc.
   - Emit both old and new event names during transition period

6. **Update all remaining imports/references** in `packages/daemon/` and `packages/shared/`
   - Update test files (10+ files with goal references, test helpers with table creation SQL)

**Acceptance Criteria**:
- All existing goal-related tests pass with renamed entities
- SQL queries still reference `goals` table (no physical rename)
- RPC handlers respond to both `goal.*` and `mission.*` namespaces
- Event subscriptions work with both old and new event names
- No TypeScript compilation errors
- Unit tests verify backward-compatible aliases work
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Frontend Rename -- Goal to Mission in UI

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: Task 1

**Description**:
Rename all frontend goal references to mission. This can run in parallel with Tasks 2-3 since it depends only on shared types (Task 1).

1. **Update RoomStore** (`packages/web/src/`):
   - Rename signals: `goals` -> `missions`, `createGoal` -> `createMission`, etc.
   - Update event subscriptions to use `mission.*` events (support both during transition)

2. **Update UI components**:
   - All component names, labels, and text: "Goal" -> "Mission"
   - Room dashboard, context panel, goal list, goal detail views

3. **Update type imports**: `RoomGoal` -> `Mission` throughout `packages/web/`

**Acceptance Criteria**:
- All "Goal" references in UI text replaced with "Mission"
- RoomStore uses `Mission` types and `mission.*` events
- UI functions correctly with both old and new backend event names
- E2E tests for basic mission display (rename doesn't break existing flows)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Measurable Mission Support -- Structured Metrics and Adaptive Replanning

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 3

**Description**:
Implement the measurable mission type with structured KPI tracking and adaptive replanning.

1. **Structured metrics in MissionManager**:
   - `recordMetric(missionId, metricName, value, timestamp)`: Update `current` in `structured_metrics` JSON AND insert a row into `mission_metric_history` table (created in Task 2)
   - `getMetricHistory(missionId, metricName, timeRange)`: Query `mission_metric_history` table by `(goal_id, metric_name, recorded_at)` index
   - `checkMetricTargets(missionId)`: Compare each metric's `current` against `target`, return pass/fail per metric
   - Progress calculation for measurable missions: `progress = average(min(current/target, 1.0) * 100)` across all metrics
   - **Migration from existing `metrics` field**: If a mission has `metrics` but no `structured_metrics`, treat `metrics` values as current values with no targets (one-shot behavior preserved)

2. **Runtime behavior for measurable missions** in `RoomRuntime`:
   - After all linked tasks complete, call `checkMetricTargets()`
   - If all targets met -> complete mission
   - If targets not met AND `planning_attempts < getEffectiveMaxPlanningAttempts(mission, roomConfig)` -> trigger replanning with metric context (use shared helper defined in Task 1 design decisions)
   - If targets not met AND attempts exhausted -> set status to `needs_human`
   - Replanning context includes: current metric values, historical trend, completed tasks summary, failed tasks and their errors

3. **Planner agent context for measurable missions**:
   - Include metric targets and current values in planning prompt
   - Include history of previous planning attempts and their outcomes
   - Guide planner to adjust strategy based on what worked/didn't work

4. **MCP tool updates** for room agent:
   - `record_metric(mission_id, metric_name, value)`: Agents can report metric progress
   - `get_metrics(mission_id)`: View current metric state and targets

**Acceptance Criteria**:
- Metrics can be recorded, queried, and compared against targets
- Existing `metrics` field data continues to work (backward compatible)
- Measurable missions auto-replan when tasks complete but targets aren't met
- Replanning stops after `maxPlanningAttempts` and escalates to `needs_human`
- Progress shows metric-based calculation for measurable missions
- Unit tests for metric CRUD, target checking, replan triggering, and attempt cap
- Online tests for the full measure -> replan -> re-execute loop
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6: Recurring Mission Support -- Scheduling Engine

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 3

**Description**:
Implement recurring mission support with cron-based scheduling.

1. **Schedule types and parsing**:
   - Support cron expressions (e.g., `0 9 * * *` for daily at 9 AM)
   - Support simple presets: `@daily`, `@weekly`, `@hourly`
   - Store timezone with schedule (default: system timezone)
   - Calculate and store `next_run_at` timestamp

2. **Make `getNextGoalForPlanning()` mission-type aware** (critical):
   - Current behavior: any `active` goal with no linked tasks or all-failed tasks is immediately selected for planning. This means a newly created recurring mission with `next_run_at` in the future would be planned immediately by the existing tick loop.
   - **Required change**: `getNextGoalForPlanning()` must skip `mission_type = 'recurring'` goals entirely. Recurring missions are planned ONLY through the scheduler path (step 3 below), never through the standard planning selector.
   - This is the cleanest separation: the planning selector handles one-shot and measurable missions (plan immediately when active); the scheduler handles recurring missions (plan only when schedule is due).

3. **Scheduler in RoomRuntime**:
   - On tick (after standard planning selector runs), check for recurring missions where `next_run_at <= now` AND `schedule_paused = false`
   - When triggered: create a new execution cycle (plan -> tasks -> execute)
   - After execution completes: calculate next `next_run_at` from cron expression
   - Each execution cycle is independent (stateless execution with external state)
   - Pass previous execution `result_summary` as context for the next cycle

   **Lifecycle edge cases** (must be specified):
   - **Precision/jitter**: Acceptable. Tick interval (30s) means up to 30s jitter. This is fine for all supported presets (`@hourly` and coarser). Document this limitation.
   - **Daemon restart with past-due schedule**: On startup, if `next_run_at` is in the past, fire immediately (catch-up). Then calculate next `next_run_at` from the current time, not from the missed time (skip missed intervals, don't queue them all).
   - **Overlap prevention**: If a recurring mission has an execution cycle still `running`, skip the trigger. Do not start concurrent executions of the same recurring mission. Log a warning.
   - **Room runtime state interaction**: Recurring missions only fire when `RuntimeState === 'running'`. When paused/stopped, `next_run_at` is not recalculated. On resume, recalculate `next_run_at` from current time.

3. **Execution history** (uses `mission_executions` table from Task 2):
   - Each schedule trigger creates a new execution record
   - Store `result_summary` from completed tasks
   - Mission progress shows latest execution status, not aggregate across all executions

4. **Lifecycle management**:
   - Recurring missions never auto-complete; only manual archive
   - Pause via `schedule_paused` flag (defined in Task 1, column added in Task 2): setting `schedule_paused = true` causes the scheduler to skip this mission without changing its `active` status
   - Resume sets `schedule_paused = false` and recalculates `next_run_at` from current time
   - `getNextGoalForPlanning()` is modified to skip `mission_type = 'recurring'` (step 2 above) -- recurring missions are planned only through the scheduler path

5. **MCP tools**:
   - `set_schedule(mission_id, cron, timezone)`: Set/update schedule
   - `pause_schedule(mission_id)` / `resume_schedule(mission_id)`: Toggle `schedule_paused` flag

**Acceptance Criteria**:
- `getNextGoalForPlanning()` skips `mission_type = 'recurring'` (recurring missions never planned by standard selector)
- Cron expressions parsed correctly with timezone support
- Scheduler triggers execution at the right times (within 30s jitter)
- Overlap prevention works (no concurrent executions of same mission)
- Daemon restart catches up on past-due schedules correctly
- `schedule_paused` flag prevents firing; resuming recalculates `next_run_at` correctly
- Each execution cycle is independent with proper context passing
- Execution history is recorded and queryable
- Unit tests for: cron parsing, schedule calculation, overlap prevention, daemon restart catch-up, pause/resume
- Online tests for a triggered recurring execution cycle
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 7: Autonomy Levels -- Tiered Human Oversight with Safety Controls

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 3

**Description**:
Implement tiered autonomy levels that control how much human oversight is required. This task modifies the core approval flow (`submittedForReview` / `approved` semantics, `complete_task` gate, and plan approval).

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
     - Escalation to human on: repeated failures, explicit uncertainty, or mission-level error

2. **Modify the `complete_task` gate** (`room-runtime.ts` line ~628):
   - Current gate: requires `submittedForReview === true` OR `approved === true`
   - New behavior: check mission `autonomyLevel` first:
     - `supervised`: unchanged -- requires `submittedForReview` + human `approved`
     - `semi_autonomous` / `autonomous`: Leader can call `complete_task` directly
       - Runtime auto-sets `approved = true` on the session group (no human action needed)
       - Lifecycle hooks (`checkLeaderPrMerged`, `checkWorkerPrMerged`) still run -- PR must actually be merged
       - `submittedForReview` is skipped (Leader does not need to call `submit_for_review` first)

3. **Modify the plan approval flow** (`room-runtime.ts` `resumeWorkerFromHuman`):
   - Current: human calls `task.approve` RPC -> sets `approved = true` -> Leader can create tasks
   - New behavior for `autonomous` mode:
     - After Leader reviews the plan PR and is satisfied, Leader calls a new tool: `auto_approve_plan(task_id)`
     - This tool (available only when `autonomyLevel === 'autonomous'`):
       - Sets `approved = true` on the session group (same as human approval)
       - Sets `submittedForReview = false` (clears the review state)
       - Resumes the planner to enter Phase 2 (task creation)
     - Plan PR is still created for auditability -- Leader merges it after self-approval
   - For `semi_autonomous`: plan approval still requires human (current flow)

4. **Handle merge failures gracefully**:
   - If `gh pr merge` fails (branch protection, conflicts, permissions):
     - Existing `checkLeaderPrMerged()` / `checkWorkerPrMerged()` lifecycle hooks already detect CLOSED/non-MERGED state and bounce a message back to the agent
     - In autonomous mode: after 2 merge retries, escalate to `needs_human` (don't loop forever)
     - Track merge retry count in session group metadata

5. **Notification system** (foundation):
   - Emit events when tasks complete without human review: `mission.task.auto_completed`
   - Emit events for autonomous plan approvals: `mission.plan.auto_approved`
   - Notification payload must include: mission ID, task ID, task title, summary of changes (e.g., PR URL, files changed count), autonomy level that allowed auto-completion
   - These events are broadcast via MessageHub for UI consumption

6. **Escalation policy**:
   - Track `consecutive_failures` per mission (column added in Task 2)
   - When `consecutiveFailures >= maxConsecutiveFailures`: set mission status to `needs_human`
   - Reset counter on successful task completion
   - On escalation, notification includes: failure count, last error, mission context

7. **Audit trail**:
   - All auto-approved completions are logged in session group messages (already mirrored by existing infrastructure)
   - PRs serve as immutable audit trail (code changes are always committed)
   - `mission_executions` table records outcome of each execution cycle

**Acceptance Criteria**:
- Three autonomy levels work as described
- `supervised` mode behavior is unchanged from current system
- `semi_autonomous` allows Leader to complete tasks without human approval, but requires human plan approval
- `autonomous` allows Leader to self-approve plans via `auto_approve_plan` tool, and complete tasks directly
- `complete_task` gate correctly checks autonomy level before enforcing human approval
- Merge failures escalate to `needs_human` after retries in autonomous mode
- Notification payloads contain enough context to understand what happened
- Escalation triggers correctly after consecutive failures and resets on success
- Audit trail is available via session group messages and PRs
- Unit tests for: each autonomy level's gate behavior, `auto_approve_plan` tool, escalation counter, merge failure retry, notification payloads
- Online tests for semi-autonomous task completion flow and autonomous plan approval flow
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 8: Frontend -- Mission Type UI and Dashboard

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 4, Task 5, Task 6, Task 7

**Description**:
Add mission-type-specific UI features to the frontend. The basic rename is done in Task 4; this task adds the new mission type functionality.

1. **Mission creation form enhancements**:
   - Mission type selector (one-shot, measurable, recurring)
   - Conditional fields based on type:
     - Measurable: metric name, target value, unit (add/remove multiple metrics)
     - Recurring: schedule preset dropdown or custom cron input, timezone selector
   - Autonomy level selector with descriptions of each level

2. **Mission detail view -- type-specific displays**:
   - One-shot: task progress bar (current behavior)
   - Measurable: metric current vs target display, progress percentage per metric
   - Recurring: next execution time, execution history list with status/summary
   - Autonomy level indicator badge

3. **Mission dashboard updates**:
   - Group or filter missions by type
   - Show schedule/next-run for recurring missions
   - Show metric progress for measurable missions
   - Notification feed for autonomous completions (from `mission.task.auto_completed` events)

**Acceptance Criteria**:
- Mission creation supports all three types with appropriate conditional fields
- Detail view shows type-specific information
- Dashboard displays missions with type-specific details
- E2E tests for: creating a one-shot mission, creating a measurable mission with metrics, creating a recurring mission with schedule
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 9: Integration Testing and Documentation

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 5, Task 6, Task 7, Task 8

**Description**:
Comprehensive integration testing across all mission features and documentation updates.

1. **Online integration tests**:
   - Full lifecycle test for each mission type:
     - One-shot: create -> plan -> execute -> complete
     - Measurable: create -> plan -> execute -> measure -> replan -> complete
     - Recurring: create -> schedule -> trigger -> execute -> next trigger
   - Autonomy level tests:
     - Supervised: human gates enforced
     - Semi-autonomous: Leader completes, human notified
     - Autonomous: full auto with escalation on failure
   - Migration test: existing goals work as one-shot missions with `supervised` autonomy
   - Coverage target: new mission code paths should have >= 80% line coverage

2. **E2E tests**:
   - Create each mission type through UI
   - View mission progress for measurable missions
   - View execution history for recurring missions
   - Change autonomy level through settings

3. **Documentation**:
   - Update `CLAUDE.md` with mission system terminology and architecture
   - Update agent prompts to use "mission" instead of "goal"

**Acceptance Criteria**:
- All online integration tests pass
- E2E tests cover the three mission types and autonomy levels
- CLAUDE.md updated with mission terminology
- New mission code has >= 80% line coverage
- No regressions in existing test suite
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependency Graph

```
Task 1 (Shared Types)
  ├─> Task 2 (DB Migration) ─> Task 3 (Backend Rename) ─┬─> Task 5 (Measurable) ──┐
  │                                                      ├─> Task 6 (Recurring) ───┤
  │                                                      └─> Task 7 (Autonomy) ───┤
  │                                                                                │
  └─> Task 4 (Frontend Rename) ───────────────────────────────────────────────┐    │
                                                                              v    v
                                                                     Task 8 (Frontend Features)
                                                                              │
                                                                              v
                                                                     Task 9 (Integration Tests)
```

- Task 1 has no dependencies and unblocks everything
- Tasks 2 -> 3 are sequential (DB first, then backend rename)
- Task 4 (frontend rename) depends only on Task 1 and can run in parallel with Tasks 2-3
- Tasks 5, 6, 7 can run in parallel after Task 3
- Task 8 (frontend features) depends on Tasks 4, 5, 6, 7
- Task 9 (integration tests) depends on Tasks 5, 6, 7, 8

## Future Work (Out of Scope for V2)

- **Monitoring missions**: Event-driven triggers via webhooks, file-watch, and external event sources. Requires new HTTP endpoint infrastructure, mission-specific authentication tokens, and filesystem event subscriptions -- significant new subsystems that should be designed separately.
- **Budget/cost controls**: Per-mission API call or token budgets with automatic pause on budget exceeded. Requires cost tracking infrastructure that doesn't exist yet.
- **Advanced risk classification**: Heuristic-based risk scoring for semi-autonomous mode (e.g., by file type, lines changed, destructive operations). V2 treats all tasks equally within an autonomy level; risk classification would allow per-task override.
