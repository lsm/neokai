# Milestone 2: Bug B -- Clear Group Rate Limit on Manual Status Change

## Goal and Scope

When a user manually changes a task status from `usage_limited` or `rate_limited` to `in_progress` via `task.setStatus`, the `task.restrictions` field IS cleared by `TaskManager.setTaskStatus()` (line 256-261), but `group.rateLimit` in `SessionGroupRepository` is NOT cleared. This means the next time `onWorkerTerminalState` fires, `classifyError` re-detects the old "You've hit your limit" text and re-applies the backoff, preventing the worker output from being forwarded to the leader.

**Additional gap discovered during verification**: `task.sendHumanMessage` (line 963) has NO special handling for `rate_limited`/`usage_limited` tasks at all. The handler only has special cases for `needs_attention`, `completed`, `cancelled`, and `review` statuses (lines 1025-1069). When a user sends a message to a rate-limited task, it falls through to generic `routeHumanMessageToGroup()` — but the group still has `rateLimit` set, so `onWorkerTerminalState` will hit the `isRateLimited(groupId)` guard at line 634 and return early, preventing the worker output (including the new human message) from being routed to the leader.

The fix adds a public `clearGroupRateLimit(taskId)` method to `RoomRuntime` and calls it from both `task.setStatus` and `task.sendHumanMessage` handlers when the task is in a limited state.

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

**Description**: In `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`, in the `task.setStatus` handler, add a call to `runtime.clearGroupRateLimit(taskId)` when the task was in `usage_limited` or `rate_limited` status and the new status is `in_progress` or `pending`. This must happen BEFORE `setTaskStatus()` is called so the group state is clean before the task status changes.

**IMPORTANT — block placement**: The existing restart block at lines 467-486 only handles transitions from `needs_attention`, `cancelled`, and `archived` (when `params.mode === 'manual'`). A task in `usage_limited` or `rate_limited` status would NOT hit this block. Therefore, the `clearGroupRateLimit` call must be in a **new, separate top-level conditional block** — NOT nested inside the existing restart block.

**Subtasks**:
1. After the existing restart block (lines 467-486, which ends with `}`) and BEFORE the `setTaskStatus` call (line 489), add a new top-level conditional block:
   ```typescript
   // Clear group rate limit when resuming from a rate/usage limited state.
   // This is a separate block (not inside the restart block above) because
   // rate_limited/usage_limited tasks are NOT covered by the restart block.
   if (
       (task.status === 'usage_limited' || task.status === 'rate_limited') &&
       (params.status === 'in_progress' || params.status === 'pending')
   ) {
       const runtime = runtimeService?.getRuntime(params.roomId);
       if (runtime) {
           runtime.clearGroupRateLimit(taskId);
       }
   }
   ```
2. The `runtimeService` variable is already available in the handler scope (used earlier in the cancel path).
3. No error is thrown if `clearGroupRateLimit` returns `false` (no group found) or if no runtime is available.

**Acceptance Criteria**:
- When `task.setStatus` transitions from `usage_limited`/`rate_limited` to `in_progress`/`pending`, `group.rateLimit` is cleared.
- The clear happens in a separate top-level block (NOT inside the restart block).
- The clear happens before `setTaskStatus()` so the runtime state is consistent.
- If no runtime is available, the handler continues normally (no error thrown).

**Dependencies**: Task 2.1

**Agent Type**: coder

---

### Task 2.3: Clear group rate limit in `task.sendHumanMessage` handler

**Title**: Clear group rate limit when sending a message to a rate-limited task

**Description**: In `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`, the `task.sendHumanMessage` handler (line 963) has no special handling for `rate_limited`/`usage_limited` tasks. When a user sends a message to such a task, it falls through to `routeHumanMessageToGroup()` but the group still has `rateLimit` set. Add handling that clears the group rate limit before routing the message, similar to the `needs_attention`/`completed` revive flow.

**Subtasks**:
1. In the `task.sendHumanMessage` handler, after the existing special-case blocks (after line 1069, before the generic routing at line 1071), add a block that checks if `task.status === 'rate_limited' || task.status === 'usage_limited'`.
2. If so, call `runtime.clearGroupRateLimit(taskId)` to clear the group's `rateLimit` and restore the task to `in_progress`.
3. The handler can then fall through to the generic `routeHumanMessageToGroup()` call, which will work correctly now that `group.rateLimit` is cleared.

**Acceptance Criteria**:
- When a user sends a human message to a `rate_limited`/`usage_limited` task, `group.rateLimit` is cleared.
- Task status is restored to `in_progress`.
- The message is routed normally via `routeHumanMessageToGroup()`.
- If `clearGroupRateLimit` returns `false` (no group found), the handler continues normally.

**Dependencies**: Task 2.1

**Agent Type**: coder

---

### Task 2.4: Unit tests for clearGroupRateLimit integration

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

**Dependencies**: Task 2.1, Task 2.2, Task 2.3

**Agent Type**: coder
