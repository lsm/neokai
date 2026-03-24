# Milestone 7: E2E Tests

## Milestone Goal

Validate the full user-facing flow end-to-end with Playwright: add an application-level MCP server via the settings UI, enable it in a room, and verify the tools are available to the room agent in a session.

## Scope

E2E package only. All production code is in place from prior milestones.

---

## Task 7.1: E2E Test — MCP Registry UI and Per-Room Enable/Disable

**Agent type:** coder

**Description:**
Write a Playwright E2E test that exercises the registry UI and per-room MCP toggle flow using the pre-seeded `fetch-mcp` entry (seeded on daemon startup by Task 6.2). The test does NOT add a new MCP via the UI — it relies on `fetch-mcp` being present from startup. This avoids the need for a valid MCP command at test time and keeps the test self-contained.

**Why not add via UI:** Registering a new MCP server from the UI requires a real, running MCP process to validate. Using the pre-seeded `fetch-mcp` (which is already validated on startup) is the simplest and most reliable E2E test strategy for this iteration.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/app-mcp-registry.e2e.ts`.
3. In `beforeEach`, create a test room via `hub.request('room.create', ...)`.
4. Navigate to Global Settings → "Application MCP Servers" section.
5. Verify the `fetch-mcp` entry appears in the list with an enabled indicator (seeded on daemon startup).
6. Navigate to the test room's settings panel → "MCP Servers" section.
7. Verify `fetch-mcp` appears in the room's MCP list with the global-default enabled state.
8. Toggle the server off for the room — verify the toggle state updates in the UI.
9. Toggle the server back on — verify the toggle state reverts.
10. Open the room chat; once a session is running, check the Tools Modal (or equivalent visible tool list) and verify `fetch-mcp` tools are listed as active.
11. In `afterEach`, delete the test room via `hub.request('room.delete', ...)`. Do **not** delete `fetch-mcp` from the registry — it is a permanent seed entry.
12. Ensure the test follows E2E rules: all assertions on visible DOM state; `hub.request` calls only in `beforeEach`/`afterEach` infrastructure.

**Acceptance criteria:**
- Test verifies `fetch-mcp` appears in the global registry settings UI.
- Test verifies per-room enable/disable toggles work and persist in the room settings UI.
- Test verifies `fetch-mcp` tools appear in the room session's active tool list after enabling.
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
