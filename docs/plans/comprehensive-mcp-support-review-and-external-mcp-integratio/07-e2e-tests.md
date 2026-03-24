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
3. In `beforeEach`, create a test room via `hub.request('room.create', ...)`.
4. Navigate to Global Settings → "Application MCP Servers" section.
5. Click "Add MCP Server":
   - Name: `test-mcp-echo`
   - Source type: `stdio`
   - Command: `echo`
   - Args: `hello`
   - Leave enabled: true
   - Click Save.
6. Verify the entry appears in the list with the correct name and an enabled indicator.
7. Navigate to the test room's settings panel → "MCP Servers" section.
8. Verify `test-mcp-echo` appears in the room's MCP list with global-default enabled state.
9. Toggle the server off for the room, then toggle it back on.
10. Open the room chat (or check the session's tool availability via a visible indicator — e.g., the Tools Modal or a system message listing active MCP tools).
11. Verify `test-mcp-echo` tools are listed as active.
12. In `afterEach`, delete the test MCP entry via `hub.request('mcp.registry.delete', ...)` and delete the room.
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
