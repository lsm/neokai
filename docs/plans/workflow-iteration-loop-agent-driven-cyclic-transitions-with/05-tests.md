# Milestone 5: Tests

## Goal

Comprehensive test coverage for all new functionality: `task_result` condition evaluation, iteration tracking with `maxIterations` cap, cyclic workflow execution, `goalId` propagation, and end-to-end verify-loop-pass integration.

## Scope

- Unit tests in `packages/daemon/tests/unit/space/workflow-executor.test.ts`
- Unit tests for repository changes in `packages/daemon/tests/unit/storage/`
- Unit test for updated built-in workflow template
- Integration/online test for a full cyclic workflow run

## Tasks

### Task 5.1: Unit tests for task_result condition evaluation

**Description:** Add unit tests for the `task_result` condition type in `evaluateCondition()`.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/tests/unit/space/workflow-executor.test.ts`, add a new `describe('task_result condition')` block.
2. Test cases:
   - `task_result` with matching prefix: `expression: 'passed'`, `taskResult: 'passed'` -> passes.
   - `task_result` with matching prefix and suffix: `expression: 'failed'`, `taskResult: 'failed: tests broken'` -> passes.
   - `task_result` with non-matching result: `expression: 'passed'`, `taskResult: 'failed: tests broken'` -> does not pass.
   - `task_result` with missing `taskResult` in context -> does not pass, with descriptive reason.
   - `task_result` with empty expression -> does not pass, with descriptive reason.
   - `task_result` with exact match (no prefix): `expression: 'passed'`, `taskResult: 'passed'` -> passes.
3. Run tests with `cd packages/daemon && bun test tests/unit/space/workflow-executor.test.ts`.

**Acceptance criteria:**
- All `task_result` condition evaluation cases pass.
- Both match and no-match scenarios are covered.
- Edge cases (missing result, empty expression) return appropriate reasons.

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.2: Unit tests for iteration tracking and maxIterations cap

**Description:** Test that `iterationCount` increments on cyclic transitions and that `maxIterations` cap triggers `needs_attention`.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/tests/unit/space/workflow-executor.test.ts`, add a `describe('iteration tracking')` block.
2. Test cases:
   - Create a cyclic workflow (A -> B -> A). Follow transition from B back to A. Verify `iterationCount` is incremented on the run.
   - Create a workflow with `maxIterations: 2`. Execute two cycles. On the third cycle attempt, verify the run status becomes `needs_attention` and no new task is created.
   - Non-cyclic transition (first visit to a step) does not increment `iterationCount`.
3. Test the repository: verify `iteration_count` and `max_iterations` are correctly persisted and read back.
4. Run tests.

**Acceptance criteria:**
- Iteration counter increments correctly on revisits.
- `maxIterations` cap sets run to `needs_attention`.
- Non-cyclic transitions do not affect the counter.
- Repository round-trips the new columns correctly.

**Depends on:** Task 2.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.3: Unit tests for goalId propagation

**Description:** Test that `goalId` is correctly propagated from workflow runs to created tasks.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/tests/unit/space/workflow-executor.test.ts` or a new test file, add tests for `goalId` propagation.
2. Test cases:
   - Create a workflow run with `goalId`. Start the run and verify the initial task has the correct `goalId`.
   - Advance the workflow and verify the new task inherits `goalId` from the run.
   - Create a workflow run without `goalId`. Verify tasks have `goalId` as `undefined`.
3. Test `findByGoalId()` repository method: create multiple tasks with the same `goalId`, verify they are all returned. Verify archived tasks are excluded.
4. Run tests.

**Acceptance criteria:**
- Tasks inherit `goalId` from their workflow run.
- `findByGoalId()` returns correct results.
- Null/undefined `goalId` is handled gracefully.

**Depends on:** Task 3.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.4: Unit test for updated built-in Coding Workflow

**Description:** Verify the updated Coding Workflow template has the correct structure with the Verify step and cyclic transitions.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/tests/unit/space/built-in-workflows.test.ts`, add or update tests for the Coding Workflow template.
2. Test cases:
   - Verify the workflow has 4 steps (Plan, Code, Verify, Done).
   - Verify the transition graph: Plan -> Code (human), Code -> Verify (always), Verify -> Plan (task_result: 'failed'), Verify -> Done (task_result: 'passed').
   - Verify `maxIterations` is set to 3.
   - Verify `seedBuiltInWorkflows` resolves all agent roles correctly.
3. Run tests.

**Acceptance criteria:**
- Template structure matches the design specification.
- All transitions have correct conditions and ordering.
- Seeding works with mock agent resolver.

**Depends on:** Task 4.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.5: Integration test for end-to-end cyclic workflow

**Description:** Test a complete workflow run with a verify step that fails once (triggering a loop back) then passes on the second attempt, completing the workflow.

**Agent type:** coder

**Subtasks:**
1. Create a test file `packages/daemon/tests/unit/space/workflow-iteration-loop.test.ts` (or add to the existing executor test file).
2. Set up a 3-step cyclic workflow: Plan -> Code -> Verify, with Verify -> Plan on `task_result: 'failed'` and Verify -> Done on `task_result: 'passed'`. Set `maxIterations: 3`.
3. Test scenario:
   - Start the workflow run. Verify initial task is for Plan step.
   - Simulate Plan task completion (update status to 'completed').
   - Advance (with human approval for Plan -> Code gate). Verify task for Code step is created.
   - Simulate Code task completion.
   - Advance. Verify task for Verify step is created.
   - Simulate Verify task completion with result `'failed: tests are broken'`.
   - Advance. Verify the transition loops back to Plan and creates a new Plan task. Verify `iterationCount` is 1.
   - Simulate Plan(2) -> Code(2) -> Verify(2) completion with result `'passed'`.
   - Advance. Verify the workflow reaches Done (terminal) and run status is `'completed'`.
   - Verify total `iterationCount` is 1 (only one loop back occurred).
4. Verify the full task audit trail: Plan(1), Code(1), Verify(1), Plan(2), Code(2), Verify(2) -- 6 tasks under the same run.
5. Run tests.

**Acceptance criteria:**
- Full cycle executes correctly: fail -> loop -> pass -> complete.
- Iteration count reflects the actual number of loops.
- All tasks are under the same workflow run with correct step IDs.
- Run status is `'completed'` at the end.

**Depends on:** Tasks 1.2, 2.2, 4.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
