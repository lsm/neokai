# Milestone 7: Online Integration Test

## Goal and Scope

Exercise the full happy path with the dev proxy (mocked SDK). Tests are broken into focused sub-tests per workflow stage with shared helpers.

**Testing strategy**: These are **gate-level integration tests**, not full agent execution tests. Each test uses `mockAgentDone()` and `writeGateData()` helpers to simulate agent completion and gate writes directly, then verifies the gate evaluation, channel routing, and node activation logic. This keeps tests fast (no real LLM calls, no agent session startup) while testing the actual Gate + Channel architecture end-to-end. The dev proxy is used only for the agent session lifecycle (spawn/kill), not for full conversation turns.

## Test File Structure

```
packages/daemon/tests/online/space/
  helpers/
    space-test-helpers.ts         # Shared helpers
  space-happy-path-plan-to-approve.test.ts    # Planning → PR Gate → Plan Review → Human Gate → approve
  space-happy-path-code-review.test.ts        # Coding → PR Gate → 3 Reviewers → Aggregate Gate
  space-happy-path-qa-completion.test.ts      # QA → Done (pass and fail loops)
  space-happy-path-full-pipeline.test.ts      # Full end-to-end
  space-edge-cases.test.ts                    # Iteration cap, cancellation, concurrent tasks
```

## Shared Helpers

`space-test-helpers.ts` provides:
- `createTestSpace(config)` — creates a Space with preset agents and V2 workflow
- `startWorkflowRun(spaceId, taskId)` — starts a workflow run
- `mockAgentDone(runId, nodeId, result)` — simulates agent completion
- `writeGateData(runId, gateId, data)` — writes data to a gate
- `readGateData(runId, gateId)` — reads gate data
- `approveHumanGate(runId, gateId)` — approves a human gate
- `rejectHumanGate(runId, gateId)` — rejects a human gate
- `waitForNodeStatus(runId, nodeId, status)` — waits for node status
- `waitForRunStatus(runId, status)` — waits for run status
- `getGateArtifacts(runId, gateId)` — gets artifacts for a gate

## Tasks

### Task 7.1: Test Helpers and Plan-to-Approve Flow

**Description**: Create shared helpers and test Planning → PR Gate → Plan Review → Human Gate → Approve.

**Subtasks**:
1. Create `space-test-helpers.ts` with all shared helpers
2. Write `space-happy-path-plan-to-approve.test.ts`:
   a. Create Space with V2 workflow
   b. Create task → start workflow run
   c. Verify Planning node activates
   d. Simulate Planner completion + write PR data to Plan PR Gate
   e. Verify Plan PR Gate opens → Plan Review node activates
   f. Simulate Plan Review completion
   g. Verify Human Gate blocks (gate data shows `{ waiting: true }`)
   h. Approve via `approveHumanGate()` helper
   i. Verify Coding node activates
   j. Test rejection: reject → verify `needs_attention` status with `failureReason: 'humanRejected'`

**Acceptance Criteria**:
- Shared helpers work with dev proxy
- Plan → approve flow test passes
- PR Gate correctly blocks until PR data is written
- Human Gate correctly blocks and unblocks
- Rejection flow works

**Depends on**: Milestone 5 (full pipeline), Milestone 6 (human gate backend)

**Agent type**: coder

---

### Task 7.2: Test Code Review with Parallel Reviewers

**Description**: Test Coding → PR Gate → 3 Reviewers (parallel) → Aggregate Gate.

**Subtasks**:
1. Write `space-happy-path-code-review.test.ts`:
   a. Start from approved plan (reuse helpers)
   b. Simulate Coder completion + write PR data to Code PR Gate
   c. Verify all 3 Reviewer nodes activate simultaneously
   d. Test happy path: all 3 reviewers approve → QA activates
   e. Test partial approval: 2 of 3 approve → Aggregate Gate stays blocked
   f. Test rejection: any reviewer rejects → feedback to Coder, cyclic channel fires
   g. Test iteration counter increments on reviewer reject cycle

**Acceptance Criteria**:
- 3 reviewers activate in parallel
- Aggregate Gate requires all 3 approvals
- Partial approval doesn't unblock
- Rejection cycles back to Coding
- Iteration counter works

**Depends on**: Task 7.1

**Agent type**: coder

---

### Task 7.3: Test QA-Completion Flow

**Description**: Test QA → Done (pass) and QA → Coding (fail) flows.

**Subtasks**:
1. Write `space-happy-path-qa-completion.test.ts`:
   a. Start from all 3 reviewers approved (reuse helpers)
   b. Test happy path: QA passes → Done → workflow completes
   c. Test QA failure: QA fails → Coding re-activates → full re-review cycle
   d. Verify re-review cycle: Coding → 3 Reviewers → QA (all 3 must re-vote)
   e. Verify iteration counter on QA→Coding cycle

**Acceptance Criteria**:
- QA pass → Done flow works
- QA failure → full re-review cycle works
- Iteration counter is global
- Completion notification emitted

**Depends on**: Task 7.2

**Agent type**: coder

---

### Task 7.4: Full Pipeline End-to-End Test

**Description**: Single end-to-end test: task creation → completion.

**Subtasks**:
1. Write `space-happy-path-full-pipeline.test.ts`:
   a. Create Space → task → workflow run
   b. Planning → PR Gate → Plan Review → Human approve → Coding → PR Gate → 3 Reviewers approve → QA pass → Done
   c. Verify completion summary
2. Test failure-and-recovery path with one reviewer rejection + one QA failure

**Acceptance Criteria**:
- Full happy path test passes
- Failure-and-recovery test passes
- Relies on shared helpers (concise)

**Depends on**: Task 7.3

**Agent type**: coder

---

### Task 7.5: Edge Case Tests

**Description**: Test edge cases.

**Subtasks**:
1. Write `space-edge-cases.test.ts`:
   a. Concurrent tasks: separate worktrees, separate iteration counters
   b. Cancellation: agents cleaned up, worktree removed
   c. Agent crash: Task Agent detects failure, run transitions to `needs_attention` with `failureReason: 'agentCrash'`
   d. Human gate persistence: `waiting` state in gate data survives daemon restart
   e. **Aggregate gate partial + restart**: (1) write 2 approve votes to `review-aggregate-gate`, (2) verify gate still blocked (quorum not met), (3) restart daemon, (4) verify gate data persisted (2 votes present in `gate_data` table), (5) write 3rd approve vote, (6) verify gate passes and QA activates. This proves gate data survives restart via the `gate_data` SQLite table.

**Acceptance Criteria**:
- All edge cases pass
- Gate data persists across restarts

**Depends on**: Task 7.1 (helpers; parallel with 7.2-7.4)

**Agent type**: coder
