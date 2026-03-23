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
   - `tasksByGoalId`: `computed(() => Map<string, TaskSummary[]>)` - First build a `Set<string>` of all linked task IDs across all goals (single pass over goals), then for each goal resolve its linked tasks from the tasks signal using this Set for O(1) lookups. Return a Map keyed by goal ID. Performance note: build the linked-ID Set first to avoid O(goals × tasks) iteration.
   - `orphanTasks`: `computed(() => TaskSummary[])` - Tasks whose ID does not appear in any goal's `linkedTaskIds`. Reuse the same linked-ID Set approach.
   - `orphanTasksActive`: `computed(() => TaskSummary[])` - Orphan tasks with status `draft`, `pending`, or `in_progress`. These three statuses represent tasks that are not yet in review or completed.
   - `orphanTasksReview`: `computed(() => TaskSummary[])` - Orphan tasks with status `review` or `needs_attention`.
   - `orphanTasksDone`: `computed(() => TaskSummary[])` - Orphan tasks with status `completed` or `cancelled`.
3. Ensure all new signals are `readonly` and placed in the "Computed Accessors" section.
4. Run `bun run typecheck` to verify no type errors.
5. Run `bun run lint` and `bun run format` to ensure code quality.

**Acceptance criteria:**
- `tasksByGoalId` returns a Map where each goal's linked tasks are resolved from the tasks signal.
- `orphanTasks` correctly excludes tasks that appear in any goal's `linkedTaskIds`.
- `orphanTasksActive` includes orphan tasks with `draft`, `pending`, or `in_progress` status (all 7 `TaskStatus` values are accounted for across the three buckets).
- `orphanTasksReview` and `orphanTasksDone` filter orphan tasks by the correct status values.
- TypeScript compiles without errors.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
