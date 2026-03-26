# Milestone 8: Bug Fixes and Hardening

## Goal and Scope

Fix issues discovered during integration and E2E testing. Add missing error handling and edge case coverage. This milestone begins with a concrete bug triage step to scope the work, then addresses each issue.

## Tasks

### Task 8.1: Bug Triage and Prioritization

**Description**: After M6 (online tests) and M7 (E2E tests) complete, create a concrete bug list with priorities and estimates. This task scopes M8's remaining work.

**Subtasks**:
1. Collect all test failures and issues from M6 and M7
2. Create a triage document at `docs/plans/space-feature-end-to-end-happy-path-single-space-single-task/bug-triage.md`:
   - Each bug: ID, description, reproduction steps, severity (P0/P1/P2), estimated fix effort
   - Group by area: workflow routing, human gate, worktree isolation, agent prompts, UI
3. Identify which bugs are in scope for M8 vs which need separate tasks
4. Update the remaining M8 tasks based on the triage

**Acceptance Criteria**:
- Triage document lists all bugs with priorities
- Bugs are grouped by area
- Scope is clear for remaining M8 tasks

**Depends on**: Task 6.4, Task 7.2

**Agent type**: general

---

### Task 8.2: Fix Integration Test Bugs

**Description**: Address bugs found during the online integration tests (M6).

**Subtasks**:
1. For each P0/P1 bug from the triage (Task 8.1) in the integration test area:
   - Reproduce the bug
   - Fix the root cause (not the test)
   - Add a unit test that covers the bug
   - Verify the integration test passes after the fix
2. For P2 bugs: evaluate whether to fix or defer

**Acceptance Criteria**:
- All P0/P1 integration test bugs are fixed
- Each fix has a unit test
- Integration tests pass

**Depends on**: Task 8.1

**Agent type**: coder

---

### Task 8.3: Fix E2E Test Bugs

**Description**: Address bugs found during the E2E tests (M7).

**Subtasks**:
1. For each P0/P1 bug from the triage (Task 8.1) in the E2E/UI area:
   - Reproduce the bug
   - Fix the root cause (backend or frontend)
   - Add a unit test or E2E regression test
   - Verify E2E tests pass after the fix
2. For P2 bugs: evaluate whether to fix or defer

**Acceptance Criteria**:
- All P0/P1 E2E test bugs are fixed
- Each fix has a regression test
- E2E tests pass

**Depends on**: Task 8.1

**Agent type**: coder

---

### Task 8.4: Error Handling and Edge Case Hardening

**Description**: Add robust error handling for common failure modes identified during testing.

**Subtasks**:
1. **Agent session crash handling**: When an agent session crashes mid-execution, the Task Agent should detect the failure (via session status change), transition the workflow run to `failed`, and notify the human with a clear error message. If the crash is transient (e.g., rate limit), the Task Agent should retry once before failing.
2. **Network errors during PR operations**: Add retry logic with exponential backoff for `gh` CLI commands that fail due to network errors (as opposed to logical errors like "no changes to commit"). Max 3 retries, 5s/10s/20s backoff.
3. **Rate limit handling**: When the LLM provider returns a rate limit error, the Task Agent should wait and retry (using the `Retry-After` header if available). If the provider supports fallback models (as the Room system does), use the fallback.
4. **Timeout enforcement**: Each workflow node should have a configurable timeout (default: 30 minutes for Coder, 15 minutes for Reviewer/QA, 20 minutes for Planner). When a node times out, the run transitions to `failed` with `nodeTimeout` error.
5. **Workflow run cancellation cleanup**: When a workflow run is cancelled:
   - Kill all active agent sessions
   - Remove all space worktrees for the run
   - Transition the run to `cancelled` status
   - Notify the human
6. **Structured error messages**: All failure modes should produce human-readable error messages in the Space chat, including: what failed, why, and suggested next steps.

**Acceptance Criteria**:
- Agent crashes produce clear `failed` status with error message (no orphaned sessions)
- Network errors retry with backoff before failing
- Rate limits trigger retry with fallback model
- Timeouts are enforced per-node and produce `nodeTimeout` error
- Cancellation cleans up all resources (sessions, worktrees)
- All errors produce human-readable messages in Space chat
- Unit tests cover each error handling scenario

**Depends on**: Task 8.2, Task 8.3

**Agent type**: coder
