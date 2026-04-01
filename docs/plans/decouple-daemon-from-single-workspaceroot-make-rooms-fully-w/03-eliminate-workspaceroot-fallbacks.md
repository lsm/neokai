# Milestone 3: Eliminate workspaceRoot Fallbacks in Room-Scoped Paths

## Goal

Remove all fallbacks to `workspaceRoot` in room-scoped code paths. After this milestone, room operations derive their workspace path from `room.defaultPath` exclusively.

## Scope

- `packages/daemon/src/lib/rpc-handlers/reference-handlers.ts` -- fix `resolveSessionContext`
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- fix `createOrGetRuntime` fallback
- `packages/daemon/src/lib/session/session-lifecycle.ts` -- fix fallback for room sessions
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- fix `setupRoomAgentSession` MCP resolution
- Associated tests

---

### Task 3.1: Fix reference handler workspace resolution for room chat sessions

**Description**: In `reference-handlers.ts`, the `resolveSessionContext` function (line 332-335) falls back to `deps.workspaceRoot` for `room:chat:*` sessions because they have no DB-loaded `AgentSession`. Fix this to look up the room's `defaultPath` instead.

**Subtasks**:
1. Add a `roomManager` (or a `getRoomDefaultPath(roomId: string): string | undefined` callback) to the `ReferenceHandlerDeps` interface.
2. Pass `roomManager` from `setupAllHandlers` in `packages/daemon/src/lib/rpc-handlers/index.ts` (line 298-307).
3. In `resolveSessionContext`, when `sessionId.startsWith('room:chat:')`, extract `roomId`, look up the room via deps, and return `room.defaultPath` (or throw if room not found). Remove the `deps.workspaceRoot` fallback for this code path.
4. Keep the general fallback `deps.workspaceRoot` for non-room sessions (line 335) -- those still need it.
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
4. Update the `room.updated` event handler (line 807+) to also propagate `defaultPath` changes to the room chat session's `workspacePath` (this overlaps with Milestone 4 but the basic wiring belongs here).
5. Update `packages/daemon/tests/unit/room/room-runtime-service.test.ts` and `room-runtime-service-wiring.test.ts`: ensure test rooms have `defaultPath` set, verify no fallback to `defaultWorkspacePath` occurs.
6. Run `make test-daemon`.

**Acceptance Criteria**:
- `createOrGetRuntime` uses `room.defaultPath` directly without fallback.
- Error is thrown if `room.defaultPath` is missing (defensive guard).
- `defaultWorkspacePath` is optional in the context interface.
- Tests pass with rooms that have explicit `defaultPath`.

**Dependencies**: Task 2.4

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.3: Fix session-lifecycle workspace fallback for room sessions

**Description**: In `session-lifecycle.ts` line 93, `const baseWorkspacePath = params.workspacePath || this.config.workspaceRoot` falls back to the daemon's workspace root. For room-scoped sessions (room chat, workers, leaders), the caller already passes `workspacePath` from the room's `defaultPath`. However, the fallback should only apply to non-room sessions. Add clarity and a defensive check.

**Subtasks**:
1. In `session-lifecycle.ts`, add a comment clarifying that `this.config.workspaceRoot` fallback is for non-room standalone sessions only.
2. Add a log warning when the fallback is used: `this.logger.warn('Session created without explicit workspacePath, falling back to daemon workspaceRoot')`.
3. Verify that all room-scoped session creation paths (room chat in `room-handlers.ts`, workers in `room-runtime.ts`) already pass `workspacePath` explicitly. Trace the code paths and document in the PR description.
4. Add a unit test in `packages/daemon/tests/unit/session/` that verifies a session created with explicit `workspacePath` does NOT fall back to `config.workspaceRoot`.
5. Run `make test-daemon`.

**Acceptance Criteria**:
- Fallback in `session-lifecycle.ts` is documented as non-room-only.
- Warning is logged when fallback is used.
- Verified that all room session creation paths pass explicit `workspacePath`.
- New unit test passes.

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
