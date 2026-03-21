# Milestone 4: Multi-Agent Workflow Steps (Types and Executor)

## Goal

Allow workflow steps to specify multiple agents that execute in parallel. When a step has multiple agents, each gets its own SpaceTask and session, all within the same group. Step completion requires all parallel tasks to complete.

## Scope

- Extend `WorkflowStep` type with `agents` array
- Update `WorkflowExecutor.advance()` to create multiple tasks per step
- Update step completion logic in `SpaceRuntime`
- Update `resolveTaskTypeForStep()` for multi-agent resolution
- Add migration for `agents` JSON column on `space_workflow_steps`
- Unit tests for all changes

---

### Task 4.1: Extend WorkflowStep Type with Agents Array

**Description:** Add the `agents` array to `WorkflowStep` and related input types for multi-agent step support, with backward compatibility for the existing single `agentId` field.

**Subtasks:**
1. Define `WorkflowStepAgent` interface in `packages/shared/src/types/space.ts`:
   ```ts
   interface WorkflowStepAgent {
     agentId: string;
     count?: number;        // spawn N instances (default: 1)
     instructions?: string; // per-agent instructions override
   }
   ```
2. Add `agents?: WorkflowStepAgent[]` to `WorkflowStep` interface
3. Make `agentId` optional on `WorkflowStep` (it becomes a shorthand for single-agent steps)
4. Add validation: either `agentId` or `agents` must be provided (not both absent)
5. Add `agents?: WorkflowStepAgent[]` to `WorkflowStepInput` interface
6. Make `agentId` optional on `WorkflowStepInput`
7. Add a utility function `resolveStepAgents(step: WorkflowStep): WorkflowStepAgent[]` that normalizes the two formats into a single `agents` array (for use by executor and other consumers)

**Acceptance Criteria:**
- `bun run typecheck` passes
- Backward compatible: steps with only `agentId` still work
- The resolution function correctly handles both formats and `count` defaults

**Dependencies:** None (types only, no runtime dependency on Milestone 1)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: Update WorkflowExecutor for Multi-Agent Steps

**Description:** Update `WorkflowExecutor.advance()` to create multiple SpaceTasks when a step has multiple agents, and update step completion logic so the step only completes when all parallel tasks finish.

**Subtasks:**
1. In `followTransition()`, use `resolveStepAgents()` to get the list of agents for the target step
2. For each agent entry (respecting `count` for multiple instances), create a separate `SpaceTask` via `taskManager.createTask()`, each with the correct `customAgentId` and per-agent instructions
3. All tasks share the same `workflowRunId` and `workflowStepId`
4. Return all created tasks in the `tasks` array of the advance result
5. Update `resolveTaskResult()` to handle multiple completed tasks on the same step -- use the latest completed task's result, or aggregate results
6. In `SpaceRuntime.processCompletedTasks()`, update the logic that decides when to advance: a step should only advance when ALL tasks for that step are completed (not just one)
7. Add a helper method `areAllStepTasksComplete(runId: string, stepId: string): Promise<boolean>` to check completion status of all parallel tasks

**Acceptance Criteria:**
- Steps with `agents: [{agentId: 'a'}, {agentId: 'b'}]` create two tasks
- Steps with `agents: [{agentId: 'a', count: 3}]` create three tasks
- Step does not advance until all parallel tasks complete
- Single-agent steps (using `agentId` shorthand) continue to work identically
- `advance()` return value includes all created tasks

**Dependencies:** Task 4.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.3: Update resolveTaskTypeForStep for Multi-Agent

**Description:** Update `SpaceRuntime.resolveTaskTypeForStep()` to work with the multi-agent format and return per-agent resolution results.

**Subtasks:**
1. Create a new variant `resolveTaskTypesForStep(step: WorkflowStep): ResolvedTaskType[]` that returns one `ResolvedTaskType` per agent entry in the step
2. Each entry resolves the agent's role to a `SpaceTaskType` using the existing role-to-type mapping (planner -> planning, coder/general -> coding, custom -> coding)
3. Update the `TaskTypeResolver` type (used by WorkflowExecutor) to support multi-agent resolution
4. Keep the existing `resolveTaskTypeForStep()` working for backward compatibility (delegates to the first entry in the resolved array)

**Acceptance Criteria:**
- Multi-agent steps get correct task types per agent
- Existing single-agent task type resolution is unchanged
- TypeScript compiles cleanly

**Dependencies:** Task 4.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.4: Add Migration and Persistence for Multi-Agent Steps

**Description:** Add persistence support for the `agents` array on workflow steps. Since steps are stored as JSON within the `space_workflows` table (in the `steps` column), no schema migration is needed -- but the serialization/deserialization in the workflow repository must handle the new field.

**Subtasks:**
1. Verify that `SpaceWorkflowRepository` serializes/deserializes `WorkflowStep` correctly with the new `agents` field (it should, since steps are stored as JSON)
2. Add validation in the workflow create/update handlers: if `agents` is provided on a step, each entry must have a valid `agentId`
3. Add validation: `count` must be >= 1 if provided
4. Add validation: either `agentId` or `agents` must be present on each step
5. Update any workflow CRUD tests to cover multi-agent step persistence

**Acceptance Criteria:**
- Workflows with multi-agent steps can be created, read, updated, and deleted
- Validation rejects invalid configurations
- Existing workflows with single-agent steps continue to work

**Dependencies:** Task 4.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.5: Unit Tests for Multi-Agent Executor

**Description:** Comprehensive unit tests for the multi-agent workflow execution flow.

**Subtasks:**
1. Create or extend test file `packages/daemon/tests/unit/workflow-executor-multi-agent.test.ts`
2. Test `advance()` with a multi-agent step: verify multiple tasks are created
3. Test `advance()` with `count > 1`: verify correct number of task instances
4. Test step completion logic: step does not advance when only some tasks are complete
5. Test step completion logic: step advances when all tasks are complete
6. Test backward compatibility: single `agentId` steps work identically
7. Test `resolveStepAgents()` utility with various input combinations
8. Test error handling: what happens when one of the parallel tasks fails
9. Test mixed workflows: some steps single-agent, some multi-agent

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/workflow-executor-multi-agent.test.ts`
- Edge cases are covered (empty agents array, count=0, missing agentId)
- Tests follow existing workflow executor test patterns

**Dependencies:** Task 4.2, Task 4.3

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
