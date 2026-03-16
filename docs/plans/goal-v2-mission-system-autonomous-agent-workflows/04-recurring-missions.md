# Milestone 4: Recurring Missions -- Scheduling and Execution Identity

## Milestone Goal

Implement cron-based scheduling for recurring missions inside `RoomRuntime`, create `mission_executions` row per trigger for execution identity, enforce at-most-one-running-execution invariant, isolate tasks per execution, and handle recovery after daemon restart.

## Tasks

### Task 4.1: Cron Scheduler and Execution Identity in RoomRuntime

**Agent**: coder
**Description**: Add cron parsing, next-run calculation, and the scheduling tick inside `RoomRuntime`; implement execution identity and per-execution task isolation; add recovery after daemon restart; add MCP schedule tools.

**Subtasks** (ordered implementation steps):

1. Add a cron parsing utility at `packages/daemon/src/lib/room/runtime/cron-utils.ts`:
   - Parse cron expressions (five-field `* * * * *` syntax)
   - Support presets: `@hourly`, `@daily`, `@weekly`, `@monthly`
   - Calculate `nextRunAt(expression, timezone, fromDate?)`: returns the next unix timestamp after `fromDate` (defaults to `Date.now()`)
   - Input validation: reject malformed expressions; throw a descriptive error
   - This file should have NO external cron library dependencies; implement a minimal parser for the five-field standard or use Bun's built-in date facilities

2. In `packages/daemon/src/types/task-group.ts` (or wherever `TaskGroupMetadata` is defined), add optional field:
   ```ts
   executionId?: string; // links session group to a mission_executions row
   ```

3. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, update `getNextGoalForPlanning()` (the standard planning selector):
   - Skip goals with `missionType === 'recurring'` entirely. Recurring missions are planned ONLY through the scheduler path.
   - One-shot and measurable goals continue to be picked immediately when active.

4. Add a scheduler method `tickRecurringMissions()` to `RoomRuntime`:
   a. Query goals for this room where `mission_type = 'recurring'` AND `schedule_paused = false` AND `next_run_at <= now` AND no `'running'` execution exists (from `GoalManager.getActiveExecution(goalId)`)
   b. For each eligible goal (in priority order):
      - Begin a DB transaction:
        - Call `goalManager.createExecution(goalId, nextExecutionNumber)` to create the `mission_executions` row with `status = 'running'`
        - Advance `next_run_at` to the next cron interval (via `nextRunAt(schedule.expression, schedule.timezone)`) and persist it via `GoalManager`
      - On unique constraint violation (another daemon beat us to it): log and skip
      - Spawn a planning group with `executionId` added to the session group metadata

5. Call `tickRecurringMissions()` at the end of each runtime tick, after the standard planning selector and after `recoverZombieGroups()` (so in-flight executions from before a restart are recovered before the scheduler fires).

6. Update the execution completion path in `RoomRuntime` (where all tasks for a goal are done):
   - If the goal is `recurring`: update the execution row to `status = 'completed'` with `resultSummary`; do NOT set goal status to `completed`; the goal stays `active`
   - Pass `resultSummary` of the previous execution as context to the next planning group when the next trigger fires

7. Per-execution task isolation -- update all task-linking call sites in the runtime path:
   - In `room-runtime.ts`, where planner draft-task creation links tasks to goals: call `GoalManager.linkTaskToExecution(goalId, executionId, taskId)` if the goal is recurring and has an active execution; otherwise use the existing `GoalManager.linkTaskToGoal(goalId, taskId)`
   - In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`, the `create_task(goal_id)` tool: same conditional
   - `goals.linked_task_ids` is overwritten per execution (the new execution's start clears it) so existing progress aggregation code works unchanged

8. Update `recoverZombieGroups()` (in `packages/daemon/src/lib/room/runtime/runtime-recovery.ts` or wherever it lives) to read `executionId` from recovered group metadata and correlate it to the `mission_executions` row. If the execution row exists, confirm it is still `'running'`; if not, log a warning but proceed with recovery.

9. Add lifecycle edge case handling in `tickRecurringMissions()`:
   - **Catch-up after daemon restart**: if `next_run_at` is in the past, fire once immediately, then calculate the next interval from `Date.now()`
   - **Overlap prevention**: if an active execution exists AND `next_run_at` is past-due, advance `next_run_at` to next interval and log a warning (skip the trigger)
   - **Room runtime state**: only fire when `this.state === 'running'`
   - **Precision / jitter**: up to 30 s (tick interval) is acceptable; document in a code comment

10. Add schedule MCP tools in `packages/daemon/src/lib/room/tools/room-agent-tools.ts`:
    - `set_schedule(goal_id, cron_expression, timezone)`: validates cron, calculates initial `next_run_at`, persists `schedule` and `next_run_at`
    - `pause_schedule(goal_id)`: sets `schedule_paused = true`
    - `resume_schedule(goal_id)`: sets `schedule_paused = false`, recalculates `next_run_at` from `Date.now()`

11. Write unit tests in `packages/daemon/tests/unit/room/`:
    - `cron-utils.test.ts`: valid expressions, preset aliases, timezone support, invalid expression error, next-run calculation
    - New or existing runtime test file: `getNextGoalForPlanning()` skips recurring; scheduler fires when due; overlap prevention; catch-up after restart; `schedule_paused` blocks firing; `executionId` stored in group metadata; per-execution `planning_attempts` resets per new execution; `linked_task_ids` scoped to current execution

12. Write an online integration test at `packages/daemon/tests/online/room/room-recurring-mission.test.ts` covering a full trigger -> execute -> next-trigger cycle.

**Acceptance Criteria**:
- `getNextGoalForPlanning()` skips `mission_type = 'recurring'` goals
- Cron expressions and presets (`@daily`, etc.) are parsed with timezone support
- Each scheduler trigger creates a `mission_executions` row with a unique `executionId`
- `executionId` is stored in session group metadata
- Partial unique index prevents two `'running'` executions for the same goal; app-level check provides the first gate
- Daemon restart correctly recovers execution identity from group metadata
- `linked_task_ids` is scoped per execution; previous execution's tasks are preserved in `mission_executions.task_ids`
- `planning_attempts` resets per execution (uses `mission_executions.planning_attempts`)
- `schedule_paused` prevents scheduler from firing; resume recalculates `next_run_at` from current time
- Catch-up after restart fires once immediately then advances to next interval
- All unit and online tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 1 (types), Milestone 2 (schema and repository, including execution CRUD and `linkTaskToExecution`)
