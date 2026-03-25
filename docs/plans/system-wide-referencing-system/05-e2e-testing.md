# M5: E2E Testing

## Milestone Goal

Create comprehensive Playwright end-to-end tests covering all aspects of the @ reference system: autocomplete, selection, message sending, and reference rendering in messages.

## Scope

- Reference autocomplete appearance and interaction
- Keyboard navigation within autocomplete
- Reference selection (click and keyboard)
- Message sending with references
- Reference rendering in chat history
- Edge cases and error handling

---

## Tasks

### Task 5.1: Basic Autocomplete E2E Tests

**Description:** Create E2E tests for basic reference autocomplete functionality.

**Subtasks:**
1. Create `packages/e2e/tests/helpers/reference-helpers.ts`:
   - `waitForReferenceAutoload(page)` - Wait for reference data to be available
   - `typeInInputWithReference(page, text)` - Type in input, possibly triggering @
   - `getReferenceAutocomplete(page)` - Get autocomplete dropdown
   - `selectReferenceByIndex(page, index)` - Select reference by keyboard
   - `selectReferenceByClick(page, searchText)` - Select reference by clicking
2. Create `packages/e2e/tests/features/reference-autocomplete.e2e.ts`:
   - Test: Shows autocomplete when typing @
   - Test: Shows grouped results by type (Tasks, Goals, Files, Folders)
   - Test: Filters results as user types
   - Test: Hides autocomplete when input cleared
   - Test: Hides autocomplete for non-@ input
   - Test: Works in middle of text (not just start)

**Acceptance Criteria:**
- All autocomplete tests pass
- Tests follow E2E principles (UI-only, no direct state access)
- Tests are reliable and not flaky
- Tests clean up resources

**Depends on:** Task 2.4, Task 2.5

**Agent Type:** coder

---

### Task 5.2: Entity Resolution E2E Tests

**Description:** Create E2E tests for reference resolution and agent context injection.

**Subtasks:**
1. Add tests to `reference-autocomplete.e2e.ts`:
   - Test: Task reference resolves to task data
   - Test: Goal reference resolves to goal data
   - Test: File reference resolves to file content
   - Test: Folder reference resolves to folder listing
   - Test: Multiple references resolve correctly
   - Test: Message with references sends successfully
   - Test: Reference renders as styled token in sent message
   - Test: Hover on token shows entity details
2. Test entity-specific scenarios:
   - Create a task via UI, reference it, verify resolution
   - Create a goal via UI, reference it, verify resolution
   - Upload/create a file, reference it, verify content

**Acceptance Criteria:**
- All resolution tests pass
- Tests verify agent receives correct context (via assistant response)
- Tests handle entity creation and cleanup
- No test pollution between runs

**Depends on:** Task 3.4, Task 4.2, Task 5.1

**Agent Type:** coder

---

### Task 5.3: Edge Cases and Error Handling E2E Tests

**Description:** Create E2E tests for edge cases and error scenarios.

**Subtasks:**
1. Add edge case tests to `reference-autocomplete.e2e.ts`:
   - Test: Reference deleted entity (shows "deleted" state)
   - Test: Reference moved file (shows "not found" state)
   - Test: Rapid typing doesn't cause duplicate requests
   - Test: Large file reference truncates content
   - Test: Many references in single message
   - Test: Copy/paste reference from another message
   - Test: Reference in combination with slash command
2. Mobile-specific tests:
   - Test: Works on mobile viewport
   - Test: Touch selection works
   - Test: Menu positioning on small screens
3. Accessibility tests:
   - Test: Keyboard-only navigation works
   - Test: Screen reader announces reference type

**Acceptance Criteria:**
- All edge case tests pass
- Tests cover error states gracefully
- Mobile tests verify touch interactions
- Accessibility tests verify keyboard/screen reader support

**Depends on:** Task 5.1, Task 5.2

**Agent Type:** coder

---

## Notes

- E2E tests must follow the project's E2E principles (UI-only, no direct state access)
- Tests should create their own entities (tasks, goals) for isolation
- Clean up entities in afterEach/afterAll hooks
- Use the existing slash command E2E tests as reference patterns
- Consider adding visual regression tests for token styling
- Mobile tests can use Playwright's device emulation
