# Milestone 3: Space Daemon Lifecycle Changes

## Goal

Update the space daemon status transitions and archival semantics to match the new lifecycle. Space tasks do **not** create worktrees (confirmed: `task-agent-manager.ts` manages agent sessions only, not worktrees), so the changes here are limited to status transitions and archival filtering.

## Scope

- `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- Update archival to set status, update error messages
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Verify no worktree cleanup on complete (confirm no-op)
- Space RPC handlers (if any handle status-specific logic)
- Space task repository (verify `archiveTask()` sets both `status` and `archived_at`)
- Unit tests

## Important Note

Space tasks do NOT create worktrees. The `task-agent-manager.ts` only manages agent sub-sessions for task execution. Therefore, the "keep worktree alive" aspect of this plan is a no-op for space tasks. The changes focus on:
1. Ensuring `archiveTask()` sets `status = 'archived'` (matching the room task behavior from Task 1.1).
2. Updating error messages and `retryTask()`/`reassignTask()` to reflect the new lifecycle.
3. Verifying completion does not trigger any cleanup that would prevent reactivation.

---

### Task 3.1: Update space task manager and task-agent-manager lifecycle

**Description:** Update the space task lifecycle so archival sets `status = 'archived'`. Verify that `task-agent-manager.ts` does not perform any cleanup on completion that would prevent reactivation.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/space/managers/space-task-manager.ts`:
   - Verify that `completeTask()` does not trigger any irreversible cleanup (it should only update status via `setTaskStatus`).
   - Update `archiveTask()` to set `status = 'archived'` in addition to `archived_at`. The space task repository's `archiveTask()` method (check `packages/daemon/src/storage/repositories/space-task-repository.ts`) needs the same update as the room task repository: set both `status = 'archived'` AND `archived_at` in one UPDATE.
   - Update `retryTask()` error message to reflect that tasks can now be retried from `completed` and `cancelled` (the transition map already allows it from Task 1.1).
3. In `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:
   - Review `handleSubSessionComplete()` — it marks step tasks as completed. Confirm it does NOT trigger any cleanup that would prevent reactivation. This should be a verification step with no code changes needed.
4. Check space RPC handlers in `packages/daemon/src/lib/rpc-handlers/` for any space-task-specific handlers that have guards blocking actions on completed/cancelled tasks. Update them if needed.
5. Update `packages/daemon/tests/unit/lib/space-task-manager.test.ts`:
   - Add test: `archiveTask()` sets both `status = 'archived'` and `archived_at`.
   - Update any tests that assumed completed/cancelled were terminal.
6. Run `cd packages/daemon && bun test tests/unit/lib/space-task-manager.test.ts`.
7. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- `archiveTask()` sets both `status = 'archived'` and `archived_at`.
- No irreversible cleanup happens on task completion that would prevent reactivation.
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
   - Add test: transition from `cancelled` to `pending` succeeds (preserved from existing behavior).
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
- Tests verify `pending` is preserved as a valid target for `cancelled` and `needs_attention`.

**Dependencies:** Task 3.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
