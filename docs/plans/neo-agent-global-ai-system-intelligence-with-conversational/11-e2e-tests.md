# Milestone 11: E2E Tests

## Goal

Playwright end-to-end tests that verify the complete Neo user experience through the browser, from NavRail input through panel interactions, action flows, and settings.

## Tasks

### Task 11.1: Neo Panel Basic Flow E2E Tests

- **Description**: E2E tests for the core Neo panel interactions: opening, sending messages, receiving responses, and closing.
- **Agent type**: coder
- **Depends on**: Task 7.3, Task 8.1
- **Subtasks**:
  1. Create `packages/e2e/tests/features/neo-panel.e2e.ts`
  2. Implement test scenarios:
     - **NavRail input to panel**: Type in NavRail input, press Enter -> panel opens with message sent
     - **Keyboard shortcut**: Press Cmd+K -> NavRail input focuses
     - **Panel persistence**: Open panel, navigate to different section, panel stays open
     - **Panel close**: Click close button -> panel closes. Click outside -> panel closes
     - **Tab switching**: Click Activity tab -> shows activity feed. Click Chat tab -> shows chat
     - **Message rendering**: Send a query -> wait for response -> verify response appears in chat
     - **Clear session**: Open settings within panel or use clear button -> session clears
  3. Follow E2E test rules: all interactions through UI, assertions on visible DOM state
  4. Use `make run-e2e TEST=tests/features/neo-panel.e2e.ts` to verify
- **Acceptance criteria**:
  - All test scenarios pass in CI
  - Tests use only UI interactions (no direct RPC calls except cleanup)
  - Tests are stable and not flaky
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 11.2: Neo Action and Security Flow E2E Tests

- **Description**: E2E tests for Neo's action execution, confirmation workflows, and security modes.
- **Agent type**: coder
- **Depends on**: Task 11.1
- **Subtasks**:
  1. Create `packages/e2e/tests/features/neo-actions.e2e.ts`
  2. Implement test scenarios:
     - **Query flow**: Ask "what rooms do I have?" -> verify structured response with room list
     - **Action confirmation (balanced mode)**: Ask to delete a room -> confirmation card appears -> click Cancel -> room still exists in room list
     - **Action confirmation (balanced mode)**: Ask to delete a room -> confirmation card appears -> click Confirm -> room is removed
     - **Auto-execute (balanced mode)**: Ask to toggle a skill -> action executes immediately with success indicator
     - **Require-explicit (balanced mode)**: Ask to delete a room with active tasks -> `require_explicit` card appears with text input and required phrase -> type wrong phrase -> error -> type correct phrase -> room deleted
     - **Activity feed**: Perform several actions -> switch to Activity tab -> verify all actions are logged with correct status
  3. Create `packages/e2e/tests/features/neo-settings.e2e.ts`
  4. Implement settings test scenarios:
     - **Security mode change**: Navigate to settings -> change security mode -> verify persisted
     - **Model selector**: Open Neo settings -> change model -> verify saved
     - **Clear session**: Click clear session -> confirm -> verify chat history is empty
  5. Follow E2E test rules strictly
- **Acceptance criteria**:
  - Action confirmation flow works end-to-end through the UI
  - Security mode changes affect Neo's behavior
  - Activity feed accurately reflects performed actions
  - Settings changes persist across page navigation
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 11.3: Neo "via Neo" Indicator E2E Tests

- **Description**: E2E tests verifying that "via Neo" indicators appear correctly in room chats and task views.
- **Agent type**: coder
- **Depends on**: Task 9.1, Task 11.1
- **Subtasks**:
  1. Create `packages/e2e/tests/features/neo-indicators.e2e.ts`
  2. Implement test scenarios:
     - **Room message indicator**: Use Neo to send a message to a room -> navigate to that room -> hover over the message -> "via Neo" badge appears
     - **Task creation indicator**: Use Neo to create a task -> navigate to task detail -> verify Neo origin badge
  3. These tests may need setup (create room first) and careful sequencing
  4. Follow E2E test rules
- **Acceptance criteria**:
  - "via Neo" indicators appear on messages and tasks originated by Neo
  - Indicators are visible on hover (not always shown)
  - Tests pass in CI
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
