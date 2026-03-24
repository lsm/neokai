# Milestone 3: MCP Lifecycle Manager

## Milestone Goal

Implement a daemon-side `AppMcpLifecycleManager` that converts `AppMcpServer` registry entries into live `McpServerConfig` objects suitable for `setRuntimeMcpServers()`. For stdio servers this includes process health-checking semantics. SSE/HTTP entries are passed through as URL configs.

## Scope

Daemon package only. No UI changes. Produces a manager class that subsequent milestones consume.

---

## Task 3.1: AppMcpLifecycleManager Class

**Agent type:** coder

**Description:**
Create `AppMcpLifecycleManager` that converts registry entries to SDK `McpServerConfig` objects. The manager reads the registry, filters enabled entries, converts each to the appropriate SDK config type, and returns a `Record<string, McpServerConfig>` ready for injection into sessions.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/lib/mcp/` directory.
3. Create `packages/daemon/src/lib/mcp/app-mcp-lifecycle-manager.ts` with class `AppMcpLifecycleManager`:
   - Constructor takes `db: Database`.
   - Method `getEnabledMcpConfigs(): Record<string, McpServerConfig>` — reads `db.appMcpServers.listEnabled()`, converts each entry: stdio → `McpStdioServerConfig`, sse → `McpSSEServerConfig`, http → `McpHttpServerConfig`. Returns the map keyed by server name.
   - Method `getEnabledMcpConfigsForRoom(roomId: string): Record<string, McpServerConfig>` — reads per-room enablement from `room_mcp_enablement` table (defined in Milestone 4), falls back to `getEnabledMcpConfigs()` if no per-room config exists. (Stub in this task — returns `getEnabledMcpConfigs()` until Milestone 4 adds the table.)
   - Method `validateEntry(entry: AppMcpServer): ValidationResult` — checks required fields per source type (stdio requires command, sse/http require url), returns `{ valid, error? }`.
4. Create `packages/daemon/src/lib/mcp/index.ts` exporting the manager.
5. Instantiate `AppMcpLifecycleManager` in `packages/daemon/src/app.ts` (the DaemonApp context) and expose it as `appMcpManager`.
6. Write unit tests in `packages/daemon/tests/unit/mcp/app-mcp-lifecycle-manager.test.ts`:
   - Test conversion of stdio entry to `McpStdioServerConfig`.
   - Test conversion of sse entry to `McpSSEServerConfig`.
   - Test conversion of http entry to `McpHttpServerConfig`.
   - Test that disabled entries are excluded.
   - Test `validateEntry` for missing required fields.

**Acceptance criteria:**
- `AppMcpLifecycleManager.getEnabledMcpConfigs()` returns correctly typed SDK configs.
- Disabled entries are excluded.
- Validation catches missing required fields.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 2.1 (Schema, Types, and Repository)

---

## Task 3.2: Integrate Lifecycle Manager into RoomRuntimeService

**Agent type:** coder

**Description:**
Update `RoomRuntimeService` to merge registry-sourced MCP configs alongside the existing file-sourced (`getEnabledMcpServersConfig()`) and `room-agent-tools` servers when attaching MCP tools to the room chat session.

**Subtasks (ordered):**

1. In `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`, inject `AppMcpLifecycleManager` via the `RoomRuntimeServiceContext` (add `appMcpManager` field to the context type).
2. In the room chat session startup code (around the `setRuntimeMcpServers` call), merge three sources: `settingsManager.getEnabledMcpServersConfig()` (file-based), `appMcpManager.getEnabledMcpConfigs()` (registry-based), and `room-agent-tools`. File-based and registry-based are merged first; `room-agent-tools` is applied last so it always wins on name collision.
3. Subscribe to `mcp.registry.changed` event in `RoomRuntimeService.subscribeToEvents()` — when the registry changes, re-apply MCP configs to all live room chat sessions by calling `setRuntimeMcpServers()` again with the updated map.
4. Pass `appMcpManager` from `DaemonApp` when constructing `RoomRuntimeService` in `packages/daemon/src/app.ts`.
5. Write unit tests in `packages/daemon/tests/unit/room/room-runtime-service-mcp.test.ts` verifying that registry entries are merged into the final `mcpServers` map passed to `setRuntimeMcpServers`.

**Acceptance criteria:**
- Registry-sourced MCP servers appear in the `mcpServers` map used by room chat sessions.
- `room-agent-tools` always takes precedence.
- On `mcp.registry.changed`, live sessions are updated.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 3.1 (AppMcpLifecycleManager Class), Task 2.2 (RPC Handlers)

---

## Task 3.3: Integrate Lifecycle Manager into Worker Sessions

**Agent type:** coder

**Description:**
Update `QueryOptionsBuilder` and the coder/general agent factories to inject registry-sourced MCP servers into worker (task-executing) sessions.

**Subtasks (ordered):**

1. Extend `QueryOptionsBuilderContext` in `packages/daemon/src/lib/agent/query-options-builder.ts` with optional `appMcpManager?: AppMcpLifecycleManager`.
2. Update `getMcpServers()` in `QueryOptionsBuilder`: if `appMcpManager` is present and `config.mcpServers` is undefined, call `appMcpManager.getEnabledMcpConfigs()` and merge with any file-based servers from `getMcpServers()`.
3. In `packages/daemon/src/lib/room/agents/coder-agent.ts` and `general-agent.ts` AgentSessionInit construction, pass `appMcpManager` through (the `AgentSessionInit` type needs an optional `appMcpManager` field, or it is set on `AgentSession` after creation via a new `setAppMcpManager()` method — choose whichever is consistent with the existing pattern).
4. Alternatively: `AgentSession` receives `AppMcpLifecycleManager` from `SessionManager` at construction time (similar to `SettingsManager`), removing the need to pass it through each agent factory. Evaluate and pick the cleaner approach.
5. Write unit tests covering that worker sessions receive registry MCP servers in their query options.

**Acceptance criteria:**
- Coder and general agents in rooms receive registry-sourced MCP tools.
- No regression in existing tool lists for worker sessions.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 3.1 (AppMcpLifecycleManager Class), Task 3.2 (RoomRuntimeService integration)
