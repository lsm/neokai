# Milestone 6: Online Integration Test

## Goal and Scope

Exercise the full happy path with the dev proxy (mocked SDK). This test verifies that the entire pipeline -- conversation -> task creation -> workflow run -> planner -> human gate -> coder -> reviewer -> QA -> completion -- works correctly with mocked agent sessions.

## Tasks

### Task 6.1: Full Pipeline Online Integration Test

**Description**: Create an online test (`packages/daemon/tests/online/space/space-happy-path-pipeline.test.ts`) that exercises the full workflow pipeline with mocked SDK sessions.

**Subtasks**:
1. Set up test infrastructure:
   - Create a Space with all preset agents
   - Seed the extended coding workflow (V2)
   - Configure dev proxy for mocked SDK responses
2. Test flow:
   a. Create a task via RPC (`spaceTask.create`)
   b. Start workflow run via RPC (`spaceWorkflowRun.create`)
   c. Verify Planner node is activated (task created in DB)
   d. Simulate Planner completion (mock agent `report_done`)
   e. Verify human gate blocks the Plan -> Code channel
   f. Approve via RPC (set `humanApproved` in run config)
   g. Verify Coder node is activated
   h. Simulate Coder completion with a mock PR
   i. Verify Reviewer node is activated
   j. Simulate Reviewer approval (report_done with 'passed' result)
   k. Verify QA node is activated
   l. Simulate QA passing (report_done with 'passed' result)
   m. Verify workflow run transitions to 'completed'
   n. Verify completion notification is emitted
3. Also test the failure loop:
   a. Simulate Reviewer rejection (report_done with 'failed')
   b. Verify Coder receives feedback via channel
   c. Simulate Coder fixing and resubmitting
   d. Simulate Reviewer passing
   e. Simulate QA passing
   f. Verify completion

**Acceptance Criteria**:
- Full pipeline test passes with dev proxy
- Human gate correctly blocks and unblocks
- Failure loops work (Reviewer -> Coder -> Reviewer)
- QA failure loops work (QA -> Coder -> Review -> QA)
- Workflow run completes successfully
- Test runs in CI with dev proxy enabled

**Depends on**: Task 5.3 (full pipeline must work)

**Agent type**: coder

---

### Task 6.2: Edge Case Online Tests

**Description**: Add online tests for edge cases in the workflow pipeline.

**Subtasks**:
1. Test iteration cap exhaustion: simulate enough QA failures to hit `maxIterations`
2. Test concurrent task handling: create two tasks in the same space, verify they don't interfere
3. Test workflow run cancellation: cancel a run mid-execution, verify agents are cleaned up
4. Test human gate timeout: verify the run stays blocked until human approves (no auto-advance)
5. Test agent crash recovery: simulate an agent session crash, verify the Task Agent can recover

**Acceptance Criteria**:
- Edge case tests pass with dev proxy
- Iteration cap is enforced
- Concurrent tasks don't interfere
- Cancellation cleans up properly
- Agent crash recovery works

**Depends on**: Task 6.1

**Agent type**: coder
