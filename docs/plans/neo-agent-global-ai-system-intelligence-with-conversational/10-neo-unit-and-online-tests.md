# Milestone 10: Neo Unit and Online Tests

## Goal

Comprehensive test coverage for all Neo backend features: tool handlers, security tiers, session persistence, conversation flows, and activity logging.

## Scope

- Unit tests for components not already covered in earlier milestones
- Online tests for full conversation flows with mocked SDK

## Tasks

### Task 10.1: Neo Tool Handler Unit Tests

**Description**: Ensure comprehensive unit test coverage for all Neo tool handlers.

**Subtasks**:
1. Create `packages/daemon/tests/unit/neo/` test directory
2. Write tests for each query tool: verify correct data returned, error handling for missing entities
3. Write tests for each action tool: verify execution, confirmation flow, error handling
4. Write tests for security tier logic: all 9 mode/risk combinations
5. Write tests for activity logging: verify entries are created with correct fields
6. Write tests for undo: verify each undoable action type, edge cases (nothing to undo, target deleted)
7. Write tests for origin metadata propagation through tool calls
8. Ensure all tests use unit test setup (no real API calls)

**Acceptance Criteria**:
- All tool handlers have unit tests covering normal, error, and edge cases
- Security tier matrix is fully tested
- Activity logging tests verify all fields
- Undo tests cover all undoable action types
- All tests pass with `make test-daemon`

**Dependencies**: Tasks 2.1-2.4, 3.1-3.5, 5.1-5.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 10.2: Neo Online Conversation Flow Tests

**Description**: Write online tests that verify full conversation flows through the Neo agent.

**Subtasks**:
1. Create `packages/daemon/tests/online/neo/` test directory
2. Write conversation flow tests (using dev proxy mock SDK):
   - Query flow: send "what rooms do I have?" -> verify Neo uses `list_rooms` tool -> structured response
   - Action flow: send "create a goal in room X" -> verify Neo uses `create_goal` tool -> goal created
   - Confirmation flow: send "delete room X" -> verify confirmation card -> confirm -> room deleted
   - Multi-turn: query -> action -> query again (verify state changed)
3. Write security tier enforcement tests:
   - Balanced mode: low-risk auto-executes, medium-risk confirms
   - Conservative mode: everything confirms
   - Autonomous mode: nothing confirms
4. Write activity feed accuracy tests:
   - Perform several actions -> verify all logged correctly in activity table
5. Write session persistence test:
   - Send messages -> restart daemon -> verify history preserved
6. All tests use `NEOKAI_USE_DEV_PROXY=1` for mocked SDK responses

**Acceptance Criteria**:
- Conversation flows work end-to-end with mocked SDK
- Security tiers enforce correctly in each mode
- Activity feed records all actions accurately
- Session survives daemon restart
- All tests pass

**Dependencies**: Tasks 4.1, 5.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
