# Milestone 5: Web UI for MCP Registry

## Milestone Goal

Build the frontend settings panel that lets users add, edit, enable/disable, and delete application-level MCP servers, and configure per-room enablement from the Room Settings panel.

## Scope

Web package only (Preact components, hooks, API helpers). Backend RPC is already in place from Milestone 2 and 4.

---

## Task 5.1: API Helpers and State Management

**Agent type:** coder

**Description:**
Add frontend API helper functions and a reactive store for the MCP registry so components can subscribe to changes.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. In `packages/web/src/lib/api-helpers.ts`, add helper functions:
   - `listAppMcpServers()` — calls `mcp.registry.list`
   - `createAppMcpServer(req)` — calls `mcp.registry.create`
   - `updateAppMcpServer(id, updates)` — calls `mcp.registry.update`
   - `deleteAppMcpServer(id)` — calls `mcp.registry.delete`
   - `setAppMcpServerEnabled(id, enabled)` — calls `mcp.registry.setEnabled`
   - `getRoomMcpEnabled(roomId)` — calls `mcp.room.getEnabled`
   - `setRoomMcpEnabled(roomId, serverId, enabled)` — calls `mcp.room.setEnabled`
   - `resetRoomMcpToGlobal(roomId)` — calls `mcp.room.resetToGlobal`
3. Create `packages/web/src/lib/app-mcp-store.ts` with a Preact Signal `appMcpServers` that is initialized from the list RPC on first use, and updated on `mcp.registry.changed` hub events.
4. Write unit tests for the API helper types (type-level tests) in `packages/web/src/lib/__tests__/app-mcp-store.test.ts`.

**Acceptance criteria:**
- API helpers compile with correct types matching `packages/shared/src/api.ts` definitions.
- `appMcpServers` signal reflects server state and updates on events.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 2.2 (RPC Handlers), Task 4.1 (Per-Room RPC)

---

## Task 5.2: Application-Level MCP Settings Panel

**Agent type:** coder

**Description:**
Build `AppMcpServersSettings` component in the global settings panel for managing the registry (add, edit, delete, enable/disable globally).

**Subtasks (ordered):**

1. Create `packages/web/src/components/settings/AppMcpServersSettings.tsx`:
   - List all registry entries from `appMcpServers` signal, showing name, source type, enabled toggle.
   - "Add MCP Server" button opens a form with fields: Name, Description (optional), Source Type (stdio / sse / http), Command (stdio), Args (stdio, space-separated), Env vars (key=value list), URL (sse/http), Headers (key=value list).
   - Inline validation: stdio requires command; sse/http require url.
   - Edit mode: click entry to open the same form pre-populated.
   - Delete: confirmation dialog before calling `deleteAppMcpServer`.
   - Enable/disable toggle per entry.
2. Integrate into the global settings panel (wherever `McpServersSettings` currently lives, add a new section "Application MCP Servers" below it, or a separate tab).
3. Use `SettingsSection` and `SettingsToggle` components from `packages/web/src/components/settings/SettingsSection.tsx` for consistency.
4. Write Vitest unit tests in `packages/web/src/components/settings/__tests__/AppMcpServersSettings.test.tsx` covering: render list, add form validation, edit, delete confirmation, toggle.

**Acceptance criteria:**
- Users can add a new stdio MCP server from the UI and see it appear in the list.
- Users can edit and delete existing entries.
- Inline validation prevents saving invalid entries.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 5.1 (API Helpers and State Management)

---

## Task 5.3: Per-Room MCP Enablement UI in Room Settings

**Agent type:** coder

**Description:**
Add an "MCP Servers" section to `packages/web/src/components/room/RoomSettings.tsx` where users can toggle which registry servers are active for that specific room.

**Subtasks (ordered):**

1. In `packages/web/src/components/room/RoomSettings.tsx`, add a new "MCP Servers" section below existing settings.
2. Load the room's current enablement via `getRoomMcpEnabled(roomId)` on mount.
3. For each entry in the global registry, show a toggle: if the room has a per-room override use it, otherwise default to the global `enabled` value.
4. On toggle, call `setRoomMcpEnabled(roomId, serverId, enabled)`.
5. Add a "Reset to Global Defaults" button that calls `resetRoomMcpToGlobal(roomId)`.
6. Show an empty state when no MCP servers are registered yet, with a link to the global settings panel.
7. Write Vitest unit tests for the MCP section in `packages/web/src/components/room/__tests__/RoomSettings-mcp.test.tsx`.

**Acceptance criteria:**
- Room settings shows a list of registry servers with per-room toggles.
- Toggle changes are persisted (verified by reloading the settings panel).
- "Reset to Global Defaults" works.
- Empty state renders correctly when no servers are registered.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 5.1 (API Helpers and State Management), Task 4.1 (Per-Room RPC)
