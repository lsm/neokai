# Milestone 4: Room.update defaultPath Propagation

## Goal

Allow changing `defaultPath` via `room.update` with safety guards, and propagate the change to all dependent runtime components.

## Scope

- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` -- `room.update` handler
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- `room.updated` event handler
- `packages/daemon/src/lib/room/runtime/room-runtime.ts` -- `updateRoom` method
- `packages/daemon/src/lib/room/runtime/task-group-manager.ts` -- workspace path mutability
- Associated tests

---

### Task 4.1: Guard defaultPath changes against active task groups

**Description**: When `room.update` changes `defaultPath`, verify there are no active (in-progress, pending, or review) task groups in the room. If there are, reject the change with a clear error. This prevents workspace path changes from breaking running workers that have worktrees based on the old path.

**Subtasks**:
1. In `room-handlers.ts` `room.update` handler, before calling `roomManager.updateRoom()`, check if `params.defaultPath` differs from the current room's `defaultPath`.
2. If it differs, query the room's runtime service (or task manager) for active task groups. The `RoomRuntimeService` is not directly available in `room-handlers.ts` -- add it as an optional dependency, or use a callback `hasActiveTaskGroups(roomId): boolean`. **Note**: If the runtime hasn't been created yet for a room (lazy initialization), the callback should return `false` (no active tasks) rather than throwing.
3. Wire the dependency from `setupAllHandlers` in `index.ts` -- pass `roomRuntimeService` to `setupRoomHandlers`.
4. If active task groups exist, throw: `Error('Cannot change defaultPath while tasks are active. Stop or complete all tasks first.')`.
5. Also validate the new `defaultPath`: must be absolute and exist on disk (`existsSync`).
6. Update `allowedPaths` if the new `defaultPath` is not in the current `allowedPaths` -- auto-add it.
7. Add unit tests: (a) reject `defaultPath` change with active tasks, (b) allow `defaultPath` change with no active tasks, (c) validate new path exists.
8. Run `make test-daemon`.

**Acceptance Criteria**:
- `room.update` rejects `defaultPath` changes when tasks are active, with a clear error message.
- New `defaultPath` is validated (absolute, exists on disk).
- `allowedPaths` is updated to include the new `defaultPath`.
- Unit tests cover guard logic.

**Dependencies**: Task 3.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: Propagate defaultPath changes to runtime and room chat session

**Description**: When `defaultPath` changes successfully via `room.update`, propagate the change to: (a) the room chat session's `workspacePath`, (b) the `RoomRuntime`'s internal workspace path (via `TaskGroupManager`). Since `TaskGroupManager.workspacePath` is readonly, the runtime must be stopped and recreated.

**Starting state**: Task 3.2 does NOT touch the `room.updated` event handler — all propagation logic is consolidated here.

**Subtasks**:
1. In `room-handlers.ts` `room.update` handler, after a successful `defaultPath` change, update the room chat session's `workspacePath` via `sessionManager.updateSession(roomChatSessionId, { workspacePath: newDefaultPath })`. Add this alongside the existing `defaultModel` sync logic.
2. In `room-runtime-service.ts`, in the `room.updated` event handler (line 807+), detect when `room.defaultPath` differs from the runtime's stored `workspacePath`. When it does, **stop and recreate the runtime** (do NOT add a mutable setter to `TaskGroupManager` — this was decided in the overview):
   a. Stop the existing runtime via `runtime.stop()`.
   b. Remove it from `this.runtimes` map.
   c. Call `this.createOrGetRuntime(room)` to create a new runtime with the updated `workspacePath`.
   d. Ensure `runtime.stop()` cleanly terminates any sessions that were started before the path change — no orphaned sessions.
3. Add unit tests verifying: (a) room chat session `workspacePath` is updated, (b) runtime workspace path reflects the new `defaultPath` after recreation, (c) **no orphaned sessions remain** after runtime stop/recreate — verify that sessions started before the path change are cleanly terminated.
4. Run `make test-daemon`.

**Acceptance Criteria**:
- Room chat session's `workspacePath` is updated when `defaultPath` changes.
- The runtime is stopped and recreated (not mutated) when `defaultPath` changes.
- No orphaned runtimes or sessions after the change.
- Unit tests cover the stop/recreate sequence including session cleanup.
- Unit tests pass.

**Dependencies**: Task 4.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
