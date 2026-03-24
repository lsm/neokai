# Milestone 7: E2E Tests

## Milestone Goal

Validate the full user-facing flow end-to-end with Playwright: add an application-level MCP server via the settings UI, enable it in a room, and verify the tools are available to the room agent in a session.

## Scope

E2E package only. All production code is in place from prior milestones.

---

## Task 7.1: E2E Test — MCP Registry Add and Room Enable

**Agent type:** coder

**Description:**
Write a Playwright E2E test that exercises the full flow: open global settings, add an MCP server (using a safe stdio command that is always available, e.g., `echo`), navigate to a room's settings, enable the new MCP, and verify the room agent session's tool list includes a wildcard entry for that MCP.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/app-mcp-registry.e2e.ts`.
3. In `beforeEach`, seed a test MCP entry via `hub.request('mcp.registry.create', { name: 'fetch-mcp', ... })` — reuse the `fetch-mcp` server that is already seeded on daemon startup (see Task 6.2), or ensure it is present via the RPC. This is a real stdio MCP server (`npx @tokenizin/mcp-npx-fetch`) that produces valid MCP protocol responses, making it suitable for E2E testing. Do **not** use `echo` or other non-MCP commands as the stdio command — they produce invalid MCP protocol output and will cause the SDK to reject the server.
4. Create a test room via `hub.request('room.create', ...)`.
5. Navigate to Global Settings → "Application MCP Servers" section.
6. Verify the `fetch-mcp` entry appears in the list with an enabled indicator (it was seeded on startup).
7. Navigate to the test room's settings panel → "MCP Servers" section.
8. Verify `fetch-mcp` appears in the room's MCP list with the global-default enabled state.
9. Toggle the server off for the room, verify the toggle state updates in the UI.
10. Toggle the server back on, verify the toggle state reverts.
11. Open the room chat — once a session is running, check the Tools Modal (or equivalent visible tool list) and verify `fetch-mcp` tools are listed as active.
12. In `afterEach`, delete the test room. Do not delete `fetch-mcp` from the registry — it is a permanent seed entry.
13. Ensure the test follows E2E rules: all assertions on visible DOM state, no direct API calls except in setup/teardown hooks.

**Acceptance criteria:**
- Test adds an MCP server via the UI and verifies it appears in the list.
- Test enables/disables the MCP in the room via the room settings UI.
- Test verifies the MCP is reflected in the room session's active tools.
- Test passes cleanly with `make run-e2e TEST=tests/features/app-mcp-registry.e2e.ts`.
- No regression in existing E2E tests.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 5.2 (AppMcpServersSettings UI), Task 5.3 (Per-Room MCP UI), Task 4.2 (Room/Session integration), Task 3.2 (RoomRuntimeService integration)

---

## Task 7.2: E2E Test — Planner Web Search Smoke Test

**Agent type:** coder

**Description:**
Write a lightweight Playwright smoke test that verifies the plan-writer sub-agent has the `fetch-mcp` tool available (the zero-config web fetch tool seeded on startup).

**Subtasks (ordered):**

1. Create `packages/e2e/tests/features/planner-web-search.e2e.ts`.
2. In `beforeEach`, create a test room with a simple goal.
3. Trigger the planner via the UI (create the goal and wait for the planner session to start).
4. Once the planner session is running, verify via the Tools Modal or system message that `fetch-mcp__*` tools are listed as available.
5. Do NOT make a real web search call — only verify tool availability.
6. In `afterEach`, clean up the room.

**Acceptance criteria:**
- Test verifies `fetch-mcp` tool is available to the planner without requiring any API key.
- Test passes with `make run-e2e TEST=tests/features/planner-web-search.e2e.ts`.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 6.3 (Wire Web Search MCP into Planner), Task 6.2 (Seed Web Search MCP), Task 7.1 (MCP Registry E2E)
