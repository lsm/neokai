# Milestone 1: task_result Condition Type

## Goal

Add a `task_result` condition type to the workflow transition system. This condition evaluates the `result` field of the most recently completed task on the current step and matches it against the condition's `expression` value. Wire the `step_result` argument from the `advance_workflow` MCP tool through to the executor so Task Agents can drive result-based transitions.

## Scope

- Extend `WorkflowConditionType` union in shared types
- Implement `task_result` evaluation in `WorkflowExecutor.evaluateCondition()`
- Update `advance()` and `ConditionContext` to carry the triggering task's result
- Forward `step_result` from `advance_workflow` tool handler to the executor

## Tasks

### Task 1.1: Add task_result to shared types

**Description:** Extend the `WorkflowConditionType` union and update JSDoc to document the new condition type.

**Agent type:** coder

**Subtasks:**
1. In `packages/shared/src/types/space.ts`, add `'task_result'` to the `WorkflowConditionType` union type (line ~473).
2. Update the `WorkflowCondition` interface JSDoc to document that `expression` is also used by `task_result` to hold the match value (e.g., `'passed'`, `'failed'`).
3. Update the `WorkflowConditionType` type JSDoc to describe the `task_result` type: "fires when the most recently completed task's result starts with the expression value."
4. Run `bun run typecheck` to verify no compilation errors from the exhaustive `never` check in `workflow-executor.ts` (it will fail -- that is expected and fixed in Task 1.2).

**Acceptance criteria:**
- `WorkflowConditionType` includes `'task_result'` as a valid value.
- JSDoc accurately describes the new condition type and `expression` usage.
- No other type errors introduced (the executor exhaustive check error is expected).

**Depends on:** (none)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.2: Implement task_result evaluation in WorkflowExecutor

**Description:** Add the `task_result` case to `evaluateCondition()`, extend `ConditionContext` with a `taskResult` field, and update `advance()` to populate it from the most recently completed task.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/runtime/workflow-executor.ts`, add `taskResult?: string` to the `ConditionContext` interface.
2. Add a `case 'task_result'` branch in `evaluateCondition()`:
   - If `condition.expression` is empty/undefined, return `{ passed: false, reason: 'task_result type requires a non-empty expression' }`.
   - If `context.taskResult` is undefined, return `{ passed: false, reason: 'No task result available for evaluation' }`.
   - Match logic: `context.taskResult.startsWith(condition.expression)` -- this allows `'failed'` to match `'failed: tests broken'` and `'passed'` to match `'passed'`.
   - Return `{ passed: true }` on match, `{ passed: false, reason: 'Task result "..." does not match "..."' }` on mismatch.
3. Remove the `default: never` exhaustive check error for the old type set (it should now include `task_result`).
4. Update `getConditionContext()` to accept an optional `taskResult` parameter and include it in the returned context.
5. Update the `advance()` method: before evaluating transitions, query the tasks for the current step in this run (via `this.taskManager`) and extract the `result` field from the most recently completed task. Pass this as `taskResult` in the condition context.
6. Since `advance()` needs to query tasks by `workflowRunId + workflowStepId`, add a method or use the existing `taskManager` to find the latest completed task for the current step. The `SpaceTaskManager` wraps `SpaceTaskRepository` which has `listByWorkflowRun()` -- filter by `workflowStepId` and `status === 'completed'`, then take the last one by `completedAt`.
7. Run `bun run typecheck` to confirm the exhaustive check is satisfied.

**Acceptance criteria:**
- `evaluateCondition()` handles `task_result` with prefix matching on `context.taskResult`.
- `advance()` automatically populates `taskResult` from the latest completed task on the current step.
- TypeScript compiles cleanly with no exhaustive check errors.
- Existing condition types (`always`, `human`, `condition`) continue to work unchanged.

**Depends on:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.3: Wire step_result through advance_workflow tool handler

**Description:** Forward the `step_result` argument from the `advance_workflow` MCP tool to the executor so that Task Agents can explicitly provide a result for transition evaluation. This serves as a fallback/override when the task's `result` field is not set.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/tools/task-agent-tools.ts`, update the `advance_workflow` handler to read `args.step_result`.
2. If `step_result` is provided, pass it to the executor's advance method. Since `advance()` auto-reads the task result from DB (Task 1.2), the tool-provided `step_result` should serve as an override: if the task's DB `result` field is null/empty but `step_result` is provided, use it. If both exist, prefer the DB task result (it is the authoritative source).
3. Update the `advance()` method signature (or add an options parameter) to accept an optional `stepResult` override that takes precedence when the DB task has no result.
4. Update the `AdvanceWorkflowSchema` JSDoc in `task-agent-tool-schemas.ts` to clarify that `step_result` is used for `task_result` condition evaluation.

**Acceptance criteria:**
- `advance_workflow` tool forwards `step_result` to the executor.
- DB task result takes precedence; `step_result` is used as fallback when DB result is absent.
- Existing advance behavior is unchanged when `step_result` is not provided.

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
