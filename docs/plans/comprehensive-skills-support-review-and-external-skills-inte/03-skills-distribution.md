# Milestone 3: Skills Distribution to Agent Sessions

## Milestone Goal

Inject enabled Skills from the registry into the SDK options when sessions start. Plugin-based skills become `SDKConfig.plugins` entries. MCP-server-based skills become additional `mcpServers` entries. Built-in skills rely on the SDK's existing slash command discovery. Room-level overrides are applied on top.

## Tasks

---

### Task 3.1: Skills Injection in QueryOptionsBuilder (with strictMcpConfig handling)

**Agent type:** coder

**Description:**
Extend `QueryOptionsBuilder` to pull enabled skills from `SkillsManager` and inject them into the SDK query options (`plugins`, `mcpServers`). This makes Skills available to any agent session.

**Critical: `strictMcpConfig` handling** — `room_chat` sessions use `strictMcpConfig: true`, which causes the SDK to silently block any MCP server not explicitly listed in the session config. Skill-injected MCP servers must be handled to avoid silent failures:
- Audit where `strictMcpConfig` is set (likely in `packages/daemon/src/lib/room/agents/` or query-options-builder).
- When MCP server skills are enabled, their server names must appear in the MCP servers map that is built for the session. Since `strictMcpConfig` only allows servers present in the config, injecting them into `mcpServers` is sufficient — but verify this is the case.
- If `strictMcpConfig` has a separate allowlist, ensure skill-injected servers are added to it.
- Add a comment in the code explaining this relationship so future developers don't accidentally break it.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/agent/query-options-builder.ts` and all room agent definitions to locate every place `strictMcpConfig` is set or referenced.
3. Confirm whether injecting a server into `mcpServers` is sufficient to satisfy `strictMcpConfig`, or if a separate allowlist must also be updated.
4. Add `skillsManager: SkillsManager` and `appMcpServerRepo: AppMcpServerRepository` to `QueryOptionsBuilderContext` interface in `packages/daemon/src/lib/agent/query-options-builder.ts`.
5. Add a private `buildPluginsFromSkills(): PluginConfig[]` method that:
   - Calls `skillsManager.getEnabledSkills()`
   - Filters for `sourceType === 'plugin'`
   - Maps each to `{ type: 'local', path: (skill.config as PluginSkillConfig).pluginPath }`
6. Add a private `getMcpServersFromSkills(): Record<string, McpServerConfig>` method that:
   - Filters enabled skills with `sourceType === 'mcp_server'`
   - For each, looks up the referenced `app_mcp_servers` entry via `appMcpServerRepo.get((skill.config as McpServerSkillConfig).appMcpServerId)` — skip silently if `null` (entry deleted or no longer exists)
   - Maps the resolved `AppMcpServer` to a standard MCP server config entry keyed by `skill.name`
7. In `build()`, merge plugins from skills with any existing `config.plugins`.
8. In `getMcpServers()`, merge MCP servers from skills with existing `config.mcpServers`. If `strictMcpConfig` requires an explicit allowlist, add the skill server names there too.
9. Add a code comment near the MCP injection: `// Skill-injected MCP servers: must appear in mcpServers map for strictMcpConfig sessions to accept them`.
10. Pass `skillsManager` through from `AgentSession` constructor.
11. Update `AgentSession` to receive and pass `SkillsManager` into `QueryOptionsBuilderContext`.
12. Run `bun run typecheck`.
13. Update unit tests in `packages/daemon/tests/unit/agent/query-options-builder.test.ts`:
    - Test that plugin skills appear in `plugins` option
    - Test that MCP server skills appear in `mcpServers`
    - Test that disabled skills are excluded
    - **Test that a skill-injected MCP server is not blocked when `strictMcpConfig` is true** (verify it is present in the final config)

**Acceptance criteria:**
- Enabled plugin skills are injected as `plugins` entries in SDK options
- Enabled MCP server skills are injected as `mcpServers` entries and are NOT silently blocked by `strictMcpConfig`
- Disabled skills are excluded
- Code comment explains `strictMcpConfig` relationship
- Unit tests updated and passing, including `strictMcpConfig` compatibility test
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillRepository (SQLite) and SkillsManager"]

---

### Task 3.2: Room-Level Skill Enablement Persistence (room_skill_overrides table)

**Agent type:** coder

**Description:**
Add per-room skill enablement configuration. A room can override the global enabled/disabled state of any registered skill. Overrides must live in a **dedicated `room_skill_overrides` table** (not the room `config` JSON blob) so LiveQuery can reactively JOIN it with the `skills` table in the `skills.byRoom` named query.

