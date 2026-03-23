# Milestone 3: goalId on SpaceTask

## Goal

Add a `goalId` field to `SpaceTask` so that tasks can be associated with a goal/mission and queried by goal across workflow runs.

## Scope

- Add `goalId` to `SpaceTask`, `CreateSpaceTaskParams`, and `UpdateSpaceTaskParams` types
- Add `goal_id` column via migration
- Add `findByGoalId()` query method to the repository
- Propagate `goalId` through task creation in `WorkflowExecutor.followTransition()`

## Tasks

### Task 3.1: Add goalId column and types

**Description:** Add the `goal_id` column to `space_tasks`, update shared types, and add a repository query method.

**Agent type:** coder

**Subtasks:**
1. In `packages/shared/src/types/space.ts`:
   - Add `goalId?: string` to `SpaceTask` interface.
   - Add `goalId?: string` to `CreateSpaceTaskParams` interface.
   - Add `goalId?: string | null` to `UpdateSpaceTaskParams` interface.
2. In `packages/daemon/src/storage/schema/migrations.ts`, add **migration 37** (assigned in overview migration number plan):
   - `ALTER TABLE space_tasks ADD COLUMN goal_id TEXT`
   - `CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)` for efficient lookups.
   - Use the try/catch + SELECT probe pattern consistent with migrations 30, 32, 33.
   - Register in `runMigrations()`.
3. In `packages/daemon/src/storage/repositories/space-task-repository.ts`:
   - Update `createTask()` INSERT statement to include `goal_id`.
   - Update `updateTask()` to handle `goalId` field.
   - Update `rowToSpaceTask()` to read `goal_id` from the row.
   - Add `findByGoalId(goalId: string): SpaceTask[]` method that queries `SELECT * FROM space_tasks WHERE goal_id = ? AND archived_at IS NULL ORDER BY created_at ASC`.
4. Run `bun run typecheck`.

**Acceptance criteria:**
- `SpaceTask` type includes `goalId`.
- Migration adds the `goal_id` column with an index.
- `findByGoalId()` returns all non-archived tasks for a given goal.
- Existing tasks have `goalId` as `undefined` (nullable column).

**Depends on:** (none -- can run in parallel with Milestones 1 and 2)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 3.2: Propagate goalId through workflow task creation

**Description:** Pass `goalId` through when creating tasks in `WorkflowExecutor.followTransition()` and `SpaceRuntime.startWorkflowRun()`, sourcing it from run config or an explicit parameter.

**Agent type:** coder

**Subtasks:**
1. In `packages/shared/src/types/space.ts`, add `goalId?: string` to `SpaceWorkflowRun` type and `CreateWorkflowRunParams`.
2. Update `SpaceWorkflowRunRepository`:
   - Add **migration 38** for `goal_id` column on `space_workflow_runs` (assigned in overview migration number plan). Use the try/catch + SELECT probe pattern.
   - Update `createRun()` to persist `goal_id`.
   - Update `rowToRun()` to read `goal_id`.
3. In `WorkflowExecutor`, accept a `goalId` from the run and pass it to `taskManager.createTask()` in `followTransition()`.
   - The executor already has access to `this.run` -- read `goalId` from the run record.
4. In `SpaceRuntime.startWorkflowRun()`, accept an optional `goalId` parameter and pass it to `createRun()` and the initial task creation.
5. Run `bun run typecheck`.

**Acceptance criteria:**
- Tasks created by workflow runs inherit `goalId` from the run.
- `goalId` is persisted on both the run and each task record.
- The `startWorkflowRun()` API accepts `goalId` for callers that want to associate a run with a goal.

**Depends on:** Task 3.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
