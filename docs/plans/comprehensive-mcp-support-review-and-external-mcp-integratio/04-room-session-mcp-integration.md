# Milestone 4: Room and Session MCP Integration

## Milestone Goal

Implement per-room MCP enablement: each room can independently opt-in or opt-out of specific application-level MCP servers. The room's enablement list is stored in SQLite, exposed via RPC, and respected by the lifecycle manager when assembling MCP configs for that room's sessions.

## Scope

Daemon and shared packages. No UI yet (that is Milestone 5).

---

## Task 4.1: Per-Room MCP Enablement Storage and RPC

**Agent type:** coder

**Description:**
Add a `room_mcp_enablement` table that stores which registry servers are enabled per room. Expose it via RPC.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/storage/schema/index.ts`, add `CREATE TABLE IF NOT EXISTS room_mcp_enablement` with columns: `room_id TEXT NOT NULL`, `server_id TEXT NOT NULL`, `enabled INTEGER NOT NULL DEFAULT 1`, `PRIMARY KEY (room_id, server_id)`.
3. In `packages/daemon/src/storage/schema/migrations.ts`, add the migration for `room_mcp_enablement`.
4. Create `packages/daemon/src/storage/repositories/room-mcp-enablement-repository.ts` implementing:
   - `setEnabled(roomId, serverId, enabled)` — upsert; call `reactiveDb.notifyChange('room_mcp_enablement')` after write
   - `getEnabledServerIds(roomId): string[]` — returns IDs of servers enabled for a room
   - `getEnabledServers(roomId): AppMcpServer[]` — joins with `app_mcp_servers` to return full entries
   - `resetToGlobal(roomId)` — removes all per-room overrides; call `reactiveDb.notifyChange('room_mcp_enablement')` after write
   - Pass `ReactiveDatabase` into the constructor (not bare `Database`), following the same pattern as `AppMcpServerRepository` (Task 2.1).
5. Add the repository to `packages/daemon/src/storage/database.ts` as `roomMcpEnablement`.
5a. **Add a named query `'mcpEnablement.byRoom'` to `NAMED_QUERY_REGISTRY`** in `live-query-handlers.ts`:
   - SQL: `SELECT rme.server_id, rme.enabled, ams.name, ams.source_type, ams.description FROM room_mcp_enablement rme JOIN app_mcp_servers ams ON ams.id = rme.server_id WHERE rme.room_id = ?`
   - Params: `[roomId]`
   - Row mapper: return `{ serverId, enabled, name, sourceType, description }` objects.
   - **Authorization guard (explicit):** In the `liveQuery.subscribe` handler, before calling `liveQueries.subscribe()`, verify the `roomId` param by calling `db.rooms.get(roomId)` (or equivalent) and returning a `403`/error if the room does not exist. This is the same guard used by `tasks.byRoom` and `sessionGroupMessages.byGroup` — look at those handlers as the reference implementation.
   - **Cross-table LiveQuery invalidation:** The `'mcpEnablement.byRoom'` query JOINs `room_mcp_enablement` with `app_mcp_servers`. `LiveQueryEngine` uses regex to extract table names from the SQL and subscribes to changes on both tables. This means: when an `app_mcp_servers` row is deleted (via `mcp.registry.delete`), `reactiveDb.notifyChange('app_mcp_servers')` fires, the engine re-executes the `'mcpEnablement.byRoom'` query for all subscribed rooms, and any room whose enablement list included that deleted server will automatically receive a delta removing it — **no extra code needed**. However: the `room_mcp_enablement` rows for the deleted server are now orphaned (dangling FK). Add `ON DELETE CASCADE` to the `server_id` foreign key in the schema, or add explicit cleanup in the `mcp.registry.delete` handler (`db.roomMcpEnablement.deleteByServerId(serverId)` before deleting the server). The cascade ensures orphaned rows don't accumulate.
   - This lets the Room Settings UI subscribe reactively and see per-room toggle changes without polling.
6. Add RPC handlers in `packages/daemon/src/lib/rpc-handlers/app-mcp-handlers.ts`:
   - `mcp.room.getEnabled` — returns enabled server IDs for a room
   - `mcp.room.setEnabled` — upsert enablement for one server in a room
   - `mcp.room.resetToGlobal` — clear per-room overrides
7. Add corresponding request/response types to `packages/shared/src/api.ts`.
8. Write unit tests for the repository and RPC handlers.

**Acceptance criteria:**
- Per-room enablement is persisted and survives daemon restart.
- RPC endpoints work and emit `mcp.registry.changed` (reuse existing event) when enablement changes.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 2.1 (Schema, Types, and Repository)

---

## Task 4.2: Wire Per-Room Enablement into Lifecycle Manager and RoomRuntimeService

**Agent type:** coder

**Description:**
Complete the `getEnabledMcpConfigsForRoom(roomId)` stub in `AppMcpLifecycleManager` to actually use `room_mcp_enablement`, and update `RoomRuntimeService` to call the room-specific method.

**Subtasks (ordered):**

1. Inject `RoomMcpEnablementRepository` into `AppMcpLifecycleManager` constructor.
2. Implement `getEnabledMcpConfigsForRoom(roomId)`:
   - Call `roomMcpEnablement.getEnabledServers(roomId)`.
   - If the room has no overrides (empty result), fall back to `listEnabled()` from the main registry (all globally-enabled servers).
   - Convert matched entries to `McpServerConfig` objects.
3. Update `RoomRuntimeService.attachRoomMcpTools()` (or equivalent) to call `appMcpManager.getEnabledMcpConfigsForRoom(room.id)` instead of `getEnabledMcpConfigs()`.
4. Update the `mcp.registry.changed` subscriber in `RoomRuntimeService` to pass `room.id` when re-applying MCP configs.
5. Write online tests (`packages/daemon/tests/online/room/room-mcp-enablement.test.ts`) that:
   - Create a registry entry.
   - Enable it for a room.
   - Verify the lifecycle manager returns it in `getEnabledMcpConfigsForRoom()`.
   - Disable it for the room.
   - Verify it is excluded.

**Acceptance criteria:**
- Per-room enablement is respected when assembling MCP configs for room sessions.
- Fallback to global registry defaults when no room-specific config exists.
- Online tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 4.1 (Per-Room MCP Enablement Storage and RPC), Task 3.2 (RoomRuntimeService integration)
