# Milestone 6: Online Integration Test

## Goal and Scope

Exercise the full happy path with the dev proxy (mocked SDK). Tests are broken into focused sub-tests per workflow stage rather than one monolithic end-to-end test. Each sub-test uses shared helper functions for common patterns (mock agent completion, verify node activation, etc.).

## Test File Structure

```
packages/daemon/tests/online/space/
  helpers/
    space-test-helpers.ts         # Shared helpers: createSpace, mockAgentDone, verifyNodeActive, etc.
  space-happy-path-plan-to-approve.test.ts    # Plan → human gate → approve
  space-happy-path-code-review.test.ts        # Code → Review (pass and fail loops)
  space-happy-path-qa-completion.test.ts      # QA → Done (pass and fail loops)
  space-happy-path-full-pipeline.test.ts      # End-to-end: Plan → Code → Review → QA → Done
  space-edge-cases.test.ts                    # Iteration cap, cancellation, concurrent tasks
```

## Shared Helpers

`space-test-helpers.ts` provides:
- `createTestSpace(config)` — creates a Space with preset agents and V2 workflow
- `startWorkflowRun(spaceId, taskId)` — starts a workflow run via RPC
- `mockAgentDone(runId, nodeId, result)` — simulates agent completion
- `mockAgentMessage(runId, fromNodeId, toNodeId, content)` — simulates inter-agent message
- `approveHumanGate(runId, channelId)` — approves a human gate via RPC
- `rejectHumanGate(runId, channelId)` — rejects a human gate via RPC
- `waitForNodeStatus(runId, nodeId, status)` — waits for a node to reach a status
- `waitForRunStatus(runId, status)` — waits for the run to reach a status
- `getCurrentIterationCount(runId)` — reads the iteration counter

## Tasks

### Task 6.1: Test Helpers and Plan-to-Approve Flow

**Description**: Create the shared test helper module and write the first focused integration test for the Plan → Human Gate → Approve flow.

**Subtasks**:
1. Create `space-test-helpers.ts` with all shared helpers listed above
2. Write `space-happy-path-plan-to-approve.test.ts`:
   a. Create a Space with V2 workflow
   b. Create a task and start a workflow run
   c. Verify Planner node is activated
   d. Simulate Planner completion (mock `report_done` with plan result)
   e. Verify workflow transitions to `waiting_for_approval` status
   f. Approve via `approveHumanGate()` helper
   g. Verify workflow transitions back to `running` and Coder node activates
   h. Test rejection: simulate Planner → reject → verify `failed` status with `humanRejected` reason
3. Verify all helpers work correctly with dev proxy

**Acceptance Criteria**:
- Shared helpers encapsulate common test patterns
- Plan → approve flow test passes with dev proxy
- Human gate correctly blocks and unblocks
- Rejection flow works
- Tests run in CI with dev proxy enabled

**Depends on**: Task 5.4 (full pipeline with human gate must work)

**Agent type**: coder

---

### Task 6.2: Test Code-Review Feedback Loop

**Description**: Write focused integration test for the Code → Review feedback loop.

**Subtasks**:
1. Write `space-happy-path-code-review.test.ts`:
   a. Start from an approved plan (reuse helpers to get past the human gate)
   b. Simulate Coder completion
   c. Verify Reviewer node activates
   d. Test happy path: Reviewer approves → Done activates
   e. Test failure loop:
      - Reviewer rejects with feedback
      - Verify Coder receives feedback (node re-activates)
      - Simulate Coder fixing and resubmitting
      - Reviewer approves → Done activates
   f. Verify iteration counter increments on each Review→Code cycle
   g. Test iteration cap: simulate enough rejections to hit `maxIterations`, verify `maxIterationsReached` error

**Acceptance Criteria**:
- Code → Review pass flow test passes
- Code → Review failure loop test passes
- Iteration counter increments correctly
- `maxIterations` exhaustion produces `maxIterationsReached` error
- Tests use shared helpers (no duplicated setup)

**Depends on**: Task 6.1

**Agent type**: coder

---

### Task 6.3: Test QA-Completion Flow

**Description**: Write focused integration test for the Review → QA → Done flow including QA failure loops.

**Subtasks**:
1. Write `space-happy-path-qa-completion.test.ts`:
   a. Start from an approved plan with coder and reviewer completed (reuse helpers)
   b. Test happy path: QA passes → Done activates → workflow completes
   c. Test QA failure loop:
      - QA fails with specific issues
      - Verify Coder receives QA feedback (node re-activates)
      - Simulate Coder fixing → Reviewer re-reviews → QA re-checks → passes → Done
   d. Verify the full re-review cycle runs after QA failure (Code → Review → QA)
   e. Verify iteration counter increments on QA→Code cycle too

**Acceptance Criteria**:
- QA pass → Done flow test passes
- QA failure → Coder fix → re-review → QA pass → Done flow test passes
- Full re-review cycle is verified after QA failure
- Iteration counter is global (tracks both Review→Code and QA→Code)

**Depends on**: Task 6.2

**Agent type**: coder

---

### Task 6.4: Full Pipeline End-to-End Test

**Description**: Write a single end-to-end integration test that exercises the complete happy path from task creation to completion. This test uses all the shared helpers and validates the full pipeline in one go.

**Subtasks**:
1. Write `space-happy-path-full-pipeline.test.ts`:
   a. Create Space → Create task → Start workflow run
   b. Planner completes → Human approves → Coder starts
   c. Coder completes → Reviewer passes → QA starts
   d. QA passes → Done → Workflow completes
   e. Verify completion notification is emitted
   f. Verify Task Agent summary is generated
2. Also test the full failure-and-recovery path:
   a. Full pipeline with one Reviewer rejection, one QA failure, then success

**Acceptance Criteria**:
- Full happy path test passes with dev proxy
- Full failure-and-recovery path test passes
- Completion notification and summary are verified
- Test is concise (relies on shared helpers, not 14 manual steps)

**Depends on**: Task 6.3

**Agent type**: coder

---

### Task 6.5: Edge Case Tests

**Description**: Add integration tests for edge cases in the workflow pipeline. These can be developed in parallel with Tasks 6.2-6.4 since they test isolated failure modes.

**Subtasks**:
1. Write `space-edge-cases.test.ts`:
   a. **Concurrent tasks**: Create two tasks in the same space, verify their workflow runs don't interfere (separate worktrees, separate iteration counters)
   b. **Cancellation**: Cancel a run mid-execution (while Coder is active), verify: agents are cleaned up, worktrees are removed, run status is `cancelled`
   c. **Agent crash**: Simulate an agent session crash (kill the session), verify the Task Agent detects the failure and transitions the run to `failed` with clear error
   d. **Human gate persistence**: Verify that a `waiting_for_approval` state survives daemon restart (rehydrate from DB)

**Acceptance Criteria**:
- All edge case tests pass with dev proxy
- Concurrent tasks have isolated worktrees and iteration counters
- Cancellation cleans up properly (no orphaned sessions or worktrees)
- Agent crashes produce clear error states
- Human gate state persists across restarts

**Depends on**: Task 6.1 (helpers must exist; can run in parallel with 6.2-6.4)

**Agent type**: coder
