# Milestone 2: Iteration Tracking

## Goal

Add iteration counting to workflow runs so that cyclic transitions (where a step is revisited) increment a counter, and a `maxIterations` safety cap prevents infinite loops by escalating to `needs_attention`.

## Scope

- Add `iteration_count` and `max_iterations` columns to `space_workflow_runs` via migration 34
- Add `max_iterations` column to `space_workflows` via migration 37
- Update `SpaceWorkflowRun` type and repository `rowToRun()`/`createRun()` to include the new fields
- Add `maxIterations` as a first-class typed field on `SpaceWorkflow` (not in `config`) with DB persistence
- Detect revisited steps in `followTransition()` and increment/cap accordingly
- Iteration counting uses **per-cycle** semantics: one logical loop-back = one increment (see overview for details)

## Tasks

### Task 2.1: Add iteration columns to DB and types

**Description:** Add the database migration, update shared types, and update the repository to persist and read iteration tracking fields.

**Agent type:** coder

**Subtasks:**
1. In `packages/shared/src/types/space.ts`, add to `SpaceWorkflowRun`:
   - `iterationCount?: number` (defaults to 0, incremented when a cyclic transition fires)
   - `maxIterations?: number` (defaults to 5, safety cap)
2. In `packages/shared/src/types/space.ts`, add to `SpaceWorkflow`:
   - `maxIterations?: number` (first-class typed field, NOT stored in `config`)
3. Add to `CreateWorkflowRunParams`:
   - `maxIterations?: number`
4. In `packages/daemon/src/storage/schema/migrations.ts`, add **migration 34** (follows existing pattern of migrations 30–33 which add columns to Space tables via ALTER TABLE):
   - `ALTER TABLE space_workflow_runs ADD COLUMN iteration_count INTEGER NOT NULL DEFAULT 0`
   - `ALTER TABLE space_workflow_runs ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 5`
   - Use the try/catch + SELECT probe pattern consistent with migrations 30, 32, 33.
   - Register the migration call in `runMigrations()`.
5. In `packages/daemon/src/storage/schema/migrations.ts`, add **migration 37** for `SpaceWorkflow.maxIterations`:
   - `ALTER TABLE space_workflows ADD COLUMN max_iterations INTEGER`
   - Use the same try/catch probe pattern.
   - Register in `runMigrations()`.
6. In `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts`:
   - Update `createRun()` to include `iteration_count` (default 0) and `max_iterations` (from params or default 5) in the INSERT statement.
   - Update `rowToRun()` to read `iteration_count` and `max_iterations` from the DB row.
   - Add `iteration_count` and `max_iterations` to `UpdateWorkflowRunParams` interface.
   - Update `updateRun()` to handle the new fields. Note: the existing `updateCurrentStep()` and `updateStatus()` convenience wrappers delegate to `updateRun()` and will continue to work as-is.
7. In `packages/daemon/src/storage/repositories/space-workflow-repository.ts` (or wherever workflows are persisted):
   - Update `createWorkflow()` / `updateWorkflow()` to handle `max_iterations`.
   - Update `rowToWorkflow()` to read `max_iterations` from the DB row.
8. Run `bun run typecheck` to verify compilation.

**Acceptance criteria:**
- Migration 34 adds `iteration_count` and `max_iterations` columns to `space_workflow_runs`.
- Migration 37 adds `max_iterations` column to `space_workflows`.
- `SpaceWorkflowRun` type includes `iterationCount` and `maxIterations`.
- `SpaceWorkflow` type includes `maxIterations` as a first-class typed field (not in `config`).
- Repository correctly persists and reads all new fields.
- Existing runs default to `iterationCount: 0` and `maxIterations: 5`.

**Depends on:** (none -- can run in parallel with Milestone 1)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.2: Implement iteration detection and capping in WorkflowExecutor

**Description:** In `followTransition()`, detect when the target step has already been visited (has existing tasks in this run), increment `iterationCount`, and enforce the `maxIterations` cap.

**Agent type:** coder

**Subtasks:**
1. In `WorkflowExecutor.followTransition()`, after resolving the target step but before creating the task:
   - Query existing tasks for this run that have the target step's `workflowStepId` (use `taskManager` or the task repo, filtering from `listByWorkflowRun()` results in-memory).
   - If any completed/in-progress tasks exist for that step, this is a cyclic revisit.
   - **Counting semantics:** Increment `iterationCount` only on the **first step revisited** in a loop-back transition. This counts logical cycles, not individual step revisits. In a Verify→Plan→Code→Verify loop, the counter increments once when Verify→Plan fires (because Plan was already visited), not again when Plan→Code or Code→Verify fire (those are forward transitions within the same iteration).
   - Implementation: track which step triggered the increment by comparing the transition's source step against the target. Only increment when the transition explicitly targets an already-visited step (the "loop-back edge").
2. After incrementing, check if `iterationCount >= maxIterations`:
   - If so, set the run status to `needs_attention` instead of following the transition.
   - Return early or throw a `WorkflowTransitionError` with a descriptive message about hitting the iteration cap.
   - **Reset behavior:** When a run hits `needs_attention` due to iteration cap and a human resets it to `in_progress`, the `iterationCount` is NOT reset — it preserves the history of how many cycles have occurred. The human may increase `maxIterations` on the run to allow more cycles.
3. Persist the updated `iterationCount` to the DB via `workflowRunRepo.updateRun({ iterationCount: newCount })`.
4. Update the `SpaceRuntime.startWorkflowRun()` method to pass `maxIterations` from the workflow template when creating the run (if `workflow.maxIterations` is set, use it; otherwise use the default 5).
5. Run `bun run typecheck`.

**Note on merge conflicts:** Task 2.2 and Task 1.2 both modify `followTransition()` in `workflow-executor.ts`. Task 2.2 depends on Task 1.2, so it should be implemented after Task 1.2 is merged. If both are in-flight simultaneously, the second PR will need to rebase.

**Acceptance criteria:**
- `iterationCount` is incremented once per logical cycle (loop-back transition to an already-visited step).
- When `iterationCount >= maxIterations`, the run transitions to `needs_attention` and no new task is created.
- The `maxIterations` from the workflow template is used when starting a run.
- Non-cyclic transitions (visiting a new step for the first time) do not increment the counter.
- Forward transitions within a new iteration (e.g., Plan→Code after a Verify→Plan loop-back) do not increment the counter.

**Depends on:** Task 2.1, Task 1.2 (needs the updated `followTransition` context and `advance()` options)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
