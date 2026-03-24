# Milestone 6: Planner Web Search Capability

## Milestone Goal

Integrate a web-search MCP server into the Planner agent (and its plan-writer sub-agent) so they can perform real-time internet searches during planning. The implementation uses the application-level MCP registry from Milestone 2 and the lifecycle manager from Milestone 3 to make the search server available.

## Scope

Daemon package (planner-agent.ts), plus optional user-facing setup instructions in `docs/`. No new infrastructure — leverages the registry built in prior milestones.

---

## Task 6.1: Evaluate and Select Web Search MCP

**Agent type:** general

**Description:**
Research the available web-search MCP options and select the best one for NeoKai's planner. Document the decision.

**Subtasks (ordered):**

1. Evaluate the following candidates:
   - `@modelcontextprotocol/server-brave-search` (requires BRAVE_API_KEY, free tier available)
   - `mcp-server-fetch` / `mcp-fetch` (no API key required, fetches URLs and converts to text — useful for reading docs but limited search)
   - DuckDuckGo community MCP server (no API key, rate-limited)
   - Tavily MCP (`tavily-mcp`, requires TAVILY_API_KEY, AI-optimized search)
2. Assessment criteria: (a) no/low-cost API key for development, (b) quality of structured search results, (c) npm/uvx installability, (d) community adoption, (e) compatibility with NeoKai's stdio MCP model.
3. Recommendation: Select **Brave Search MCP** as primary (free tier API key, high result quality, official MCP package) and **mcp-server-fetch** as a zero-config fallback for URL retrieval.
4. Write evaluation findings in `docs/mcp-web-search-evaluation.md`.
5. Produce a PR with the document.

**Acceptance criteria:**
- `docs/mcp-web-search-evaluation.md` exists and documents all four candidates with pros/cons.
- A recommendation is clearly stated with rationale.
- PR created via `gh pr create` targeting `dev`.

**Depends on:** (none — can run in parallel with Milestone 3 and 4)

---

## Task 6.2: Seed Web Search MCP on Daemon Startup

**Agent type:** coder

**Description:**
On daemon startup, if no web-search MCP entry exists in the registry, optionally auto-register a `brave-search` entry (disabled by default, waiting for user to provide API key) and a `mcp-server-fetch` entry (enabled by default, no API key required).

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/app.ts` (or a new `packages/daemon/src/lib/mcp/seed-defaults.ts`), after `AppMcpLifecycleManager` is initialized, check if `fetch-mcp` entry exists in the registry; if not, create it:
   ```json
   {
     "name": "fetch-mcp",
     "description": "Fetch web pages and convert to Markdown for reading documentation and articles",
     "sourceType": "stdio",
     "command": "npx",
     "args": ["-y", "@tokenizin/mcp-npx-fetch"],
     "enabled": true
   }
   ```
3. Check if `brave-search` entry exists; if not, create it (disabled by default):
   ```json
   {
     "name": "brave-search",
     "description": "Web search via Brave Search API (requires BRAVE_API_KEY env var)",
     "sourceType": "stdio",
     "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-brave-search"],
     "env": {},
     "enabled": false
   }
   ```
4. The seed is idempotent — if entries already exist (by name), skip creation.
5. Write unit tests that verify the seed function is idempotent and creates expected entries on a fresh registry.

**Acceptance criteria:**
- On first daemon start, `fetch-mcp` and `brave-search` entries appear in the registry.
- On subsequent starts, no duplicate entries are created.
- `fetch-mcp` is enabled; `brave-search` is disabled until the user sets the API key.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 2.1 (Schema, Types, and Repository), Task 3.1 (AppMcpLifecycleManager)

---

## Task 6.3: Wire Web Search MCP into Planner and Plan-Writer Agents

**Agent type:** coder

**Description:**
Update `planner-agent.ts` so the Planner and its plan-writer sub-agent have access to web-search tools from the registry's enabled web-search MCP servers (e.g., `fetch-mcp`, `brave-search`).

**Subtasks (ordered):**

1. In `packages/daemon/src/lib/room/agents/planner-agent.ts`, update `createPlannerAgentInit()` to accept an optional `webSearchMcpServers?: Record<string, McpServerConfig>` in `PlannerAgentConfig`.
2. Merge `webSearchMcpServers` into the `mcpServers` map passed to the planner session: `{ 'planner-tools': mcpServer, ...webSearchMcpServers }`.
3. In the plan-writer sub-agent definition (`buildPlanWriterAgentDef`), add the web-search MCP server names to the agent's allowed tool wildcards (e.g., `'fetch-mcp__*'`, `'brave-search__*'`) so the plan-writer can call those tools.
4. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, when constructing `PlannerAgentConfig`, query `appMcpManager.getWebSearchMcpConfigs()` (a new helper on `AppMcpLifecycleManager` that filters registry entries tagged as web-search, or simply returns all enabled entries matching names `fetch-mcp` and `brave-search`).
5. Add `getWebSearchMcpConfigs(): Record<string, McpServerConfig>` to `AppMcpLifecycleManager` that returns enabled entries with `name` in `['fetch-mcp', 'brave-search']` (or any entry with description containing "search" or "fetch" — make the filter configurable via a `tags` field added to `AppMcpServer` type if preferred).
6. Write unit tests verifying the planner session init includes web-search MCP servers when they are enabled in the registry.
7. Write an online test that starts a planner session with a mock web-search MCP and verifies the tool appears in the session's available tools.

**Acceptance criteria:**
- Planner sessions have `fetch-mcp` tools available (when `fetch-mcp` is enabled in registry).
- Plan-writer sub-agent can call web-search tools during codebase exploration.
- No regression in existing planner behavior (create_task, update_task, remove_task tools still work).
- Unit and online tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 3.1 (AppMcpLifecycleManager), Task 6.2 (Seed Web Search MCP), Task 2.2 (RPC Handlers)
