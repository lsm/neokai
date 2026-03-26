# Milestone 8: Bug Fixes and Hardening

## Goal and Scope

Fix issues discovered during integration and E2E testing. Add missing error handling and edge case coverage. This is a catch-all milestone for work discovered during testing.

## Tasks

### Task 8.1: Fix Integration Test Bugs

**Description**: Address bugs found during the online integration test execution (Milestone 6).

**Subtasks**:
1. Collect bugs from M6 test results
2. Triage and prioritize bugs
3. Fix each bug with a corresponding unit test
4. Verify the integration test passes after fixes

**Acceptance Criteria**:
- All bugs found in M6 are fixed
- Each fix has a unit test
- Integration tests pass

**Depends on**: Task 6.1, Task 6.2

**Agent type**: coder

---

### Task 8.2: Fix E2E Test Bugs

**Description**: Address bugs found during the E2E test execution (Milestone 7).

**Subtasks**:
1. Collect bugs from M7 test results
2. Triage and prioritize bugs
3. Fix each bug
4. Verify E2E tests pass after fixes

**Acceptance Criteria**:
- All bugs found in M7 are fixed
- E2E tests pass

**Depends on**: Task 7.1, Task 7.2

**Agent type**: coder

---

### Task 8.3: Error Handling Hardening

**Description**: Add robust error handling for common failure modes in the workflow pipeline.

**Subtasks**:
1. Handle agent session crashes gracefully (auto-recover or fail with clear message)
2. Handle network errors during PR operations (retry with backoff)
3. Handle rate limits during agent execution (reuse Room system's fallback model logic)
4. Add timeout enforcement for each workflow node (configurable per-space)
5. Ensure cleanup on workflow run cancellation (kill active sessions, clean worktrees)
6. Add structured error messages to the human when failures occur

**Acceptance Criteria**:
- Agent crashes are handled gracefully without orphaned sessions
- Network errors don't leave the workflow in an inconsistent state
- Rate limits are handled with appropriate fallbacks
- Timeouts are enforced and reported
- Cleanup is thorough on cancellation

**Depends on**: Task 8.1, Task 8.2

**Agent type**: coder
