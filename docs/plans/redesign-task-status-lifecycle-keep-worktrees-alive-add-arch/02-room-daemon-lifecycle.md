# Milestone 2: Room Daemon Lifecycle Changes

## Goal

Update the room daemon so that `completed` and `cancelled` tasks keep their worktrees and session groups paused. Only `archived` triggers worktree cleanup and group teardown. Update all daemon-side guards that block messaging to cancelled/completed tasks.

## Scope

- `packages/daemon/src/lib/room/runtime/task-group-manager.ts` -- Stop worktree cleanup on complete/terminate
- `packages/daemon/src/lib/room/runtime/room-runtime.ts` -- Keep groups paused on complete/cancel, only tear down on archive, update reactivation logic
- `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` -- Update `task.setStatus` handler for reactivation and archive, update `task.sendHumanMessage` guard
- `packages/daemon/src/lib/room/tools/room-agent-tools.ts` -- Update `send_message_to_task` guard and stale comments
- `packages/daemon/src/storage/repositories/task-repository.ts` -- Ensure archive sets both `archived_at` and status
- Unit tests for all changes

## Key Design Notes

### Reactivation Architecture

The codebase already has two relevant methods for reviving task groups:
- **`reviveTaskForMessage(taskId, message)`** in `room-runtime.ts` (line ~1420): Revives a failed task's session group by clearing `completedAt`, restoring sessions from persisted state, restoring MCP servers, and injecting a message. This is the **lightweight revive** path — it preserves conversation history.
- **`resetGroupForRestart(groupId)`** in `SessionGroupRepository`: Full wipe — resets the group for a fresh start. Currently used by `task.setStatus` handler for `needs_attention → in_progress` and `cancelled → in_progress/pending` transitions (lines 432-446 in `task-handlers.ts`).

For **`completed → in_progress`** reactivation: use `reviveTaskForMessage()` (lightweight, preserves conversation) since the task completed successfully and the user wants to continue from where it left off. For **`cancelled → in_progress`**: continue using `resetGroupForRestart()` (fresh start) since the task was explicitly cancelled and may need a clean slate.

### Messaging Contract for Completed/Cancelled Tasks

When a user sends a message to a `completed` or `cancelled` task, the daemon should **auto-reactivate** the task to `in_progress` before injecting the message. This uses `reviveTaskForMessage()` which already handles revival + message injection in one atomic operation. The UI simply needs to enable the message input; the daemon handles the status transition transparently.

### Cascade Behavior

`cancelTaskCascade()` only cascades to `pending` dependents. Archiving does NOT cascade — it is an explicit per-task action. Reactivating a task does NOT un-cascade previously cancelled dependents.

---

### Task 2.1: Stop worktree cleanup on complete and cancel in task-group-manager

**Description:** Modify `task-group-manager.ts` so the `complete()` method no longer calls `cleanupWorktree()`. The `terminateGroup()` method (used by cancel) should also stop cleaning up worktrees. Only `archiveGroup()` should call `cleanupWorktree()`.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/runtime/task-group-manager.ts`:
   - In the `complete()` method, remove the `await this.cleanupWorktree(group)` call. Add comment: `// Worktree preserved for potential reactivation — only archiveGroup() cleans up`.
   - In the `terminateGroup()` method, remove both `cleanupWorktree()` calls (for already-terminal groups and newly terminated groups). Add similar comment.
   - Verify `archiveGroup()` still calls `cleanupWorktree()` — this is the only path that should clean up.
3. Update `packages/daemon/tests/unit/room/task-group-manager.test.ts`:
   - Adjust any tests that assert worktree cleanup happens on complete or terminate.
   - Add a test verifying `complete()` does NOT call `removeWorktree`.
   - Add a test verifying `terminateGroup()` does NOT call `removeWorktree`.
   - Add a test verifying `archiveGroup()` DOES call `removeWorktree`.
4. Run `cd packages/daemon && bun test tests/unit/room/task-group-manager.test.ts`.
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- `complete()` no longer cleans up the worktree.
- `terminateGroup()` no longer cleans up the worktree.
- `archiveGroup()` remains the only method that cleans up worktrees.
- All existing and new unit tests pass.

**Dependencies:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.2: Update room-runtime and RPC handlers for new lifecycle

**Description:** Update `room-runtime.ts` cancel/complete/archive flows, update `task.setStatus` RPC handler to support reactivation from `completed` and archive transitions, and update `task.sendHumanMessage` to allow messaging completed/cancelled tasks (with auto-reactivation).

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. **Verify cancel flow in `room-runtime.ts`:** The `cancelTask()` method calls `terminateGroup()` for active groups. Since Task 2.1 removes worktree cleanup from `terminateGroup()`, the cancel flow now correctly preserves worktrees with no further changes needed. Verify this by reading the `cancelTask()` method and confirming the worktree survives after the `terminateGroup()` call. If any other cleanup paths exist, update them.
3. **Update `archiveTaskGroup()` in `room-runtime.ts`** to ensure it:
   - Terminates active sessions if the group is still active.
   - Calls `taskGroupManager.archiveGroup()` (which calls `cleanupWorktree`).
   - Sets the task status to `archived` via `taskManager.archiveTask()`.
