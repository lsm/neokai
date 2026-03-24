# Milestone 1: Audit and Documentation

## Milestone Goal

Produce a comprehensive audit of NeoKai's current MCP support covering server registration, tool distribution, session/room integration, and identify all gaps that the subsequent milestones address.

## Scope

Read-only investigation — no code changes. Output is a Markdown document committed to the repo.

---

## Task 1.1: MCP Architecture Audit

**Agent type:** general

**Description:**
Conduct a thorough audit of the current MCP support in NeoKai. Produce a structured report at `docs/mcp-audit.md`.

**Subtasks (ordered):**

1. Read `packages/daemon/src/lib/settings-manager.ts` — understand `listMcpServersFromSources()` and `getEnabledMcpServersConfig()` and how servers are read from `.mcp.json`, `settings.json`.
2. Read `packages/daemon/src/lib/agent/query-options-builder.ts` — understand how `getMcpServers()` assembles the `mcpServers` option passed to the SDK, and the special handling for `room_chat` sessions (strict mode, wildcard allow-listing).
3. Read `packages/daemon/src/lib/agent/agent-session.ts` — understand `setRuntimeMcpServers()` and how runtime MCP servers are merged at query time.
4. Read `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — understand how `getEnabledMcpServersConfig()` feeds into `setRuntimeMcpServers()` alongside `room-agent-tools`.
5. Read `packages/daemon/src/lib/room/agents/planner-agent.ts` — understand the plan-writer sub-agent's tool list and that it lacks any external web search MCP today.
6. Read `packages/daemon/src/lib/room/agents/coder-agent.ts` and `general-agent.ts` — understand how worker agents receive (or don't receive) MCP servers.
7. Read `packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts` and `settings-handlers.ts` — catalogue all existing MCP-related RPC endpoints.
8. Read `packages/web/src/components/settings/McpServersSettings.tsx` — understand the existing UI for toggling MCP servers.
9. Read `packages/shared/src/types/sdk-config.ts` (McpStdioServerConfig, McpSSEServerConfig, McpHttpServerConfig) and `packages/shared/src/types/settings.ts` (FileOnlySettings, McpServerSettings).
10. Write `docs/mcp-audit.md` covering: (a) how MCPs are registered today, (b) server types supported, (c) tool distribution chain, (d) per-session vs per-room vs global granularity, (e) gaps: no app-level registry, no UI to add servers, no planner web search, no per-room enablement UI.

**Acceptance criteria:**
- `docs/mcp-audit.md` exists and is committed on a feature branch.
- The document covers all five audit areas listed in subtask 10.
- A GitHub PR is created via `gh pr create` targeting `dev`.

**Depends on:** (none)

**Notes:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
