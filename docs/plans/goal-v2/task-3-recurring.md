# Task 3: Recurring Missions -- Scheduling with Execution Identity and Recovery

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: [Task 1](./task-1-schema-types.md)

## Description

Implement recurring mission support with cron-based scheduling, execution identity for recovery, and per-execution task isolation.

### 1. Schedule types and parsing

- Support cron expressions (e.g., `0 9 * * *`) and presets (`@daily`, `@weekly`, `@hourly`)
- Store timezone with schedule (default: system timezone)
- Calculate and store `next_run_at` timestamp

### 2. Execution identity (critical for recovery and overlap prevention)

- Each scheduled trigger creates a `mission_executions` row with a monotonic `execution_number`
- Add `executionId` to session group metadata (`TaskGroupMetadata.executionId?: string`) -- correlates running planner/coder/leader groups to a specific recurrence
- **Invariant**: at most one active execution per recurring mission. Check: no `mission_executions` row with `status = 'running'` for this goal before creating a new one.
- On daemon restart, `recoverZombieGroups()` can read `executionId` from group metadata to correlate recovered groups to their execution

### 3. Make `getNextGoalForPlanning()` mission-type aware (critical)

- Skip `mission_type = 'recurring'` goals entirely in the standard planning selector
- Recurring missions are planned ONLY through the scheduler path (step 4), never by the standard selector
- One-shot and measurable goals continue to be planned immediately when active

### 4. Scheduler in RoomRuntime

- On tick (after standard planning selector), check for recurring missions where `next_run_at <= now` AND `schedule_paused = false` AND no active execution
- When triggered: create execution record, spawn planning group with `executionId` in metadata
- After execution completes: update execution record, calculate next `next_run_at` from cron expression
- Pass previous execution `result_summary` as context for the next cycle

**Lifecycle edge cases**:
- **Precision/jitter**: Up to 30s (tick interval). Acceptable for `@hourly` and coarser. Documented.
- **Daemon restart catch-up**: If `next_run_at` is in the past, fire once immediately. Calculate next `next_run_at` from current time (skip missed intervals).
- **Overlap prevention**: If `mission_executions` has `status = 'running'` for this goal, skip AND advance `next_run_at` to the next scheduled interval (so subsequent ticks don't re-evaluate the same past-due time). Log a warning.
- **Room runtime state**: Only fire when `RuntimeState === 'running'`. On resume, recalculate `next_run_at` from current time.

### 5. Per-execution task isolation — explicit storage model (critical for recurring missions)

Recurring missions need per-execution scoping for tasks and planning attempts. Here is where each piece of state lives:

- **Task linkage**: `mission_executions.task_ids` (JSON array) is the source of truth for which tasks belong to an execution. `goals.linked_task_ids` is overwritten on each new execution to contain only the current execution's tasks (so existing runtime code that reads `linkedTaskIds` for progress aggregation, replan checks, etc. continues to work without modification). After an execution completes, its tasks remain in `mission_executions.task_ids` for history; `goals.linked_task_ids` is cleared when the next execution starts.
- **Intentional tradeoff — historical task→goal linkage**: Overwriting `linked_task_ids` means `getGoalsForTask(oldTaskId)` will NOT find the goal for tasks from previous executions. This is acceptable because: (1) old execution tasks are in terminal state (completed/failed) so progress updates and replan checks don't apply, (2) `list_tasks(goal_id)` showing only current execution tasks is the correct agent behavior for recurring missions, (3) historical lookup is available through `mission_executions.task_ids`. Code paths affected: `GoalRepository.getGoalsForTask()` (SQL LIKE on `linked_task_ids`), `GoalManager.updateGoalsForTask()`, `room-agent-tools.ts list_tasks` filter — all operate correctly on current-execution tasks only.
- **Planning attempts**: `mission_executions.planning_attempts` (INTEGER column, added in Task 1 schema) is the per-execution counter. For recurring missions, `getEffectiveMaxPlanningAttempts()` checks this column instead of `goals.planning_attempts`. `goals.planning_attempts` is unused for recurring missions.
- **Progress**: Derived from `goals.linked_task_ids` (which mirrors current execution only), so existing progress aggregation logic works unchanged. Shows latest execution status, not lifetime aggregate.
- **After daemon restart**: `goals.linked_task_ids` still contains the current execution's tasks. `mission_executions` row with `status = 'running'` identifies which execution is active. Session group metadata contains `executionId` to correlate recovered groups.

### 6. Lifecycle management

- Recurring missions never auto-complete; only manual archive
- Pause via `schedule_paused` flag; resume recalculates `next_run_at` from current time

### 7. MCP tools

- `set_schedule(goal_id, cron, timezone)`: Set/update schedule
- `pause_schedule(goal_id)` / `resume_schedule(goal_id)`: Toggle `schedule_paused`

## Acceptance Criteria

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
