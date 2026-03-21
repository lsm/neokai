# Fix E2E Test Failures on Dev Branch CI

## Goal

Fix four failing E2E test suites on the `dev` branch CI (run ID `23382023181`):

1. `features-task-actions-dropdown` -- 9/10 tests fail
2. `features-space-creation` -- 1/7 tests fail
3. `features-visual-workflow-editor` -- 6/6 tests fail
4. `features-worktree-isolation` -- 1/5 tests fail (LLM test)

## Approach

The failures group into four root causes. Each task below addresses one root cause. All PRs target `dev`.

---

## Task 1: Fix task-actions-dropdown E2E tests -- update selectors to match actual UI

**Type:** coder

**Description:**
The `task-actions-dropdown.e2e.ts` tests were written expecting a three-dot dropdown menu with `data-testid="task-options-menu"`, but the actual `TaskView.tsx` uses inline action buttons:
- `data-testid="task-cancel-button"` (Cancel button, visible for pending/in_progress/review tasks)
- `data-testid="task-complete-button"` (Complete button, visible for in_progress tasks, hidden for review)

Additionally, some tests transition tasks to `in_progress` which triggers worktree creation. In CI, the workspace is a temp directory (not a git repo), so worktree creation fails with "Worktree creation failed -- task requires isolation". The tests that need `in_progress` status should use `task.setStatus` RPC directly (which is already done in the test helper `createRoomAndTask`), and the test assertions should not depend on a worktree-spawned session.

**Key files:**
- `packages/e2e/tests/features/task-actions-dropdown.e2e.ts` -- the failing test file
- `packages/web/src/components/room/TaskView.tsx` -- the actual UI (lines ~938-968 for action buttons, lines ~500-630 for confirmation modals)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read the current TaskView.tsx to understand the actual UI pattern (inline buttons, not dropdown menu).
3. Rewrite tests that check for `task-options-menu` to instead use `task-cancel-button` and `task-complete-button`:
   - "shows task options menu for pending task (cancel only)" -- assert `task-cancel-button` is visible, `task-complete-button` is not visible.
   - "shows task options menu for in_progress task (complete + cancel)" -- assert both buttons visible.
   - "does NOT show task options menu for completed task" -- this test already passes; keep as-is.
   - "opens dropdown and shows Cancel Task item" -- replace dropdown menu interaction with direct click on `task-cancel-button`.
   - "shows Mark as Complete for in_progress task" -- replace dropdown interaction with asserting `task-complete-button` visible.
   - "opens cancel confirmation dialog on Cancel Task click" -- click `task-cancel-button` directly instead of opening dropdown.
   - "opens complete confirmation dialog on Mark as Complete click" -- click `task-complete-button` directly.
   - "can dismiss cancel dialog with Keep Task button" -- click `task-cancel-button` directly, rest stays same.
   - "cancels task and navigates away on confirmation" -- click `task-cancel-button` directly, confirm, check navigation.
   - "completes task and navigates away on confirmation" -- click `task-complete-button` directly, confirm, check navigation.
4. For tests that wait for task status to appear in the UI after creating a task with `in_progress` status: ensure the test navigates to the task page AFTER the status transition is complete (the helper already does this via RPC `task.setStatus`). The page should render the correct buttons based on the task's current status from the database, not from a live worktree session.
5. Run the test locally: `make run-e2e TEST=tests/features/task-actions-dropdown.e2e.ts`.
6. Verify all tests pass.

**Acceptance Criteria:**
- All 10 tests in `task-actions-dropdown.e2e.ts` pass locally.
- Tests use the actual UI selectors (`task-cancel-button`, `task-complete-button`, `cancel-task-confirm`, `complete-task-confirm`).
- No tests rely on `data-testid="task-options-menu"` (which does not exist).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None

---

## Task 2: Fix space-creation E2E test -- update assertion to match actual space layout

**Type:** coder

**Description:**
The test "creates space and shows 3-column layout" in `space-creation.e2e.ts` (line 122) expects to see `SpaceNavPanel` content ("No runs or tasks yet") after space creation. However, `SpaceNavPanel` is not used in the actual `SpaceIsland` component. The space view uses a tabbed layout (Dashboard, Agents, Workflows, Settings) without a left nav panel showing runs/tasks.

After creating a space, the user is navigated to `/space/<id>` where `SpaceIsland` renders with the Dashboard tab active, showing the `SpaceDashboard` component which has "Quick Actions", "Start Workflow Run", and "Create Task" text.

**Key files:**
- `packages/e2e/tests/features/space-creation.e2e.ts` -- the failing test (line 122-159)
- `packages/web/src/islands/SpaceIsland.tsx` -- actual space view component (tabbed layout)
- `packages/web/src/components/space/SpaceDashboard.tsx` -- Dashboard tab content
- `packages/web/src/components/space/SpaceNavPanel.tsx` -- unused component (not imported by SpaceIsland)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read SpaceIsland.tsx and SpaceDashboard.tsx to understand what is actually rendered when a space is loaded.
3. Update the test assertions in "creates space and shows 3-column layout" to match the actual UI:
   - Remove assertion for "No runs or tasks yet" (from SpaceNavPanel, not rendered).
   - Keep or adjust assertions for "Quick Actions", "Start Workflow Run", "Create Task" -- these are in SpaceDashboard and should be visible on the Dashboard tab.
   - Consider renaming the test to reflect the actual layout (tabbed, not 3-column).
