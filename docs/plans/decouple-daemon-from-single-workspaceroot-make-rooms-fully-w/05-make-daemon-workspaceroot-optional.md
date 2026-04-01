# Milestone 5: Make Daemon workspaceRoot Optional

## Goal

Change `Config.workspaceRoot` from required to optional. The daemon can now start without a workspace path -- rooms provide their own. `workspaceRoot` remains used for: DB path derivation, non-room standalone sessions, `FileIndex` (graceful degradation), and `SystemState` broadcasting.

## Scope

- `packages/daemon/src/config.ts` -- make `workspaceRoot` optional
- `packages/daemon/src/app.ts` -- handle optional `workspaceRoot`
- `packages/daemon/src/lib/rpc-handlers/index.ts` -- pass optional to consumers
- `packages/daemon/src/lib/state-manager.ts` -- handle optional in broadcast
- `packages/daemon/src/lib/neo/tools/neo-query-tools.ts` -- handle optional
- `packages/shared/src/state-types.ts` -- make `workspaceRoot` optional
- Associated tests

---

### Task 5.1: Make Config.workspaceRoot optional and update daemon startup

**Description**: Change `Config.workspaceRoot` from `string` to `string | undefined`. Update `getConfig()` to not throw when no workspace is provided -- instead return `undefined`. Update `DaemonApp` creation in `app.ts` to handle optional `workspaceRoot`. The DB path derivation needs a fallback when `workspaceRoot` is undefined (use a default DB path or require explicit `--db-path`).

**Subtasks**:
1. In `config.ts`, change `workspaceRoot: string` to `workspaceRoot?: string` in the `Config` interface.
2. In `getConfig()`, replace the `throw new Error(...)` (line 76-79) with `workspaceRoot = undefined`. Update the `defaultDbPath` derivation to handle `undefined` -- if `workspaceRoot` is undefined, use a generic default path like `~/.neokai/default/database/daemon.db`.
3. In `app.ts`, update `DaemonAppContext` creation to handle `config.workspaceRoot` being undefined. `SettingsManager` constructor takes `workspacePath` -- pass `config.workspaceRoot ?? homedir()` as a reasonable fallback for global settings reading.
4. In `packages/daemon/src/lib/rpc-handlers/index.ts`, update all places that pass `deps.config.workspaceRoot` to handle `undefined`: `setupRoomHandlers` (already optional param), `RoomRuntimeService.defaultWorkspacePath` (already optional after Milestone 3), `FileIndex` constructor, `setupReferenceHandlers.workspaceRoot`, Neo tools.
5. Update `FileIndex` to accept `undefined` root -- when undefined, `init()` is a no-op and searches return empty results. Add a guard at the top of `init()`.
6. In `state-manager.ts`, broadcast `workspaceRoot: config.workspaceRoot ?? ''` (or make the `SystemState.workspaceRoot` field optional).
7. In `packages/shared/src/state-types.ts`, change `workspaceRoot: string` to `workspaceRoot?: string`.
8. Update `neo-query-tools.ts` `get_system_info` to handle optional `workspaceRoot`.
9. Update all daemon tests that mock `Config` with `workspaceRoot` to continue working. No test should break -- they all provide explicit values.
10. Run `bun run typecheck && make test-daemon`.

**Acceptance Criteria**:
- Daemon can start without `--workspace` flag (using default DB path).
- `Config.workspaceRoot` is optional.
- `SystemState.workspaceRoot` is optional.
- `FileIndex` gracefully degrades when no `workspaceRoot`.
- All daemon tests pass.
- Type check passes across all packages.

**Dependencies**: Tasks 3.1, 3.2, 3.3, 4.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Update frontend to handle optional workspaceRoot

**Description**: Update the frontend to handle `SystemState.workspaceRoot` being optional. The `CreateRoomModal` pre-population should show an empty field when `workspaceRoot` is undefined. Any UI that displays `workspaceRoot` should show a fallback or hide the element.

**Subtasks**:
1. Search the web package for all references to `workspaceRoot` in `SystemState` or state subscriptions. Update them to handle `undefined`.
2. In `CreateRoomModal`, when `workspaceRoot` is undefined, leave the workspace path field empty instead of pre-populating.
3. In any status displays (e.g., `ConnectionStatus.tsx`, `GlobalStatus.tsx`) that show `workspaceRoot`, handle the undefined case gracefully (show "No default workspace" or hide the field).
4. Run `make test-web` to verify.

**Acceptance Criteria**:
- Frontend does not crash or show "undefined" when `workspaceRoot` is not set.
- `CreateRoomModal` workspace path field is empty when no daemon `workspaceRoot`.
- Web tests pass.

**Dependencies**: Task 5.1, Task 2.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
