# Milestone 3: MCP Lifecycle Manager

## Milestone Goal

Implement a daemon-side `AppMcpLifecycleManager` that converts `AppMcpServer` registry entries into live `McpServerConfig` objects suitable for `setRuntimeMcpServers()`. SSE/HTTP entries are passed through as URL configs. Includes user-facing error reporting for invalid registry entries (health-check/auto-restart of stdio processes is deferred to a future iteration). Integrates into room sessions, worker sessions, and the space module's task/step agents.

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
   - Method `getStartupErrors(): Array<{ serverId: string; name: string; error: string }>` — returns a list of registry entries that failed validation (e.g. missing command). This list is exposed via an `mcp.registry.listErrors` RPC (added in Task 2.2) so the UI can surface a warning badge next to misconfigured entries. Full spawn-failure reporting (process crash detection) is deferred to a future iteration.
   - **Job Queue note (future iteration):** When health checking and auto-restart are implemented, they should use the `JobQueueProcessor` — specifically a self-scheduling queue (e.g., `mcp.health_check`) following the `github.poll` pattern in `job-queue-constants.ts`. This avoids holding process state in memory across daemon restarts. Do NOT implement health-check polling via `setInterval` or in-memory state in this iteration.
4. Create `packages/daemon/src/lib/mcp/index.ts` exporting the manager.
5. Instantiate `AppMcpLifecycleManager` in `packages/daemon/src/app.ts` (the DaemonApp context) and expose it as `appMcpManager`.
6. Write unit tests in `packages/daemon/tests/unit/mcp/app-mcp-lifecycle-manager.test.ts`:
   - Test conversion of stdio entry to `McpStdioServerConfig`.
   - Test conversion of sse entry to `McpSSEServerConfig`.
   - Test conversion of http entry to `McpHttpServerConfig`.
   - Test that disabled entries are excluded.
   - Test `validateEntry` for missing required fields.
   - Test that `getStartupErrors()` returns invalid entries with descriptive error messages.

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
3. Subscribe to `mcp.registry.changed` event in `RoomRuntimeService.subscribeToEvents()` — when the registry changes, re-apply MCP configs to all live room chat sessions. The mechanism: call `session.setRuntimeMcpServers(updatedMap)` directly on the `AgentSession` object, which replaces the runtime MCP map used on the next query. **Important architectural note:** `setRuntimeMcpServers()` updates the config used for subsequent queries; it does NOT restart an in-flight query. This is sufficient because MCP server changes between queries are the expected use case. If a user needs the new tools mid-conversation, they restart the session — no special restart path is required. Document this constraint in code comments.
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
Inject registry-sourced MCP servers into worker (coder/general) sessions using `setRuntimeMcpServers()` — the same mechanism used for room chat sessions — rather than modifying `getMcpServers()` in `QueryOptionsBuilder`.

**Approach rationale (verified against source code):**
`AgentSession.setRuntimeMcpServers(map)` writes directly to `session.config.mcpServers`. `QueryOptionsBuilder.getMcpServers()` checks `if (config.mcpServers !== undefined) return config.mcpServers` — so calling `setRuntimeMcpServers()` with only the registry map would suppress SDK auto-load of file-based servers entirely. This is the same constraint room chat sessions work around by explicitly merging all sources before calling `setRuntimeMcpServers()` (see `RoomRuntimeService`). Worker sessions must follow the same pattern: build a merged map of file-based + registry servers, then pass the complete map to `setRuntimeMcpServers()`.

**Subtasks (ordered):**

1. In `packages/daemon/src/lib/room/agents/coder-agent.ts` and `general-agent.ts`, after the `AgentSession` is created, build the merged MCP map before calling `setRuntimeMcpServers()`:
   - `const fileBased = settingsManager.getEnabledMcpServersConfig()` — same call `RoomRuntimeService` uses for file-based servers.
   - `const registry = appMcpManager.getEnabledMcpConfigs()` — registry servers.
   - Merge: `{ ...registry, ...fileBased }` — file-based wins on name collision (registry is the lower-priority default; local config overrides it).
   - Call `session.setRuntimeMcpServers(merged)`.
2. Pass `appMcpManager` and `settingsManager` into each agent factory. Preferred pattern: add them to the existing agent context/config object (e.g., `CoderAgentConfig`, `GeneralAgentConfig`) rather than `AgentSessionInit`. Evaluate the existing pattern and follow it consistently.
3. Subscribe to `mcp.registry.changed` in the worker session lifecycle — when the registry changes, rebuild the merged map and call `session.setRuntimeMcpServers(newMerged)` on live worker sessions. Worker sessions are short-lived, so if hot-reload is complex, re-injection on next session creation is acceptable; document the decision.
4. Emit a WARN log when a name collision between file-based and registry servers is detected.
5. Write unit tests covering:
   - Worker sessions receive the merged (file-based + registry) MCP map via `setRuntimeMcpServers()`.
   - File-based servers take precedence over registry servers on name collision.
   - The merged map is complete (neither source is dropped).

**Acceptance criteria:**
- Coder and general agents in rooms receive both file-based and registry-sourced MCP tools.
- File-based servers take precedence on name collision (registry is the lower-priority default).
- The merged map is passed to `setRuntimeMcpServers()` — no source is silently dropped.
- Unit tests confirm the merge is correct and neither source is lost.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 3.1 (AppMcpLifecycleManager Class), Task 3.2 (RoomRuntimeService integration)

---

## Task 3.4: Integrate Lifecycle Manager into Space Module Agents

**Agent type:** coder

**Description:**
The space module (`packages/daemon/src/lib/space/`) also calls `setRuntimeMcpServers()` for task agents and step agents. This task extends the registry-sourced MCP injection to space agents so they benefit from the same application-level MCP configuration.

**Files to examine:**
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` — calls `setRuntimeMcpServers()`
- `packages/daemon/src/lib/space/provision-global-agent.ts` — may also set runtime MCPs

**Subtasks (ordered):**

1. Read `task-agent-manager.ts` and `provision-global-agent.ts` to understand how MCP servers are currently injected into space agents.
2. Inject `AppMcpLifecycleManager` into the space runtime context (via `SpaceRuntimeContext` or equivalent — whichever is consistent with the existing pattern).
3. In `task-agent-manager.ts`, when building the `setRuntimeMcpServers()` call, merge registry entries from `appMcpManager.getEnabledMcpConfigs()` alongside existing sources. Apply the same merge strategy as Task 3.3 (file-based wins on name collision).
4. Apply the same pattern in `provision-global-agent.ts` if it also injects runtime MCPs.
5. Write unit tests covering that space task agents receive registry MCP servers.

**Scope decision note:** Space agents are in-scope for this iteration because they share the same `setRuntimeMcpServers()` injection point and excluding them would create an inconsistent experience (room agents have registry MCPs, space agents do not). A follow-up task for per-space MCP enablement (analogous to per-room enablement) is deferred to a future milestone.

**Acceptance criteria:**
- Space task agents receive registry-sourced MCP tools.
- No regression in existing space agent behavior.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 3.1 (AppMcpLifecycleManager Class), Task 3.3 (Worker Sessions integration)
