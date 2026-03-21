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
5. Update the `advance()` method signature to accept an optional `options?: { stepResult?: string }` parameter. Before evaluating transitions, query the tasks for the current step in this run (via `this.taskManager`) and extract the `result` field from the most recently completed task. If the DB task result is null/empty but `options.stepResult` is provided, use it as fallback. Pass the resolved result as `taskResult` in the condition context.
6. Since `advance()` needs to query tasks by `workflowRunId + workflowStepId`, use the existing `taskManager` / `SpaceTaskRepository.listByWorkflowRun()` — filter in-memory by `workflowStepId` and `status === 'completed'`, then take the last one by `completedAt`. Note: this does a full run task scan, which is acceptable for typical workflow sizes. If performance becomes an issue later, a targeted query can be added.
7. Run `bun run typecheck` to confirm the exhaustive check is satisfied.

**Important:** The `advance()` signature change in subtask 5 is critical for Task 1.3 (wiring `step_result` from the tool handler). Task 1.3 will pass `stepResult` through this options parameter. The current `advance()` takes no arguments — this is the foundational change.

**Acceptance criteria:**
- `evaluateCondition()` handles `task_result` with prefix matching on `context.taskResult`.
- `advance()` automatically populates `taskResult` from the latest completed task on the current step.
- TypeScript compiles cleanly with no exhaustive check errors.
- Existing condition types (`always`, `human`, `condition`) continue to work unchanged.

**Depends on:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.3: Wire step_result through advance_workflow tool handler and update Task Agent prompt

**Description:** Forward the `step_result` argument from the `advance_workflow` MCP tool to the executor so that Task Agents can explicitly provide a result for transition evaluation. Also update the Task Agent system prompt to instruct the LLM to pass `step_result` when calling `advance_workflow`.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/tools/task-agent-tools.ts`, update the `advance_workflow` handler:
   - Remove the underscore prefix from `_args` (currently `async advance_workflow(_args: AdvanceWorkflowInput)` — the args are entirely unused).
   - Read `args.step_result` and pass it to `executor.advance({ stepResult: args.step_result })` using the options parameter added in Task 1.2.
   - Remove or update the comment block (lines 506–510) that describes `step_result` as a placeholder — it is now functional.
2. Update the `AdvanceWorkflowSchema` JSDoc in `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts` to clarify that `step_result` is used for `task_result` condition evaluation and should always be provided after completing a verify/review step.
3. In `packages/daemon/src/lib/space/agents/task-agent.ts`, update the Task Agent system prompt (`buildTaskAgentSystemPrompt`) to include an instruction like:
   - "When calling `advance_workflow` after a step that evaluates results (e.g., verify, review, or test steps), always include the `step_result` field with a value starting with 'passed' if the work is acceptable, or 'failed: <reason>' if issues were found."
   - This is essential for the `task_result` condition to work end-to-end — without it, the LLM will omit `step_result` and result-based transitions will silently fail.
4. Run `bun run typecheck`.

**Acceptance criteria:**
- `advance_workflow` tool forwards `step_result` to the executor via `advance({ stepResult })`.
- DB task result takes precedence; `step_result` is used as fallback when DB result is absent (precedence logic is in `advance()` from Task 1.2).
- Existing advance behavior is unchanged when `step_result` is not provided.
- Task Agent system prompt instructs the LLM to pass `step_result` on verify/review steps.

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
