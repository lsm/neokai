# M6: Advanced Features

> **Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Goal

Connect Space workflows to the goal/mission system for progress tracking, add cron scheduling for recurring workflows, and enhance the dashboard with goal progress and activity feeds. After this milestone, workflow runs can be linked to goals, recurring workflows auto-start, and the dashboard provides a comprehensive overview.

## Milestone Acceptance Criteria

- [ ] Completing a Space task with a `goalId` updates goal progress.
- [ ] Space workflows with a schedule auto-start new runs at configured intervals.
- [ ] Dashboard shows goal progress, active runs, and recent task activity.

---

## Task 14: Design GoalManager Bridge Architecture for Space

- **Priority:** CRITICAL
- **Agent Type:** general
- **Dependencies:** None
- **Description:** `GoalManager` is constructed with `roomId` and operates on Room-scoped data. The `goals` table has a required `room_id` FK to `rooms(id)`. Space stores `goalId` on `SpaceWorkflowRun` (nullable `goal_id` column) but has no `roomId` concept. Before any goal integration code can be written, the bridge architecture must be designed.

- **Files to analyze:**
  - `packages/daemon/src/lib/room/managers/goal-manager.ts` -- `GoalManager` constructor: `(db, roomId, reactiveDb, shortIdAllocator?)`
  - `packages/daemon/src/storage/repositories/goal-repository.ts` -- all methods require `roomId` except `getGoalsForTask(taskId)` and `linkTaskToGoal(goalId, taskId)`
  - `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- `goalId` stored as nullable `goal_id` column
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- integration point at `handleSubSessionComplete()` (line ~882)

- **Design options to evaluate:**
  1. **Space queries GoalRepository directly** -- Use `getGoalsForTask(taskId)`. Problem: Space tasks are not Room tasks, `linkTaskToGoal` has never been called.
  2. **Space instantiates GoalManager with resolved roomId** -- Resolve `roomId` from the `goals` table. Problem: `recalculateProgress()` iterates `goal.linkedTaskIds` which are Room task UUIDs.
  3. **Space tracks its own progress** -- Add a `SpaceTaskProgress` table or extend the goals table with Space-specific task links. Most flexible but most work.
  4. **Space stores roomId alongside goalId** -- Schema change on `space_workflow_runs` to add `room_id`. Most direct path.

- **Key question:** How does `updateGoalsForTask()` work when the tasks are Space tasks, not Room tasks? The Room method calls `getGoalsForTask(taskId)` then `calculateProgressFromTasks(goal)` which iterates `linkedTaskIds` and calls `taskRepo.getTask(taskId)`. Space tasks live in `space_tasks` with `SpaceTaskRepository`.

- **Deliverable:** `docs/plans/space-goal-bridge-design.md` with: (a) recommended option, (b) schema changes, (c) API surface changes, (d) integration points, (e) backward compatibility analysis.

- **Acceptance Criteria:** Design document is approved with a clear recommendation.

---

## Task 15: Wire Space Task Completion to Goal Progress Tracking

- **Priority:** CRITICAL
- **Agent Type:** coder
- **Dependencies:** Task 14 (design approved)
- **Description:** Implement the bridge between Space task completion and Room's GoalManager, following the design from Task 14.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- `handleSubSessionComplete()` at line ~882
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `SpaceRuntimeConfig` interface
  - Possibly: `packages/daemon/src/storage/repositories/goal-repository.ts` -- if new cross-system query methods are needed

- **Implementation approach** (will be refined based on Task 14 design):
  1. Add a goal integration callback to `SpaceRuntimeConfig`:
     ```ts
     onTaskGoalProgressUpdate?: (taskId: string, goalId: string) => Promise<void>;
     ```
  2. In `handleSubSessionComplete()`, after `taskManager.setTaskStatus(stepTask.id, 'completed')` succeeds, look up the workflow run to get `goalId`. If present, call the callback.
  3. The callback implementation will resolve the goal, recalculate progress, and emit `goal.progressUpdated` DaemonHub event.

- **Edge cases:**
  - Task has no `goalId` -- skip silently.
  - Goal has been deleted since the workflow run started -- handle gracefully (goal lookup returns null, log warning, skip).
  - Multiple tasks completing simultaneously -- each triggers independent progress update.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/task-agent-goal-bridge.test.ts` (create)
  - Test scenarios: (a) completing a task with goalId triggers progress update, (b) completing a task without goalId skips, (c) deleted goal is handled gracefully

