# Milestone 5 — UI Display

## Goal

Display short IDs in the web frontend for tasks and goals — in task cards, the room task list, and detail views — and provide a copy-to-clipboard helper that copies the short ID. Short IDs link to the correct URL routes.

## Context

The frontend is a Preact + Signals app. Key files:
- `packages/web/src/components/room/` — room-related components including task list, task card, goals editor
- `packages/web/src/lib/room-store.ts` — room data store, receives tasks and goals via RPC/live query
- Task and goal objects received from the API now include `shortId` (from Milestone 3)

After Milestone 3, the API returns `shortId` on task and goal objects. The UI just needs to display it and use it in URLs where appropriate.

URL pattern for tasks: `/room/{roomId}/task/{taskId}` — for navigation purposes, the short ID can be used in place of the UUID. When navigating with a short ID URL, the router (updated in Milestone 3) correctly matches it, and the RPC handler (also updated in Milestone 3) resolves it.

## Tasks

---

### Task 5.1 — Display Short IDs in Task Cards

**Description**: Update task card and task list components to show the short ID (`t-42`) prominently alongside or instead of the truncated UUID.

**Subtasks**:
1. Locate the task card component(s) in `packages/web/src/components/room/` (likely `TaskCard.tsx` or similar)
2. If `task.shortId` is present, display it as a small badge/label (e.g., `#t-42`) near the task title
3. Make the short ID clickable — clicking it copies `t-42` to the clipboard (use `navigator.clipboard.writeText`)
4. Add a tooltip on hover: "Click to copy short ID"
5. If `task.shortId` is absent (old task without short ID), fall back to showing the first 8 chars of the UUID (existing truncation behavior, or no badge)
6. Update the task detail URL navigation: when constructing `/room/{roomId}/task/{taskId}`, prefer `task.shortId` over `task.id` if available, so URLs are shorter in the address bar
7. Run `make test-web` to confirm no regressions

**Acceptance Criteria**:
- Tasks with `shortId` show a `#t-42` badge in the task card
- Clicking the badge copies the short ID to clipboard
- Task detail URL uses short ID when available (e.g., `/room/04062505.../task/t-42`)
- Tasks without `shortId` show no badge (graceful degradation)
- `make test-web` passes

**Depends on**: Milestone 3 complete (API returns `shortId`)

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 5.2 — Display Short IDs in Goals Editor

**Description**: Update `GoalsEditor.tsx` to show short IDs for goals similarly to Task 5.1 for tasks.

**Subtasks**:
1. Locate `packages/web/src/components/room/GoalsEditor.tsx`
2. In the goal list view, add a short ID badge (`#g-7`) near the goal title if `goal.shortId` is present
3. Make the badge copy the short ID to clipboard on click
4. Add graceful fallback for goals without `shortId`
5. Run `make test-web`

**Acceptance Criteria**:
- Goals with `shortId` display a `#g-7` badge
- Clicking the badge copies the short ID
- `make test-web` passes

**Depends on**: Task 5.1

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 5.3 — E2E Test: Short ID Display and Copy

**Description**: Add a Playwright e2e test that verifies short IDs appear in the UI and the copy-to-clipboard action works.

**Subtasks**:
1. Create `packages/e2e/tests/features/short-id-display.e2e.ts`
2. Test flow:
   a. Create a room and create a task via the UI
   b. Assert that a short ID badge (e.g., `#t-1`) appears in the task card
   c. Click the badge — verify the clipboard receives the short ID string (use `page.evaluate(() => navigator.clipboard.readText())`)
   d. Navigate to the task detail page via the short ID URL (e.g., `/room/{roomId}/task/t-1`) and assert the task title is visible
3. Follow E2E test rules: all actions through UI, no direct RPC in test actions, only cleanup via RPC in `afterEach`
4. Run the e2e test: `make run-e2e TEST=tests/features/short-id-display.e2e.ts`

**Acceptance Criteria**:
- Short ID badge appears in the task card after task creation
- Badge click copies the short ID to clipboard
- Navigating to `/room/{roomId}/task/t-1` loads the task detail page
- E2e test passes with `make run-e2e`

**Depends on**: Task 5.1, Task 5.2

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.
