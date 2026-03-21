# Milestone 1: Shared Types, DB Migration, and Status Transitions

## Goal

Add `archived` to the `TaskStatus` and `SpaceTaskStatus` type unions, create a DB migration for the CHECK constraints, update all status transition maps, update repository archival filtering to use `status = 'archived'`, and cover the changes with unit tests.

## Scope

- Shared type definitions in `packages/shared/src/types/neo.ts` and `packages/shared/src/types/space.ts`
- DB migration in `packages/daemon/src/storage/schema/migrations.ts` and fresh-DB schema in `packages/daemon/src/storage/schema/index.ts`
- Room task manager transitions in `packages/daemon/src/lib/room/managers/task-manager.ts`
- Space task manager transitions in `packages/daemon/src/lib/space/managers/space-task-manager.ts`
- Task repository archival filtering in `packages/daemon/src/storage/repositories/task-repository.ts`
- `task.list` RPC handler in `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`
- Unit tests for both managers

---

### Task 1.1: Add `archived` to shared type unions, create DB migration, and update transition maps

**Description:** Add `archived` as a new value to both `TaskStatus` and `SpaceTaskStatus` union types. Create Migration 34 to add `archived` to the CHECK constraints on `tasks` and `space_tasks` tables, backfilling any rows with `archived_at IS NOT NULL`. Update `VALID_STATUS_TRANSITIONS` in `task-manager.ts` and `VALID_SPACE_TASK_TRANSITIONS` in `space-task-manager.ts` to reflect the new lifecycle. Update `task-repository.ts` to use `status`-based archival filtering.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/shared/src/types/neo.ts`, add `| 'archived'` to the `TaskStatus` union (after `cancelled`).
3. In `packages/shared/src/types/space.ts`, add `| 'archived'` to the `SpaceTaskStatus` union (after `cancelled`).
4. **DB Migration (Migration 34):** In `packages/daemon/src/storage/schema/migrations.ts`:
   - Add `runMigration34()` following the established pattern (see `runMigration18` / `runMigration24` for table rebuild examples).
   - For the `tasks` table: rebuild with `'archived'` added to the status CHECK constraint: `CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived'))`.
   - For the `space_tasks` table: same CHECK constraint update.
   - Backfill: `UPDATE tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'` (and same for `space_tasks`).
   - Register the migration in the migrations array.
5. **Fresh-DB schema:** In `packages/daemon/src/storage/schema/index.ts`, update the `tasks` table CHECK constraint to include `'archived'`.
6. In `packages/daemon/src/lib/room/managers/task-manager.ts`, update `VALID_STATUS_TRANSITIONS` to:
   - `completed: ['in_progress', 'archived']` (was `[]`)
   - `cancelled: ['pending', 'in_progress', 'archived']` (was `['pending', 'in_progress']` — **preserves the existing `pending` target**)
   - `needs_attention: ['pending', 'in_progress', 'review', 'archived']` (was `['pending', 'in_progress', 'review']` — **preserves the existing `pending` target**)
   - `archived: []` (new entry — true terminal state)
7. In `packages/daemon/src/lib/space/managers/space-task-manager.ts`, update `VALID_SPACE_TASK_TRANSITIONS` with the same changes as above.
8. **Update archival filtering in `task-repository.ts`:**
   - In `listTasks()`, change the default filter from `archived_at IS NULL` to `status != 'archived'`. This makes `status` the source of truth for archival.
   - In `archiveTask()`, update to set **both** `status = 'archived'` and `archived_at = ?` in a single UPDATE statement.
9. **Update `task.list` RPC handler** in `packages/daemon/src/lib/rpc-handlers/task-handlers.ts`: the handler currently only passes `status` and `priority` to `listTasks()`. Add `includeArchived: params.includeArchived` to the filter object so callers can opt in to seeing archived tasks.
10. In `space-task-manager.ts`, update `retryTask()` to also allow retrying from `completed` and `cancelled` via `in_progress`, and update `reassignTask()`'s `allowedStatuses` to include `completed` and `cancelled`.
11. Run `bun run typecheck` to ensure no type errors from the new union member. Fix any exhaustiveness checks or switch statements that need an `archived` case.
12. Run `bun run lint` and `bun run format` to fix any style issues.

**Acceptance criteria:**
- `TaskStatus` and `SpaceTaskStatus` both include `archived`.
- Migration 34 exists and correctly updates CHECK constraints on both `tasks` and `space_tasks`.
- Migration 34 backfills existing `archived_at IS NOT NULL` rows with `status = 'archived'`.
- Fresh-DB schema in `index.ts` includes `archived` in the CHECK constraint.
- Both transition maps include `archived` as terminal and preserve existing `pending` targets for `cancelled` and `needs_attention`.
- `task-repository.ts` `listTasks()` uses `status != 'archived'` as default filter.
- `task-repository.ts` `archiveTask()` sets both `status = 'archived'` and `archived_at`.
- `task.list` RPC handler passes `includeArchived` through to the repository.
- `bun run typecheck` passes with zero errors.
- `bun run lint` passes.

**Dependencies:** None

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.2: Unit tests for new status transitions and archival filtering

**Description:** Update existing unit tests and add new test cases for the `archived` status transitions in both room and space task managers. Add tests for the updated archival filtering in `task-repository.ts`.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/tests/unit/room/task-manager.test.ts`:
   - Add test cases verifying `completed -> in_progress` is valid.
   - Add test cases verifying `completed -> archived` is valid.
   - Add test cases verifying `cancelled -> pending` is valid (preserved from existing behavior).
   - Add test cases verifying `cancelled -> in_progress` is valid.
   - Add test cases verifying `cancelled -> archived` is valid.
   - Add test cases verifying `needs_attention -> pending` is valid (preserved).
   - Add test cases verifying `needs_attention -> archived` is valid.
   - Add test cases verifying `archived -> *` (any status) is invalid.
   - Remove or update any tests that assert `completed` and `cancelled` are terminal with no transitions.
3. In `packages/daemon/tests/unit/lib/space-task-manager.test.ts`:
   - Add equivalent test cases for `VALID_SPACE_TASK_TRANSITIONS`.
   - Test that `retryTask` works from `completed` and `cancelled` states.
4. Add tests for `task-repository.ts` archival filtering:
   - Test: `listTasks()` without `includeArchived` excludes tasks with `status = 'archived'`.
   - Test: `listTasks()` with `includeArchived: true` includes archived tasks.
   - Test: `archiveTask()` sets both `status = 'archived'` and `archived_at`.
5. Run `cd packages/daemon && bun test tests/unit/room/task-manager.test.ts` and `bun test tests/unit/lib/space-task-manager.test.ts` to verify all tests pass.
6. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All new transition test cases pass.
- No existing tests broken (or updated to match new behavior).
- Tests explicitly verify `archived` is a dead-end state.
- Tests verify the dual-model resolution (status-based filtering, `archiveTask` sets both fields).

**Dependencies:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
