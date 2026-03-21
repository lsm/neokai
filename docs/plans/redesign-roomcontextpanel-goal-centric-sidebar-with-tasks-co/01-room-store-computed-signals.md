# Milestone 1: Room Store Computed Signals

## Goal

Add computed signals to `room-store.ts` that derive goal-grouped tasks, orphan tasks, and status-filtered task lists. These signals power the new sidebar sections.

## Tasks

### Task 1.1: Add Computed Signals for Goal-Task Grouping and Orphan Tasks

**Description:** Add computed signals to the `RoomStore` class that the redesigned sidebar needs: tasks grouped by goal ID, orphan tasks (not linked to any goal), and orphan tasks filtered by status category (active, review, done).

**Agent type:** coder

**Depends on:** (none)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/lib/room-store.ts`, add the following computed signals to `RoomStore`:
   - `tasksByGoalId`: `computed(() => Map<string, TaskSummary[]>)` - Iterate over `goals.value`, for each goal filter `tasks.value` by checking if `task.id` is in `goal.linkedTaskIds`. Return a Map keyed by goal ID.
   - `orphanTasks`: `computed(() => TaskSummary[])` - Tasks whose ID does not appear in any goal's `linkedTaskIds`.
   - `orphanTasksActive`: `computed(() => TaskSummary[])` - Orphan tasks with status `in_progress`.
   - `orphanTasksReview`: `computed(() => TaskSummary[])` - Orphan tasks with status `review` or `needs_attention`.
   - `orphanTasksDone`: `computed(() => TaskSummary[])` - Orphan tasks with status `completed` or `cancelled`.
3. Ensure all new signals are `readonly` and placed in the "Computed Accessors" section.
4. Run `bun run typecheck` to verify no type errors.
5. Run `bun run lint` and `bun run format` to ensure code quality.

**Acceptance criteria:**
- `tasksByGoalId` returns a Map where each goal's linked tasks are resolved from the tasks signal.
- `orphanTasks` correctly excludes tasks that appear in any goal's `linkedTaskIds`.
- `orphanTasksActive`, `orphanTasksReview`, `orphanTasksDone` filter orphan tasks by the correct status values.
- TypeScript compiles without errors.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