4. **Update `task.setStatus` RPC handler** in `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`:
   - When transitioning TO `archived`: call `runtime.archiveTaskGroup()` if a runtime exists, otherwise call `taskManager.archiveTask()` directly.
   - When transitioning FROM `completed` TO `in_progress`: use `runtime.reviveTaskForMessage()` (the existing method at line ~1420 of `room-runtime.ts`) for lightweight revival that preserves conversation history. If no message is provided, call `reviveTaskForMessage()` with an empty/system message or use a simpler revival path.
   - When transitioning FROM `cancelled` TO `in_progress` or `pending`: continue using the existing `resetGroupForRestart()` path (lines 432-446 of `task-handlers.ts`), which performs a full wipe. This is correct for cancelled tasks.
   - Ensure the existing `task.archive` RPC handler calls the updated `archiveTask()` which now sets `status = 'archived'`.
5. **Update `task.sendHumanMessage` handler** in `task-handlers.ts` (lines 804-810): Remove the guard that throws for `cancelled` tasks ("Cancelled tasks cannot receive messages because their workspace has been cleaned up"). Replace with logic that auto-reactivates the task via `runtime.reviveTaskForMessage()` before injecting the message. Apply the same logic for `completed` tasks if they are currently blocked.
6. Run all related daemon unit tests: `cd packages/daemon && bun test tests/unit/room/ tests/unit/rpc-handlers/task-handlers.test.ts`.
7. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Cancelling a task stops agent sessions and mirroring but preserves the worktree.
- Completing a task preserves the worktree and group (paused).
- Archiving a task cleans up the worktree, tears down the group, and sets `status = 'archived'`.
- Reactivation from `completed` to `in_progress` uses lightweight revival (preserves conversation).
- Reactivation from `cancelled` to `in_progress` uses full reset (clean slate).
- `task.sendHumanMessage` works for completed and cancelled tasks (auto-reactivates).
- All unit tests pass.

**Dependencies:** Task 2.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.3: Update room-agent-tools.ts daemon-side guards and comments

**Description:** Update the agent-facing tool guards in `room-agent-tools.ts` that block messaging to cancelled tasks, and fix stale comments about worktree cleanup semantics.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`:
   - **Update `send_message_to_task` guard** (lines 515-522): The current guard throws an error for `status === 'cancelled'` saying "Cancelled tasks cannot receive messages because their workspace has been cleaned up." Since cancelled tasks now keep their worktrees, update this to either:
     - Allow messaging and auto-reactivate (preferred, consistent with `task.sendHumanMessage`), OR
     - Update the error message to reflect new semantics (e.g., "Task is cancelled. Use set_task_status to reactivate it first.") if agent-initiated messaging should still require explicit reactivation.
   - **Update stale comment** (lines 398-400): The comment says "Only supported for failed tasks — cancelled tasks have their worktree cleaned up so reviving the group would point sessions at a gone workspace." This is no longer true. Update to: "Lightweight revive: clear completedAt without resetting metadata. Supported for failed and completed tasks. Cancelled tasks use resetGroupForRestart() for a clean slate."
3. Search for any other references to "workspace has been cleaned up" or "worktree cleaned up" in `room-agent-tools.ts` and update them.
4. Run `cd packages/daemon && bun test tests/unit/room/`.
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- `send_message_to_task` no longer blocks cancelled tasks with a stale worktree error.
- All comments about worktree cleanup for cancelled tasks are updated to reflect new semantics.
- All unit tests pass.

**Dependencies:** Task 2.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.4: Unit tests for room-runtime lifecycle changes

**Description:** Add unit tests covering the new lifecycle behavior in room-runtime: reactivation from completed/cancelled, archive triggering cleanup, messaging to completed/cancelled tasks, and verifying worktree preservation on complete/cancel.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/tests/unit/rpc-handlers/task-handlers.test.ts`:
   - Add test: `task.setStatus` from `completed` to `in_progress` succeeds (reactivation via lightweight revival).
   - Add test: `task.setStatus` from `cancelled` to `in_progress` succeeds (reactivation via full reset).
   - Add test: `task.setStatus` from `completed` to `archived` succeeds and triggers worktree cleanup.
   - Add test: `task.setStatus` from `archived` to any other status fails.
   - Add test: `task.archive` RPC sets status to `archived` and cleans up worktree.
   - Add test: `task.sendHumanMessage` to a `completed` task succeeds (auto-reactivates).
   - Add test: `task.sendHumanMessage` to a `cancelled` task succeeds (auto-reactivates).
   - Add test: `task.sendHumanMessage` to an `archived` task fails.
3. Run `cd packages/daemon && bun test tests/unit/rpc-handlers/task-handlers.test.ts`.
4. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All new test cases pass.
- Tests verify both the status transition and the worktree cleanup (or lack thereof).
- Tests verify archived is truly terminal.
- Tests verify messaging auto-reactivation for completed/cancelled.

**Dependencies:** Task 2.3

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
