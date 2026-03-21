# Milestone 2: Room Daemon Lifecycle Changes

## Goal

Update the room daemon so that `completed` and `cancelled` tasks keep their worktrees and session groups paused. Only `archived` triggers worktree cleanup and group teardown.

## Scope

- `packages/daemon/src/lib/room/runtime/task-group-manager.ts` -- Stop worktree cleanup on complete/fail/terminate
- `packages/daemon/src/lib/room/runtime/room-runtime.ts` -- Keep groups paused on complete/cancel, only tear down on archive
- `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` -- Update setStatus handler to support reactivation and archive transitions
- `packages/daemon/src/storage/repositories/task-repository.ts` -- Ensure archive sets both `archivedAt` and status
- Unit tests for task-group-manager and room-runtime changes

---

### Task 2.1: Stop worktree cleanup on complete and cancel in task-group-manager

**Description:** Modify `task-group-manager.ts` so the `complete()` method no longer calls `cleanupWorktree()`. The `terminateGroup()` method (used by cancel) should also stop cleaning up worktrees. Only `archiveGroup()` should call `cleanupWorktree()`. The `fail()` method already skips cleanup (kept for debugging), so no change there.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/runtime/task-group-manager.ts`:
   - In the `complete()` method (line ~561), remove the `await this.cleanupWorktree(group)` call. Update the comment to explain worktree is preserved for potential reactivation.
   - In the `terminateGroup()` method (line ~724), remove both `cleanupWorktree()` calls (line ~732 for already-terminal groups and line ~743 for newly terminated groups). Update comments.
   - Verify `archiveGroup()` (line ~771) still calls `cleanupWorktree()` -- this is the only path that should clean up.
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

### Task 2.2: Update room-runtime cancel and complete flows

**Description:** Update `room-runtime.ts` so that the `cancelTask()` method keeps the group paused (not fully torn down) and the complete flow preserves the group. Update the `archiveTaskGroup()` method to also terminate active sessions and tear down the group before cleaning the worktree. Update the `terminateTaskGroup()` method to stop sessions but keep the group.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, update `cancelTask()` (line ~1570):
   - Instead of calling `taskGroupManager.terminateGroup()`, call `taskGroupManager.cancel()` which already handles the task status change, but modify the flow to NOT terminate the group -- instead pause it. Concretely: stop agent sessions (via `terminateGroupSessions()`), cleanup mirroring, but do NOT call `terminateGroup()`. Instead mark the group as paused by setting `completedAt` (this already happens in the current flow via `failGroup`).
   - Actually, review the current flow carefully: `cancelTask()` calls `terminateGroup()` for active groups and then `terminateGroupSessions()` + `cleanupMirroring()`. Since `terminateGroup()` now no longer cleans worktrees (from Task 2.1), the behavior is already correct -- the group gets marked terminal but the worktree survives. Verify this is the case and adjust only if needed.
3. Update `archiveTaskGroup()` to ensure it:
   - Terminates active sessions if the group is still active.
   - Calls `taskGroupManager.archiveGroup()` (which calls `cleanupWorktree`).
   - Sets the task status to `archived`.
4. Update the `task.setStatus` RPC handler in `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`:
   - When transitioning TO `archived`: call `runtime.archiveTaskGroup()` if a runtime exists, otherwise call `taskManager.archiveTask()`.
   - When transitioning FROM `completed` or `cancelled` TO `in_progress` (reactivation): call `runtime.reviveTaskGroup()` to restore the paused group and its agent sessions.
   - Ensure the existing `task.archive` RPC handler still works (it should set status to `archived`).
5. Update `packages/daemon/src/storage/repositories/task-repository.ts` `archiveTask()` to also set `status = 'archived'` in addition to `archived_at`.
6. Run all related daemon unit tests: `cd packages/daemon && bun test tests/unit/room/ tests/unit/rpc-handlers/task-handlers.test.ts`.
7. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Cancelling a task stops agent sessions and mirroring but preserves the worktree.
- Completing a task preserves the worktree and group (paused).
- Archiving a task cleans up the worktree and is the only path that does so.
- Reactivation from `completed`/`cancelled` to `in_progress` revives the group.
- All unit tests pass.

**Dependencies:** Task 2.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.3: Unit tests for room-runtime lifecycle changes

**Description:** Add unit tests covering the new lifecycle behavior in room-runtime: reactivation from completed/cancelled, archive triggering cleanup, and verifying worktree preservation on complete/cancel.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In the appropriate test file (likely `packages/daemon/tests/unit/rpc-handlers/task-handlers.test.ts` or `packages/daemon/tests/unit/rpc/task-handlers.test.ts`):
   - Add test: `task.setStatus` from `completed` to `in_progress` succeeds (reactivation).
   - Add test: `task.setStatus` from `cancelled` to `in_progress` succeeds (reactivation).
   - Add test: `task.setStatus` from `completed` to `archived` succeeds and triggers worktree cleanup.
   - Add test: `task.setStatus` from `archived` to any other status fails.
   - Add test: `task.archive` RPC sets status to `archived` and cleans up worktree.
3. Run `cd packages/daemon && bun test tests/unit/rpc-handlers/task-handlers.test.ts tests/unit/rpc/task-handlers.test.ts`.
4. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All new test cases pass.
- Tests verify both the status transition and the worktree cleanup (or lack thereof).
- Tests verify archived is truly terminal.

**Dependencies:** Task 2.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
