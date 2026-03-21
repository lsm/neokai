# Milestone 2: Iteration Tracking

## Goal

Add iteration counting to workflow runs so that cyclic transitions (where a step is revisited) increment a counter, and a `maxIterations` safety cap prevents infinite loops by escalating to `needs_attention`.

## Scope

- Add `iteration_count` and `max_iterations` columns to `space_workflow_runs` via a new migration
- Update `SpaceWorkflowRun` type and repository `rowToRun()`/`createRun()` to include the new fields
- Add `maxIterations` to `SpaceWorkflow` for template-level defaults
- Detect revisited steps in `followTransition()` and increment/cap accordingly

## Tasks

### Task 2.1: Add iteration columns to DB and types

**Description:** Add the database migration, update shared types, and update the repository to persist and read iteration tracking fields.

**Agent type:** coder

**Subtasks:**
1. In `packages/shared/src/types/space.ts`, add to `SpaceWorkflowRun`:
   - `iterationCount?: number` (defaults to 0, incremented when a cyclic transition fires)
   - `maxIterations?: number` (defaults to 5, safety cap)
2. In `packages/shared/src/types/space.ts`, add to `SpaceWorkflow`:
   - `maxIterations?: number` (template-level default, copied to run at creation)
3. Add to `CreateWorkflowRunParams`:
   - `maxIterations?: number`
4. In `packages/daemon/src/storage/schema/migrations.ts`, add a new migration (next number after 33, so migration 34):
   - `ALTER TABLE space_workflow_runs ADD COLUMN iteration_count INTEGER NOT NULL DEFAULT 0`
   - `ALTER TABLE space_workflow_runs ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 5`
   - Register the migration call in `runMigrations()`.
5. In `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts`:
   - Update `createRun()` to include `iteration_count` (default 0) and `max_iterations` (from params or default 5) in the INSERT statement.
   - Update `rowToRun()` to read `iteration_count` and `max_iterations` from the DB row.
   - Add `iteration_count` and `max_iterations` to `UpdateWorkflowRunParams` interface.
   - Update `updateRun()` to handle the new fields.
6. Run `bun run typecheck` to verify compilation.

**Acceptance criteria:**
- Migration 34 adds the two columns with correct defaults.
- `SpaceWorkflowRun` type includes `iterationCount` and `maxIterations`.
- Repository correctly persists and reads the new fields.
- Existing runs default to `iterationCount: 0` and `maxIterations: 5`.

**Depends on:** (none -- can run in parallel with Milestone 1)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.2: Implement iteration detection and capping in WorkflowExecutor

**Description:** In `followTransition()`, detect when the target step has already been visited (has existing tasks in this run), increment `iterationCount`, and enforce the `maxIterations` cap.

**Agent type:** coder

**Subtasks:**
1. In `WorkflowExecutor.followTransition()`, after resolving the next step but before creating the task:
   - Query existing tasks for this run that have the target step's `workflowStepId` (use `taskManager` or the task repo).
   - If any such tasks exist, this is a cyclic revisit -- increment `iterationCount` on the run.
2. After incrementing, check if `iterationCount >= maxIterations`:
   - If so, set the run status to `needs_attention` instead of following the transition.
   - Return early or throw a `WorkflowTransitionError` with a descriptive message about hitting the iteration cap.
3. Persist the updated `iterationCount` to the DB via `workflowRunRepo.updateRun()`.
4. Update the `SpaceRuntime.startWorkflowRun()` method to pass `maxIterations` from the workflow template when creating the run (if `workflow.maxIterations` is set, use it; otherwise use the default 5).
5. Run `bun run typecheck`.

**Acceptance criteria:**
- `iterationCount` is incremented each time a step is revisited in a cyclic transition.
- When `iterationCount >= maxIterations`, the run transitions to `needs_attention` and no new task is created.
- The `maxIterations` from the workflow template is used when starting a run.
- Non-cyclic transitions (visiting a new step) do not increment the counter.

**Depends on:** Task 2.1, Task 1.2 (needs the updated `followTransition` context)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