- **Acceptance Criteria:** Space tasks with `goalId` update goal progress when completed. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 16: Cron Scheduling for Recurring Space Workflows

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 5 (JobQueue -- see `02-runtime-reliability.md`)
- **Description:** Add cron-based scheduling for recurring Space workflows, enabling workflows to auto-start at configured intervals.

- **Files to modify:**
  - `packages/daemon/src/storage/repositories/space-workflow-repository.ts` -- add schedule fields
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- add schedule check in tick
  - Database migration: add `schedule TEXT` and `next_run_at INTEGER` columns to `space_workflows` table

- **Implementation approach:**
  1. **Schema migration:** Add `schedule` (JSON: `{ expression: string; timezone: string }`) and `next_run_at` (Unix seconds) to `space_workflows`.
  2. **Next-run computation:** Reuse `packages/daemon/src/lib/room/runtime/cron-utils.ts` directly:
     ```ts
     import { getNextRunAt, isValidCronExpression } from '../room/runtime/cron-utils';
     ```
  3. **Tick handler:** In `SpaceRuntime.executeTick()`, add a `processScheduledWorkflows()` step that lists workflows with `next_run_at <= now` and starts new runs.
  4. **Catch-up detection:** If `next_run_at` is in the past by more than one interval, only start ONE run (not backfill). Follow Room's approach.

- **Edge cases:**
  - Invalid cron expression -- validate on save, reject with clear error.
  - Timezone changes -- recompute `next_run_at` when timezone is updated.
  - Workflow deleted while scheduled -- cleanup in tick handler.
  - Space archived -- skip all scheduled workflows for archived spaces.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-cron-scheduling.test.ts` (create)
  - Test scenarios: (a) valid cron creates run at correct time, (b) catch-up starts only one run, (c) archived space skips, (d) deleted workflow cleaned up

- **Acceptance Criteria:** Scheduled Space workflows auto-start new runs at configured intervals. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 17: Enhance Space Dashboard with Goal Progress and Activity Feed

- **Priority:** LOW
- **Agent Type:** coder
- **Dependencies:** Task 15 (goal integration)
- **Description:** Enhance the existing `SpaceDashboard.tsx` (already shows space overview, active run progress, and quick-action cards) with goal progress, task status summary, and recent activity feed.

- **Files to modify:**
  - `packages/web/src/components/space/SpaceDashboard.tsx` -- add goal progress section, task status counts, activity feed
  - `packages/web/src/lib/space-store.ts` -- add goal-related computed signals if needed

- **Implementation approach:**
  1. **Goal progress section** -- Add a collapsible "Mission Progress" panel. Reuse the progress bar component from `GoalsEditor.tsx` (or extract to shared). Show each active goal with title, progress percentage, and linked Space task count.
  2. **Task status summary** -- Add a task status breakdown row (in_progress: N, needs_attention: N, completed: N) using existing `spaceStore.activeTasks` and `spaceStore.standaloneTasks` signals.
  3. **Recent activity feed** -- Add a compact feed showing the last 10 task status changes (completed, failed, needs_attention). Source from `spaceStore.tasks` sorted by `updatedAt` descending.
  4. **Conditional rendering** -- Only show goal section when goal integration is available.

- **Edge cases:**
  - Space has no associated goals -- show informative placeholder.
  - Large number of goals -- show top 3 with "Show all" link.
  - Dashboard already has substantial content -- new sections should be collapsible.

- **Testing:**
  - Unit test: verify goal progress section renders when goals exist, hides when no goals.
  - Test file: extend `packages/web/tests/space/SpaceDashboard.test.ts`

- **Acceptance Criteria:** Dashboard shows goal progress, task status counts, and recent activity. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