4. Run the test locally: `make run-e2e TEST=tests/features/space-creation.e2e.ts`.
5. Verify all tests pass.

**Acceptance Criteria:**
- All tests in `space-creation.e2e.ts` pass locally.
- Test assertions match the actual space layout (tabbed view with Dashboard).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None

---

## Task 3: Fix visual-workflow-editor E2E tests -- diagnose and fix SpaceIsland loading issues

**Type:** coder

**Description:**
All 6 tests in `visual-workflow-editor.e2e.ts` fail. The primary failure is a 60-second timeout waiting for `text=Workflows` to appear on the page after navigating to `/space/<id>`. This means the `SpaceIsland` component is not rendering its tab bar. One test also fails with "No agents found in space" when calling `spaceAgent.list` via RPC.

The test creates a space via RPC in `beforeEach` using the server's workspace root (a temp directory), then navigates to it. The SpaceIsland component calls `spaceStore.selectSpace(spaceId)` on mount, which calls `space.overview` RPC. If this fails or the store gets stuck in loading state, the tabs won't render.

Potential causes to investigate:
- The `space.overview` RPC may be failing for the newly created space (check if the handler returns the space correctly)
- The `spaceStore` loading state may not resolve properly
- The test's `navigateToSpace` function navigates directly to the URL but may not wait for the WebSocket to reconnect or the store to load
- The "No agents found" error may indicate that `seedPresetAgents` is silently failing during space creation on non-git workspaces

**Key files:**
- `packages/e2e/tests/features/visual-workflow-editor.e2e.ts` -- failing tests
- `packages/web/src/islands/SpaceIsland.tsx` -- space view component
- `packages/web/src/lib/space-store.ts` -- space store with `selectSpace`/`doSelect`/`startSubscriptions`
- `packages/daemon/src/lib/rpc-handlers/space-handlers.ts` -- `space.overview` RPC handler
- `packages/daemon/src/lib/space/agents/seed-agents.ts` -- agent seeding on space creation
- `packages/daemon/src/lib/rpc-handlers/space-agent-handlers.ts` -- `spaceAgent.list` RPC handler

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Run the visual-workflow-editor test locally to reproduce the failure: `make run-e2e TEST=tests/features/visual-workflow-editor.e2e.ts`.
3. Investigate whether the `space.overview` RPC returns the space data correctly for a newly created space. Check the handler in `space-handlers.ts`.
4. Investigate whether `seedPresetAgents` succeeds for spaces created on non-git workspaces. Check if there's a git requirement in the agent creation path.
5. If the issue is that `SpaceIsland` gets stuck in loading state, add appropriate waits in the test (e.g., wait for the Dashboard tab to appear before clicking Workflows).
6. If the issue is that `navigateToSpace` in the test doesn't properly wait for the space to load, add a wait for a space-specific element to appear before proceeding.
7. If the "No agents found" is a real bug (agents not being seeded), fix the seeding or add a fallback in the test to create agents via RPC.
8. Run the test locally and verify all 6 tests pass.

**Acceptance Criteria:**
- All 6 tests in `visual-workflow-editor.e2e.ts` pass locally.
- Root cause is identified and fixed (either in the source code or the test, depending on where the bug is).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None

---

## Task 4: Fix worktree-isolation E2E test -- session deletion should navigate away

**Type:** coder

**Description:**
The test "should cleanup worktree when session is deleted" in `worktree-isolation.e2e.ts` (line 84) fails because after deleting a session, the URL still contains the deleted session ID. The test expects that after clicking "Delete Chat" and confirming, the browser navigates away from the deleted session's URL.

The test flow:
1. Creates a session, sends a message, waits for response
2. Opens session options, clicks "Delete Chat", confirms deletion
3. Waits 2 seconds
4. Asserts `url` does not contain the deleted session ID -- THIS FAILS

The issue is that the UI doesn't navigate away from a deleted session's URL. The session deletion RPC succeeds, but the client-side routing doesn't redirect to another page.

**Key files:**
- `packages/e2e/tests/features/worktree-isolation.e2e.ts` -- failing test (line 84-121)
- `packages/web/src/components/SessionList.tsx` or similar -- session deletion UI handler
- `packages/web/src/lib/router.ts` -- routing logic
- `packages/web/src/lib/session-store.ts` or `packages/web/src/hooks/useSessionActions.ts` -- session deletion logic

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Find the session deletion handler in the web code (search for "Delete Chat", "session.delete", or "confirm-delete-session").
3. Check if the deletion handler navigates away from the deleted session's URL after successful deletion.
4. If the handler does not navigate away, add navigation to the home page (or the next available session) after successful deletion.
5. If the handler already navigates away but has a race condition or timing issue, fix the timing (e.g., navigate synchronously after the delete RPC resolves).
6. Alternatively, if the navigation works correctly and the test is simply not waiting long enough, update the test to use a proper Playwright wait (e.g., `await expect(page).not.toHaveURL(...)` with a timeout instead of `waitForTimeout(2000)`).
7. Run the test locally: `make run-e2e TEST=tests/features/worktree-isolation.e2e.ts`. Note: this is an LLM test, so it requires the devproxy or real API credentials.
8. Verify the test passes.

**Acceptance Criteria:**
- The "should cleanup worktree when session is deleted" test passes.
- After session deletion, the URL no longer contains the deleted session's ID.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None
