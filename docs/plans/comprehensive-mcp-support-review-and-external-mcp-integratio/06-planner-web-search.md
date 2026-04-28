# Milestone 6: Default MCP Seeds and Planner Web Search Verification

## Milestone Goal

**Clarification:** The original goal ("planner web search capability") referred to the planner agent used in the planning workflow being able to search the internet. This capability is **already implemented**: both the Planner agent and the plan-writer sub-agent include `WebFetch` and `WebSearch` in their tool lists (`planner-agent.ts` lines 242-243 for plan-writer, lines 592-593 for Planner). No new infrastructure is required for this.

This milestone therefore covers two things:
1. **Document** the existing planner web search capability so it is not accidentally removed in future refactors.
2. **Seed** the useful default MCP entry `fetch-mcp` into the application-level registry at daemon startup — this is useful for end-users and required by the E2E test in Task 7.1.

## Scope

Daemon package (startup seeding) and one documentation task. No new agent wiring.

---

## Task 6.1: Document Planner Web Search Capability

**Agent type:** general

**Description:**
Verify and document that the Planner agent and plan-writer sub-agent already have web search capability via built-in `WebFetch` and `WebSearch` tools. Produce a short document so this capability is visible and not accidentally regressed.

**Subtasks (ordered):**

1. Read `packages/daemon/src/lib/room/agents/planner-agent.ts` to confirm:
   - The Planner agent's `AgentSubAgentDef` (for plan-writer) includes `'WebFetch'` and `'WebSearch'` in its `tools` array.
   - The Planner agent's own `AgentSessionInit` includes `'WebFetch'` and `'WebSearch'` in its `tools` array.
2. Confirm there are no `allowedTools` or permission filters downstream that would block these tools for the Planner or plan-writer.
3. Write `docs/planner-web-search.md` documenting:
   - Current state: WebFetch and WebSearch are in scope for both agents.
   - How to use them: WebSearch for broad queries, WebFetch for reading specific URLs (npm package pages, GitHub releases, documentation).
   - Maintenance note: future changes to the planner tool list should preserve these two tools.
4. Produce a PR with the document.

**Acceptance criteria:**
- `docs/planner-web-search.md` exists and documents the current tool availability.
- No code changes — documentation only.
- PR created via `gh pr create` targeting `dev`.

**Depends on:** (none — can run in parallel from day one)

---

## Task 6.2: Seed Default Application-Level MCP Entries on Daemon Startup

**Agent type:** coder

**Description:**
On daemon startup, seed the useful default `fetch-mcp` entry into the application-level registry if it does not already exist. This is for end-users (not for the planner's own web search, which uses built-in tools). The `fetch-mcp` entry is also required by the E2E test in Task 7.1.

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
3. The seed is idempotent — if the entry already exists (by name), skip creation.
4. **Verify package names at implementation time** — `@tokenizin/mcp-npx-fetch` is the expected package as of plan creation but npm package names can change. The implementing agent must verify this package exists on npm before hardcoding it.
5. Write unit tests that verify the seed function is idempotent and creates expected entries on a fresh registry.

**Acceptance criteria:**
- On first daemon start, the `fetch-mcp` entry appears in the registry.
- On subsequent starts, no duplicate entries are created.
- `fetch-mcp` is enabled.
- Unit tests pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 2.1 (Schema, Types, and Repository), Task 3.1 (AppMcpLifecycleManager)
