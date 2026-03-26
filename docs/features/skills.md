# Skills

Skills extend NeoKai's capabilities by integrating external tools, commands, and services into agent sessions. A skill can be a slash command, a plugin that adds custom behavior, or an MCP server that provides additional tools.

## What are Skills?

In NeoKai, a skill is a configured capability that can be invoked by an agent during a session. Skills fall into three categories:

- **Slash commands** — Built-in commands like `/merge-session` that the agent can call directly
- **Plugin skills** — Local executable scripts or programs that extend agent functionality
- **MCP server skills** — [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers that provide tools via the MCP standard

Skills are configured **globally** at the application level and then selectively **enabled per room**.

## Adding a Skill

### Via Settings > Skills

1. Open **Settings** (gear icon in the top-right navigation)
2. Select **Skills** in the left sidebar
3. Click **Add Skill**
4. Fill in the skill details (see Source Types below)
5. Click **Save**

The skill is now registered in the global skills registry and can be enabled in any room.

### Source Types

When adding a skill, you choose a source type that determines how the skill is invoked:

#### Built-in

Built-in skills are shipped with NeoKai and require no configuration. Currently, the only built-in skill is **Web Search (MCP)**, which provides web search capability via the Brave Search API.

To use the Web Search skill:
1. Add a `BRAVE_API_KEY` environment variable (get one from [brave.com/search/api](https://brave.com/search/api/))
2. Enable the **Web Search (MCP)** skill in the skills registry
3. Enable it in your room's settings

#### Plugin

Plugin skills execute a local executable. They require:
- **Plugin Path** — Absolute path to the executable (must be an absolute path starting with `/`)
- **Command Name** — The slash-command name agents use to invoke it (e.g., `/my-tool`)

Example: A Python script at `/usr/local/bin/my-skill` with command name `/analyze` would be invoked when the agent calls `/analyze`.

Security: Path traversal (`..`) is blocked. Only absolute paths are accepted.

#### MCP Server

MCP server skills wrap an existing MCP server from the [application MCP registry](./mcp.md#application-level-mcp-registry). They require:
- **MCP Server** — Select an existing MCP server entry from the dropdown

When enabled, all tools exposed by that MCP server become available to the agent.

## Enabling Skills Per Room

By default, skills are disabled. You must explicitly enable them per room.

1. Open a **Room**
2. Click the **Room Settings** button (top-right of the room panel)
3. Scroll to **Skills**
4. Toggle the skills you want to enable for this room

### Room Override Behavior

When you toggle a skill in room settings, it creates a **room-level override**. This override takes precedence over the skill's global enabled/disabled state.

- **Globally enabled + room disabled** → Skill is OFF in that room
- **Globally disabled + room enabled** → Skill is ON in that room
- **No override** → Skill uses its global enabled state

To remove a room override, click **Reset** next to the skill. The skill returns to its global state.

## Built-in Skills

### Web Search (MCP)

Provides real-time web search via Brave Search. Requires a `BRAVE_API_KEY` environment variable.

- **Name**: `web-search-mcp`
- **Type**: MCP Server (built-in, opt-in)
- **Tools exposed**: `brave_web_search`, `brave_image_search`

This skill is **always available** to the planner agent for research tasks.

### Other Built-in Commands

NeoKai agents also have access to built-in slash commands registered through the SDK (e.g., `/merge-session`). These are always available and do not appear in the skills registry.

## Skills Architecture

For developers working on the skills system:

```
User adds skill (via Settings UI)
    ↓
skills-store.ts (frontend) → skill.create RPC
    ↓
skill-handlers.ts → SkillsManager.addSkill()
    ↓
SkillRepository.insert() → SQLite skills table
    ↓
reactiveDb.notifyChange('skills') → LiveQuery propagates to all clients

Agent session starts
    ↓
QueryOptionsBuilder.build() calls SkillsManager.getEnabledSkills()
    ↓
buildPluginsFromSkills() → SDK plugins[] config
getMcpServersFromSkills() → SDK mcpServers{} config
    ↓
AgentSession initializes with skills injected
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/shared/src/types/skills.ts` | TypeScript types for skills (AppSkill, configs, status) |
| `packages/daemon/src/lib/skills-manager.ts` | SkillsManager: CRUD, validation, built-in initialization |
| `packages/daemon/src/lib/rpc-handlers/skill-handlers.ts` | RPC handlers: list, get, create, update, delete, setEnabled |
| `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` | LiveQuery: `skills.list`, `skills.byRoom` named queries |
| `packages/daemon/src/lib/agent/query-options-builder.ts` | Injects enabled skills into SDK session options |
| `packages/web/src/lib/skills-store.ts` | Frontend reactive store with LiveQuery subscription |
| `packages/web/src/components/settings/SkillsRegistry.tsx` | Global skills management UI |
| `packages/web/src/components/room/RoomSkillsSettings.tsx` | Per-room skill override UI |

### Validation

When a skill is added or updated, an async validation job runs to verify:
- **Plugin skills**: The executable path is accessible (`fs.promises.access`)
- **MCP server skills**: The referenced MCP server entry exists in `app_mcp_servers`
- **Built-in skills**: No validation needed (always valid)

Validation status is stored in `AppSkill.validationStatus`: `pending | valid | invalid | unknown`

## Restrictions

- Built-in skills cannot be deleted
- Path traversal (`..`) is rejected for plugin paths
- MCP server skills must reference an existing MCP server entry