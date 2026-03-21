# Redesign Task Status Lifecycle: Keep Worktrees Alive, Add Archived

## Goal

Redesign the task status lifecycle so that `completed` and `cancelled` tasks retain their worktrees and agent session groups (paused), allowing users to reactivate them at any time. Introduce `archived` as the only true terminal state where worktrees are cleaned up and the task cannot be reverted.

## Approach

The change touches four layers of the stack:

1. **Shared types** -- Add `archived` to both `TaskStatus` and `SpaceTaskStatus` union types.
2. **Daemon (Room)** -- Update the status transition map, stop worktree cleanup on complete/cancel, only tear down on archive. Adjust `task-group-manager.ts` so `complete()` and `terminateGroup()` no longer call `cleanupWorktree()`. Update `room-runtime.ts` cancel flow to keep groups paused instead of terminated.
3. **Daemon (Space)** -- Mirror the same transition map and lifecycle changes in `space-task-manager.ts` and `task-agent-manager.ts`.
4. **Web UI** -- Update tab grouping (Review tab = review + needs_attention; Done tab = completed + cancelled; Archived tab = archived), add reactivate/archive actions, enable messaging for completed/cancelled tasks.

A new DB migration adds support for `archived` as a valid task status value (the existing `archived_at` column remains for backward compatibility).

## Milestones

1. **Shared types and status transitions** -- Add `archived` to type unions, update `VALID_STATUS_TRANSITIONS` in both room and space task managers, add unit tests for new transitions.
2. **Room daemon lifecycle changes** -- Stop worktree cleanup on complete/cancel in `task-group-manager.ts`, keep groups paused in `room-runtime.ts`, wire archive as the only cleanup trigger. Update RPC handlers.
3. **Space daemon lifecycle changes** -- Mirror room changes in `space-task-manager.ts` and `task-agent-manager.ts`. Update space RPC handlers.
4. **Web UI updates** -- Update tab grouping, add reactivate/archive actions, enable messaging for completed/cancelled tasks.
5. **Integration and E2E tests** -- Online tests for reactivation flow, E2E tests for new UI actions.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (needs the new type).
- Milestone 3 depends on Milestone 1 (needs the new type).
- Milestone 4 depends on Milestones 2 and 3 (UI must reflect daemon behavior).
- Milestone 5 depends on all previous milestones.

## Estimated Task Count

14 tasks across 5 milestones.
