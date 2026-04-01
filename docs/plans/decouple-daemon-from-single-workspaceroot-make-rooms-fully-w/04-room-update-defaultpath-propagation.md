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
2. If it differs, query for active task groups. Rather than adding yet another positional parameter to `setupRoomHandlers` (which already takes 7+ params and risks silent `undefined` bugs), use a **callback approach**: add a `hasActiveTaskGroups: (roomId: string) => boolean` callback to the existing deps/options object.
3. Wire the callback from `setupAllHandlers` in `index.ts` -- implement it as `(roomId) => roomRuntimeService.hasActiveTaskGroups(roomId)`, where `hasActiveTaskGroups` is a new method on `RoomRuntimeService`. **Critical**: This method must query the DB via `SessionGroupRepository.getActiveGroups(roomId)` (or equivalent), NOT just check the in-memory `runtimes` map. The in-memory map may be empty after a daemon restart while DB-persisted active groups still exist with running workers. Checking only the in-memory map would falsely allow a `defaultPath` change while workers are still running. The `SessionGroupRepository` is available via `this.ctx.groupRepo` or can be constructed from the DB handle.
4. If active task groups exist, throw: `Error('Cannot change defaultPath while tasks are active. Stop or complete all tasks first.')`.
5. Also validate the new `defaultPath`: must be absolute and exist on disk (`existsSync`). **Only validate the incoming new path, not the current path** — rooms with sentinel values (from Task 2.4 backfill) must be able to self-repair via `room.update` by providing a valid new path.
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

**Starting state**: Task 3.2 does NOT touch the `room.updated` event handler — all propagation logic is consolidated here. Task 4.1 already guards against `defaultPath` changes when active task groups exist, so by the time this code runs, there are no in-progress workers. However, the room chat session (the synthetic `room:chat:*` session) may still be active.

**Subtasks**:
1. In `room-handlers.ts` `room.update` handler, after a successful `defaultPath` change, update the room chat session's `workspacePath` via `sessionManager.updateSession(roomChatSessionId, { workspacePath: newDefaultPath })`. Add this alongside the existing `defaultModel` sync logic. **In-memory cache note**: `session-lifecycle.ts:395-409` shows that `update()` calls `agentSession.updateMetadata(updates)` when the session is live in cache, and `resolveSessionContext` in `reference-handlers.ts:328` calls `getSessionAsync` which re-fetches from DB on cache miss. Both paths are already covered — **no additional cache invalidation or `reloadSession` call is needed**. Document this in the PR description for reviewers.
2. In `room-runtime-service.ts`, in the `room.updated` event handler (line 807+), detect when `room.defaultPath` differs from the runtime's stored `workspacePath`. When it does, **stop and recreate the runtime** (do NOT add a mutable setter to `TaskGroupManager` — this was decided in the overview):
   a. Stop the existing runtime via `runtime.stop()`.
   b. Remove it from `this.runtimes` map.
   c. Call `this.createOrGetRuntime(room)` to create a new runtime with the updated `workspacePath`.
   **Important note on `runtime.stop()` behavior**: The current `RoomRuntime.stop()` cleans up job queues, mirroring subscriptions, observers, and zombie groups, but does NOT terminate active agent sessions (it only calls `cancelPendingTickJobs` and `cleanupZombieGroupsForRoom`). This is acceptable here because Task 4.1's guard ensures no active task groups exist when `defaultPath` changes.

   **Room chat session SDK subprocess behavior**: The room chat session's `AgentSession` object has its `workspacePath` updated in the DB and in-memory metadata (subtask 1), but the SDK subprocess is NOT interrupted or restarted. Any in-flight SDK conversation will finish using the old working directory; the **next** SDK invocation will use the updated `workspacePath`. This is deemed acceptable because room chat sessions don't fork worktrees — they operate on the room's `defaultPath` directly, and the path change only takes effect when the user sends their next message. No pause or restart of the SDK subprocess is needed.
3. Add unit tests verifying: (a) room chat session `workspacePath` is updated, (b) runtime workspace path reflects the new `defaultPath` after recreation, (c) the old runtime is properly stopped (observer disposed, job queue cancelled), (d) verify the guard from Task 4.1 prevents this code from running with active task groups (integration test).
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
