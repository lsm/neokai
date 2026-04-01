# Milestone 2: Room Creation Enforcement

## Goal

Enforce that every room is created with an explicit `defaultPath`. Update the backend `room.create` handler, the frontend `CreateRoomModal`, Neo action tools, and add a backfill migration for existing rooms that have `defaultPath = null`.

## Scope

- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` -- remove auto-populate fallback
- `packages/web/src/components/lobby/CreateRoomModal.tsx` -- add workspace path input
- `packages/web/src/lib/lobby-store.ts` -- pass `defaultPath` through
- `packages/daemon/src/lib/neo/tools/neo-action-tools.ts` -- remove `workspaceRoot` fallback
- `packages/daemon/src/storage/` -- backfill migration
- `packages/daemon/tests/` -- update tests

---

### Task 2.1: Update room.create handler to require defaultPath

**Description**: Remove the auto-populate fallback in `room.create` handler (lines 52-54 of `room-handlers.ts`) that silently fills `allowedPaths` and `defaultPath` from `workspaceRoot`. Instead, validate that `defaultPath` is provided and is a valid absolute path. If `allowedPaths` is not provided, derive it as `[{ path: defaultPath }]`. Validate that `defaultPath` exists on the filesystem using `fs.existsSync`. Update the `setupRoomHandlers` function signature -- `workspaceRoot` parameter is still passed (other handlers may need it) but is no longer used for room creation fallback.

**Subtasks**:
1. In `room-handlers.ts` `room.create` handler, replace the auto-populate logic: require `params.defaultPath`, throw `Error('defaultPath is required when creating a room')` if missing.
2. Add filesystem existence check: `if (!existsSync(params.defaultPath)) throw new Error('defaultPath does not exist: ...')`.
3. Derive `allowedPaths` from `defaultPath` if not explicitly provided: `const allowedPaths = params.allowedPaths ?? [{ path: params.defaultPath }]`.
4. Use `validateWorkspacePath()` from `@neokai/shared` for format validation.
5. Update `packages/daemon/tests/unit/rpc/room-handlers.test.ts`: fix all test cases that create rooms with `defaultPath: undefined` to use a valid temp directory path instead. Add a new test case that verifies `room.create` throws when `defaultPath` is missing.
6. Run `make test-daemon` to verify all tests pass.

**Acceptance Criteria**:
- `room.create` throws a clear error when `defaultPath` is not provided.
- `room.create` throws when `defaultPath` does not exist on disk.
- `allowedPaths` is auto-derived from `defaultPath` when not explicitly provided.
- All existing daemon tests pass with updated fixtures.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Update CreateRoomModal to collect workspace path

**Description**: Add a workspace path input field to `CreateRoomModal`. The field should be pre-populated with the daemon's `workspaceRoot` (available from `SystemState` via the global state channel). The field is required -- the form cannot submit without it. Use the shared `validateWorkspacePath()` for client-side validation.

**Subtasks**:
1. In `CreateRoomModal.tsx`, add a `workspacePath` state variable, initialized from the daemon's `workspaceRoot` obtained via `SystemState` (import from the appropriate signal/store).
2. Add an input field for workspace path before the background textarea, with label "Workspace Path" and helper text "Filesystem path for this room's workspace".
3. Add client-side validation using `validateWorkspacePath()` -- show inline error if path is empty or not absolute.
4. Update the `onSubmit` prop type and call to include `defaultPath: workspacePath`.
5. In `Lobby.tsx`, update the `onSubmit` callback passed to `CreateRoomModal` to include `defaultPath` in the `lobbyStore.createRoom(params)` call.
6. Update `packages/web/src/components/lobby/__tests__/` tests if any exist for `CreateRoomModal`.
7. Run `make test-web` to verify.

**Acceptance Criteria**:
- `CreateRoomModal` shows a "Workspace Path" input field, pre-populated with daemon `workspaceRoot`.
- Form submission includes `defaultPath` in the params.
- Client-side validation prevents empty or relative paths.
- Web tests pass.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Update Neo action tools room creation

**Description**: Update `create_room` in `neo-action-tools.ts` to always pass an explicit `defaultPath`. Remove the fallback to `workspaceRoot` (lines 558-561). If the user does not provide `workspace_path` in the tool call, the tool should return an error asking for the path rather than silently using the daemon's workspace.

**Subtasks**:
1. In `neo-action-tools.ts`, update the `create_room` tool: make `workspace_path` (mapped to `args.workspace_path`) required. If not provided, return an error result: "workspace_path is required when creating a room".
2. Set `allowedPaths` and `defaultPath` exclusively from `args.workspace_path`.
3. Remove the `workspaceRoot` fallback in the `allowedPaths` and `defaultPath` derivation.
4. Update the tool's JSON schema description to indicate `workspace_path` is required.
5. Verify that `workspaceRoot` is still passed to the Neo tools constructor (it may be used by `get_system_info` in query tools) but is no longer used for room creation.
6. Add/update unit tests if they exist for Neo action tools.

**Acceptance Criteria**:
- `create_room` tool requires `workspace_path` and errors clearly when missing.
- No fallback to daemon `workspaceRoot` for room creation.
- Existing tests pass.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.4: Backfill migration for existing rooms with null defaultPath

**Description**: Add a database migration that backfills `defaultPath` for existing rooms where it is `NULL`. The migration should set `defaultPath` to the first entry in `allowedPaths` (parsed from the JSON column). If `allowedPaths` is also empty, the migration cannot auto-fix -- log a warning. This ensures all existing rooms have a `defaultPath` before fallback removal in Milestone 3.

**Subtasks**:
1. Create a new migration file in `packages/daemon/src/storage/migrations/` that:
   - Selects all rooms where `default_path IS NULL`.
   - For each, parses `allowed_paths` JSON and sets `default_path` to the first entry's `path`.
   - Logs a warning for rooms where both are empty/null.
2. Add the migration to the migration runner's ordered list.
3. Add a unit test that creates a room with `defaultPath = null` (via direct DB insert), runs the migration, and verifies `defaultPath` is backfilled.
4. Run `make test-daemon` to verify.

**Acceptance Criteria**:
- Migration backfills `defaultPath` from `allowedPaths[0].path` for all rooms with null `defaultPath`.
- Rooms with empty `allowedPaths` are logged as warnings (not crashed).
- Migration is idempotent (safe to run multiple times).
- Unit test covers the backfill logic.

**Dependencies**: Task 2.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
