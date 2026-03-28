# Milestone 10: Unit and Online Tests

## Goal

Edge-case, integration, and online test coverage that extends the per-milestone happy-path tests. **Test boundary**: Milestones 2-5 each include unit tests covering happy paths and basic error cases for their specific code. Milestone 10 adds: combinatorial edge cases (security mode x risk level matrix), cross-component integration tests, coverage threshold enforcement, and full conversation flow online tests using the dev proxy.

## Tasks

### Task 10.1: Tool Handler Unit Test Suite

- **Description**: Edge-case and integration unit tests that extend the per-milestone happy-path coverage. Milestones 3-5 cover basic happy paths and simple error cases. This task adds: edge cases (empty lists, very long inputs, special characters), cross-tool interactions, and coverage threshold enforcement.
- **Agent type**: coder
- **Depends on**: Task 5.2
- **Subtasks**:
  1. Create/extend test files for each tool category:
     - `packages/daemon/tests/unit/neo/tools/neo-query-tools.test.ts` -- read-only tools
     - `packages/daemon/tests/unit/neo/tools/neo-room-write-tools.test.ts` -- room/goal write tools
     - `packages/daemon/tests/unit/neo/tools/neo-space-write-tools.test.ts` -- space write tools
     - `packages/daemon/tests/unit/neo/tools/neo-config-write-tools.test.ts` -- config write tools
     - `packages/daemon/tests/unit/neo/tools/neo-message-tools.test.ts` -- message tools
     - `packages/daemon/tests/unit/neo/tools/neo-meta-tools.test.ts` -- undo and explain
  2. For each tool handler test:
     - Happy path: correct input produces correct output
     - Missing resource: tool returns helpful error (not crash)
     - Invalid input: appropriate error message
     - Edge cases: empty lists, very long inputs, special characters
  3. Verify each write tool correctly stores undo data
  4. Run `make test-daemon` to verify all tests pass
- **Acceptance criteria**:
  - Every tool handler has at least happy path + error case tests
  - All tests pass with `make test-daemon`
  - Test coverage for Neo tools is above 80%
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 10.2: Security Tier and Action Logging Tests

- **Description**: Combinatorial and lifecycle tests for the security tier engine and action logging middleware. Extends per-milestone happy-path tests with the full 9-combination matrix (3 modes x 3 risk levels) and full action lifecycle coverage.
- **Agent type**: coder
- **Depends on**: Task 4.1, Task 4.2
- **Subtasks**:
  1. Create `packages/daemon/tests/unit/neo/security-tier.test.ts`:
     - Test all 9 combinations: 3 security modes x 3 risk levels
     - Test context-aware risk elevation (e.g., delete room with/without active tasks)
     - Test that risk classification map covers all tools
  2. Create `packages/daemon/tests/unit/neo/action-logger.test.ts`:
     - Test auto-execute flow: action logged, handler called, status updated
     - Test confirm flow: action logged as pending, confirm executes, status updated
     - Test cancel flow: action logged as pending, cancel sets cancelled status
     - Test failed actions: handler throws, status set to failed, error captured
     - Test undo data is stored correctly for each action type
  3. Create `packages/daemon/tests/unit/neo/undo-engine.test.ts`:
     - Test undo of each reversible action type
     - Test undo of irreversible action returns error
     - Test undo when no actions exist
     - Test double-undo prevention (already undone actions)
- **Acceptance criteria**:
  - All security tier combinations are verified
  - Action logging covers the full lifecycle (pending -> confirmed -> executed)
  - Undo tests verify actual reversal of operations
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 10.3: Session Persistence and Origin Metadata Tests

- **Description**: Tests for Neo session persistence across restarts and origin metadata propagation.
- **Agent type**: coder
- **Depends on**: Task 2.1, Task 1.4
- **Subtasks**:
  1. Create `packages/daemon/tests/unit/neo/provision-neo-agent.test.ts` (extends happy-path tests from Task 2.1 with edge cases):
     - Test first-time provisioning creates a new session with ID `'neo:global'`
     - Test subsequent provisioning restores the existing session
     - Test `clearSession` deletes messages but preserves `'neo:global'` session ID
     - Test `sendMessage` queues to the session (concurrent sends are serialized)
     - Test `getHistory` returns messages in order
  2. Create `packages/daemon/tests/unit/neo/origin-metadata.test.ts`:
     - Test that messages sent by Neo have `origin: 'neo'`
     - Test that regular human messages have `origin: 'human'` (or undefined for backward compat)
     - Test origin field persists through DB storage and retrieval
     - Test origin propagation through `sendMessage` -> DB -> retrieval chain
  3. Run all tests together to verify no conflicts
- **Acceptance criteria**:
  - Session persistence is verified with actual DB operations
  - Origin metadata propagates correctly through the full message pipeline
  - No regressions in existing session or message tests
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 10.4: Online Conversation Flow Tests

- **Description**: Online tests that exercise full Neo conversation flows using the dev proxy for mocked SDK responses.
- **Agent type**: coder
- **Depends on**: Task 6.1, Task 10.1
- **Subtasks**:
  1. Create `packages/daemon/tests/online/neo/neo-conversation.test.ts`:
     - Test query flow: send "what rooms do I have?" -> Neo uses `list_rooms` tool -> returns structured response
     - Test action flow: send "create a goal in room X" -> Neo uses `create_goal` tool -> goal exists
     - Test confirmation flow (balanced mode): send "delete room X" -> confirmation prompt -> confirm -> room deleted
     - Test rejection flow: send "delete room X" -> confirmation prompt -> cancel -> room still exists
  2. Create `packages/daemon/tests/online/neo/neo-undo.test.ts`:
     - Test undo flow: enable skill -> undo -> skill back to previous state
  3. Use `NEOKAI_USE_DEV_PROXY=1` for all online tests
  4. Set up proper test fixtures (create rooms, goals, skills for Neo to interact with)
- **Acceptance criteria**:
  - Full conversation flows work end-to-end with mocked SDK
  - Tool calls are correctly triggered by Neo's responses
  - Confirmation and undo flows complete successfully
  - Tests run with dev proxy and do not require real API credentials
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
