# Milestone 2: Bug B -- Clear Group Rate Limit on Manual Status Change

## Goal and Scope

When a user manually changes a task status from `usage_limited` or `rate_limited` to `in_progress` via `task.setStatus`, the `task.restrictions` field IS cleared by `TaskManager.setTaskStatus()`, but `group.rateLimit` in `SessionGroupRepository` is NOT cleared. This means the next time `onWorkerTerminalState` fires, `classifyError` re-detects the old "You've hit your limit" text and re-applies the backoff, preventing the worker output from being forwarded to the leader.

The fix adds a public `clearGroupRateLimit(taskId)` method to `RoomRuntime` and calls it from the `task.setStatus` RPC handler when the task was in a limited state and the new status is `in_progress`.

## Tasks

### Task 2.1: Add `clearGroupRateLimit(taskId)` method to RoomRuntime

**Title**: Add public `clearGroupRateLimit()` method to `RoomRuntime`

**Description**: Add a public method to `RoomRuntime` that looks up the active group for a given task ID and clears its rate limit via `groupRepo.clearRateLimit(groupId)`. Also clear the task restriction via `this.clearTaskRestriction(taskId)`.

**Subtasks**:
1. Add method `clearGroupRateLimit(taskId: string): boolean` to `RoomRuntime` (public, in the same area as other public methods like `cancelTask`, `terminateTaskGroup`).
2. The method should: find the active group for the task via `groupRepo.getGroupByTaskId(taskId)`, if found call `groupRepo.clearRateLimit(group.id)`, call `clearTaskRestriction(taskId)`, log a message, and return `true`. If no group found, return `false`.
3. Note: `groupRepo.getGroupByTaskId()` already exists (used in `task-handlers.ts` line 476).

**Acceptance Criteria**:
- `clearGroupRateLimit(taskId)` is a public method on `RoomRuntime`.
- It clears `group.rateLimit` via `groupRepo.clearRateLimit()`.
- It calls `clearTaskRestriction(taskId)` to restore task status.
- It returns `true` if a group was found and cleared, `false` otherwise.

**Dependencies**: None.

**Agent Type**: coder

---

### Task 2.2: Call `clearGroupRateLimit()` from `task.setStatus` handler

**Title**: Integrate `clearGroupRateLimit()` into the `task.setStatus` RPC handler

**Description**: In `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`, in the `task.setStatus` handler (around line 467-486), add a call to `runtime.clearGroupRateLimit(taskId)` when the task was in `usage_limited` or `rate_limited` status and the new status is `in_progress` or `pending`. This must happen BEFORE `setTaskStatus()` is called so the group state is clean before the task status changes.

**Subtasks**:
1. In the `task.setStatus` handler, after the existing `groupRepo.resetGroupForRestart` block (line 467-486) but before `setTaskStatus` (line 489), add a block that checks if the current task status is `usage_limited` or `rate_limited` and the new status is `in_progress` or `pending`.
2. If so, get the runtime and call `runtime.clearGroupRateLimit(taskId)`.
3. This should use the same runtime lookup pattern already present: `runtimeService?.getRuntime(params.roomId)`.

**Acceptance Criteria**:
- When `task.setStatus` transitions from `usage_limited`/`rate_limited` to `in_progress`/`pending`, `group.rateLimit` is cleared.
- The clear happens before `setTaskStatus()` so the runtime state is consistent.
- If no runtime is available, the handler continues normally (no error thrown).

**Dependencies**: Task 2.1

**Agent Type**: coder

---

### Task 2.3: Unit tests for clearGroupRateLimit integration

**Title**: Add tests for `clearGroupRateLimit()` and its integration with `task.setStatus`

**Description**: Add tests verifying that manual status change from `usage_limited`/`rate_limited` to `in_progress` clears both the group rate limit and the task restriction.

**Subtasks**:
1. Test: Call `runtime.clearGroupRateLimit(taskId)` after a usage_limit detection -- verify `group.rateLimit` is null and task status is `in_progress`.
2. Test: Verify that after manual status change, a subsequent `onWorkerTerminalState` call does NOT re-apply the backoff for the old usage limit text (because `group.rateLimit` is null, but the old text triggers `usage_limit` -- the handler runs but `trySwitchToFallbackModel` is attempted, and if no fallback, it sets a new backoff -- but this time the `getWorkerMessages` returns new messages without the error text).
3. Integration-style test: simulate the full flow -- usage_limit detected -> backoff set -> manual status change to `in_progress` -> new worker message (without error text) -> `onWorkerTerminalState` routes to leader normally.

**Acceptance Criteria**:
- Test "clearGroupRateLimit clears group rate limit and task restriction" passes.
- Test "after manual status change, worker output routes to leader normally" passes.
- Existing rate-limit-persistence tests continue to pass.

**Dependencies**: Task 2.1, Task 2.2

**Agent Type**: coder
