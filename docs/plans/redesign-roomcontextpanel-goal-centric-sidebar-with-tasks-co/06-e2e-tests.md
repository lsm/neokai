# Milestone 6: E2E Tests

## Goal

Add Playwright E2E tests that verify URL-addressable navigation survives page refresh, and that the sidebar's interactive features (goal expand/collapse, task tab filtering) work correctly through the browser.

## Tasks

### Task 6.1: E2E Test for Room Sidebar URL Navigation

**Description:** Write a Playwright E2E test that verifies all room sidebar navigation targets produce correct URLs and survive page refresh.

**Agent type:** coder

**Depends on:** Task 4.1 (Room.tsx integration)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/room-sidebar-navigation.e2e.ts`:
   - Use the existing E2E helpers to create a room via RPC in `beforeEach` (infrastructure pattern) and delete in `afterEach`.
   - Create goals and tasks via RPC setup (infrastructure). **Call sequence:**
     1. `hub.request('task.create', { roomId, title, description })` — create tasks first
     2. `hub.request('goal.create', { roomId, title })` — create goals (note: `goal.create` does NOT accept `linkedTaskIds`)
     3. `hub.request('goal.linkTask', { roomId, goalId, taskId })` — link tasks to goals after creation
   - Also create at least one orphan task (not linked to any goal) for the Tasks section tests.
   - **Test: Dashboard URL persistence** - Navigate to the room, verify URL is `/room/<id>`, reload page, verify Dashboard view is shown.
   - **Test: Room Agent URL persistence** - Click Room Agent in sidebar, verify URL changes to `/room/<id>/agent`, reload page, verify Room Agent chat is shown and Room Agent sidebar item is highlighted.
   - **Test: Task URL persistence** - Click a task in the sidebar (either under a goal or in orphan tasks), verify URL changes to `/room/<id>/task/<taskId>`, reload page, verify TaskView is shown.
   - **Test: Session URL persistence** - Create a session, click it in sidebar, verify URL changes to `/room/<id>/session/<sessionId>`, reload page, verify session chat is shown.
   - All assertions must verify visible DOM state (text content, element visibility).
3. Run `make run-e2e TEST=tests/features/room-sidebar-navigation.e2e.ts` to verify.

**Acceptance criteria:**
- All four URL persistence tests pass.
- Tests only use UI interactions for navigation (clicks, not direct signal manipulation).
- Tests verify DOM state, not internal signals.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 6.2: E2E Test for Goal Expand/Collapse and Task Tab Filtering

**Description:** Write a Playwright E2E test that verifies sidebar interactive features: goal expand/collapse toggles and task tab filtering.

**Agent type:** coder

**Depends on:** Task 4.1 (Room.tsx integration)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/room-sidebar-sections.e2e.ts`:
   - Set up room with goals, linked tasks, and orphan tasks in various statuses via RPC (infrastructure). Use the same call sequence as Task 6.1: `task.create` → `goal.create` → `goal.linkTask`. Create orphan tasks with various statuses (`in_progress`, `review`, `completed`) to test tab filtering.
   - **Test: Goals section expand/collapse** - Verify goals section is visible, click a goal to expand it, verify linked tasks are visible. Click again to collapse, verify tasks are hidden.
   - **Test: Tasks tab filtering** - Verify the Tasks section shows the Active tab by default. Click Review tab, verify only review-status tasks are shown. Click Done tab, verify only completed/cancelled tasks are shown.
   - **Test: Sessions section collapsible** - Verify the Sessions section is collapsed by default. Click to expand, verify sessions are visible. Verify the [+] button in the header is visible.
   - **Test: Goals section shows correct count** - Verify the Goals section header shows the correct number of active goals.
3. Run `make run-e2e TEST=tests/features/room-sidebar-sections.e2e.ts` to verify.

**Acceptance criteria:**
- All interactive feature tests pass.
- Tests use only UI interactions (clicking section headers, tab buttons).
- Tests verify visible DOM state.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
