# Milestone 3: Skills Distribution to Agent Sessions

## Milestone Goal

Inject enabled Skills from the registry into the SDK options when sessions start. Plugin-based skills become `SDKConfig.plugins` entries. MCP-server-based skills become additional `mcpServers` entries. Built-in skills rely on the SDK's existing slash command discovery. Room-level overrides are applied on top.

## Tasks

---

### Task 3.1: Skills Injection in QueryOptionsBuilder

**Agent type:** coder

**Description:**
Extend `QueryOptionsBuilder` to pull enabled skills from `SkillsManager` and inject them into the SDK query options (`plugins`, `mcpServers`). This makes Skills available to any agent session.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add `skillsManager: SkillsManager` to `QueryOptionsBuilderContext` interface in `packages/daemon/src/lib/agent/query-options-builder.ts`.
3. Add a private `buildPluginsFromSkills(): PluginConfig[]` method that:
   - Calls `skillsManager.getEnabledSkills()`
   - Filters for `sourceType === 'plugin'`
   - Maps each to `{ type: 'local', path: (skill.config as PluginSkillConfig).pluginPath }`
4. Add a private `getMcpServersFromSkills(): Record<string, unknown>` method that:
   - Filters enabled skills with `sourceType === 'mcp_server'`
   - Maps each to a standard MCP server config entry
5. In `build()`, merge plugins from skills with any existing `config.plugins`.
6. In `getMcpServers()`, merge MCP servers from skills with existing `config.mcpServers`.
7. Pass `skillsManager` through from `AgentSession` constructor.
8. Update `AgentSession` to receive and pass `SkillsManager` into `QueryOptionsBuilderContext`.
9. Run `bun run typecheck`.
10. Update unit tests in `packages/daemon/tests/unit/agent/query-options-builder.test.ts`:
    - Test that plugin skills appear in `plugins` option
    - Test that MCP server skills appear in `mcpServers`
    - Test that disabled skills are excluded

**Acceptance criteria:**
- Enabled plugin skills are injected as `plugins` entries in SDK options
- Enabled MCP server skills are injected as `mcpServers` entries
- Disabled skills are excluded
- Unit tests updated and passing
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillsManager Service"]

---

### Task 3.2: Room-Level Skill Enablement Persistence

**Agent type:** coder

**Description:**
Add per-room skill enablement configuration. A room can override the global enabled/disabled state of any registered skill. This is stored in the room's `config` JSON column.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add `RoomSkillOverride = { skillId: string; enabled: boolean }` type to `packages/shared/src/types/skills.ts`.
3. Add `skillOverrides?: RoomSkillOverride[]` to the `Room` type's `config` shape (or define a `RoomConfig` interface in `packages/shared/src/types/neo.ts`).
4. Update `RoomManager` to expose `getSkillOverrides(roomId)` and `setSkillOverrides(roomId, overrides)` methods that read/write to the room's `config.skillOverrides`.
5. Add RPC handlers to `packages/daemon/src/lib/rpc-handlers/room-handlers.ts`:
   - `room.getSkillOverrides` → `{ roomId: string }` → `{ overrides: RoomSkillOverride[] }`
   - `room.setSkillOverrides` → `{ roomId: string; overrides: RoomSkillOverride[] }` → `{ success: boolean }`
6. Update `packages/shared/src/api.ts` with the two new RPC types.
7. Run `bun run typecheck`.
8. Write unit tests for the new RoomManager methods and RPC handlers.

**Acceptance criteria:**
- `RoomSkillOverride` type defined in shared
- RoomManager can read/write skill overrides from room config
- Two new RPC handlers exposed and registered
- Unit tests pass
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.1: AppSkill Types in Shared Package"]

---

### Task 3.3: Apply Room Skill Overrides to Session Init

**Agent type:** coder

**Description:**
When creating a room session (leader, coder, planner), apply the room's skill overrides on top of the global skill registry before building SDK options. Skills disabled by the room override are excluded even if globally enabled.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add `roomSkillOverrides?: RoomSkillOverride[]` to `QueryOptionsBuilderContext`.
3. In `QueryOptionsBuilder.buildPluginsFromSkills()` and `getMcpServersFromSkills()`, apply room overrides: if a skill is in the room's override list with `enabled: false`, exclude it.
4. In room agent creation paths (`packages/daemon/src/lib/room/agents/`), fetch room skill overrides and pass them into the session config.
5. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, where sessions are initialized, retrieve overrides from `RoomManager` and inject into the session init config.
6. Run `bun run typecheck`.
7. Update unit tests to cover override application logic.

**Acceptance criteria:**
- Room skill overrides are applied correctly at session initialization
- A skill disabled at room level is excluded even if globally enabled
- Unit tests cover override priority
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 3.1: Skills Injection in QueryOptionsBuilder", "Task 3.2: Room-Level Skill Enablement Persistence"]
