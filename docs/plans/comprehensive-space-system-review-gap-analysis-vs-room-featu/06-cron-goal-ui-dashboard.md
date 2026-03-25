# M6: Cron Scheduling + Goal UI + Dashboard

> **⚠️ Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Acceptance Criteria

- [ ] Space workflows with a `schedule` field auto-start new runs at configured intervals.
- [ ] Users can create and manage goals from the Space UI.
- [ ] Space dashboard shows goal progress, active workflow runs, and task status.

---

## Task 12: Cron Scheduling for Recurring Space Workflows

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 7 (JobQueue -- see `02-runtime-reliability.md`)
- **Description:** Add cron-based scheduling for recurring Space workflows.

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
  3. **Tick handler:** In `SpaceRuntime.executeTick()`, add a `processScheduledWorkflows()` step that:
     - Lists workflows with `next_run_at <= now` and `schedule != null`.
     - For each due workflow, starts a new run via `startWorkflowRun()`.
     - Computes and persists the next `next_run_at`.
  4. **Catch-up detection:** If `next_run_at` is in the past by more than one interval, only start ONE run (not backfill missed runs). This follows Room's approach.

- **Edge cases:**
  - Invalid cron expression -- validate on save, reject with clear error.
  - Timezone changes -- recompute `next_run_at` when timezone is updated.
  - Workflow deleted while scheduled -- cleanup in tick handler.
  - Space archived -- skip all scheduled workflows for archived spaces.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-cron-scheduling.test.ts`
  - Test scenarios: (a) valid cron creates run at correct time, (b) catch-up starts only one run, (c) archived space skips, (d) deleted workflow cleaned up

- **Acceptance Criteria:** Scheduled Space workflows auto-start new runs at configured intervals.

---

## Task 13: Goal Creation UI for Space

- **Priority:** LOW
- **Agent Type:** coder
- **Dependencies:** Task 1 (goal integration -- see `03-goal-integration-hitl-ui.md`)
- **Description:** Create a goal/mission creation wizard for Space.

- **Files to create:**
  - `packages/web/src/components/space/SpaceGoalsEditor.tsx`

- **Files to modify:**
  - `packages/web/src/lib/space-store.ts` -- add goal-related actions
  - `packages/web/src/components/space/SpaceTaskPane.tsx` or a parent layout -- integrate GoalsEditor

- **Implementation approach:**
  1. **Follow Room's `GoalsEditor.tsx` pattern** but simplify for Space context:
     ```tsx
     interface SpaceGoalsEditorProps {
       spaceId: string;
       goals: RoomGoal[];
       tasks?: SpaceTask[];
     }
     ```
  2. Reuse the same `goal.create`, `goal.list`, `goal.update`, `goal.delete` RPC handlers (they are Room-scoped but the Space context would need to know which `roomId` to use -- this depends on Task 0's design).
  3. If Task 0's design introduces Space-specific goal RPCs, use those instead.

- **Edge cases:**
  - No Room associated with the Space -- show message "Associate a Room to create goals" (depends on Task 0 design).
  - Goal created from Room but visible in Space -- show read-only or editable depending on design.

- **Testing:**
  - E2E test: goal creation wizard flow in Space context.
  - E2E test file: `packages/e2e/tests/features/space-goals-editor.e2e.ts`

- **Acceptance Criteria:** Users can create and manage goals from the Space UI.

---

## Task 14: Enhance Existing Space Dashboard with Goal/Task Overview

- **Priority:** LOW
- **Agent Type:** coder
- **Dependencies:** Task 1 (goal integration), Task 13 (goal UI)
- **Description:** Enhance the existing `SpaceDashboard.tsx` (already shows space overview, active run progress, and quick-action cards) with goal progress, task status summary, and recent activity feed.

- **Files to modify:**
  - `packages/web/src/components/space/SpaceDashboard.tsx` -- add goal progress section, task status counts, activity feed
  - `packages/web/src/lib/space-store.ts` -- add goal-related computed signals if needed

- **Implementation approach:**
  1. **Goal progress section** -- Add a collapsible "Mission Progress" panel below the existing quick-action cards. Reuse the progress bar component from `GoalsEditor.tsx` (or extract to a shared component). Show each active goal with its title, progress percentage bar, and linked Space task count.
  2. **Task status summary** -- Add a task status breakdown row (in_progress: N, needs_attention: N, completed: N) using `spaceStore.activeTasks`, `spaceStore.standaloneTasks` computed signals.
  3. **Recent activity feed** -- Add a compact activity feed showing the last 10 task status changes (completed, failed, needs_attention). Source from `spaceStore.tasks` sorted by `updatedAt` descending.
  4. **Conditional rendering** -- Only show the goal section when `Task 1` integration is available (goals exist for the space's associated room). Show a placeholder "Associate a Room to track mission progress" if no goals.

- **Edge cases:**
  - Space has no associated room/goals -- show informative placeholder, not an empty section.
  - Large number of goals -- show top 3 with "Show all" link to GoalsEditor.
  - Dashboard already has substantial content -- new sections should be collapsible to avoid overwhelming the view.

- **Testing:**
  - Unit test: verify goal progress section renders when goals exist, hides when no goals.
  - Test file: `packages/web/tests/space/SpaceDashboard.test.ts` (create or extend)

- **Acceptance Criteria:** Users can see at a glance the status of all goals, workflows, and tasks within a Space. Goal progress, task counts, and recent activity are visible on the existing dashboard.
