# Milestone 1: Shared Types and Status Transitions

## Goal

Add `archived` to the `TaskStatus` and `SpaceTaskStatus` type unions, update all status transition maps to reflect the new lifecycle, and cover the changes with unit tests.

## Scope

- Shared type definitions in `packages/shared/src/types/neo.ts` and `packages/shared/src/types/space.ts`
- Room task manager transitions in `packages/daemon/src/lib/room/managers/task-manager.ts`
- Space task manager transitions in `packages/daemon/src/lib/space/managers/space-task-manager.ts`
- Unit tests for both managers

---

### Task 1.1: Add `archived` to shared type unions and update transition maps

**Description:** Add `archived` as a new value to both `TaskStatus` and `SpaceTaskStatus` union types. Update `VALID_STATUS_TRANSITIONS` in `task-manager.ts` and `VALID_SPACE_TASK_TRANSITIONS` in `space-task-manager.ts` to reflect the new lifecycle where `completed` and `cancelled` are no longer terminal.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/shared/src/types/neo.ts`, add `| 'archived'` to the `TaskStatus` union (after `cancelled`).
3. In `packages/shared/src/types/space.ts`, add `| 'archived'` to the `SpaceTaskStatus` union (after `cancelled`).
4. In `packages/daemon/src/lib/room/managers/task-manager.ts`, update `VALID_STATUS_TRANSITIONS` to:
   - `completed: ['in_progress', 'archived']` (was `[]`)
   - `cancelled: ['in_progress', 'archived']` (was `['pending', 'in_progress']`)
   - `needs_attention: ['in_progress', 'review', 'archived']` (was `['pending', 'in_progress', 'review']`)
   - `archived: []` (new entry -- true terminal state)
5. In `packages/daemon/src/lib/space/managers/space-task-manager.ts`, update `VALID_SPACE_TASK_TRANSITIONS` with the same changes as above.
6. In `space-task-manager.ts`, update the `retryTask` method to also allow retrying from `completed` and `cancelled` via `in_progress` (the transition is now valid), and update the `reassignTask` method's `allowedStatuses` to include `completed` and `cancelled`.
7. Run `bun run typecheck` to ensure no type errors from the new union member. Fix any exhaustiveness checks or switch statements that need an `archived` case.
8. Run `bun run lint` and `bun run format` to fix any style issues.

**Acceptance criteria:**
- `TaskStatus` and `SpaceTaskStatus` both include `archived`.
- Both transition maps match the specified lifecycle.
- `bun run typecheck` passes with zero errors.
- `bun run lint` passes.

**Dependencies:** None

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.2: Unit tests for new status transitions

**Description:** Update existing unit tests and add new test cases for the `archived` status transitions in both room and space task managers.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/tests/unit/room/task-manager.test.ts`:
   - Add test cases verifying `completed -> in_progress` is valid.
   - Add test cases verifying `completed -> archived` is valid.
   - Add test cases verifying `cancelled -> in_progress` is valid.
   - Add test cases verifying `cancelled -> archived` is valid.
   - Add test cases verifying `needs_attention -> archived` is valid.
   - Add test cases verifying `archived -> *` (any status) is invalid.
   - Remove or update any tests that assert `completed` and `cancelled` are terminal with no transitions.
3. In `packages/daemon/tests/unit/lib/space-task-manager.test.ts`:
   - Add equivalent test cases for `VALID_SPACE_TASK_TRANSITIONS`.
   - Test that `retryTask` works from `completed` and `cancelled` states.
4. Run `cd packages/daemon && bun test tests/unit/room/task-manager.test.ts` and `bun test tests/unit/lib/space-task-manager.test.ts` to verify all tests pass.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All new transition test cases pass.
- No existing tests broken (or updated to match new behavior).
- Tests explicitly verify `archived` is a dead-end state.

**Dependencies:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
