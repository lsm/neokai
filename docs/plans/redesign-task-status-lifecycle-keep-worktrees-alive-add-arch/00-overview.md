# Redesign Task Status Lifecycle: Keep Worktrees Alive, Add Archived

## Goal

Redesign the task status lifecycle so that `completed` and `cancelled` tasks retain their worktrees and agent session groups (paused), allowing users to reactivate them at any time. Introduce `archived` as the only true terminal state where worktrees are cleaned up and the task cannot be reverted.

## Key Design Decision: `archived_at` vs `status = 'archived'`

The current codebase uses `archived_at IS NOT NULL` as the sole archival signal:
- `task-repository.ts` `listTasks()` filters by `archived_at IS NULL`
- `task-repository.ts` `archiveTask()` only sets `archived_at`; no status update
- `TaskFilter.includeArchived` in `neo.ts` refers to `archived_at` semantics

**Resolution:** `status = 'archived'` becomes the **canonical source of truth** for the archived state. The `archived_at` column is kept as a **derived timestamp** (set simultaneously when status becomes `archived`). All queries and filters will check `status = 'archived'` instead of `archived_at IS NOT NULL`. A DB migration will backfill any existing rows where `archived_at IS NOT NULL` but status is not `archived`. The `includeArchived` filter parameter will be updated to check `status != 'archived'` (or passed through to the query appropriately).

This unifies the dual model: there is one source of truth (`status`), and `archived_at` is kept only for the timestamp of when archiving occurred.

## Approach

The change touches four layers of the stack:

1. **Shared types + DB migration** -- Add `archived` to both `TaskStatus` and `SpaceTaskStatus` union types. Create Migration 34 to add `archived` to the status CHECK constraints on `tasks` and `space_tasks` tables, and backfill existing `archived_at IS NOT NULL` rows.
2. **Daemon (Room)** -- Update the status transition map, stop worktree cleanup on complete/cancel, only tear down on archive. Adjust `task-group-manager.ts` so `complete()` and `terminateGroup()` no longer call `cleanupWorktree()`. Update `room-runtime.ts` cancel flow to keep groups paused. Update daemon-side guards in `room-agent-tools.ts` and `task-handlers.ts` that block messaging to cancelled tasks. Update `task-repository.ts` to use `status = 'archived'` as primary filter. Wire `task.list` RPC handler to pass `includeArchived` through.
3. **Daemon (Space)** -- Mirror the same transition map changes in `space-task-manager.ts`. Note: space tasks do NOT create worktrees (confirmed via codebase inspection of `task-agent-manager.ts`), so worktree cleanup is not relevant. The changes are limited to status transitions and archival semantics.
4. **Web UI** -- Update tab grouping (Review tab = review + needs_attention; Done tab = completed + cancelled; Archived tab = archived), add reactivate/archive actions, add localStorage tab migration, enable messaging for completed/cancelled tasks.

## Milestones

1. **Shared types, DB migration, and status transitions** -- Add `archived` to type unions, create Migration 34, update `VALID_STATUS_TRANSITIONS` in both room and space task managers, update `task-repository.ts` and `task.list` RPC to use status-based archival filtering, add unit tests.
2. **Room daemon lifecycle changes** -- Stop worktree cleanup on complete/cancel in `task-group-manager.ts`, keep groups paused in `room-runtime.ts`, wire archive as the only cleanup trigger. Update daemon-side message guards. Update RPC handlers for reactivation and archive.
3. **Space daemon lifecycle changes** -- Update `space-task-manager.ts` status transitions and archival. No worktree changes needed (space tasks don't use worktrees).
4. **Web UI updates** -- Update tab grouping with localStorage migration, add reactivate/archive actions, resolve messaging contract for completed/cancelled tasks.
5. **Integration and E2E tests** -- Online tests for reactivation flow, E2E tests for new UI actions.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (needs the new type and migration).
- Milestone 3 depends on Milestone 1 (needs the new type and migration).
- Milestone 4 depends on Milestones 2 and 3 (UI must reflect daemon behavior).
- Milestone 5 depends on all previous milestones.

## Estimated Task Count

16 tasks across 5 milestones.
