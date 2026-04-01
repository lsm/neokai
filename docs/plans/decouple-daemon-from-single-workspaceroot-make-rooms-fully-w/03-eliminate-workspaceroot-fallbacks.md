# Milestone 3: Eliminate workspaceRoot Fallbacks in Room-Scoped Paths

## Goal

Remove all fallbacks to `workspaceRoot` in room-scoped code paths. After this milestone, room operations derive their workspace path from `room.defaultPath` exclusively.

## Scope

- `packages/daemon/src/lib/rpc-handlers/reference-handlers.ts` -- fix `resolveSessionContext`
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- fix `createOrGetRuntime` fallback
- `packages/daemon/src/lib/session/session-lifecycle.ts` -- fix fallback for room sessions
- `packages/daemon/src/lib/session/session-manager.ts` -- fix `cleanupOrphanedWorktrees` fallback
- `packages/daemon/src/lib/rpc-handlers/settings-handlers.ts` -- verify no room-scoped fallback (document as no-op)
- Associated tests

---

### Task 3.1: Fix reference handler workspace resolution for room chat sessions

**Description**: In `reference-handlers.ts`, the `resolveSessionContext` function (line 332-335) falls back to `deps.workspaceRoot` for `room:chat:*` sessions because they have no DB-loaded `AgentSession`. Fix this to look up the room's `defaultPath` instead.

**Subtasks**:
1. Add a `roomManager` (or a `getRoomDefaultPath(roomId: string): string | undefined` callback) to the `ReferenceHandlerDeps` interface.
2. Pass `roomManager` from `setupAllHandlers` in `packages/daemon/src/lib/rpc-handlers/index.ts` (line 298-307).
3. In `resolveSessionContext`, when `sessionId.startsWith('room:chat:')`, extract `roomId`, look up the room via deps, and return `room.defaultPath`. If the room is not found (e.g., deleted while a reference request is in-flight), return `deps.workspaceRoot` as a graceful fallback with a warning log — do NOT throw an unhandled exception, since this is invoked during `@file`/`@folder` search in the chat UI and an uncaught throw would surface as an opaque RPC error to the user. Remove the `deps.workspaceRoot` fallback only for the happy path (room exists).
4. Keep the general fallback `deps.workspaceRoot` for non-room sessions (line 335) -- those still need it. **Note for Milestone 5**: When `deps.workspaceRoot` becomes `string | undefined`, the return type of `resolveSessionContext` must be updated to `string | undefined` and callers must handle `undefined`. The Task 5.1 implementer should address this.
5. Keep `sessionData.workspacePath ?? deps.workspaceRoot` on line 340 -- non-room sessions may still lack a workspace path.
6. Update `packages/daemon/tests/unit/rpc-handlers/reference-handlers.test.ts` to provide the new dependency and test that `room:chat:*` sessions resolve to room's `defaultPath`.
7. Run `make test-daemon`.

**Acceptance Criteria**:
- `room:chat:*` sessions in `resolveSessionContext` resolve to `room.defaultPath`, not `deps.workspaceRoot`.
- Non-room session fallback to `workspaceRoot` is preserved.
- Reference handler tests pass with updated fixtures.

**Dependencies**: Task 2.4 (backfill ensures all rooms have `defaultPath`)

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Fix room-runtime-service workspace fallback and MCP resolution

**Description**: In `room-runtime-service.ts`, `createOrGetRuntime` (line 638) falls back to `this.ctx.defaultWorkspacePath` when `room.defaultPath` is undefined. Since all rooms now have `defaultPath` (after backfill), this fallback should be removed or converted to an error. Also fix `setupRoomAgentSession` which uses the global `SettingsManager` for MCP config resolution -- it should read MCP config relative to the room's `defaultPath`.

**Subtasks**:
1. In `createOrGetRuntime`, replace `room.defaultPath ?? this.ctx.defaultWorkspacePath` with `room.defaultPath`. Add a guard: if `!room.defaultPath`, log an error and throw (this should never happen after backfill).
2. In the `RoomRuntimeServiceContext` interface, make `defaultWorkspacePath` optional (it will be removed in Milestone 5).
3. In `setupRoomAgentSession`, where MCP servers are resolved via `this.ctx.settingsManager.getEnabledMcpServersConfig()`, add a comment noting this is global MCP config (acceptable for now -- per-room MCP is out of scope). The key fix is that the room chat session's `workspacePath` is set correctly (from `room.defaultPath`), which is already handled by the room.create handler.
   - **Also verify `settings-handlers.ts`**: Confirm that `settings.mcp.listFromSources` constructs a `SettingsManager` from `session.workspacePath` (already correct once room sessions have the right path), NOT from `deps.workspaceRoot`. Document this verification in the PR description as "confirmed no change needed for settings-handlers.ts".
