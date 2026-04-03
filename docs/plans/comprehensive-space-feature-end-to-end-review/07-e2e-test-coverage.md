# Milestone 7: E2E Test Coverage Expansion

## Goal

Add Playwright E2E tests covering the gaps identified in milestones 1-6. These tests validate the fixed and new behavior through the browser UI.

## Scope

All 12 happy paths, focusing on the gaps not covered by existing 17 E2E test files.

## Tasks

### Task 7.1: E2E test for space creation with agent and workflow verification

**Description:** Extend the existing `space-creation.e2e.ts` to verify that after creating a space, the configure page shows all 6 preset agents and all built-in workflows.

**Subtasks:**
1. Read `packages/e2e/tests/features/space-creation.e2e.ts` for the existing creation test.
2. Read `packages/e2e/tests/helpers/wait-helpers.ts` for available helper functions.
3. Add a test case that: creates a space via the UI dialog, navigates to the configure page, verifies all 6 preset agent names are visible (Coder, General, Planner, Research, Reviewer, QA), verifies built-in workflows are listed.
4. Clean up the space in afterEach via RPC.
5. Run `make run-e2e TEST=tests/features/space-creation.e2e.ts` to verify.

**Acceptance Criteria:**
- E2E test verifies all preset agents and workflows are visible after space creation.
- Test follows existing E2E patterns (UI-only actions, DOM assertions).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.3, Task 1.4

**Agent type:** coder

### Task 7.2: E2E test for blocked task display and manual status control

**Description:** Add an E2E test that creates a task, sets it to blocked status (via RPC in setup), and verifies: blocked reason is visible on the dashboard, blocked reason is visible in the task pane, user can change status back to in_progress via the UI.

**Subtasks:**
1. Read existing space E2E tests for setup patterns (RPC-based task creation in beforeEach).
2. Create `packages/e2e/tests/features/space-task-status-control.e2e.ts`.
3. Test scenario 1: Create space + task via RPC, set task to blocked with a reason, navigate to dashboard, verify blocked indicator and reason text visible.
4. Test scenario 2: Open blocked task, verify blocked reason banner in task pane, click "Resume" button, verify status changes to in_progress.
5. Test scenario 3: Open done task, verify "Reopen" action is available, click it, verify task returns to in_progress.
6. Clean up in afterEach.
7. Run `make run-e2e TEST=tests/features/space-task-status-control.e2e.ts` to verify.

**Acceptance Criteria:**
- E2E tests verify blocked reason display and manual status transitions.
- Tests follow E2E rules (UI actions, DOM assertions, RPC only in setup/cleanup).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 2.2, Task 2.3

**Agent type:** coder

### Task 7.3: E2E test for canvas mode toggle and workflow visualization

**Description:** Add an E2E test that verifies the canvas mode toggle works from the task view: button appears for workflow tasks, clicking toggles to canvas view, canvas shows workflow nodes, clicking a node opens overlay.

**Subtasks:**
1. Read existing `space-happy-path-pipeline.e2e.ts` for how workflow runs are set up.
2. Create `packages/e2e/tests/features/space-canvas-mode.e2e.ts`.
3. Set up a space with a workflow run via RPC in beforeEach.
4. **Stability guidance:** Before interacting with new UI elements, wait for their presence: `await page.waitForSelector('[data-testid="canvas-toggle"]')`. This prevents flaky tests when the toggle renders asynchronously.
5. Test scenario: Navigate to a workflow task, verify canvas toggle button is visible (`[data-testid="canvas-toggle"]`), click toggle, verify canvas view renders (`[data-testid="canvas-view"]`) with workflow nodes, verify at least the start node is visible.
6. If overlay chat is implemented (Task 4.2), test clicking a node opens the overlay (`[data-testid="agent-overlay-chat"]`).
7. Clean up in afterEach.
8. Run `make run-e2e TEST=tests/features/space-canvas-mode.e2e.ts` to verify.

**Acceptance Criteria:**
- E2E test verifies canvas mode toggle and workflow node rendering.
- Test uses `data-testid` selectors for new UI elements and waits for stable rendering before assertions.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 5.1, Task 5.3

**Agent type:** coder

### Task 7.4: E2E test for artifacts panel

**Description:** Add an E2E test that verifies the artifacts side panel opens and shows changed files for a workflow task.

**Subtasks:**
1. Create `packages/e2e/tests/features/space-artifacts-panel.e2e.ts`.
2. Set up a space with a completed workflow run that has gate data with file changes (via RPC).
3. **Stability guidance:** Wait for `[data-testid="artifacts-toggle"]` before clicking. Wait for `[data-testid="artifacts-panel"]` before asserting panel contents.
4. Test scenario: Navigate to the workflow task, click "Artifacts" button (`[data-testid="artifacts-toggle"]`), verify the side panel opens (`[data-testid="artifacts-panel"]`), verify file names are listed, verify +/- line counts are shown.
5. If the diff viewer works, click a file and verify the diff renders.
6. Clean up in afterEach.
7. Run `make run-e2e TEST=tests/features/space-artifacts-panel.e2e.ts` to verify.

**Acceptance Criteria:**
- E2E test verifies artifacts panel shows file changes.
- Test uses `data-testid` selectors for new UI elements and waits for stable rendering before assertions.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 5.2

**Agent type:** coder

### Task 7.5: E2E test for user interaction in task thread

**Description:** Add an E2E test that verifies users can send messages in the task thread and responses appear.

**Subtasks:**
1. Read existing `space-agent-chat.e2e.ts` for messaging test patterns.
2. Create `packages/e2e/tests/features/space-task-messaging.e2e.ts`.
3. Set up a space with a task that has a task agent session (via RPC setup + ensure session).
4. Test scenario 1: Navigate to task, type a message in the composer, send it, verify message appears in the thread.
5. Test scenario 2 (required): Type `@` in the composer, verify autocomplete dropdown appears with agent names, select one, verify name is inserted into the message.
6. Clean up in afterEach.
7. Run `make run-e2e TEST=tests/features/space-task-messaging.e2e.ts` to verify.

**Acceptance Criteria:**
- E2E test verifies user can send messages in task thread.
- Message appears in the unified thread after sending.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 6.1

**Agent type:** coder

### Task 7.6: E2E test for agent overlay chat

**Description:** Add an E2E test that verifies clicking an agent name opens an overlay chat panel instead of navigating away.

**Subtasks:**
1. Create `packages/e2e/tests/features/space-agent-overlay.e2e.ts`.
2. Set up a space with a task that has agent sessions (via RPC).
3. Test scenario: Navigate to task view, click an agent name/session link, verify overlay panel opens (not full-page navigation), verify task view is still visible underneath, click close button, verify overlay closes.
4. Clean up in afterEach.
5. Run `make run-e2e TEST=tests/features/space-agent-overlay.e2e.ts` to verify.

**Acceptance Criteria:**
- E2E test verifies overlay chat opens and closes correctly.
- Task view remains accessible while overlay is open.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.2

**Agent type:** coder