**Why a dedicated table instead of room config JSON:**
The LiveQuery engine tracks changes at the table level. If overrides were stored in the room `config` JSON column, the `skills.byRoom` query would not automatically re-execute when an override changes (it only watches `skills`, not `rooms`). A dedicated table triggers the correct change event.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add `RoomSkillOverride = { skillId: string; roomId: string; enabled: boolean }` type to `packages/shared/src/types/skills.ts`.
3. Create `packages/daemon/src/storage/repositories/room-skill-override-repository.ts` with:
   - Constructor accepts `reactiveDb: ReactiveDatabase`
   - `ensureTable()` — creates `room_skill_overrides` table: `skill_id TEXT`, `room_id TEXT`, `enabled INTEGER NOT NULL`, `PRIMARY KEY (skill_id, room_id)`, `FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE`, `FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE`
   - `getOverrides(roomId): RoomSkillOverride[]` — synchronous
   - `upsertOverride(roomId, skillId, enabled): void` — INSERT OR REPLACE; calls `reactiveDb.notifyChange('room_skill_overrides')`
   - `deleteOverride(roomId, skillId): void` — calls `reactiveDb.notifyChange('room_skill_overrides')`
   - `deleteAllForRoom(roomId): void` — calls `reactiveDb.notifyChange('room_skill_overrides')`
4. Register `RoomSkillOverrideRepository` in `packages/daemon/src/app.ts` and call `ensureTable()` on startup.
5. Add RPC handlers to `packages/daemon/src/lib/rpc-handlers/room-handlers.ts`:
   - `room.getSkillOverrides` → `{ roomId: string }` → `{ overrides: RoomSkillOverride[] }`
   - `room.setSkillOverride` → `{ roomId: string; skillId: string; enabled: boolean }` → `{ success: boolean }` (single upsert)
   - `room.clearSkillOverride` → `{ roomId: string; skillId: string }` → `{ success: boolean }` (remove override, revert to global)
6. Update `packages/shared/src/api.ts` with the three new RPC types.
7. **Add `skills.byRoom` named query** to `NAMED_QUERY_REGISTRY` in `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` — this belongs here (not Task 2.4) because the query JOINs `room_skill_overrides`, which is created in this task.

   Use `mcpEnablement.byRoom` (1-param at line ~257) as the structural template.

   **`skills.byRoom`** (1 param: `roomId`) — all global skills with per-room override applied via LEFT JOIN:
   ```sql
   SELECT s.id, s.name, s.display_name AS displayName, s.description,
          s.source_type AS sourceType, s.config, s.built_in AS builtIn,
          s.validation_status AS validationStatus,
          s.created_at AS createdAt,
          CASE WHEN rso.enabled IS NOT NULL THEN rso.enabled ELSE s.enabled END AS enabled,
          CASE WHEN rso.skill_id IS NOT NULL THEN 1 ELSE 0 END AS overriddenByRoom
   FROM skills s
   LEFT JOIN room_skill_overrides rso ON rso.skill_id = s.id AND rso.room_id = ?
   ORDER BY s.built_in DESC, s.created_at ASC
   ```
   Row mapper: parse `config` JSON; coerce `enabled`, `builtIn`, `overriddenByRoom` to booleans.

8. **Authorization guard**: add `queryName === 'skills.byRoom'` to the allow-list in `liveQuery.subscribe` alongside `'tasks.byRoom'`, `'goals.byRoom'`, and `'mcpEnablement.byRoom'` (~line 453 in `live-query-handlers.ts`).
9. Run `bun run typecheck`.
10. Write unit tests for `RoomSkillOverrideRepository`, the new RPC handlers, and the `skills.byRoom` query:
    - Test `skills.byRoom` returns global `enabled` when no room override row exists
    - Test `skills.byRoom` returns room override `enabled` when override row exists
    - Test `RoomSkillOverrideRepository` calls `reactiveDb.notifyChange('room_skill_overrides')` on upsert/delete
    - Test cascade deletes work: deleting a room or skill removes its overrides

**Acceptance criteria:**
- `room_skill_overrides` table created via `RoomSkillOverrideRepository.ensureTable()`
- `RoomSkillOverrideRepository` calls `reactiveDb.notifyChange('room_skill_overrides')` after every write
- `RoomSkillOverride` type in shared package
- Three new RPC handlers exposed and registered
- `skills.byRoom` registered in `NAMED_QUERY_REGISTRY` with correct SQL and row mapper
- `skills.byRoom` added to the auth guard allow-list
- Cascade deletes work: deleting a room or skill removes its overrides
- Unit tests pass
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillRepository (SQLite) and SkillsManager"]

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

**depends_on:** ["Task 3.1: Skills Injection in QueryOptionsBuilder (with strictMcpConfig handling)", "Task 3.2: Room-Level Skill Enablement Persistence (room_skill_overrides table)"]