4. **Do NOT modify the `room.updated` event handler here** — all `room.updated` propagation logic (including `defaultPath` changes to the room chat session and runtime) is consolidated in Milestone 4 (Tasks 4.1 and 4.2).
5. Update `packages/daemon/tests/unit/room/room-runtime-service.test.ts` and `room-runtime-service-wiring.test.ts`: ensure test rooms have `defaultPath` set, verify no fallback to `defaultWorkspacePath` occurs.
6. Run `make test-daemon`.

**Acceptance Criteria**:
- `createOrGetRuntime` uses `room.defaultPath` directly without fallback.
- Error is thrown if `room.defaultPath` is missing (defensive guard).
- `defaultWorkspacePath` is optional in the context interface.
- `room.updated` handler is NOT modified in this task (deferred to Milestone 4).
- Tests pass with rooms that have explicit `defaultPath`.

**Dependencies**: Task 2.4

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.3: Fix session-lifecycle workspace fallback for room sessions

**Description**: In `session-lifecycle.ts` line 93, `const baseWorkspacePath = params.workspacePath || this.config.workspaceRoot` falls back to the daemon's workspace root. For room-scoped sessions (room chat, workers, leaders), the caller already passes `workspacePath` from the room's `defaultPath`. However, the fallback should only apply to non-room sessions. Add clarity and a defensive check.

**Subtasks**:
1. In `session-lifecycle.ts`, split the fallback logic based on **session type** (not session ID prefix). At line 91, `sessionType` is available as `params.sessionType ?? 'worker'`. The room-scoped session types are: `'room_chat'`, `'planner'`, `'coder'`, `'leader'`, `'general'`. Guard using a set:
   ```ts
   const ROOM_SESSION_TYPES = ['room_chat', 'planner', 'coder', 'leader', 'general'] as const;
   if (ROOM_SESSION_TYPES.includes(sessionType) && !params.workspacePath) {
     throw new Error('Room-scoped session must have explicit workspacePath');
   }
   ```
   **Why session type, not ID prefix**: Worker/leader/planner/coder sessions have IDs like `planner:{roomId}:{taskId}:{uuid}`, `coder:{roomId}:...` — they do NOT start with `room:`. Only `room:chat:{roomId}` does. Guarding by `sessionId.startsWith('room:')` would miss all non-chat room sessions. Guarding by `sessionType` is accurate, self-documenting, and resilient to new session ID formats.
   - For non-room standalone sessions: keep the existing fallback to `this.config.workspaceRoot` with a log warning.
2. Add a comment clarifying the split: room-scoped session types throw, non-room sessions fall back.
3. Verify that all room-scoped session creation paths (room chat in `room-handlers.ts`, workers in `room-runtime.ts`) already pass `workspacePath` explicitly. Trace the code paths and document in the PR description.
4. Add a unit test in `packages/daemon/tests/unit/session/` that verifies: (a) a session created with explicit `workspacePath` does NOT fall back to `config.workspaceRoot`, (b) a `room_chat` session created without explicit `workspacePath` **throws**, (c) a `planner`/`coder`/`leader`/`general` session created without explicit `workspacePath` **also throws**, and (d) a non-room session (e.g., `'worker'` standalone) without explicit `workspacePath` falls back to `config.workspaceRoot` with a warning.
5. Run `make test-daemon`.

**Acceptance Criteria**:
- Room-scoped sessions (`room:*`) throw if `workspacePath` is not explicitly provided.
- Non-room sessions fall back to `config.workspaceRoot` with a warning log.
- Verified that all existing room session creation paths pass explicit `workspacePath` (so the throw is never hit in practice).
- Unit tests cover both the throw and fallback paths.
- All daemon tests pass.

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.4: Fix session-manager cleanupOrphanedWorktrees fallback

**Description**: In `session-manager.ts` line 437, `cleanupOrphanedWorktrees` falls back to `this.config.workspaceRoot` when no `workspacePath` is provided. This must be updated to handle `workspaceRoot` being optional (Milestone 5) and to prefer room-specific paths when called in a room context.

**Subtasks**:
1. In `session-manager.ts`, update `cleanupOrphanedWorktrees` to require `workspacePath` as a mandatory parameter (remove the fallback). The method signature changes from `cleanupOrphanedWorktrees(workspacePath?: string)` to `cleanupOrphanedWorktrees(workspacePath: string)`.
2. Audit all callers of `cleanupOrphanedWorktrees` in the codebase and ensure they pass an explicit `workspacePath`. Room-scoped callers should pass `room.defaultPath`.
3. If there are callers that currently rely on the fallback (no explicit path), update them to pass `this.config.workspaceRoot` explicitly (preserving current behavior for non-room contexts).
4. Add a unit test verifying `cleanupOrphanedWorktrees` uses the provided path, not a global fallback.
5. Run `make test-daemon`.

**Acceptance Criteria**:
- `cleanupOrphanedWorktrees` requires an explicit `workspacePath` parameter.
- All callers pass an explicit path.
- No fallback to `config.workspaceRoot` inside the method.
- Unit test passes.

**Dependencies**: Task 2.4

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.



*(Task 3.5 was folded into Task 3.2, subtask 3 — the `settings-handlers.ts` verification is now a sub-item of Task 3.2.)*
