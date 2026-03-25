# M1: Foundation -- Data Model Fixes + Goal Bridge Design

> **⚠️ Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Acceptance Criteria

- [ ] `VALID_SPACE_TASK_TRANSITIONS` allows `in_progress → rate_limited` and `in_progress → usage_limited`.
- [ ] Unit tests cover the new transition map entries.
- [ ] Design document for GoalManager bridge architecture is approved.
- [ ] Notification dedup restart contract is validated with unit tests.
- [ ] Pending workflow run rehydration works correctly.

---

## Task 0: Design GoalManager Bridge Architecture for Space

- **Priority:** CRITICAL
- **Agent Type:** general
- **Dependencies:** None
- **Description:** `GoalManager` is constructed with `roomId` and operates on Room-scoped data. The `goals` table has a required `room_id` FK to `rooms(id)`. Space stores `goalId` on `SpaceWorkflowRun` (nullable `goal_id` column) but has no `roomId` concept. Before any goal integration code can be written, the bridge architecture must be designed.

- **Files to analyze:**
  - `packages/daemon/src/lib/room/managers/goal-manager.ts` -- `GoalManager` constructor: `(db, roomId, reactiveDb, shortIdAllocator?)`
  - `packages/daemon/src/storage/repositories/goal-repository.ts` -- all methods require `roomId` except `getGoalsForTask(taskId)` and `linkTaskToGoal(goalId, taskId)`
  - `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- `goalId` stored as nullable `goal_id` column
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- integration point at `handleSubSessionComplete()` line ~907
  - `packages/daemon/src/lib/room/managers/task-manager.ts` -- Room tasks are linked to goals via `GoalRepository.linkTaskToGoal()`, not via a `goalId` field on tasks

- **Design options to evaluate:**
  1. **(a) Space queries GoalRepository directly** -- Use `GoalRepository.getGoalsForTask(taskId)` to look up goals without needing `roomId`. Problem: Space tasks are not Room tasks, so `linkTaskToGoal` has never been called. The linkage would need to be established at workflow run creation time.
  2. **(b) Space instantiates GoalManager with resolved roomId** -- When a Space workflow run starts with a `goalId`, resolve the `roomId` from the `goals` table, then create a `GoalManager(roomId)`. Problem: `GoalManager.recalculateProgress()` iterates `goal.linkedTaskIds` which are Room task UUIDs, not Space task IDs.
  3. **(c) Space tracks its own progress** -- Add a `SpaceTaskProgress` table or extend the goals table with Space-specific task links. Most flexible but most work.
  4. **(d) Space stores roomId alongside goalId** -- Schema change on `space_workflow_runs` to add `room_id`. Then Space can instantiate `GoalManager(roomId)` and use its full API.

- **Key question to resolve:** How does `updateGoalsForTask()` work when the tasks are Space tasks, not Room tasks? The Room method calls `getGoalsForTask(taskId)` then `calculateProgressFromTasks(goal)` which iterates `goal.linkedTaskIds` and calls `taskRepo.getTask(taskId)`. Space tasks live in a different table (`space_tasks` vs `tasks`) with a different repository (`SpaceTaskRepository` vs `TaskRepository`).

- **Deliverable:** `docs/plans/space-goal-bridge-design.md` with: (a) recommended option, (b) schema changes, (c) API surface changes, (d) integration points, (e) backward compatibility analysis.

- **Acceptance Criteria:** Design document is approved with a clear recommendation.

---

## Task 2: Rate Limit Detection Pipeline for Space (Data Model Prerequisite)

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Fix the `VALID_SPACE_TASK_TRANSITIONS` map to allow rate limit transitions. This is a prerequisite for the full pipeline (which will be in Milestone 5).

- **Files to modify:**
  - `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- line 26: add `'rate_limited'`, `'usage_limited'` to `in_progress` transitions

