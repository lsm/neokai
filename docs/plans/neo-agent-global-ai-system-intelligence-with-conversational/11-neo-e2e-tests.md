# Milestone 11: Neo E2E Tests

## Goal

Playwright end-to-end tests covering the full Neo user experience: NavRail input, panel interaction, query/action flows, security tier behavior, activity feed, and undo.

## Scope

- Browser-based tests simulating real user interactions with Neo
- All tests go through the UI (no direct API calls in test actions/assertions)
- Follow existing E2E test patterns from `packages/e2e/`

## Tasks

### Task 11.1: Neo Panel Basic E2E Tests

**Description**: Test the core Neo panel interaction flow.

**Subtasks**:
1. Create `packages/e2e/tests/features/neo-panel.e2e.ts`
2. Test: NavRail input visible and focusable
3. Test: Typing in NavRail input and pressing Enter opens the Neo panel
4. Test: Neo panel displays with Chat tab active
5. Test: Can switch between Chat and Activity tabs
6. Test: Close button dismisses the panel
7. Test: Click outside dismisses the panel
8. Test: Panel state persists across page navigation (localStorage)
9. Test: Cmd+K keyboard shortcut focuses the NavRail input

**Acceptance Criteria**:
- All panel interaction tests pass
- Tests follow E2E rules (UI-only actions and assertions)
- Tests are reliable and not flaky

**Dependencies**: Task 7.2, Task 7.3

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 11.2: Neo Query and Action Flow E2E Tests

**Description**: Test full conversational flows through the Neo UI.

**Subtasks**:
1. Create `packages/e2e/tests/features/neo-conversation.e2e.ts`
2. Test query flow: type "what rooms do I have?" -> verify structured response appears in chat
3. Test action flow: type "enable skill X" -> verify confirmation or auto-execute -> verify result message
4. Test security flow (conservative mode): change security mode in settings -> perform action -> verify confirmation required -> cancel -> verify no change
5. Test activity feed: perform several actions -> switch to Activity tab -> verify entries listed with timestamps
6. Test clear session: open settings -> clear session -> verify chat history cleared
7. Test undo flow: perform undoable action -> type "undo" -> verify action reversed
8. Setup: create test rooms/skills/goals via `beforeEach` infrastructure RPC calls

**Acceptance Criteria**:
- Query flows show correct responses
- Action flows handle confirmation correctly
- Security mode switching works through settings UI
- Activity feed shows all actions
- Undo works through conversation
- All tests pass with `make run-e2e`

**Dependencies**: Tasks 7.1-7.3, Task 8.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 11.3: Neo Settings E2E Tests

**Description**: Test Neo settings configuration through the UI.

**Subtasks**:
1. Create `packages/e2e/tests/features/neo-settings.e2e.ts`
2. Test: Navigate to Settings -> Neo section is visible
3. Test: Security mode selector changes and persists across page reload
4. Test: Model selector shows available models and persists selection
5. Test: Clear session button shows confirmation dialog
6. Test: Confirming clear session resets the Neo chat
7. Test: Canceling clear session preserves the chat

**Acceptance Criteria**:
- All settings interactions work through the UI
- Settings persist across page reloads
- Clear session flow works correctly
- Tests follow E2E rules

**Dependencies**: Task 8.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
