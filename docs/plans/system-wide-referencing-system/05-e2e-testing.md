# M5: E2E Testing

## Milestone Goal

Create comprehensive Playwright end-to-end tests covering all aspects of the @ reference system: autocomplete, selection, message sending, and reference rendering in messages. Includes dedicated E2E helpers for room/task/goal entity setup and teardown.

## Scope

- E2E helper functions for room/task/goal creation and cleanup
- Reference autocomplete appearance and interaction
- Keyboard navigation within autocomplete
- Reference selection (click and keyboard)
- Message sending with references
- Reference rendering in chat history
- Edge cases and error handling
- Mobile-specific testing

**Important E2E design decisions:**

- Room/task/goal creation in `beforeEach` uses the **infrastructure exemption** (RPC-based `room.create`, `task.create`, `goal.create` via `hub.request()`) — this is accepted for test isolation, consistent with the project's E2E rules for `room.create`/`room.delete`.
- All test actions and assertions go through the UI (clicks, typing, DOM verification) — no direct state access.
- Tests clean up all created entities in `afterEach`/`afterAll` to prevent pollution.

---

## Tasks

### Task 5.1: Create E2E Helpers for Room Entity Management

**Description:** Create reusable E2E helper functions for setting up and tearing down rooms, tasks, and goals needed by reference E2E tests.

**Subtasks:**
1. Create `packages/e2e/tests/helpers/room-helpers.ts`:
   - `createRoomWithTask(page, taskTitle, taskDesc)` — Creates a room via RPC (infrastructure exemption), creates a task via RPC, returns `{ roomId, taskId }`
   - `createRoomWithGoal(page, goalTitle, goalDesc)` — Creates a room, creates a goal via RPC, returns `{ roomId, goalId }`
   - `createRoomWithTaskAndGoal(page, taskTitle, goalDesc, goalTitle)` — Creates both, returns all IDs
   - `createTestFile(page, filePath, content)` — Creates a test file in the workspace
   - `deleteTestFile(page, filePath)` — Removes test file from workspace
   - `cleanupRoom(page, roomId)` — Deletes room and associated entities via RPC
   - `cleanupAllCreatedEntities(page, entities)` — Bulk cleanup helper
2. Create `packages/e2e/tests/helpers/reference-helpers.ts`:
   - `waitForReferenceAutocomplete(page)` — Wait for autocomplete dropdown to appear
   - `getReferenceAutocompleteItems(page)` — Get all items in the autocomplete dropdown
   - `selectReferenceByIndex(page, index)` — Navigate to and select reference by keyboard
   - `selectReferenceByClick(page, searchText)` — Click on a specific reference in the dropdown
   - `waitForMentionToken(page, refId)` — Wait for a mention token to appear in a message
   - `getMentionTokenText(page, refId)` — Get display text of a mention token
   - `hoverMentionToken(page, refId)` — Hover over a mention token
   - `typeInChatInput(page, text)` — Type text in the chat input field

**Acceptance Criteria:**
- All helper functions are exported and documented
- Room/task/goal creation uses RPC (infrastructure exemption)
- Cleanup functions remove all created entities
- No test pollution between runs
- Helper functions follow existing E2E helper patterns in the project

**Depends on:** None (can start in parallel with M2-M4)

**Agent Type:** coder

---

### Task 5.2: Basic Autocomplete E2E Tests

**Description:** Create E2E tests for basic reference autocomplete functionality.

**Subtasks:**
1. Create `packages/e2e/tests/features/reference-autocomplete.e2e.ts`:
   - Test: Shows autocomplete when typing @
   - Test: Shows grouped results by type (Tasks, Goals, Files, Folders)
   - Test: Filters results as user types after @
   - Test: Hides autocomplete when Escape is pressed
   - Test: Hides autocomplete when input is cleared
   - Test: Hides autocomplete for non-@ input
   - Test: Works in middle of text (not just start)
   - Test: Only one menu visible at a time (close slash menu when @ typed, and vice versa)
