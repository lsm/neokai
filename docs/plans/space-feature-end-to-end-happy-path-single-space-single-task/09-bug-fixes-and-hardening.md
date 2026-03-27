# Milestone 9: Bug Fixes and Hardening

## Goal and Scope

Fix issues discovered during integration and E2E testing. Add robust error handling and edge case coverage.

## Tasks

### Task 9.1: Bug Triage and Prioritization

**Description**: After M7 and M8 complete, create a concrete bug list.

**Subtasks**:
1. Collect all test failures from M7 and M8
2. Create triage document at `docs/plans/space-feature-end-to-end-happy-path-single-space-single-task/bug-triage.md`
3. Group by area: gate routing, approval gate UI, worktree isolation, canvas, agent prompts
4. Prioritize: P0/P1/P2

**Acceptance Criteria**:
- Triage document with all bugs and priorities
- Clear scope for remaining tasks

**Depends on**: Task 7.4, Task 8.2

**Agent type**: general

---

### Task 9.2: Fix Integration Test Bugs

**Description**: Fix P0/P1 bugs from online integration tests.

**Subtasks**:
1. Reproduce each P0/P1 bug
2. Fix root cause (not the test)
3. Add unit test covering the bug
4. Verify integration test passes

**Acceptance Criteria**:
- All P0/P1 integration bugs fixed with unit tests
- Integration tests pass

**Depends on**: Task 9.1

**Agent type**: coder

---

### Task 9.3: Fix E2E Test Bugs

**Description**: Fix P0/P1 bugs from E2E tests.

**Subtasks**:
1. Reproduce each P0/P1 bug
2. Fix root cause
3. Add regression test
4. Verify E2E tests pass

**Acceptance Criteria**:
- All P0/P1 E2E bugs fixed
- E2E tests pass

**Depends on**: Task 9.1

**Agent type**: coder

---

### Task 9.4: Error Handling and Edge Case Hardening

**Description**: Add robust error handling for common failure modes.

**Subtasks**:
1. **Agent session crash handling**: Task Agent detects crash, transitions to `needs_attention` with `failureReason: 'agentCrash'`, notifies human
2. **Network errors**: Retry with exponential backoff for `gh` CLI commands (max 3, 5s/10s/20s)
3. **Rate limit handling**: Wait and retry using `Retry-After` header
4. **Timeout enforcement**: Per-node configurable timeouts (30min coder, 15min reviewer/QA, 20min planner)
5. **Cancellation cleanup**: Kill sessions, remove worktree, transition to `cancelled`, notify human
6. **Gate data corruption recovery**: If gate data is malformed (fails JSON parse or schema validation), reset data to `{}` and log error. Since all gates use the unified Gate entity, the reset is always `{}` — the gate's condition will re-evaluate against the empty data store (e.g., `check: prUrl exists` will fail, `count: votes.approve >= 3` will return 0, etc.). For human-approval gates specifically, also set `{ waiting: true }` to re-show the approval UI.
7. **Structured error messages**: All failures produce human-readable messages in Space chat

**Acceptance Criteria**:
- Crashes produce clear failure status
- Network errors retry before failing
- Timeouts enforced per-node
- Cancellation cleans up all resources
- Human-readable error messages
- Unit tests for each scenario

**Depends on**: Task 9.2, Task 9.3

**Agent type**: coder