- **Specific change:**
  ```ts
  // Before:
  in_progress: ['review', 'completed', 'needs_attention', 'cancelled'],
  // After:
  in_progress: ['review', 'completed', 'needs_attention', 'cancelled', 'rate_limited', 'usage_limited'],
  ```

- **Edge cases:**
  - Existing unit tests that enumerate valid transitions must be updated.
  - The `setTaskStatus()` method's `options` parameter should be extended to accept `{ rateLimitInfo?: { resetsAt: number; sessionRole: string } }` for persisting backoff metadata.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-task-manager.test.ts` (create if needed)
  - Test scenarios: (a) `in_progress → rate_limited` is valid, (b) `in_progress → usage_limited` is valid, (c) all existing transitions still work, (d) invalid transitions still throw

- **Acceptance Criteria:** Transition map updated and tested. PR created.

---

## Task 8: Pending Run Rehydration Fix

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Handle `pending` workflow runs that were mid-creation during a daemon crash. `rehydrateExecutors()` in `space-runtime.ts` only loads runs with status `in_progress` or `needs_attention`.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `rehydrateExecutors()` method
  - `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- add `getRehydratablePendingRuns()` or modify `getRehydratableRuns()`

- **Implementation approach:**
  1. Modify `SpaceWorkflowRunRepository.getRehydratableRuns()` to also include `pending` runs that have existed for less than a configurable threshold (default 5 minutes).
  2. In `rehydrateExecutors()`, for `pending` runs: attempt to resume task creation by checking if the workflow run already has tasks in the `space_tasks` table. If yes, transition to `in_progress` and load executor. If no tasks exist after the threshold, transition to `cancelled`.
  3. Add a configuration option `SpaceRuntimeConfig.pendingRunTimeoutMs` (default 300_000).

- **Edge cases:**
  - Run was `pending` but has tasks (partial creation) -- resume as `in_progress`.
  - Run was `pending` with no tasks and just created (< 1 minute) -- keep as `pending`, retry on next tick.
  - Run was `pending` with no tasks and stale (> 5 minutes) -- cancel.
  - Multiple `pending` runs for the same workflow -- cancel duplicates, keep newest.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-runtime-rehydrate.test.ts` (create if needed)
  - Test scenarios: (a) pending run with tasks resumes, (b) stale pending run without tasks cancels, (c) fresh pending run without tasks stays pending, (d) multiple pending runs deduplicated

- **Acceptance Criteria:** Pending runs from crashed daemon instances are either recovered or cleaned up on next startup. Unit tests pass.

---

## Task 9: Validate Notification Dedup Restart Contract

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** The `notifiedTaskSet` in `SpaceRuntime` is intentionally in-memory only (documented restart contract at `space-runtime.ts:150-153`). This task validates that contract with tests.

- **Files to modify:**
  - `packages/daemon/tests/unit/space/space-runtime-notification-dedup.test.ts` (create)

- **Test scenarios:**
  1. Construct a new `SpaceRuntime` instance -- verify `notifiedTaskSet` is empty (the field is private, so test via behavior: a `needs_attention` task should trigger a notification on the first tick after "restart").
  2. Simulate restart scenario: create a runtime, add a `needs_attention` task to the DB, call `executeTick()`, verify `safeNotify` was called exactly once for that task.
  3. On second tick, verify the same task does NOT re-notify (dedup works).
  4. Verify that calling `setNotificationSink()` clears the dedup set.

- **Implementation notes:**
  - Follow the same test pattern as `packages/daemon/tests/unit/room/` tests: use a mock `NotificationSink` that records calls.
  - The `SpaceRuntime` constructor takes `SpaceRuntimeConfig`. For tests, provide a mock `SpaceManager` and `SpaceTaskRepository` that return fixture data.

- **Acceptance Criteria:** Unit tests confirm: (a) dedup set starts empty, (b) `needs_attention` tasks re-notify on first tick after restart, (c) subsequent ticks are deduped.
