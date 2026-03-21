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
2. Add `isCyclic?: boolean` to the `WorkflowTransition` interface. When `true`, following this transition increments `iterationCount` on the run. This flag is used by Milestone 2 for cycle detection — it avoids heuristic-based detection that would misfire on DAG merge paths.
3. Add `isCyclic?: boolean` to `ExportedWorkflowTransition` (line ~739 of `space.ts`). This is a separate interface that does NOT extend `WorkflowTransition` — the field must be added explicitly. Also update the export logic in `packages/daemon/src/lib/space/export-format.ts` (line ~192-198, note: no `export/` subdirectory) to include `isCyclic` when building the exported transition (e.g., `if (t.isCyclic !== undefined) exported.isCyclic = t.isCyclic;`). Also update the Zod import schema in the same file — the `workflowConditionSchema` at line ~38 hardcodes `z.enum(['always', 'human', 'condition'])`. Add `'task_result'` to this enum so workflows with `task_result` transitions can be imported without Zod validation errors.
4. Persist `isCyclic` to the DB via **migration 34**: `ALTER TABLE space_workflow_transitions ADD COLUMN is_cyclic INTEGER` (use the try/catch + SELECT probe pattern). Then update the transition persistence in `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - Update `insertTransition()` (private method, line ~409): add `is_cyclic` to the INSERT statement. The method takes `WorkflowTransitionInput` — `isCyclic` is already inherited via `Omit<WorkflowTransition, 'id'>`, so no type change needed for `WorkflowTransitionInput`. Pass `input.isCyclic ? 1 : 0` (or null if undefined) to the INSERT.
   - Update `rowToTransition()` (line ~107): read `is_cyclic` from the `TransitionRow` and map it to `isCyclic: Boolean(row.is_cyclic)` on the returned `WorkflowTransition`. Add `is_cyclic` to the `TransitionRow` interface.
   - Without these changes, `isCyclic` would be silently dropped on persist and lost when executors are rehydrated from DB.
5. Update the `WorkflowCondition` interface JSDoc to document that `expression` is also used by `task_result` to hold the match value (e.g., `'passed'`, `'failed'`).
6. Update the `WorkflowConditionType` type JSDoc to describe the `task_result` type: "fires when the most recently completed task's result starts with the expression value."
7. Run `bun run typecheck` to verify no compilation errors from the exhaustive `never` check in `workflow-executor.ts` (it will fail -- that is expected and fixed in Task 1.2).

**Note on `is_cyclic` migration:** This task includes migration 34 for `is_cyclic` on `space_workflow_transitions`. See the overview's migration number table for the full assignment (34 for isCyclic, 35-36 for iteration tracking, 37-38 for goalId).

**Acceptance criteria:**
- `WorkflowConditionType` includes `'task_result'` as a valid value.
- `WorkflowTransition` includes `isCyclic?: boolean`.
- JSDoc accurately describes the new condition type, `expression` usage, and `isCyclic` flag.
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
5. Update the `advance()` method signature to accept an optional `options?: { stepResult?: string }` parameter. Before evaluating transitions, query the tasks for the current step in this run (via `this.taskManager`) and extract the `result` field from the most recently completed task. Resolution order: use DB task `result` if non-empty, otherwise fall back to `options.stepResult`. Pass the resolved result as `taskResult` in the condition context.

   **When is the fallback used?** The step agent sets the task's `result` field via `report_result` → `taskManager.setTaskStatus(..., { result: summary })`. In the normal case, the DB result is populated and used. The `stepResult` fallback covers cases where: (a) the step agent completes without calling `report_result` (the completion callback sets status to `completed` but does not set `result`), or (b) the step agent's result summary does not contain the expected prefix (e.g., it wrote a generic summary instead of `'passed'`/`'failed: ...'`). The fallback ensures the Task Agent can always drive result-based transitions even if the step agent doesn't set a result in the expected format.
6. Since `advance()` needs to query tasks by `workflowRunId + workflowStepId`, use the existing `taskManager` / `SpaceTaskRepository.listByWorkflowRun()` — filter in-memory by `workflowStepId` and `status === 'completed'`, then take the last one by `completedAt`. Note: `listByWorkflowRun()` returns tasks ordered by `created_at ASC`. The "most recently completed" task should be selected by sorting the filtered results by `completedAt` descending and taking the first. This does a full run task scan which is acceptable for typical workflow sizes (even with cyclic workflows, the task count grows linearly with iterations). If performance becomes an issue later, a targeted query can be added.
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
3. In `packages/daemon/src/lib/space/agents/task-agent.ts`, update the Task Agent system prompt (`buildTaskAgentSystemPrompt`):
   - **Fix stale text at line ~175:** The existing prompt says `Pass the \`result\` of the completed step.` but the tool schema field is `step_result`, not `result`. Change this to `Pass the \`step_result\` of the completed step.`
   - **Add new instruction:** "When calling `advance_workflow` after a step that evaluates results (e.g., verify, review, or test steps), always include the `step_result` field with a value starting with 'passed' if the work is acceptable, or 'failed: <reason>' if issues were found."
   - Both changes are essential — fixing the stale field name prevents LLM confusion between `result` and `step_result`, and the new instruction ensures result-based transitions work end-to-end.
   - **Important distinction:** The updated prompt must clearly distinguish between `report_result` (which sets the task's `status` — one of `'completed'`/`'needs_attention'`/`'cancelled'`) and `advance_workflow` with `step_result` (which is a free-form string like `'passed'` or `'failed: <reason>'` used for transition evaluation). These are different concepts: `report_result.status` controls the task lifecycle, while `advance_workflow.step_result` drives result-based routing.
4. In `packages/daemon/src/lib/space/agents/task-agent.ts`, update the `formatTransition()` helper (lines ~91-104) to add a `task_result` branch. The existing code has a comment: "Any future WorkflowConditionType values not handled here will also produce no label; add a branch above when new types are introduced." Add a branch that labels `task_result` transitions, e.g., `→ [result matches "${condition.expression}"]`. Without this, the Task Agent's initial message will show Verify→Plan and Verify→Done transitions without labels, giving the LLM no signal about result-based routing.
5. Run `bun run typecheck`.

**Acceptance criteria:**
- `advance_workflow` tool forwards `step_result` to the executor via `advance({ stepResult })`.
- DB task result takes precedence; `step_result` is used as fallback when DB result is absent (precedence logic is in `advance()` from Task 1.2). The fallback is used when the step agent completes without calling `report_result` or sets a generic result not matching the expected prefix.
- Existing advance behavior is unchanged when `step_result` is not provided.
- Task Agent system prompt instructs the LLM to pass `step_result` on verify/review steps, and clearly distinguishes `step_result` (free-form string for routing) from `report_result.status` (task lifecycle enum).
- `formatTransition()` labels `task_result` transitions so the Task Agent LLM can see result-based routing.

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
