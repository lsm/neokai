# Goal V2: Mission System -- Autonomous Agent Workflows

## Overview

Evolve NeoKai's current "Goal" feature into a fully autonomous agent workflow system called **"Mission"**. The current system supports basic goal-to-task decomposition with human approval gates. The v2 system adds support for measurable outcome-based missions, recurring/scheduled missions, adaptive replanning, and tiered autonomy levels -- enabling agents to work continuously on long-term objectives with minimal human intervention.

### Naming Strategy

**"Mission"** is the user-facing name for the concept currently called "Goal" internally. It is chosen for its semantic qualities — sustained effort, clear ownership, outcome orientation — not because other frameworks use it (only HBR's enterprise AI framework does).

Why "Mission" over alternatives:
- **vs "Objective"**: Implies a finish line, conflicts with recurring missions that run indefinitely.
- **vs "Workflow"**: Too technical, implies step-by-step process rather than outcome pursuit.
- **vs "Project"**: Overloaded, doesn't convey AI autonomy.

**Rename strategy**: For this iteration, `goal` remains the internal name across storage, runtime, RPCs, events, and backend code. `Mission` is introduced at the **type-alias layer** (`type Mission = RoomGoal` in shared types) and the **UI copy layer** (labels, text, component names). A full backend/API rename is deferred to a future iteration if still justified — this avoids creating a giant conflict surface for every feature task.

### Mission Types (V2 Scope)

| Type | Description | Example | Completion |
|------|-------------|---------|------------|
| **One-Shot** | Discrete objective with clear done criteria | "Add dark mode to the app" | Completes when criteria met |
| **Measurable** | Outcome with quantifiable KPI target | "Reduce test suite runtime by 50%" | Completes when KPI target reached |
| **Recurring** | Executes on a schedule, never truly "completes" | "Check email daily, clean spam" | Runs indefinitely on schedule |

**Deferred to future iteration**: Monitoring missions (event-driven triggers via webhooks/file-watch). Cron-based monitoring is covered by the Recurring type.

### Current State

The existing system provides:
- `RoomGoal` with status (`active | needs_human | completed | archived`), priority, progress aggregation
- `RoomGoal.metrics?: Record<string, number>` -- existing metrics field for custom progress tracking
- `RoomGoal.linkedTaskIds: string[]` -- tasks linked to goal, used for progress aggregation
- `RoomGoal.planning_attempts?: number` -- lifetime counter, incremented per planning spawn
- `NeoTask` with full lifecycle (`draft -> pending -> in_progress -> review -> completed/failed/cancelled`)
- Session groups with metadata (`submittedForReview`, `approved`, `workerRole`, etc.) -- the runtime's unit of active work
- Recovery via `findZombieGroups()` / `recoverZombieGroups()` on each tick -- re-registers sessions from DB
- Two-phase planning (plan PR -> approval -> task creation)
- Progress aggregation: average of all linked task progress values

### What V2 Adds

1. **Mission type system** -- Different runtime behaviors for one-shot, measurable, and recurring missions
2. **Structured metrics with targets** -- Extends existing metrics with target values, units, and time-series history
3. **Scheduling engine** -- Cron-based scheduling for recurring missions with execution identity
4. **Adaptive replanning** -- Smarter replanning that learns from completed/failed tasks
5. **Narrowed autonomy slice** -- Semi-autonomous mode for coder/general tasks only (plan approval stays human-gated)
6. **UI terminology** -- "Mission" in user-facing copy and component names

### Cross-Cutting Design Decisions

**`maxPlanningAttempts` precedence**: Room-level `config.maxPlanningRetries` (retries = N means N+1 total attempts) and mission-level `maxPlanningAttempts` (attempts = N means N total) could conflict. **Rule**: mission-level takes precedence when set; otherwise fall back to `roomConfig.maxPlanningRetries + 1`; default 5. Implementation: shared helper `getEffectiveMaxPlanningAttempts(mission, roomConfig)` used in all gate checks.

**`schedulePaused` as a boolean flag**: Recurring mission pause is a schedule-level flag (`schedule_paused` column), NOT a new `GoalStatus`. Current status CHECK constraint (`'active' | 'needs_human' | 'completed' | 'archived'`) stays unchanged. A recurring mission stays `active` but the scheduler skips it when `schedule_paused = true`. This mirrors how `RuntimeState.paused` is orthogonal to goal status at the room level.

**Metrics precedence**: For measurable missions, `structured_metrics` is the authoritative source. The existing `metrics` column becomes read-only (derived from `structured_metrics` for backward compatibility). For one-shot missions (no `structured_metrics`), legacy `metrics` continues to work as before. There is one writer, not two.

---

## Task Breakdown

### Task 1: Schema and Types -- Mission Metadata Foundation

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: None

**Description**:
Add mission metadata columns to the existing `goals` table, create supporting tables, and define shared types. The physical table name remains `goals`. Internal code continues to use `goal` naming — only type aliases and UI copy use "Mission".

1. **New shared types** in `packages/shared/src/types/neo.ts`:
   - `MissionType = 'one_shot' | 'measurable' | 'recurring'`
   - `AutonomyLevel = 'supervised' | 'semi_autonomous'` (narrowed scope — no `autonomous` in V2)
   - `MissionMetric`:
     ```ts
     interface MissionMetric {
       name: string;
       target: number;
       current: number;
       unit?: string;
     }
     ```
   - `MetricHistoryEntry`: `{ metricName: string; value: number; recordedAt: number }` -- unix timestamp, matches DB INTEGER
   - `CronSchedule`: `{ expression: string; timezone: string; nextRunAt?: number }` -- `nextRunAt` is unix timestamp
   - `MissionExecutionStatus = 'running' | 'completed' | 'failed'`
   - `type Mission = RoomGoal` (alias for UI/type layer; `RoomGoal` stays canonical)
   - Add to `RoomGoal` interface: `missionType?: MissionType`, `autonomyLevel?: AutonomyLevel`, `structuredMetrics?: MissionMetric[]`, `schedule?: CronSchedule`, `schedulePaused?: boolean`, `maxConsecutiveFailures?: number`, `maxPlanningAttempts?: number`, `consecutiveFailures?: number`

2. **Add new columns to `goals` table** via migration:
   - `mission_type` (TEXT, default `'one_shot'`, CHECK constraint)
   - `autonomy_level` (TEXT, default `'supervised'`, CHECK constraint)
   - `schedule` (TEXT/JSON, nullable)
   - `schedule_paused` (INTEGER, default 0)
   - `structured_metrics` (TEXT/JSON, nullable)
   - `max_consecutive_failures` (INTEGER, default 3)
   - `max_planning_attempts` (INTEGER, default 5)
   - `consecutive_failures` (INTEGER, default 0)
   - Migrate existing rows: `mission_type = 'one_shot'`, `autonomy_level = 'supervised'`

3. **New `mission_metric_history` table**:
   - `id` (TEXT PK), `goal_id` (TEXT FK to `goals.id` ON DELETE CASCADE), `metric_name` (TEXT NOT NULL), `value` (REAL NOT NULL), `recorded_at` (INTEGER NOT NULL)
   - Index on `(goal_id, metric_name, recorded_at)`

4. **New `mission_executions` table**:
   - `id` (TEXT PK), `goal_id` (TEXT FK), `execution_number` (INTEGER NOT NULL), `started_at` (INTEGER), `completed_at` (INTEGER), `status` (TEXT), `result_summary` (TEXT), `task_ids` (TEXT/JSON)
   - Unique constraint on `(goal_id, execution_number)`

5. **Update `GoalRepository`** (keep class name):
   - Add CRUD for new columns
   - Add `mission_metric_history` queries (insert, query by time range)
   - Add `mission_executions` queries (insert, list, update status, get active execution)
   - Implement shared helper `getEffectiveMaxPlanningAttempts(goal, roomConfig)`

**Acceptance Criteria**:
- Migration runs cleanly on fresh DB and with existing goals data
- Physical table remains `goals`, all existing SQL unchanged
- New types exported from `@neokai/shared`
- `Mission` type alias exists; `RoomGoal` continues to compile everywhere
- `mission_metric_history` and `mission_executions` tables created and queryable
- Unit tests for: migration, new column defaults, metric history CRUD, execution CRUD, `getEffectiveMaxPlanningAttempts` helper
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Measurable Missions -- Structured Metrics and Adaptive Replanning

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 1

**Description**:
Implement the measurable mission type with structured KPI tracking and adaptive replanning.

1. **Metrics in GoalManager**:
   - `recordMetric(goalId, metricName, value, timestamp)`: Update `current` in `structured_metrics` JSON AND insert into `mission_metric_history`. Also derive and write legacy `metrics` field (`Record<string, number>` with `{[name]: current}`) for backward compatibility.
   - `getMetricHistory(goalId, metricName, timeRange)`: Query `mission_metric_history` by `(goal_id, metric_name, recorded_at)` index
   - `checkMetricTargets(goalId)`: Compare each metric's `current` against `target`, return pass/fail
   - Progress for measurable missions: `progress = average(min(current/target, 1.0) * 100)` across all structured metrics
   - **Backward compatibility**: If a goal has legacy `metrics` but no `structured_metrics`, treat as one-shot (no targets, existing behavior preserved)

2. **Runtime behavior for measurable missions** in `RoomRuntime`:
   - After all linked tasks complete, call `checkMetricTargets()`
   - If all targets met -> complete mission
   - If targets not met AND `planning_attempts < getEffectiveMaxPlanningAttempts()` -> trigger replanning with metric context
   - If targets not met AND attempts exhausted -> set status to `needs_human`
   - Replanning context includes: current metric values, historical trend, completed tasks, failed task errors

3. **Planner agent context for measurable missions**:
   - Include metric targets and current values in planning prompt
   - Include history of previous planning attempts and their outcomes

4. **MCP tool updates** for room agent:
   - `record_metric(goal_id, metric_name, value)`: Agents can report metric progress
   - `get_metrics(goal_id)`: View current metric state and targets

**Acceptance Criteria**:
- `structured_metrics` is the authoritative source for measurable missions; legacy `metrics` is derived read-only
- Metrics can be recorded, queried, and compared against targets
- Measurable missions auto-replan when tasks complete but targets aren't met
- Replanning stops after max attempts and escalates to `needs_human`
- Unit tests for metric CRUD, target checking, replan triggering, attempt cap, legacy derivation
- Online tests for the full measure -> replan -> re-execute loop
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: Recurring Missions -- Scheduling with Execution Identity and Recovery

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 1

**Description**:
Implement recurring mission support with cron-based scheduling, execution identity for recovery, and per-execution task isolation.

1. **Schedule types and parsing**:
   - Support cron expressions (e.g., `0 9 * * *`) and presets (`@daily`, `@weekly`, `@hourly`)
   - Store timezone with schedule (default: system timezone)
   - Calculate and store `next_run_at` timestamp

2. **Execution identity** (critical for recovery and overlap prevention):
   - Each scheduled trigger creates a `mission_executions` row with a monotonic `execution_number`
   - Add `executionId` to session group metadata (`TaskGroupMetadata.executionId?: string`) -- correlates running planner/coder/leader groups to a specific recurrence
   - **Invariant**: at most one active execution per recurring mission. Check: no `mission_executions` row with `status = 'running'` for this goal before creating a new one.
   - On daemon restart, `recoverZombieGroups()` can read `executionId` from group metadata to correlate recovered groups to their execution

3. **Make `getNextGoalForPlanning()` mission-type aware** (critical):
   - Skip `mission_type = 'recurring'` goals entirely in the standard planning selector
   - Recurring missions are planned ONLY through the scheduler path (step 4), never by the standard selector
   - One-shot and measurable goals continue to be planned immediately when active

4. **Scheduler in RoomRuntime**:
   - On tick (after standard planning selector), check for recurring missions where `next_run_at <= now` AND `schedule_paused = false` AND no active execution
   - When triggered: create execution record, spawn planning group with `executionId` in metadata
   - After execution completes: update execution record, calculate next `next_run_at` from cron expression
   - Pass previous execution `result_summary` as context for the next cycle

   **Lifecycle edge cases**:
   - **Precision/jitter**: Up to 30s (tick interval). Acceptable for `@hourly` and coarser. Documented.
   - **Daemon restart catch-up**: If `next_run_at` is in the past, fire once immediately. Calculate next `next_run_at` from current time (skip missed intervals).
   - **Overlap prevention**: If `mission_executions` has `status = 'running'` for this goal, skip. Log a warning.
   - **Room runtime state**: Only fire when `RuntimeState === 'running'`. On resume, recalculate `next_run_at` from current time.

5. **Per-execution task isolation** (critical for recurring missions):
   - Recurring missions do NOT accumulate tasks in `linkedTaskIds` across executions
   - Each execution gets its own set of tasks. When a new execution starts, previous execution's tasks are finalized (completed/failed)
   - `planning_attempts` resets per execution (not mission-lifetime), because a long-lived recurring mission would otherwise permanently hit its cap
   - Progress shows **latest execution status only**, not aggregate across all executions
   - Task IDs for each execution are stored in `mission_executions.task_ids`

6. **Lifecycle management**:
   - Recurring missions never auto-complete; only manual archive
   - Pause via `schedule_paused` flag; resume recalculates `next_run_at` from current time

7. **MCP tools**:
   - `set_schedule(goal_id, cron, timezone)`: Set/update schedule
   - `pause_schedule(goal_id)` / `resume_schedule(goal_id)`: Toggle `schedule_paused`

**Acceptance Criteria**:
- `getNextGoalForPlanning()` skips `mission_type = 'recurring'`
- Cron expressions parsed correctly with timezone support
- Execution identity stored in both `mission_executions` and session group metadata
- Overlap prevention works (checked via `mission_executions` status, not just session groups)
- Daemon restart correctly recovers execution identity from group metadata
- Per-execution task isolation: `linkedTaskIds` scoped per execution, `planning_attempts` reset per execution
- Progress reflects latest execution only
- `schedule_paused` prevents firing; resume recalculates correctly
- Unit tests for: cron parsing, schedule calculation, overlap prevention, daemon restart catch-up, execution identity recovery, per-execution task isolation, planning_attempts reset
- Online tests for a triggered recurring execution cycle
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Semi-Autonomous Mode -- Narrowed Autonomy Slice

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 1

**Description**:
Implement `semi_autonomous` mode for **coder and general tasks only**. Plan approval stays human-gated. This is the narrowest safe autonomy slice — Leader can complete non-planning work without human approval, but all plans still require human sign-off.

1. **Scope limitation** (explicit):
   - Only applies to session groups where `workerRole === 'coder'` or `workerRole === 'general'`
   - Planning tasks (`workerRole === 'planner'`) are ALWAYS supervised regardless of autonomy level
   - Phase 2 planner gating (`isPlanApproved()` in `planner-agent.ts`) is unchanged — `approved` must still be set by human

2. **Modify the `complete_task` gate** (`room-runtime.ts` ~line 628):
   - Current: requires `submittedForReview === true` OR `approved === true`
   - New behavior when `goal.autonomyLevel === 'semi_autonomous'` AND `workerRole !== 'planner'`:
     - Leader can call `complete_task` without prior `submit_for_review`
     - Runtime auto-sets `approved = true` on the session group
     - Lifecycle hooks still run: `checkLeaderPrMerged()` / `checkWorkerPrMerged()` — PR must actually be merged
     - `submittedForReview` step is skipped entirely

3. **Record approval source** in session group metadata:
   - Add `approvalSource?: 'human' | 'leader_semi_auto'` to `TaskGroupMetadata`
   - Set to `'human'` when `resumeWorkerFromHuman()` sets `approved = true`
   - Set to `'leader_semi_auto'` when runtime auto-approves in semi-autonomous mode
   - This enables auditing of who approved what

4. **Notification events**:
   - Emit `goal.task.auto_completed` when a task completes without human review
   - Payload: goal ID, task ID, task title, PR URL, files changed count, approval source
   - Broadcast via MessageHub for UI consumption

5. **Escalation policy**:
   - Track `consecutive_failures` per mission (column from Task 1)
   - When `consecutiveFailures >= maxConsecutiveFailures`: set goal status to `needs_human`
   - Reset counter on successful task completion

**Acceptance Criteria**:
- `supervised` mode is completely unchanged (default behavior)
- `semi_autonomous` allows Leader to complete coder/general tasks without human approval
- Planning tasks always require human approval regardless of autonomy level
- `approvalSource` is correctly recorded in session group metadata
- Lifecycle hooks (`checkLeaderPrMerged`, `checkWorkerPrMerged`) still enforced
- Escalation triggers after consecutive failures
- Notification events emitted with correct payload
- Unit tests for: gate behavior per autonomy level, planner exclusion, approval source recording, escalation counter
- Online tests for semi-autonomous coder task completion flow
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: UI -- Mission Terminology and Type-Specific Features

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 2, Task 3, Task 4

**Description**:
Update the frontend to use "Mission" terminology and add type-specific UI. Backend RPCs and events stay as `goal.*`.

1. **Terminology rename in UI copy only**:
   - All user-visible text: "Goal" -> "Mission" (labels, headings, buttons, tooltips)
   - Component names can optionally rename (e.g., `GoalList` -> `MissionList`) but this is cosmetic
   - RoomStore signals keep `goal` naming internally; event subscriptions stay `goal.*`
   - Import `Mission` type alias from shared types

2. **Mission creation form enhancements**:
   - Mission type selector (one-shot, measurable, recurring)
   - Conditional fields:
     - Measurable: metric name, target value, unit (add/remove multiple)
     - Recurring: schedule preset dropdown or custom cron, timezone selector
   - Autonomy level selector (supervised, semi-autonomous) with descriptions

3. **Mission detail view -- type-specific displays**:
   - One-shot: task progress bar (current behavior)
   - Measurable: metric current vs target, progress percentage per metric
   - Recurring: next execution time, execution history list with status/summary
   - Autonomy level indicator badge

4. **Dashboard updates**:
   - Group or filter missions by type
   - Show schedule/next-run for recurring missions
   - Show metric progress for measurable missions
   - Notification feed for auto-completed tasks (from `goal.task.auto_completed` events)

**Acceptance Criteria**:
- All user-visible "Goal" text replaced with "Mission"
- Backend event subscriptions still use `goal.*` (no backend changes)
- Mission creation supports all three types with conditional fields
- Detail view shows type-specific information
- E2E tests for: creating a one-shot mission, creating a measurable mission with metrics, creating a recurring mission with schedule
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6: Integration Testing and Documentation

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: Task 2, Task 3, Task 4, Task 5

**Description**:
Comprehensive testing and documentation. Test scope follows repo rules: E2E covers user-facing flows only; daemon tests cover scheduler edge cases, autonomy internals, and recovery scenarios.

1. **Daemon online integration tests** (not E2E):
   - Full lifecycle per mission type:
     - One-shot: create -> plan -> execute -> complete
     - Measurable: create -> plan -> execute -> measure -> replan -> complete
     - Recurring: create -> schedule -> trigger -> execute -> next trigger
   - Semi-autonomous flow: Leader completes coder task without human approval
   - Escalation: consecutive failures trigger `needs_human`
   - Migration: existing goals work as one-shot missions with `supervised` autonomy

2. **Daemon unit tests** for edge cases:
   - Scheduler: overlap prevention, daemon restart catch-up, room state interaction
   - Execution identity: recovery from group metadata after restart
   - Per-execution isolation: `planning_attempts` reset, `linkedTaskIds` scoped
   - Metrics: dual-write derivation, target checking, history queries
   - Autonomy gate: planner exclusion, approval source recording

3. **E2E tests** (user-facing flows only):
   - Create each mission type through UI
   - View mission progress for measurable missions
   - View execution history for recurring missions
   - No E2E for: merge failures, scheduler internals, autonomy gate logic

4. **Documentation**:
   - Update `CLAUDE.md` with mission system terminology
   - Coverage target: new mission code paths >= 80% line coverage

**Acceptance Criteria**:
- All daemon integration and unit tests pass
- E2E tests cover three mission types via UI
- CLAUDE.md updated with mission terminology
- New mission code has >= 80% line coverage
- No regressions in existing test suite
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependency Graph

```
Task 1 (Schema + Types)
  ├─> Task 2 (Measurable) ──────────────┐
  ├─> Task 3 (Recurring) ───────────────┤
  └─> Task 4 (Semi-Autonomous) ─────────┤
                                         v
                                  Task 5 (UI)
                                         │
                                         v
                                  Task 6 (Tests + Docs)
```

- Task 1 has no dependencies and unblocks all feature tasks
- Tasks 2, 3, 4 can run in parallel after Task 1
- Task 5 (UI) depends on Tasks 2, 3, 4 (needs all backend features)
- Task 6 (tests) depends on Tasks 2, 3, 4, 5

## Future Work (Out of Scope for V2)

- **Full backend rename** (`goal` -> `mission` in RPCs, events, class names, internal code): Deferred to avoid cross-cutting churn. May never be needed if internal naming is treated as implementation detail.
- **Autonomous mode** (Leader self-approves plans, auto-merges PRs): Requires detailed design for Phase 2 planner gating changes, merge retry/failure handling, and audit trail. V2 only implements `semi_autonomous` for coder/general tasks.
- **Monitoring missions**: Event-driven triggers via webhooks/file-watch. Requires new HTTP infrastructure outside MessageHub.
- **Budget/cost controls**: Per-mission API call or token budgets.
- **Advanced risk classification**: Heuristic-based risk scoring for per-task autonomy override.