2. Use `reference-helpers.ts` for all interactions
3. Use `room-helpers.ts` to set up a room with task/goal for meaningful search results

**Acceptance Criteria:**
- All autocomplete tests pass
- Tests follow E2E principles (UI-only, no direct state access)
- Tests are reliable and not flaky
- Tests clean up resources via `afterEach`/`afterAll`

**Depends on:** Task 2.4, Task 2.5, Task 5.1

**Agent Type:** coder

---

### Task 5.3: Entity Resolution and Message Rendering E2E Tests

**Description:** Create E2E tests for reference resolution and message rendering.

**Subtasks:**
1. Add tests to `reference-autocomplete.e2e.ts`:
   - Test: Selecting a task reference inserts `@ref{task:t-XX}` in input
   - Test: Selecting a goal reference inserts `@ref{goal:g-XX}` in input
   - Test: Selecting a file reference inserts `@ref{file:path}` in input
   - Test: Message with references sends successfully
   - Test: Reference renders as styled token in sent message (verify pill styling, type color)
   - Test: Hover on token shows entity details (title, status)
   - Test: Multiple references in a single message all resolve correctly
2. Test entity-specific scenarios:
   - Create a task via RPC helper, reference it, verify token shows task info
   - Create a goal via RPC helper, reference it, verify token shows goal info
   - Create a test file, reference it, verify token shows file info
3. Test standalone session (no room):
   - In a standalone session, typing @ shows only file/folder results
   - File reference works normally
   - No task/goal results appear

**Acceptance Criteria:**
- All resolution tests pass
- Tokens render with correct type-specific styling
- Hover shows entity details
- Standalone sessions show only file/folder results
- Tests handle entity creation and cleanup via helpers
- No test pollution between runs

**Depends on:** Task 3.4, Task 4.2, Task 5.1

**Agent Type:** coder

---

### Task 5.4: Edge Cases and Error Handling E2E Tests

**Description:** Create E2E tests for edge cases and error scenarios.

**Subtasks:**
1. Add edge case tests to `reference-autocomplete.e2e.ts`:
   - Test: Reference a deleted task — token shows "deleted" state after task is deleted
   - Test: Reference a moved file — token shows "not found" state
   - Test: Rapid typing doesn't cause duplicate autocomplete requests (verify menu updates correctly)
   - Test: Many references in single message (5+) — all render correctly
   - Test: Copy/paste `@ref{type:id}` text from another message — renders as token in new context
   - Test: Reference combined with slash command (e.g., `/agent @task-t-42 fix the bug`)
   - Test: Empty search results (query that matches nothing)
2. Mobile-specific tests:
   - Test: Works on mobile viewport (use Playwright device emulation)
   - Test: Touch selection works (tap to select reference)
   - Test: Menu positioning on small screens (above input, not hidden by keyboard)
3. Accessibility tests (simplified — no screen reader):
   - Test: Keyboard-only navigation works (Tab, arrow keys, Enter, Escape)
   - Test: ARIA labels are present on mention tokens (verify via `page.getByRole`)
   - Test: Focus management works correctly

**Acceptance Criteria:**
- All edge case tests pass
- Tests cover error states gracefully
- Mobile tests verify touch interactions
- Accessibility tests verify ARIA support
- No flaky tests due to timing issues

**Depends on:** Task 5.2, Task 5.3

**Agent Type:** coder

---

## Notes

- E2E tests must follow the project's E2E principles (UI-only, no direct state access for actions/assertions)
- Room/task/goal creation in `beforeEach` uses RPC infrastructure exemption (consistent with project rules)
- Clean up entities in `afterEach`/`afterAll` hooks via cleanup helpers
- Use the existing slash command E2E tests as reference patterns
- Screen reader testing is simplified to ARIA label verification (Playwright's accessibility support is limited for screen reader announcements)
- Mobile tests use Playwright's device emulation (not real devices)
- Consider adding visual regression tests for token styling as a stretch goal
