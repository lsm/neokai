# Milestone 2: Database Schema Migration

## Milestone Goal

Add new mission V2 columns to the `goals` table via a numbered migration, create two new supporting tables (`mission_metric_history` and `mission_executions`), and update the `GoalRepository` class to read/write all new fields. The physical table name stays `goals`; all existing SQL continues to work.

## Tasks

### Task 2.1: Write Database Migration (Migration 28)

**Agent**: coder
**Description**: Add a new migration function `runMigration28` to `packages/daemon/src/storage/schema/migrations.ts` that adds the mission V2 columns to the `goals` table and creates the two new tables. Register it in `runMigrations`.

**Subtasks** (ordered implementation steps):

1. In `migrations.ts`, add `runMigration28(db)` to the `runMigrations` function body after the existing `runMigration27(db)` call.

2. Implement `runMigration28`:
   a. Add columns to `goals` table (each wrapped in try/catch or column-exists check for idempotency):
      - `mission_type TEXT DEFAULT 'one_shot' CHECK(mission_type IN ('one_shot', 'measurable', 'recurring'))`
      - `autonomy_level TEXT DEFAULT 'supervised' CHECK(autonomy_level IN ('supervised', 'semi_autonomous'))`
      - `schedule TEXT` (nullable JSON)
      - `schedule_paused INTEGER DEFAULT 0`
      - `next_run_at INTEGER` (nullable)
      - `structured_metrics TEXT` (nullable JSON)
      - `max_consecutive_failures INTEGER DEFAULT 3`
      - `max_planning_attempts INTEGER DEFAULT 5`
      - `consecutive_failures INTEGER DEFAULT 0`

   b. Create `mission_metric_history` table (IF NOT EXISTS):
      ```sql
      CREATE TABLE IF NOT EXISTS mission_metric_history (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
      )
      ```

   c. Create `mission_executions` table (IF NOT EXISTS):
      ```sql
      CREATE TABLE IF NOT EXISTS mission_executions (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        execution_number INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running', 'completed', 'failed')),
        result_summary TEXT,
        task_ids TEXT NOT NULL DEFAULT '[]',
        planning_attempts INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
        UNIQUE (goal_id, execution_number)
      )
      ```

   d. Create indexes:
      - `CREATE INDEX IF NOT EXISTS idx_mission_metric_history ON mission_metric_history(goal_id, metric_name, recorded_at)`
      - `CREATE INDEX IF NOT EXISTS idx_mission_executions_goal ON mission_executions(goal_id, status)`
      - `CREATE INDEX IF NOT EXISTS idx_goals_mission_scheduler ON goals(mission_type, schedule_paused, next_run_at)`
      - `CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running ON mission_executions(goal_id) WHERE status = 'running'`

   e. Backfill existing rows: `UPDATE goals SET mission_type = 'one_shot', autonomy_level = 'supervised' WHERE mission_type IS NULL`

3. Update `createTables` in `packages/daemon/src/storage/schema/index.ts` to include the two new tables and their indexes in the initial schema (for fresh database installs). Mirror the same DDL from step 2b and 2c.

4. Write a migration test at `packages/daemon/tests/unit/storage/migrations/migration-28_test.ts` following the pattern of `migration-24_test.ts`:
   - Verify new columns exist with correct defaults on a migrated DB
   - Verify `mission_metric_history` and `mission_executions` tables exist
   - Verify the partial unique index prevents two `'running'` executions for the same goal
   - Verify the migration is idempotent (run twice, no error)
   - Verify existing goal rows are backfilled with `mission_type = 'one_shot'`

**Acceptance Criteria**:
- Migration runs cleanly on a fresh database
- Migration runs cleanly on an existing database with existing goal rows
- Existing goals are backfilled with `mission_type = 'one_shot'` and `autonomy_level = 'supervised'`
- `mission_metric_history` and `mission_executions` tables exist and are queryable
- Partial unique index prevents concurrent `'running'` executions for the same goal
- Migration is idempotent (running it twice throws no errors)
- Migration test passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Task 1.1 (new column names must match new TypeScript field names)

---

### Task 2.2: Update GoalRepository and GoalManager

**Agent**: coder
**Description**: Update `GoalRepository` and `GoalManager` to read/write the new columns, add CRUD methods for `mission_metric_history` and `mission_executions`, and implement the `getEffectiveMaxPlanningAttempts` helper.

