# Comprehensive MCP Support Review and External MCP Integration

## Goal Summary

NeoKai currently supports MCP servers defined in project-level `.mcp.json` or `~/.claude/settings.json` files, which are auto-loaded by the Claude Agent SDK. There is no application-level registry for managing, adding, or importing MCP servers from external sources, no UI to configure MCPs beyond toggling existing ones, and no persistent CRUD API for registering new MCPs.

This plan audits the current MCP system, then implements:
1. A daemon-managed **Application-Level MCP Registry** (SQLite-backed) for CRUD on named MCP server configs.
2. A **Lifecycle Manager** that converts registry entries to SDK configs, integrates them into room/session and space/task-agent contexts, and provides error feedback for failed MCP servers.
3. A **Web UI** for adding, editing, enabling/disabling, and deleting application-level MCPs (including secure env-var editor for API keys).
4. **Room/session MCP enablement**: per-room opt-in from the registry.
5. **Web search for the Planner** via a bundled or user-configured web-search MCP server.

## Approach

The existing system reads MCP server configs from `.mcp.json` / `settings.json` files on disk and delegates spawning entirely to the Claude Agent SDK subprocess. The new system layered on top:

- Stores registry entries in the SQLite `app_mcp_servers` table.
- At room-chat session startup, `RoomRuntimeService` reads the registry, applies per-room enablement, and passes the resolved `mcpServers` map to `setRuntimeMcpServers()` alongside the existing `room-agent-tools` server.
- For worker (coder/general) sessions, enabled registry entries are injected via `session.setRuntimeMcpServers()` after session creation — preserving the SDK's existing auto-load of file-based MCP servers (`config.mcpServers` remains `undefined`).
- The Planner and plan-writer sub-agents gain access to web-search tools from a configured web-search MCP entry.

No existing MCP file-based flows are removed — the registry is additive.

## Milestones

1. **Audit and Documentation** — Deep-dive into current MCP flows, document gaps, and produce an audit report.
2. **Application-Level MCP Registry (Backend)** — SQLite schema, repository, RPC handlers (CRUD + list), and unit tests.
3. **MCP Lifecycle Manager** — Convert registry entries to SDK configs, inject via `setRuntimeMcpServers()` into room sessions (Task 3.2), worker sessions (Task 3.3), and space agents (Task 3.4). Validation error reporting for misconfigured entries. Health-check/auto-restart deferred to a future iteration.
4. **Room and Session MCP Integration** — Per-room enablement stored in the DB, integration in `RoomRuntimeService` and `QueryOptionsBuilder`, and online tests.
5. **Web UI for MCP Registry** — Settings panel for adding/editing/deleting application-level MCP entries with enable/disable per room.
6. **Planner Web Search Capability** — Evaluate and integrate a web-search MCP (Brave/DuckDuckGo/Fetch), wire it into Planner and plan-writer agents.
7. **E2E Tests** — End-to-end Playwright test: add an MCP, enable in a room, verify tools available to the room agent.

## Cross-Milestone Dependencies

- Milestone 2 (registry backend) must land before 3, 4, 5, and 6.
- Milestone 3 (lifecycle manager) must land before 4 (room integration) and 6 (planner web search).
- Milestone 4 (room integration) must land before 5 (UI reflects per-room state) and 7 (E2E test).
- Milestone 5 (UI) can be developed in parallel with 6 (planner search) after milestone 4 is done.
- Milestone 7 (E2E) depends on all prior milestones.
- **Task 6.1** (web search evaluation) has **no dependencies** and can start in parallel with Milestone 2 from day one.

## Audit Feedback Loop

Milestone 1 (Audit) should complete before implementation milestones begin. If the audit uncovers a critical architectural gap not covered by this plan, implementation tasks should be adjusted before proceeding with the affected milestone. The audit document (`docs/mcp-audit.md`) serves as the authoritative reference for implementation decisions.

## Total Estimated Task Count

19 tasks across 7 milestones (added Task 3.4 for space module integration).
