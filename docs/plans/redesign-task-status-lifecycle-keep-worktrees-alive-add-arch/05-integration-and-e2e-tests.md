# Milestone 5: Integration and E2E Tests

## Goal

Add online integration tests and Playwright E2E tests to validate the full lifecycle: reactivation from completed/cancelled, archive as terminal state with worktree cleanup, and the new UI tab grouping.

## Scope

- Online integration tests in `packages/daemon/tests/online/`
- E2E Playwright tests in `packages/e2e/tests/`

---

### Task 5.1: Online integration tests for task reactivation and archive

**Description:** Add online tests that exercise the full task lifecycle including reactivation from completed/cancelled and archiving. These tests run against a real daemon with mocked SDK (dev proxy).

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/daemon/tests/online/rpc/rpc-task-lifecycle.test.ts` (or add to existing `rpc-task-draft-handlers.test.ts` if appropriate):
   - Test: Create a task, move through `pending -> in_progress -> completed`, then reactivate to `in_progress`, verify the task group is revived and worktree exists.
   - Test: Create a task, move through `pending -> in_progress -> cancelled`, then reactivate to `in_progress`, verify the task group is revived and worktree exists.
   - Test: Create a task, complete it, then archive it. Verify the worktree is cleaned up and status is `archived`.
   - Test: Verify that `archived` tasks cannot transition to any other status.
   - Test: Verify `task.list` with `includeArchived: false` excludes archived tasks, and `includeArchived: true` includes them.
3. Use `NEOKAI_USE_DEV_PROXY=1` for mocked SDK tests.
4. Run: `NEOKAI_USE_DEV_PROXY=1 cd packages/daemon && bun test tests/online/rpc/rpc-task-lifecycle.test.ts`.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All online tests pass with dev proxy.
- Tests cover the full lifecycle: create -> complete -> reactivate -> archive.
- Tests verify worktree preservation on complete/cancel and cleanup on archive.

**Dependencies:** Tasks 2.2, 2.3

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.2: E2E Playwright tests for reactivate and archive UI actions

**Description:** Add Playwright E2E tests that exercise the new UI actions: reactivating a completed/cancelled task and archiving a task through the browser UI.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/task-lifecycle.e2e.ts`:
   - Test: Navigate to a completed task, click "Reactivate", verify the task status changes to `in_progress` in the UI.
   - Test: Navigate to a completed task, click "Archive", confirm the dialog, verify the task moves to the Archived tab.
   - Test: Verify that archived tasks appear under the Archived tab and not in the Done tab.
   - Test: Verify that the Archive confirmation dialog mentions permanent worktree cleanup.
3. Follow E2E test rules from CLAUDE.md: all actions through UI clicks, all assertions on visible DOM state. No direct RPC calls except for setup/teardown.
4. Run: `make run-e2e TEST=tests/features/task-lifecycle.e2e.ts`.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All E2E tests pass.
- Tests exercise real browser interactions (no RPC shortcuts).
- Tests verify visible UI state changes.

**Dependencies:** Tasks 4.2, 4.3, 5.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