**Subtasks** (ordered implementation steps):

1. In `packages/daemon/src/storage/repositories/goal-repository.ts`:

   a. Update `createGoal`: include all new columns in the INSERT statement with their defaults (`mission_type`, `autonomy_level`, `schedule`, `schedule_paused`, `next_run_at`, `structured_metrics`, `max_consecutive_failures`, `max_planning_attempts`, `consecutive_failures`). Accept them via `CreateGoalParams`.

   b. Update `updateGoal`: handle all new fields in the partial update path (`missionType`, `autonomyLevel`, `schedule`, `schedulePaused`, `nextRunAt`, `structuredMetrics`, `maxConsecutiveFailures`, `maxPlanningAttempts`, `consecutiveFailures`).

   c. Update `rowToGoal` to parse and populate all new fields from the DB row. Parse JSON fields (`schedule`, `structuredMetrics`) safely, defaulting to `undefined` if null.

   d. Add metric history methods:
      - `insertMetricHistory(goalId, metricName, value, recordedAt)`: insert a row into `mission_metric_history`
      - `getMetricHistory(goalId, metricName, fromTs?, toTs?)`: query by `(goal_id, metric_name, recorded_at)` index, optional time range filter

   e. Add execution CRUD methods:
      - `createExecution(goalId, executionNumber)`: INSERT into `mission_executions`, returns the new row
      - `getActiveExecution(goalId)`: SELECT WHERE `goal_id = ? AND status = 'running'`
      - `getExecution(executionId)`: SELECT by primary key
      - `listExecutions(goalId)`: SELECT all for a goal, ordered by `execution_number DESC`
      - `updateExecutionStatus(executionId, status, resultSummary?, completedAt?)`: UPDATE status/result
      - `appendExecutionTaskId(executionId, taskId)`: read `task_ids` JSON, append, write back (single transaction)
      - `getNextExecutionNumber(goalId)`: SELECT MAX(execution_number) + 1 (or 1 if no rows)

2. In `packages/daemon/src/lib/room/managers/goal-manager.ts`:

   a. Expose thin async wrappers for all new repository methods (metric history insert/query, execution CRUD). Keep the same async pattern as existing manager methods.

   b. Implement `getEffectiveMaxPlanningAttempts(goalId, roomConfig)`:
      - Fetch the goal
      - If `goal.maxPlanningAttempts` is set (>= 1), return it
      - Else if `roomConfig?.maxPlanningRetries` is set, return `roomConfig.maxPlanningRetries + 1`
      - Else return 5 (hardcoded default)
      - Export this as a standalone helper function (not just a method) so it can be called with a `RoomGoal` object directly (for use in runtime without a manager instance)

   c. Add `linkTaskToExecution(goalId, executionId, taskId)` method:
      - Atomically updates both `mission_executions.task_ids` (via `appendExecutionTaskId`) and `goals.linked_task_ids` (via `linkTaskToGoal`) in a single SQLite transaction
      - For non-recurring missions, continue using the existing `linkTaskToGoal` unchanged

3. Write unit tests in `packages/daemon/tests/unit/room/goal-manager.test.ts`:
   - New goal creation with `missionType` and `autonomyLevel` persists correctly
   - Metric history: insert, query with time range, empty result for no history
   - Execution CRUD: create, get active, update status, list
   - `appendExecutionTaskId` dual-write atomicity
   - `getEffectiveMaxPlanningAttempts`: mission-level override, room-level fallback, default fallback
   - `linkTaskToExecution` updates both stores atomically

**Acceptance Criteria**:
- `GoalRepository.createGoal` and `updateGoal` handle all new fields
- `rowToGoal` correctly deserializes all new fields from DB rows
- Metric history CRUD works end-to-end
- Execution CRUD works end-to-end
- Partial unique index constraint is surfaced as an error on duplicate `'running'` execution insert
- `getEffectiveMaxPlanningAttempts` returns correct priority: mission > room config > default 5
- `linkTaskToExecution` atomically updates both `mission_executions.task_ids` and `goals.linked_task_ids`
- All new tests pass; existing `goal-manager` tests still pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Task 2.1 (migration must exist so tables/columns are present during tests)
