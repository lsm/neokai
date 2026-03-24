# Comprehensive Skills Support Review and External Skills Integration

## Goal Summary

NeoKai currently has **no application-level Skills registry**. The term "Skill" in NeoKai maps directly to the Claude Agent SDK's slash-command system (markdown files in `.claude/commands/`). The SDK also supports local **Plugins** (directories providing agents, skills, hooks) and **MCP tools** (MCP servers). This goal delivers:

1. A thorough audit of the current state
2. An application-level Skills registry — add, configure, and manage custom skills from the UI
3. Support for external skill sources: built-in (SDK slash commands), plugin-based (local plugin directories), and MCP-based web search
4. Web search capability for the Planner agent via the SDK's built-in `WebSearch` tool (already wired in; needs verification and prompt enhancement)
5. Room/session-level Skill enablement
6. Tests at all layers

## Key Findings from Codebase Audit

- **"Skill" tool** in NeoKai = SDK's built-in `Skill` tool, which invokes slash commands from `.claude/commands/*.md`. Already included in allowed tool lists for `room_chat` and coordinator modes.
- **SDK Plugins** (`{ type: 'local', path: string }`) can provide custom commands/agents/hooks. NeoKai's `SDKConfig` has a `plugins?: PluginConfig[]` field but no UI or management system for it.
- **Planner/plan-writer agents already include `WebSearch` and `WebFetch`** in their tool lists — planner web search capability exists at the code level but needs verification and possibly prompt guidance.
- **No Skills registry exists**: no CRUD UI, no config file, no RPC handlers for Skills management.
- **MCP is the established extensibility mechanism**: `.mcp.json` in workspace, managed via `ToolsConfig.disabledMcpServers`.
- **Settings pattern**: GlobalSettings → SettingsManager → SQLite → SDK options.
- **Application config dir**: `~/.neokai/` (already in `additionalDirectories`).

## High-Level Approach

- Build an application-level **Skills registry** backed by `~/.neokai/skills.json` (or SQLite)
- Support three skill source types: **built-in** (SDK slash commands), **plugin** (local plugin dir via SDK's `plugins` option), **mcp-server** (MCP server used as a skill provider)
- Add a **Skills Manager** backend service with CRUD operations + RPC handlers
- Expose Skills configuration via the **Settings UI** (global skills) and **Room Settings** (per-room overrides)
- Verify and enhance the planner's **WebSearch** capability with explicit prompt guidance
- Cover everything with unit tests and E2E tests

## Milestones

1. **Skills Audit and Baseline Documentation** — Audit current Skills/MCP/Plugin integration; document the as-is state; identify gaps and establish the target architecture.
2. **Skills Registry Data Model and Backend** — Define `AppSkill` types, create `SkillsManager` backed by `~/.neokai/skills.json`, and wire up RPC handlers (CRUD + list).
3. **Skills Distribution to Agent Sessions** — Inject Skills from registry into SDK options (`plugins`, `skills` preload array) for regular sessions; apply room-level enablement overrides.
4. **Room-Level Skills Enablement** — Add per-room skill enablement config (which registry skills are active for a given room), persist it, and surface it to session init.
5. **Settings UI: Global Skills Registry** — Build the Skills management UI in the global settings panel (list, add, remove, enable/disable skills).
6. **Room Settings UI: Per-Room Skill Enablement** — Extend the Room Settings panel to show available registry skills with per-room toggles.
7. **Planner Web Search Verification and Enhancement** — Confirm the Planner's `WebSearch` tool works end-to-end; add prompt guidance for web search use; write an online test.

## Cross-Milestone Dependencies

- Milestones 3 and 4 depend on Milestone 2 (data model must exist first)
- Milestone 5 depends on Milestone 2 (RPC handlers must exist)
- Milestone 6 depends on Milestones 4 and 5
- Milestone 7 is independent and can proceed in parallel with Milestones 2–6

## Total Estimated Task Count

~22 tasks across 7 milestones
