# M1: Workflow Execution Foundation

> **Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Goal

Fix data model and state management holes that can cause workflow runs to silently lose progress or get stuck. After this milestone, a workflow run that is mid-creation during a daemon crash will be recovered, the transition map will support rate limit states, and the notification dedup restart contract will be validated with tests.

## Milestone Acceptance Criteria

- [ ] `VALID_SPACE_TASK_TRANSITIONS` allows `in_progress -> rate_limited` and `in_progress -> usage_limited`.
- [ ] Pending workflow runs from crashed daemon instances are recovered or cleaned up on restart.
- [ ] Notification dedup restart contract is validated with unit tests.

---

## Task 1: Fix Task Status Transition Map for Rate Limit States

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** The `VALID_SPACE_TASK_TRANSITIONS` map in `space-task-manager.ts` does not allow `in_progress -> rate_limited` or `in_progress -> usage_limited`. These transitions are required before any error classification pipeline can be built (Milestone 2, Task 6). Without this fix, the runtime cannot pause tasks when API rate limits are hit.

- **Files to modify:**
  - `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- line 26: the `in_progress` entry

- **Specific change:**
  ```ts
  // Before:
  in_progress: ['review', 'completed', 'needs_attention', 'cancelled'],
  // After:
  in_progress: ['review', 'completed', 'needs_attention', 'cancelled', 'rate_limited', 'usage_limited'],
  ```

- **Edge cases:**
  - Existing unit tests at `packages/daemon/tests/unit/lib/space-task-manager.test.ts` that enumerate valid transitions must be updated.
  - The `setTaskStatus()` method's `options` parameter should eventually accept rate limit metadata, but that is out of scope here -- this task only adds the transition.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/lib/space-task-manager.test.ts` (extend existing)
  - Test scenarios: (a) `in_progress -> rate_limited` is valid, (b) `in_progress -> usage_limited` is valid, (c) all existing transitions still work, (d) invalid transitions still throw

- **Acceptance Criteria:** Transition map updated and tested. All existing tests still pass. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2: Pending Workflow Run Rehydration

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** `rehydrateExecutors()` in `space-runtime.ts` only loads runs with status `in_progress` or `needs_attention`. A `pending` run that was mid-creation during a daemon crash is silently skipped. The run record remains in the DB as `pending` forever, its tasks are never created, and it never appears in the executor map.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `rehydrateExecutors()` method
  - `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- possibly add `getRehydratablePendingRuns()` or modify `getRehydratableRuns()`

- **Implementation approach:**
  1. Modify `SpaceWorkflowRunRepository.getRehydratableRuns()` to also include `pending` runs that have existed for less than a configurable threshold (default 5 minutes).
  2. In `rehydrateExecutors()`, for `pending` runs: attempt to resume task creation by checking if the workflow run already has tasks in the `space_tasks` table. If tasks exist, transition to `in_progress` and load executor. If no tasks exist after the threshold, transition to `cancelled`.
  3. Add a configuration option `SpaceRuntimeConfig.pendingRunTimeoutMs` (default 300_000).

- **Edge cases:**
  - Run was `pending` but has tasks (partial creation) -- resume as `in_progress`.
  - Run was `pending` with no tasks and just created (< 1 minute) -- keep as `pending`, retry on next tick.
  - Run was `pending` with no tasks and stale (> 5 minutes) -- cancel.
  - Multiple `pending` runs for the same workflow -- cancel duplicates, keep newest.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-runtime-rehydrate.test.ts` (create)
  - Test scenarios: (a) pending run with tasks resumes, (b) stale pending run without tasks cancels, (c) fresh pending run without tasks stays pending, (d) multiple pending runs deduplicated
  - Follow existing test patterns in `packages/daemon/tests/unit/space/space-runtime.test.ts`

- **Acceptance Criteria:** Pending runs from crashed daemon instances are either recovered or cleaned up on next startup. Unit tests pass. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3: Validate Notification Dedup Restart Contract

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** The `notifiedTaskSet` in `SpaceRuntime` is intentionally in-memory only. This is documented as intentional design at `space-runtime.ts:150-153`. The contract is: tasks already in `needs_attention` at restart time will be re-notified once on the first tick. This task validates that contract with explicit tests so the behavior is locked in and regressions are caught.

- **Files to create:**
  - `packages/daemon/tests/unit/space/space-runtime-notification-dedup.test.ts`

- **Test scenarios:**
  1. Create a new `SpaceRuntime` instance, add a `needs_attention` task to the DB, call `executeTick()`, verify `safeNotify` was called exactly once for that task.
  2. On second tick, verify the same task does NOT re-notify (dedup works).
  3. Verify that calling `setNotificationSink()` clears the dedup set.
  4. Verify that completing a task clears its dedup entry so re-entry into `needs_attention` will re-notify.

- **Implementation notes:**
  - Follow the same test pattern as existing `packages/daemon/tests/unit/space/space-runtime-notifications.test.ts`.
  - Use a mock `NotificationSink` that records calls.

- **Acceptance Criteria:** Unit tests confirm: (a) dedup set starts empty, (b) `needs_attention` tasks re-notify on first tick after restart, (c) subsequent ticks are deduped, (d) `setNotificationSink()` clears dedup. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
