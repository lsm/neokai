# Milestone 3: Space Daemon Lifecycle Changes

## Goal

Mirror the room daemon lifecycle changes in the space layer: keep worktrees alive for completed/cancelled space tasks, only clean up on archive.

## Scope

- `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- Update complete/cancel behavior
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Update task completion handling
- Space RPC handlers (if any handle worktree cleanup on complete/cancel)
- Unit tests

---

### Task 3.1: Update space task manager and task-agent-manager lifecycle

**Description:** Update the space task lifecycle so completed and cancelled tasks retain worktrees. Only archiving triggers cleanup. Update `task-agent-manager.ts` to not tear down worktrees when sub-sessions complete.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/space/managers/space-task-manager.ts`:
   - Verify that `completeTask()` does not trigger worktree cleanup (check if it delegates to `setTaskStatus` only -- if so, no change needed here).
   - Update `archiveTask()` to set `status = 'archived'` in addition to setting `archived_at`.
   - Update `retryTask()` error message to reflect that tasks can now be retried from `completed` and `cancelled` (the transition map already allows it from Task 1.1).
3. In `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:
   - Review `handleSubSessionComplete()` -- it marks step tasks as completed. Verify it does NOT trigger worktree cleanup. If it does, remove that cleanup.
   - Review the main task completion flow to ensure worktrees survive.
4. Check space RPC handlers in `packages/daemon/src/lib/rpc-handlers/` for any space-task-specific handlers that clean up worktrees on complete/cancel. Update them to only clean up on archive.
5. Update `packages/daemon/tests/unit/lib/space-task-manager.test.ts`:
   - Add test: `archiveTask()` sets status to `archived`.
   - Add test: completing a task does not trigger worktree cleanup.
   - Update any tests that assumed completed/cancelled were terminal.
6. Update `packages/daemon/tests/unit/space/task-agent-manager.test.ts` if relevant tests exist.
7. Run `cd packages/daemon && bun test tests/unit/lib/space-task-manager.test.ts tests/unit/space/`.
8. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Space tasks keep worktrees on complete and cancel.
- Only `archiveTask()` triggers worktree cleanup.
- `archiveTask()` sets status to `archived`.
- All unit tests pass.

**Dependencies:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 3.2: Unit tests for space task lifecycle

**Description:** Add comprehensive unit tests for the space task lifecycle changes, especially around reactivation from completed/cancelled and the archive terminal state.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/tests/unit/lib/space-task-manager.test.ts`:
   - Add test: transition from `completed` to `in_progress` succeeds.
   - Add test: transition from `cancelled` to `in_progress` succeeds.
   - Add test: transition from `completed` to `archived` succeeds.
   - Add test: transition from `archived` to any status fails.
   - Add test: `retryTask()` from `completed` works.
   - Add test: `reassignTask()` from `completed` works.
3. In `packages/daemon/tests/unit/rpc-handlers/space-task-handlers.test.ts`:
   - Add tests for space task archive RPC handler if it exists.
   - Add tests for space task reactivation via RPC.
4. Run tests: `cd packages/daemon && bun test tests/unit/lib/space-task-manager.test.ts tests/unit/rpc-handlers/space-task-handlers.test.ts`.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All new tests pass.
- Coverage of the complete lifecycle including reactivation and archive.

**Dependencies:** Task 3.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
